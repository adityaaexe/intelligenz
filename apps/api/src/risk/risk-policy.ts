import type { RiskClass } from '@intelligenz/contracts';

/**
 * The risk policy — one versioned table, in code, with the reason for each number.
 *
 * ## Why a table and not a heuristic
 *
 * The whole finding behind D-006 is that the old class was an *assertion*: anyone
 * could type `"riskClass": "LOW"` and the approvals screen would display a control
 * that had been opted out of. A number in a `switch` is not auditable a week later;
 * a named table with a version is. Every row below is a policy decision that can be
 * reviewed, argued with, and changed in a diff.
 *
 * ## Two mechanisms, and why both exist
 *
 *   - **weights** accumulate into a score, which is banded into a class. They express
 *     "more dangerous things together are worse than either alone".
 *   - **floors** are hard minimums. They express "no combination of other signals may
 *     make this LOW". A weighted score alone would let a nasty task hide behind safe
 *     neighbours; a floor alone cannot distinguish `read` from `edit`.
 *
 * The result is `max(band(score), every floor)`.
 *
 * ## Direction of error
 *
 * Keyword matching produces false positives: a task that says "do not delete rows
 * by accident" is classified as if it deletes rows. That is deliberate. A false
 * positive costs one approval click; a false negative costs the control. The match
 * terms are recorded in `riskFactors.matchedTerms` so a reviewer can see exactly why.
 *
 * ## What this table must never do
 *
 * Text inside the repository (a README, a `CLAUDE.md`, an issue template) is
 * **hostile input**. It may raise a classification (it is scanned like task content)
 * but it can never lower one, and a line in it that says "risk class: LOW" is a
 * `untrusted_instruction_override` signal, not a directive. See `classify.ts`.
 */

/**
 * Bump on any change that can move a task between classes. Stored on every classified
 * task (`Task.riskPolicyVersion`) and every approval (`ApprovalRequest.policyVersion`),
 * so a class recorded months ago stays attributable to the rules that produced it.
 */
export const RISK_POLICY_VERSION = '2026-11-14.1';

/** Default when a task does not name a profile. Mirrors the worker's light profile. */
export const DEFAULT_EXECUTION_PROFILE = 'standard';

export type OperationKind = 'read_only' | 'file_write' | 'shell' | 'deploy' | 'unknown';

export type RepositoryTrust = 'trusted' | 'untrusted' | 'unknown';

export type SecuritySignal = 'credential_request' | 'host_path_request';

/**
 * Score added per detected operation. `unknown` is not zero: an operation nobody could
 * classify is not evidence of safety.
 */
export const OPERATION_WEIGHTS: Readonly<Record<OperationKind, number>> = {
  read_only: 0,
  file_write: 30,
  shell: 50,
  deploy: 100,
  unknown: 25,
};

/** Score added per repository-trust state. Trusted repos are the only zero. */
export const TRUST_WEIGHTS: Readonly<Record<RepositoryTrust, number>> = {
  trusted: 0,
  untrusted: 20,
  unknown: 15,
};

/** A task that explicitly requests a capability pays for it even if nothing else does. */
export const CAPABILITY_WEIGHTS = {
  shell: 40,
  network: 30,
} as const;

/** Heavier execution profiles get more of the host; that is a risk, not a preference. */
export const PROFILE_WEIGHTS: Readonly<Record<string, number>> = {
  standard: 0,
  heavy: 30,
};

/** An unknown profile string is treated as "declared but not understood" → MEDIUM. */
export const UNKNOWN_PROFILE_WEIGHT = 10;

/** Text that tries to rewrite the classifier's own rules. */
export const INSTRUCTION_OVERRIDE_WEIGHT = 50;

/**
 * Score bands. A score at or above a threshold lands in that class.
 *
 * Chosen so the documented rules compose predictably:
 *   - untrusted (20) + file_write (30) = 50 → HIGH via the untrusted-write floor,
 *     which is the rule the decision record calls out explicitly;
 *   - trusted (0) + file_write (30)     = 30 → MEDIUM, i.e. a normal edit;
 *   - trusted (0) + read_only (0)       = 0  → LOW, only when every signal is known.
 */
export const SCORE_BANDS: readonly { readonly min: number; readonly riskClass: RiskClass }[] = [
  { min: 100, riskClass: 'CRITICAL' },
  { min: 60, riskClass: 'HIGH' },
  { min: 25, riskClass: 'MEDIUM' },
  { min: 0, riskClass: 'LOW' },
];

/**
 * Match vocabulary. Terms are matched case-insensitively on word boundaries where the
 * term is a single word, and as plain substrings for phrases. Every term that matched
 * is reported in `riskFactors.matchedTerms`.
 */
export const TERMS = {
  /**
   * Deploy/publish/merge/delete/production. A hard CRITICAL floor: these actions are
   * either irreversible (delete, merge, force-push) or reach an environment other
   * people depend on (deploy, production).
   */
  critical: [
    'deploy',
    'deployment',
    'release',
    'publish',
    'rollout',
    'roll out',
    'promote',
    'ship',
    'production',
    'prod',
    'merge',
    'delete',
    'drop',
    'destroy',
    'truncate',
    'wipe',
    'purge',
    'force push',
    'force-push',
    'reset --hard',
    'overwrite',
  ],

  /**
   * Credentials and host paths. A hard CRITICAL floor **and** a security event: a task
   * asking for a secret or a host path is not a risky change, it is an attempt at the
   * platform's own trust boundary.
   */
  credential: [
    'credential',
    'credentials',
    'secret',
    'secrets',
    'api key',
    'api-key',
    'apikey',
    'password',
    'passwd',
    'private key',
    'ssh key',
    'id_rsa',
    'kubeconfig',
    'auth.json',
    'opencode.db',
    'access key',
    'bearer token',
  ],
  hostPath: [
    '/etc/',
    '/root/',
    '/home/',
    '/var/',
    '/usr/',
    '/proc/',
    '/sys/',
    '/dev/',
    'c:\\',
    '../',
    '..\\',
    '/tmp/',
  ],

  /** Arbitrary code execution. HIGH floor on its own. */
  shell: [
    'shell',
    'bash',
    'sh -c',
    'subprocess',
    'exec(',
    'sudo',
    'chmod',
    'chown',
    'crontab',
    'systemctl',
    'npm run',
    'pnpm ',
    'yarn ',
    'make ',
    'cargo ',
    'docker ',
    'kubectl ',
    'terraform ',
    'ansible ',
  ],

  /** Outbound traffic. HIGH floor: egress is the one thing a sandbox exists to bound. */
  network: [
    'network',
    'http request',
    'http call',
    'webhook',
    'egress',
    'upload',
    'download',
    'curl ',
    'wget ',
    'external api',
    'internet',
    'third-party api',
  ],

  /** Changes to files. MEDIUM baseline; HIGH when the repository is untrusted. */
  write: [
    'write',
    'edit',
    'modify',
    'refactor',
    'rename',
    'implement',
    'patch',
    'fix',
    'generate',
    'apply',
    'migrate',
    'create file',
    'add file',
    'add a file',
    'update the',
  ],

  /** Inspection only. The only vocabulary that can reach LOW, and only when trusted. */
  readOnly: [
    'read',
    'review',
    'analyse',
    'analyze',
    'summarise',
    'summarize',
    'explain',
    'inspect',
    'report',
    'document',
    'audit',
    'list',
    'search',
    'investigate',
    'describe',
    'compare',
    'evaluate',
  ],

  /**
   * Attempts to talk the classifier out of its own rules. Only ever *raises*: a
   * repository instruction is data, not policy.
   */
  instructionOverride: [
    'ignore previous',
    'ignore all previous',
    'ignore the above',
    'ignore prior',
    'disregard previous',
    'disregard the above',
    'risk class',
    'riskclass',
    'skip approval',
    'no approval needed',
    'approval is not required',
    'approve this',
    'you are authorized',
    'system prompt',
    'new instructions',
  ],
} as const;

/**
 * Repository trust. `trusted` means both halves are present: a source that matches an
 * allowlisted entry and a pinned commit. A branch name is not a pin — it moves.
 *
 * An empty allowlist trusts nothing. That is the safe default and it is what ships:
 * an operator opts a repository in explicitly (`TRUSTED_SOURCE_REPOS`).
 */
export function resolveRepositoryTrust(
  sourceRef: string | null | undefined,
  baseCommit: string | null | undefined,
  allowlist: readonly string[],
): RepositoryTrust {
  const ref = sourceRef?.trim().toLowerCase();
  const commit = baseCommit?.trim();

  if (ref === undefined || ref.length === 0 || commit === undefined || commit.length === 0) {
    return 'unknown';
  }

  const repo = ref.split('#')[0]?.trim() ?? '';

  if (repo.length === 0) return 'unknown';

  const trusted = allowlist.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate.length === 0) return false;

    // A prefix match that respects a path boundary: allowing `github.com/acme` must
    // not allow `github.com/acme-evil`.
    return repo === candidate || repo.startsWith(`${candidate}/`);
  });

  return trusted ? 'trusted' : 'untrusted';
}
