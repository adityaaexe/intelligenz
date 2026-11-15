import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { summariseArtifact, type ArtifactRecord } from './artifact-summary';
import { createArtifactLocator, type ArtifactLocator } from './artifact-locator';

/**
 * How an `Artifact` row becomes a wire object, tested where it is decided.
 *
 * Three properties, each of which was a plausible bug:
 *
 *   1. **A legacy row is reported as unattributed, not guessed.** Every artifact written
 *      before Phase 4 has `attemptId: null`, and every artifact written before Phase 6 has
 *      `authoritative: false` with no `evidenceSource`. Filling either in from "the newest
 *      run" or from `kind` would make the platform assert provenance it never recorded.
 *   2. **A tampered file fails verification.** This is the input to the `409` the download
 *      endpoint returns; a summary that said `verified` after the bytes moved would be the
 *      first half of serving them.
 *   3. **The new authority fields are copied, never derived.** `authoritative: true` on the
 *      row is the only thing that makes it true on the wire.
 */

let directory: string;
let locator: ArtifactLocator;

const MANIFEST_BODY = '{"version":1,"changes":[]}';
const MANIFEST_DIGEST = createHash('sha256').update(MANIFEST_BODY).digest('hex');

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'intelligenz-artifact-summary-'));
  locator = createArtifactLocator([directory]);

  await writeFile(join(directory, 'change-manifest.json'), MANIFEST_BODY);
  await writeFile(join(directory, 'legacy.patch'), '# git diff\n');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function record(overrides: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'kind' | 'uri' | 'checksum'>): ArtifactRecord {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    attemptId: null,
    runtimeId: 'opencode-cli',
    sizeBytes: BigInt(MANIFEST_BODY.length),
    evidenceSource: null,
    authoritative: false,
    manifestDigest: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('summariseArtifact — provenance is copied, never inferred', () => {
  it('reports a legacy row as unattributed and non-authoritative', async () => {
    const summary = await summariseArtifact(
      locator,
      record({
        kind: 'diff',
        uri: join(directory, 'legacy.patch'),
        checksum: createHash('sha256').update('# git diff\n').digest('hex'),
        sizeBytes: 10n,
      }),
      'text/x-diff',
    );

    // `null` attempt + `unattributed: true`: the row never recorded which run produced it,
    // and the wire says so rather than picking the newest attempt.
    expect(summary.attemptId).toBeNull();
    expect(summary.unattributed).toBe(true);

    // `false` and `null` rather than a default of authority. A diff was never authority,
    // and a row that predates the column was never measured either.
    expect(summary.authoritative).toBe(false);
    expect(summary.evidenceSource).toBeNull();
    expect(summary.manifestDigest).toBeNull();

    // The bytes are still verifiable, which is a separate fact from their provenance.
    expect(summary.integrity).toBe('verified');
  });

  it('reports a host manifest with its digests and its authority', async () => {
    const summary = await summariseArtifact(
      locator,
      record({
        kind: 'change-manifest',
        uri: join(directory, 'change-manifest.json'),
        checksum: MANIFEST_DIGEST,
        attemptId: 'attempt-1',
        evidenceSource: 'host-snapshot',
        authoritative: true,
        manifestDigest: MANIFEST_DIGEST,
      }),
      'application/json',
    );

    expect(summary.unattributed).toBe(false);
    expect(summary.attemptId).toBe('attempt-1');
    expect(summary.evidenceSource).toBe('host-snapshot');
    expect(summary.authoritative).toBe(true);
    expect(summary.manifestDigest).toBe(MANIFEST_DIGEST);
    expect(summary.integrity).toBe('verified');
  });

  it('reports a tampered file as integrity `failed`, which is what the 409 is built from', async () => {
    await writeFile(join(directory, 'tampered.json'), `${MANIFEST_BODY} `);

    const summary = await summariseArtifact(
      locator,
      record({
        kind: 'change-manifest',
        uri: join(directory, 'tampered.json'),
        checksum: MANIFEST_DIGEST,
        evidenceSource: 'host-snapshot',
        authoritative: true,
        manifestDigest: MANIFEST_DIGEST,
      }),
      'application/json',
    );

    expect(summary.integrity).toBe('failed');
    // Authority is a stored claim about provenance; integrity is computed from the bytes.
    // The two are deliberately independent, so a tampered manifest still says it *was*
    // authority — and the integrity field is what stops it being served.
    expect(summary.authoritative).toBe(true);
    expect(summary.checksum).toBe(MANIFEST_DIGEST);
  });

  it('keeps the recorded size when the bytes are gone instead of pretending they are intact', async () => {
    const summary = await summariseArtifact(
      locator,
      record({
        kind: 'change-manifest',
        uri: join(directory, 'never-written.json'),
        checksum: MANIFEST_DIGEST,
        sizeBytes: 123n,
      }),
      'application/json',
    );

    expect(summary.integrity).toBe('unknown');
    expect(summary.sizeBytes).toBe(123);
  });
});
