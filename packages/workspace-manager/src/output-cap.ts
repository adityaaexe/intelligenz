import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, stat, unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * Output ceilings — `outputCapBytes`, enforced instead of declared.
 *
 * ## The failure this prevents
 *
 * Every resource profile declares `outputCapBytes` (5 MiB for `SMALL`/`STANDARD`, 10 MiB
 * for `HEAVY`). Phase 4 read it nowhere, so a process that printed a gigabyte produced a
 * gigabyte of Buffers in the worker's heap, a gigabyte in the artifact store and a
 * transcript nothing would open. `execFile` with `maxBuffer` does not solve it either:
 * the buffer grows to the ceiling *before* it errors, so the memory cost of the ceiling
 * is paid even for well-behaved runs, and the error loses the bytes that were captured.
 *
 * ## The shape of the fix
 *
 * A **streaming** ceiling with three properties:
 *
 * 1. **Memory is bounded by the cap, not by the output.** Chunks are counted at their
 *    full length, appended only while they fit, and then discarded — the stream is
 *    never paused, so the producer never blocks on backpressure and nothing queues.
 * 2. **A truncation is recorded, not silent.** The captured prefix ends with a
 *    structured marker carrying the original byte count and the digest of the prefix,
 *    so a reader can tell "this is all there was" from "this is all we kept", and can
 *    still verify the bytes it has.
 * 3. **The cap composes.** `ArtifactBudget` shares one ceiling across several files,
 *    so six artifacts of 4 MiB cannot add up to 24 MiB of evidence under a 5 MiB
 *    profile.
 *
 * ## The marker
 *
 * `\0IZ_TRUNCATED:{json}\0` on its own line. NUL is not valid in text a model or a
 * diff produces, so the marker cannot be confused with content, and the JSON body is
 * machine-readable rather than a sentence someone has to parse with a regex.
 */

/** The marker's prefix. `\0` cannot occur in the text this wraps. */
export const TRUNCATION_MARKER_PREFIX = '\u0000IZ_TRUNCATED:';
const TRUNCATION_MARKER_SUFFIX = '\u0000';

export interface TruncationMarker {
  readonly scope: string;
  readonly capBytes: number;
  readonly capturedBytes: number;
  /** What the producer actually emitted, when it is knowable (a stream, a file size). */
  readonly originalBytes: number;
  readonly droppedBytes: number;
  /** SHA-256 of the captured prefix, so the kept bytes are still verifiable. */
  readonly sha256: string;
}

export interface CaptureResult {
  /** The captured prefix, with the marker appended when anything was dropped. */
  readonly text: string;
  /** Bytes kept. Never greater than `capBytes`. */
  readonly capturedBytes: number;
  /** Bytes the producer emitted. `capturedBytes + droppedBytes`. */
  readonly originalBytes: number;
  readonly droppedBytes: number;
  readonly truncated: boolean;
  readonly marker: TruncationMarker | null;
}

export function formatTruncationMarker(marker: TruncationMarker): string {
  return `\n${TRUNCATION_MARKER_PREFIX}${JSON.stringify(marker)}${TRUNCATION_MARKER_SUFFIX}\n`;
}

export function readTruncationMarker(text: string): TruncationMarker | null {
  // Deliberately a scan rather than a regular expression: the marker body is JSON,
  // which owns every character a regex would want to escape.
  const start = text.indexOf(TRUNCATION_MARKER_PREFIX);
  if (start === -1) return null;

  const bodyStart = start + TRUNCATION_MARKER_PREFIX.length;
  const end = text.indexOf(TRUNCATION_MARKER_SUFFIX, bodyStart);
  if (end === -1) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(bodyStart, end));
    if (typeof parsed !== 'object' || parsed === null) return null;

    const candidate = parsed as Partial<TruncationMarker>;

    if (
      typeof candidate.capBytes !== 'number' ||
      typeof candidate.capturedBytes !== 'number' ||
      typeof candidate.originalBytes !== 'number' ||
      typeof candidate.scope !== 'string'
    ) {
      return null;
    }

    return {
      scope: candidate.scope,
      capBytes: candidate.capBytes,
      capturedBytes: candidate.capturedBytes,
      originalBytes: candidate.originalBytes,
      droppedBytes: candidate.droppedBytes ?? candidate.originalBytes - candidate.capturedBytes,
      sha256: candidate.sha256 ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * A ceiling with a counter. `write()` is synchronous and allocation-free once the cap is
 * reached, which is what keeps a flooding producer cheap to absorb: the bytes are
 * measured and dropped rather than buffered, queued or stringified.
 */
export class BoundedCapture {
  readonly capBytes: number;
  readonly scope: string;
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  private observed = 0;
  /**
   * The digest of the captured prefix, or `undefined` when it must be recomputed.
   *
   * Cached as a **string**, not as a live `Hash`: `Hash#digest()` finalises the object,
   * so a second `result()` on a truncated capture used to throw `Digest already called`
   * from `node:crypto` — a crash in a logging path that only reads a capture twice.
   * `write()` invalidates it, which is what the previous comment claimed and did not do.
   */
  private digest: string | undefined;

  constructor(capBytes: number, scope: string) {
    if (!Number.isInteger(capBytes) || capBytes <= 0) {
      throw new RangeError(`output cap must be a positive integer, received ${String(capBytes)}`);
    }

    this.capBytes = capBytes;
    this.scope = scope;
  }

  /** Bytes kept so far. */
  get capturedBytes(): number {
    return this.captured;
  }

  /** Bytes seen so far, whether kept or dropped. */
  get originalBytes(): number {
    return this.observed;
  }

  get truncated(): boolean {
    return this.observed > this.captured;
  }

  /** Returns true when the chunk (or part of it) was kept. */
  write(chunk: Buffer | string): boolean {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;

    this.observed += buffer.byteLength;
    // A digest taken before this write describes fewer bytes than the capture now holds.
    this.digest = undefined;

    const remaining = this.capBytes - this.captured;
    if (remaining <= 0) return false;

    const kept = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);

    this.chunks.push(kept);
    this.captured += kept.byteLength;

    return true;
  }

  /** The captured bytes, without a marker. Used when hashing or copying. */
  buffer(): Buffer {
    return Buffer.concat(this.chunks, this.captured);
  }

  /** Memoised digest of exactly the bytes retained so far. */
  private digestOfCaptured(): string {
    this.digest ??= createHash('sha256').update(this.buffer()).digest('hex');

    return this.digest;
  }

  marker(): TruncationMarker | null {
    if (!this.truncated) return null;

    return {
      scope: this.scope,
      capBytes: this.capBytes,
      capturedBytes: this.captured,
      originalBytes: this.observed,
      droppedBytes: this.observed - this.captured,
      sha256: this.digestOfCaptured(),
    };
  }

  result(): CaptureResult {
    const marker = this.marker();
    const body = this.buffer().toString('utf8');

    return {
      text: marker === null ? body : body + formatTruncationMarker(marker),
      capturedBytes: this.captured,
      originalBytes: this.observed,
      droppedBytes: this.observed - this.captured,
      truncated: marker !== null,
      marker,
    };
  }
}

/**
 * Drain a stream through a ceiling.
 *
 * The listener is attached with `.on('data')`, which puts the stream in flowing mode and
 * **never** pauses it: that is the difference between "we stopped storing" and "we
 * stopped reading". A paused stream applies backpressure to the child, the child blocks
 * on `write()`, and a run that should have been truncated instead hangs until its
 * deadline — a timeout wearing a cap's clothes.
 *
 * `maxBytes` is a second, larger ceiling: past it the stream is destroyed, so a producer
 * emitting terabytes into a void still cannot run forever. It defaults to 64× the cap.
 */
export function captureStream(
  stream: Readable,
  options: { readonly capBytes: number; readonly scope: string; readonly maxBytes?: number },
): Promise<CaptureResult> {
  const capture = new BoundedCapture(options.capBytes, options.scope);
  const maxBytes = options.maxBytes ?? options.capBytes * 64;

  return new Promise<CaptureResult>((resolvePromise, reject) => {
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolvePromise(capture.result());
    };

    stream.on('data', (chunk: Buffer | string) => {
      capture.write(chunk);

      if (capture.originalBytes > maxBytes && !stream.destroyed) {
        // Stop reading, but keep what was captured. The caller sees a truncated result
        // rather than an error: the ceiling did its job.
        stream.destroy();
      }
    });

    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** The in-memory case: a string an adapter handed us, which may be enormous. */
export function enforceTextCap(text: string, capBytes: number, scope: string): CaptureResult {
  const capture = new BoundedCapture(capBytes, scope);
  capture.write(text);

  return capture.result();
}

export interface ArtifactBudgetResult {
  readonly capBytes: number;
  readonly usedBytes: number;
  readonly files: number;
  readonly truncatedFiles: readonly string[];
  readonly exhausted: boolean;
}

/**
 * One ceiling shared by several files.
 *
 * The profile says `outputCapBytes` is the **sum** of bytes an attempt may leave behind,
 * so per-file caps alone would multiply it by the number of artifacts. Each allocation
 * is `min(requested, remaining)`, and a zero allocation means the artifact is not written
 * at all — recorded in `truncatedFiles` rather than silently omitted.
 */
export interface ArtifactBudget {
  readonly capBytes: number;
  readonly usedBytes: number;
  readonly remainingBytes: number;
  /** How many bytes this artifact may use. Zero means "do not write it". */
  allocate(requestedBytes: number): number;
  commit(bytes: number): void;
  result(): ArtifactBudgetResult;
}

export function withArtifactBudget(capBytes: number): ArtifactBudget {
  let used = 0;
  let files = 0;
  const truncatedFiles: string[] = [];

  return {
    capBytes,
    get usedBytes() {
      return used;
    },
    get remainingBytes() {
      return Math.max(0, capBytes - used);
    },
    allocate(requestedBytes: number): number {
      files += 1;

      return Math.max(0, Math.min(requestedBytes, capBytes - used));
    },
    commit(bytes: number): void {
      used += bytes;
    },
    result(): ArtifactBudgetResult {
      return {
        capBytes,
        usedBytes: used,
        files,
        truncatedFiles,
        exhausted: used >= capBytes,
      };
    },
  };
}

export interface BoundedCopyResult {
  readonly capturedBytes: number;
  readonly originalBytes: number;
  readonly truncated: boolean;
  readonly droppedBytes: number;
  /** Digest of the bytes actually written — never of the bytes that were dropped. */
  readonly sha256: string;
  readonly marker: TruncationMarker | null;
  /** Sidecar carrying the marker when the destination cannot hold inline metadata. */
  readonly markerPath: string | null;
}

/**
 * Copy a file through a ceiling.
 *
 * Used for artifact extraction: a 2 GiB `diff.patch` an adapter claims to have produced
 * is not evidence, it is a denial of service against the artifact store. The source is
 * streamed, the destination stops growing at the cap, and the dropped bytes are counted
 * and recorded rather than assumed.
 *
 * `inlineMarker` appends the marker to the destination. Turn it off for binary media,
 * where an appended NUL-delimited JSON line would corrupt the file — the sidecar
 * (`<destination>.truncation.json`) carries it instead, and both are reported.
 */
export async function boundedCopyFile(input: {
  readonly source: string;
  readonly destination: string;
  readonly capBytes: number;
  readonly scope: string;
  readonly inlineMarker?: boolean;
  readonly highWaterMark?: number;
}): Promise<BoundedCopyResult> {
  const info = await stat(input.source);
  const originalBytes = info.size;
  const cap = Math.max(0, Math.min(input.capBytes, originalBytes));
  const truncated = originalBytes > Math.max(0, input.capBytes);

  const hash = createHash('sha256');
  const reader = createReadStream(input.source, {
    highWaterMark: input.highWaterMark ?? 64 * 1024,
  });
  const writer = createWriteStream(input.destination, { mode: 0o600 });

  let written = 0;

  await new Promise<void>((resolvePromise, reject) => {
    let failed = false;

    reader.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const remaining = cap - written;
      if (remaining <= 0) return;

      const keep = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);

      hash.update(keep);
      written += keep.byteLength;

      if (!writer.write(keep)) reader.pause();
    });

    writer.on('drain', () => reader.resume());

    reader.once('error', (error) => {
      failed = true;
      reader.destroy();
      writer.destroy(error);
      reject(error);
    });

    writer.once('error', (error) => {
      failed = true;
      reader.destroy();
      reject(error);
    });

    reader.once('end', () => {
      if (!failed) writer.end();
    });

    writer.once('finish', () => resolvePromise());
  });

  const sha256 = hash.digest('hex');

  // Built explicitly rather than from a `BoundedCapture`: with a zero-byte allowance
  // nothing is ever written, so a capture's own counters would not know a truncation
  // happened. The file size is the authority and it is always available.
  const marker: TruncationMarker | null = truncated
    ? {
        scope: input.scope,
        capBytes: input.capBytes,
        capturedBytes: written,
        originalBytes,
        droppedBytes: Math.max(0, originalBytes - written),
        sha256,
      }
    : null;

  const markerPath = marker === null ? null : `${input.destination}.truncation.json`;

  if (marker !== null && markerPath !== null) {
    await appendFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });

    if (input.inlineMarker === true) {
      await appendFile(input.destination, formatTruncationMarker(marker), { mode: 0o600 });
    }
  }

  return {
    capturedBytes: written,
    originalBytes,
    truncated,
    droppedBytes: Math.max(0, originalBytes - written),
    sha256,
    marker,
    markerPath,
  };
}

/** Remove a sidecar a previous, successful copy left behind. */
export async function removeTruncationSidecar(destination: string): Promise<void> {
  await unlink(`${destination}.truncation.json`).catch(() => undefined);
}
