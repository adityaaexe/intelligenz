import { Icon } from '@intelligenz/design-system';

import {
  integrityDescriptor,
  provenanceDescriptor,
  runStateDescriptor,
  type IntegrityDescriptor,
  type Provenance,
  type RunStateDescriptor,
  type StateDescriptor,
  type TaskGateDescriptor,
} from '../../lib/execution-state';
import type { ArtifactIntegrity, RunStatus } from '../../lib/types';

/**
 * The execution badges: provenance, run state, artifact integrity, task gate.
 *
 * One renderer for all four so the contract DESIGN.md §4.4 makes — *every* state
 * ships a glyph, a word, and a colour, and removing colour leaves the screen
 * readable — cannot be honoured by one badge and skipped by another.
 *
 * `ProvenanceBadge` takes a `Provenance`, not a boolean. A component cannot
 * receive `simulated: true` and decide to render "Live": the only values it
 * accepts are the two the vocabulary defines, produced by one pure function.
 */

interface BadgeProps {
  readonly descriptor: StateDescriptor;
  readonly size?: 'sm' | 'md';
  /** Extra visual channel beyond glyph + word (dashed edge, bold label). */
  readonly dataAttributes?: Readonly<Record<string, string>>;
  readonly className?: string;
  readonly title?: string;
}

function Badge({ descriptor, size = 'md', dataAttributes, className, title }: BadgeProps) {
  return (
    <span
      className={['iz-pill', className].filter(Boolean).join(' ')}
      data-tone={descriptor.tone}
      data-size={size}
      title={title}
      {...dataAttributes}
    >
      <Icon className="iz-pill__glyph" name={descriptor.glyph} size={12} />
      <span className="iz-pill__label">
        <span className="iz-sr-only">{descriptor.srPrefix}</span>
        {descriptor.label}
      </span>
    </span>
  );
}

/**
 * `Live` or `Simulated`, from the adapter's own `simulated` field.
 *
 * The two are separated by five channels, not one: the word, the glyph (a live
 * signal vs a flask), the tone, a solid vs dashed edge, and the accessible name
 * (`Provenance: Live` / `Provenance: Simulated`). Greyscale, screen reader, and
 * 200% zoom all still distinguish them.
 */
export function ProvenanceBadge({
  provenance,
  size = 'md',
}: {
  readonly provenance: Provenance;
  readonly size?: 'sm' | 'md';
}) {
  const descriptor = provenanceDescriptor(provenance);
  return (
    <Badge
      descriptor={descriptor}
      size={size}
      className="ex-provenance"
      dataAttributes={{ 'data-provenance': provenance }}
      title={
        provenance === 'simulated'
          ? 'No model was called for this attempt.'
          : 'The runtime reported a model call for this attempt.'
      }
    />
  );
}

/** Where the attempt got to. `Failed · Timed out` keeps the state word scannable. */
export function RunStateBadge({
  status,
  size = 'md',
}: {
  readonly status: RunStatus;
  readonly size?: 'sm' | 'md';
}) {
  const descriptor: RunStateDescriptor = runStateDescriptor(status);
  return (
    <span className="ex-runstate">
      <Badge descriptor={descriptor} size={size} dataAttributes={{ 'data-run-status': status }} />
      {descriptor.qualifier !== null ? (
        <span className="ex-runstate__qualifier">{descriptor.qualifier}</span>
      ) : null}
    </span>
  );
}

/**
 * `Verified` · `Failed` · `Unverified`, computed by the API from the bytes on
 * this request. Failed integrity is loud — tinted row, bold word, and a sentence
 * that says what it means — because it is the one state where a file on disk is
 * no longer the file the ledger recorded.
 */
export function IntegrityBadge({
  integrity,
  size = 'sm',
}: {
  readonly integrity: ArtifactIntegrity;
  readonly size?: 'sm' | 'md';
}) {
  const descriptor: IntegrityDescriptor = integrityDescriptor(integrity);
  return (
    <Badge
      descriptor={descriptor}
      size={size}
      className="ex-integrity"
      dataAttributes={{
        'data-integrity': integrity,
        ...(descriptor.loud ? { 'data-loud': 'true' } : {}),
      }}
    />
  );
}

/**
 * Task-level state. `Waiting for approval` and `Blocked` share the awaiting stem
 * because both wait on a human, and are separated by glyph (`approvals` vs pause
 * bars) and word.
 */
export function TaskGateBadge({ gate }: { readonly gate: TaskGateDescriptor }) {
  return (
    <span className="ex-gate" title={gate.reason}>
      <Badge descriptor={gate} size="md" dataAttributes={{ 'data-gate': gate.word }} />
      <span className="ex-gate__reason">{gate.reason}</span>
    </span>
  );
}
