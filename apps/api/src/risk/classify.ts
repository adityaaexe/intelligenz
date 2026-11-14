import {
  compareRiskClass,
  maxRiskClass,
  requiresApproval,
  type RiskClass,
} from '@intelligenz/contracts';

import {
  CAPABILITY_WEIGHTS,
  DEFAULT_EXECUTION_PROFILE,
  INSTRUCTION_OVERRIDE_WEIGHT,
  OPERATION_WEIGHTS,
  PROFILE_WEIGHTS,
  RISK_POLICY_VERSION,
  SCORE_BANDS,
  TERMS,
  TRUST_WEIGHTS,
  UNKNOWN_PROFILE_WEIGHT,
  resolveRepositoryTrust,
  type OperationKind,
  type RepositoryTrust,
  type SecuritySignal,
} from './risk-policy';

/**
 * Server-side risk classification (D-006).
 *
 * ## The property this establishes
 *
 * The caller's asserted `riskClass` is **not an input to the decision**. It is read
 * only to record whether the caller tried to move the class down (`clientAttempted
 * Downgrade`) or up (`clientAttemptedEscalation`). Both are recorded; neither is
 * obeyed. There is no branch below that returns `input.clientRiskClass`.
 *
 * ## Unknown is not safe
 *
 * A signal that could not be determined (no source, no pinned commit, content with no
 * recognisable operation) contributes a weight and a floor. The result is therefore at
 * least `MEDIUM` whenever any signal is unknown. `LOW` requires *all* of: a read-only
 * operation, an allowlisted repository pinned to a commit, no shell or network
 * request, no credential/host-path/destructive language, and the standard profile.
 * That combination is not reachable from client input alone — it needs an operator to
 * have allowlisted the repository first.
 *
 * ## Hostile text
 *
 * `repositoryInstructions` is text that came from the repository being worked on. It
 * is scanned exactly like task content (it can raise a class) and it is additionally
 * checked for attempts to rewrite the policy (`ignore previous instructions`,
 * `riskClass: LOW`, `approval is not required`). Such an attempt is recorded as
 * `untrusted_instruction_override` and raises the floor to `HIGH`; it never lowers
 * anything and is never treated as an instruction.
 *
 * ## No content leaves this function
 *
 * `RiskFactorRecord` carries rule ids and matched vocabulary terms, never the task's
 * title, goal or file text. It is safe to persist, to return to a client, and to log.
 */

export interface ClassificationInput {
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  /** `standard` | `heavy`; unknown strings are treated as declared-but-ununderstood. */
  readonly executionProfile?: string | null;
  /** e.g. `github.com/acme/app#main`. */
  readonly sourceRef?: string | null;
  /** Pinned commit. Without it the repository is not trusted, whatever the allowlist says. */
  readonly baseCommit?: string | null;
  /** Operator-owned allowlist. Empty means "trust nothing", which is the shipped default. */
  readonly trustedSourceRepos?: readonly string[];
  /**
   * Text read from the repository under work. Hostile input: it may raise the class,
   * never lower it. The API passes `[]` until repository content is available at
   * request time; the worker owns the same check inside the sandbox.
   */
  readonly repositoryInstructions?: readonly string[];
  /** What the caller asserted. Recorded, never obeyed. */
  readonly clientRiskClass?: RiskClass | null;
}

export interface RiskFactorRecord {
  /** Rule ids that fired, e.g. `operation:shell`, `repository:untrusted`. */
  readonly signals: readonly string[];
  readonly score: number;
  readonly operation: OperationKind;
  readonly repositoryTrust: RepositoryTrust;
  /** Vocabulary terms that matched — policy words, never task content. */
  readonly matchedTerms: readonly string[];
  readonly executionProfile: string;
  readonly policyVersion: string;
  readonly clientRiskClass: RiskClass | null;
  readonly clientAttemptedDowngrade: boolean;
  readonly clientAttemptedEscalation: boolean;
  /** Present when the task asked for credentials or host paths. Drives a security event. */
  readonly securityEvents: readonly SecuritySignal[];
}

export interface RiskClassification {
  readonly riskClass: RiskClass;
  readonly policyVersion: string;
  readonly factors: RiskFactorRecord;
  readonly requiresApproval: boolean;
}

/**
 * The classifier. Pure: same input, same output, no clock, no database, no I/O.
 * `policyVersion` in the result is the version of the table that produced it.
 */
export function classify(input: ClassificationInput): RiskClassification {
  const corpus = normalise([input.title, input.goal, ...input.acceptanceCriteria].join('\n'));
  const hostile = normalise((input.repositoryInstructions ?? []).join('\n'));
  const profile = input.executionProfile?.trim().toLowerCase() ?? DEFAULT_EXECUTION_PROFILE;

  const signals: string[] = [];
  const matched: string[] = [];
  const floors: RiskClass[] = [];

  const criticalTerms = matchTerms(corpus, TERMS.critical);
  const credentialTerms = matchTerms(corpus, TERMS.credential);
  const hostPathTerms = matchTerms(corpus, TERMS.hostPath);
  const shellTerms = matchTerms(corpus, TERMS.shell);
  const networkTerms = matchTerms(corpus, TERMS.network);
  const writeTerms = matchTerms(corpus, TERMS.write);
  const readTerms = matchTerms(corpus, TERMS.readOnly);
  const overrideTerms = matchTerms(hostile, TERMS.instructionOverride);

  matched.push(
    ...criticalTerms,
    ...credentialTerms,
    ...hostPathTerms,
    ...shellTerms,
    ...networkTerms,
    ...writeTerms,
    ...readTerms,
  );

  // ─── 1. Operation ─────────────────────────────────────────────────────────
  // Precedence is by severity, so a task that says both "read" and "deploy" is a
  // deploy. Only a task with no recognisable verb is `unknown`.
  const operation = detectOperation({ critical: criticalTerms, shell: shellTerms, write: writeTerms, read: readTerms });

  let score = OPERATION_WEIGHTS[operation];
  signals.push(`operation:${operation}`);

  if (operation === 'deploy') floors.push('CRITICAL');
  if (operation === 'shell') floors.push('HIGH');
  if (operation === 'file_write') floors.push('MEDIUM');
  if (operation === 'unknown') floors.push('MEDIUM');

  // ─── 2. Repository trust ──────────────────────────────────────────────────
  const repositoryTrust = resolveRepositoryTrust(
    input.sourceRef,
    input.baseCommit,
    input.trustedSourceRepos ?? [],
  );

  score += TRUST_WEIGHTS[repositoryTrust];
  signals.push(`repository:${repositoryTrust}`);

  // Any unknown signal is at least MEDIUM. This is the rule that makes "LOW from the
  // client alone" impossible: an unauthenticated caller cannot produce trust.
  if (repositoryTrust !== 'trusted') floors.push('MEDIUM');

  // The explicit rule from the decision record: an untrusted repository's **file
  // write** is at least HIGH, and an untrusted repository's shell or deploy is
  // CRITICAL — the task is asking to run code against a checkout nobody vouched for.
  if (repositoryTrust === 'untrusted' && operation === 'file_write') floors.push('HIGH');
  if (repositoryTrust === 'untrusted' && (operation === 'shell' || operation === 'deploy')) {
    floors.push('CRITICAL');
  }

  // ─── 3. Declared capabilities ─────────────────────────────────────────────
  const shellRequested = shellTerms.length > 0;
  const networkRequested = networkTerms.length > 0;

  if (shellRequested) {
    signals.push('capability:shell');
    floors.push('HIGH');
    // No double count: when the detected operation is already `shell`, its weight
    // already accounts for this evidence. Counting it twice turned an ordinary
    // `shell` task into a weighted CRITICAL purely by arithmetic.
    if (operation !== 'shell') score += CAPABILITY_WEIGHTS.shell;
  }

  if (networkRequested) {
    score += CAPABILITY_WEIGHTS.network;
    signals.push('capability:network');
    floors.push('HIGH');
  }

  // ─── 4. Irreversible / environment-reachable language ─────────────────────
  if (criticalTerms.length > 0) {
    signals.push('language:irreversible');
    floors.push('CRITICAL');
  }

  const securityEvents: SecuritySignal[] = [];

  if (credentialTerms.length > 0) {
    signals.push('security:credential_request');
    floors.push('CRITICAL');
    securityEvents.push('credential_request');
  }

  if (hostPathTerms.length > 0) {
    signals.push('security:host_path_request');
    floors.push('CRITICAL');
    securityEvents.push('host_path_request');
  }

  // ─── 5. Execution profile ────────────────────────────────────────────────
  const profileWeight = PROFILE_WEIGHTS[profile];
  score += profileWeight ?? UNKNOWN_PROFILE_WEIGHT;
  signals.push(`profile:${profile}`);

  if (profile === 'heavy') floors.push('HIGH');
  if (profileWeight === undefined) floors.push('MEDIUM');

  // ─── 6. Hostile repository text ──────────────────────────────────────────
  if (overrideTerms.length > 0) {
    score += INSTRUCTION_OVERRIDE_WEIGHT;
    signals.push('untrusted_instruction_override');
    floors.push('HIGH');
  }

  // ─── 7. Compose ──────────────────────────────────────────────────────────
  const banded = bandFor(score);
  const derived = floors.reduce<RiskClass>((current, floor) => maxRiskClass(current, floor), banded);

  const clientRiskClass = input.clientRiskClass ?? null;
  const clientAttemptedDowngrade =
    clientRiskClass !== null && compareRiskClass(clientRiskClass, derived) < 0;
  const clientAttemptedEscalation =
    clientRiskClass !== null && compareRiskClass(clientRiskClass, derived) > 0;

  if (clientAttemptedDowngrade) signals.push('client:downgrade_attempted');
  if (clientAttemptedEscalation) signals.push('client:escalation_attempted');

  return {
    riskClass: derived,
    policyVersion: RISK_POLICY_VERSION,
    requiresApproval: requiresApproval(derived),
    factors: {
      signals,
      score,
      operation,
      repositoryTrust,
      matchedTerms: [...new Set(matched)].sort(),
      executionProfile: profile,
      policyVersion: RISK_POLICY_VERSION,
      clientRiskClass,
      clientAttemptedDowngrade,
      clientAttemptedEscalation,
      securityEvents,
    },
  };
}

interface OperationMatch {
  readonly critical: readonly string[];
  readonly shell: readonly string[];
  readonly write: readonly string[];
  readonly read: readonly string[];
}

function detectOperation(match: OperationMatch): OperationKind {
  if (match.critical.length > 0) return 'deploy';
  if (match.shell.length > 0) return 'shell';
  if (match.write.length > 0) return 'file_write';
  if (match.read.length > 0) return 'read_only';

  return 'unknown';
}

function bandFor(score: number): RiskClass {
  for (const band of SCORE_BANDS) {
    if (score >= band.min) return band.riskClass;
  }

  return 'LOW';
}

/** Case-folded, whitespace-collapsed. Keeps `pnpm  run` and `pnpm run` equivalent. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Single words match on a word boundary so `prod` does not match `product` and
 * `read` does not match `already`. Terms containing a space, punctuation or a slash
 * are matched as plain substrings (a word boundary around `/etc/` is not meaningful).
 */
function matchTerms(corpus: string, terms: readonly string[]): string[] {
  if (corpus.length === 0) return [];

  return terms.filter((term) => matchesTerm(corpus, term));
}

function matchesTerm(corpus: string, term: string): boolean {
  const candidate = term.trim().toLowerCase();

  if (candidate.length === 0) return false;

  const isPlainWord = /^[a-z]+$/.test(candidate);

  if (!isPlainWord) return corpus.includes(candidate);

  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(corpus);
}
