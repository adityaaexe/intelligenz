import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation. Object keys are sorted at every depth so
 * that two logically identical payloads always hash identically.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** The `prev` value of the first entry in every journal. */
export const GENESIS_HASH = '0'.repeat(64);

export interface HashInput {
  readonly prev: string;
  readonly seq: number;
  readonly type: string;
  readonly ts: string;
  readonly payload: unknown;
}

/**
 * Chain hash for one entry. Every field that a reader could tamper with is
 * covered, including the link to the previous entry.
 */
export function computeHash(input: HashInput): string {
  const material = [
    input.prev,
    String(input.seq),
    input.type,
    input.ts,
    canonical(input.payload),
  ].join('\n');

  return createHash('sha256').update(material, 'utf8').digest('hex');
}
