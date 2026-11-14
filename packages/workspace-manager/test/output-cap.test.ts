import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  BoundedCapture,
  TRUNCATION_MARKER_PREFIX,
  captureStream,
  enforceTextCap,
  formatTruncationMarker,
  readTruncationMarker,
  type TruncationMarker,
} from '../src';

/**
 * Gate E — `outputCapBytes`, enforced instead of declared.
 *
 * The property under test is not "a long string is shortened". It is that the **ceiling
 * is what bounds the memory**, that a truncation is *recorded* rather than silent, and
 * that the record survives a round trip. A cap that grows with its input, or a marker a
 * reader cannot parse, would satisfy "the field is shorter" while failing the point.
 */

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

describe('output cap — a text ten times the cap', () => {
  const cap = 1_024;

  it('keeps exactly the cap and appends a marker that states the original size', () => {
    const body = 'a'.repeat(cap * 10);
    const result = enforceTextCap(body, cap, 'result.summary');

    expect(result.truncated).toBe(true);
    expect(result.capturedBytes).toBe(cap);
    expect(result.originalBytes).toBe(cap * 10);
    expect(result.droppedBytes).toBe(cap * 9);
    // The text is the kept prefix plus the marker, not "cap bytes of text".
    expect(result.text.startsWith(body.slice(0, cap))).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeGreaterThan(cap);

    const marker = readTruncationMarker(result.text);

    expect(marker).not.toBeNull();
    if (marker === null) throw new Error('a truncated capture must carry a readable marker');

    expect(marker.scope).toBe('result.summary');
    expect(marker.capBytes).toBe(cap);
    expect(marker.capturedBytes).toBe(cap);
    expect(marker.originalBytes).toBe(cap * 10);
    expect(marker.droppedBytes).toBe(cap * 9);
    // The digest is of the bytes kept, so a reader can still verify what it has.
    expect(marker.sha256).toBe(sha256(body.slice(0, cap)));

    // Exactly the cap plus the marker — not "about the cap", and not the marker displacing
    // captured bytes. The marker is machine-readable JSON, not a sentence.
    expect(result.text).toBe(`${body.slice(0, cap)}${formatTruncationMarker(marker)}`);
    expect(result.text).toContain(JSON.stringify(marker));
  });

  it('counts bytes, not code points, when the cap falls inside a multi-byte character', () => {
    // '€' is three UTF-8 bytes: a 10-byte cap keeps three whole ones and one partial.
    const text = '€'.repeat(100);
    const result = enforceTextCap(text, 10, 'event:data');

    expect(result.capturedBytes).toBe(10);
    expect(result.originalBytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(result.truncated).toBe(true);

    // The ceiling is a *byte* budget: it stops at ten bytes even though that splits a
    // character. Decoding the cut code point yields U+FFFD — the marker, not the text,
    // is what states how many bytes were really kept.
    expect(result.text.startsWith('€€€')).toBe(true);
    expect(result.text.charAt(3)).toBe('\uFFFD');
    expect(readTruncationMarker(result.text)?.capturedBytes).toBe(10);
    expect(readTruncationMarker(result.text)?.originalBytes).toBe(300);
  });

  it('does not truncate at exactly the cap and truncates one byte past it', () => {
    const atCap = enforceTextCap('b'.repeat(cap), cap, 's');
    expect(atCap.truncated).toBe(false);
    expect(atCap.marker).toBeNull();
    expect(atCap.text).toBe('b'.repeat(cap));

    const overCap = enforceTextCap('b'.repeat(cap + 1), cap, 's');
    expect(overCap.truncated).toBe(true);
    expect(overCap.droppedBytes).toBe(1);
    expect(readTruncationMarker(overCap.text)?.originalBytes).toBe(cap + 1);
  });

  it('bounds a chunked capture at the cap while it absorbs ten times the cap', () => {
    const capture = new BoundedCapture(cap, 'stdout');
    let largestRetained = 0;

    // 200 writes of 1 KiB against a 1 KiB cap: the retained buffer must stop at the cap
    // and never grow again, which is the property that keeps a flooding producer cheap.
    for (let index = 0; index < 200; index += 1) {
      capture.write(Buffer.alloc(1_024, index % 250));
      largestRetained = Math.max(largestRetained, capture.buffer().length);
    }

    expect(largestRetained).toBe(cap);
    expect(capture.capturedBytes).toBe(cap);
    expect(capture.originalBytes).toBe(200 * 1_024);
    expect(capture.truncated).toBe(true);
    expect(capture.result().text).toContain('\u0000IZ_TRUNCATED:');
  });

  it('rejects a cap that is not a positive integer instead of silently treating it as zero', () => {
    expect(() => new BoundedCapture(0, 's')).toThrow(RangeError);
    expect(() => new BoundedCapture(-1, 's')).toThrow(RangeError);
    expect(() => new BoundedCapture(1.5, 's')).toThrow(RangeError);
    expect(() => enforceTextCap('x', 0, 's')).toThrow(RangeError);
  });
});

describe('output cap — streamed capture', () => {
  /** A stream that hands out the same Buffer repeatedly: the test allocates no chunks. */
  class RepeatingStream extends Readable {
    pauseCalls = 0;
    private produced = 0;

    constructor(
      private readonly chunk: Buffer,
      private readonly total: number,
    ) {
      super();
    }

    override pause(): this {
      this.pauseCalls += 1;

      return super.pause();
    }

    override _read(): void {
      if (this.produced === this.total) {
        this.push(null);

        return;
      }

      this.produced += 1;
      this.push(this.chunk);
    }
  }

  it('retains the cap while 256 MiB flows through a 1 MiB ceiling', async () => {
    const cap = 1_024 * 1_024;
    const chunk = Buffer.alloc(cap, 0x61);
    const totalChunks = 256;
    const stream = new RepeatingStream(chunk, totalChunks);

    const before = process.memoryUsage().rss;
    // `maxBytes` is the second ceiling; it defaults to 64× the cap, which would stop this
    // stream at 64 MiB. Raised here so the memory property is measured against 256 MiB.
    const result = await captureStream(stream, {
      capBytes: cap,
      scope: 'stdout',
      maxBytes: 512 * 1_024 * 1_024,
    });
    const grewBy = process.memoryUsage().rss - before;

    expect(result.capturedBytes).toBe(cap);
    expect(result.originalBytes).toBe(totalChunks * cap);
    expect(result.droppedBytes).toBe(totalChunks * cap - cap);
    expect(readTruncationMarker(result.text)?.originalBytes).toBe(totalChunks * cap);

    // The stream is never paused: a paused stream would backpressure the producer and
    // turn a truncation into a timeout. This is the difference between "stopped storing"
    // and "stopped reading", and it is asserted rather than described.
    expect(stream.pauseCalls).toBe(0);

    // 256 MiB were seen and 1 MiB was kept. RSS growth bounded well below the input is
    // the substance of "memory does not grow with input"; the headroom covers Buffer
    // pool and GC slack, not retention of the stream.
    expect(grewBy).toBeLessThan(64 * 1_024 * 1_024);
  });

  it('stops a producer past maxBytes and still returns the captured prefix', async () => {
    // A second, larger ceiling: past it the stream is destroyed so a producer emitting
    // terabytes into a void cannot run forever. The result is still a truncation, not an
    // error, and it does not hang waiting for an `end` that will never come.
    const stream = new RepeatingStream(Buffer.alloc(64 * 1_024, 0x62), 10_000);
    const result = await captureStream(stream, {
      capBytes: 1_024,
      maxBytes: 256 * 1_024,
      scope: 'stdout',
    });

    expect(result.truncated).toBe(true);
    expect(result.capturedBytes).toBe(1_024);
    expect(result.originalBytes).toBeLessThan(10_000 * 64 * 1_024);
    expect(result.originalBytes).toBeGreaterThan(256 * 1_024);
  });

  it('propagates a stream error rather than reporting a truncated success', async () => {
    const stream = new Readable({
      read(): void {
        this.destroy(new Error('producer died'));
      },
    });

    await expect(captureStream(stream, { capBytes: 16, scope: 'stderr' })).rejects.toThrow(
      'producer died',
    );
  });
});

describe('output cap — the truncation marker', () => {
  const marker: TruncationMarker = {
    scope: 'artifact:diff',
    capBytes: 5 * 1_024 * 1_024,
    capturedBytes: 5 * 1_024 * 1_024,
    originalBytes: 2_147_483_648,
    droppedBytes: 2_147_483_648 - 5 * 1_024 * 1_024,
    sha256: 'a'.repeat(64),
  };

  it('round-trips through formatTruncationMarker and readTruncationMarker', () => {
    expect(readTruncationMarker(formatTruncationMarker(marker))).toEqual(marker);

    // Embedded in real content, with the marker on its own line.
    const embedded = `some captured stdout\n${formatTruncationMarker(marker)}`;
    expect(readTruncationMarker(embedded)).toEqual(marker);
  });

  it('returns null for content that carries no marker or an unreadable one', () => {
    expect(readTruncationMarker('ordinary output')).toBeNull();
    expect(readTruncationMarker('')).toBeNull();
    // Prefix without a terminator: a marker cut in half is not a marker.
    expect(readTruncationMarker('\u0000IZ_TRUNCATED:{"scope":"s"')).toBeNull();
    // JSON that is not a marker.
    expect(readTruncationMarker('\u0000IZ_TRUNCATED:{"hello":"world"}\u0000')).toBeNull();
    expect(readTruncationMarker('\u0000IZ_TRUNCATED:not-json\u0000')).toBeNull();
  });

  it('reads the same capture twice, and the digest is of the retained prefix', () => {
    // Regression: the digest used to be a live `Hash`, so a second `result()` threw
    // `Digest already called` from node:crypto. Reading a capture twice is not exotic —
    // a log line and a persistence step both read it.
    const capture = new BoundedCapture(8, 's');
    capture.write('0123456789');

    const first = capture.result();
    const second = capture.result();

    expect(second).toEqual(first);
    expect(second.marker).toEqual(first.marker);

    // The digest describes the eight bytes kept, never the ten observed.
    expect(first.marker?.sha256).toBe(sha256('01234567'));
    expect(first.marker?.originalBytes).toBe(10);
    expect(first.marker?.droppedBytes).toBe(2);
  });

  it('a capture that was never truncated has no marker and reports truncated=false', () => {
    const capture = new BoundedCapture(1_024, 's');
    capture.write('short');

    const result = capture.result();

    expect(result.truncated).toBe(false);
    expect(result.marker).toBeNull();
    expect(result.text).toBe('short');
    expect(result.capturedBytes).toBe(5);
    expect(result.originalBytes).toBe(5);
    expect(result.droppedBytes).toBe(0);
  });
});

/**
 * The boundary matrix.
 *
 * A cap is a byte ceiling, so the interesting cases are the ones where "characters",
 * "chunks" and "bytes" disagree: a chunk boundary inside a UTF-8 sequence, a marker that
 * is larger than the space left for it, and calls that arrive after the ceiling is
 * reached. The invariant asserted in every case is the same and is measured, not
 * described: `capturedBytes <= capBytes`, and the bytes retained are exactly what the
 * marker says they are.
 */

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe('output cap — empty input and empty chunks', () => {
  it('captures an empty body as empty, with no marker and no truncation', () => {
    const result = enforceTextCap('', 8, 'empty');

    expect(result.text).toBe('');
    expect(result.capturedBytes).toBe(0);
    expect(result.originalBytes).toBe(0);
    expect(result.droppedBytes).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.marker).toBeNull();
    expect(readTruncationMarker(result.text)).toBeNull();
  });

  it('treats zero-length writes as no-ops between real chunks', () => {
    const capture = new BoundedCapture(6, 'chunks');

    capture.write(Buffer.alloc(0));
    capture.write('');
    capture.write('abc');
    capture.write(Buffer.alloc(0));
    capture.write(Buffer.from('def', 'utf8'));

    const result = capture.result();

    expect(capture.buffer().length).toBe(6);
    expect(result.text).toBe('abcdef');
    expect(result.truncated).toBe(false);
    // Empty chunks are observed as zero bytes, not as a truncation event.
    expect(result.originalBytes).toBe(6);
  });
});

describe('output cap — multi-byte sequences across chunk boundaries', () => {
  it('joins a UTF-8 character split across two writes before decoding it', () => {
    const euro = Buffer.from('€', 'utf8'); // e2 82 ac

    expect(euro.byteLength).toBe(3);

    const capture = new BoundedCapture(3, 'chunked');

    // The producer's chunk boundary falls after the first byte of a three-byte character.
    // Decoding each chunk as it arrives would emit U+FFFD twice; accumulating bytes and
    // decoding once at the end is what makes this a valid character.
    capture.write(euro.subarray(0, 1));
    capture.write(euro.subarray(1, 3));

    const result = capture.result();

    expect(capture.buffer()).toEqual(euro);
    expect(result.text).toBe('€');
    expect(result.text).not.toContain('\uFFFD');
    expect(result.truncated).toBe(false);
  });

  it('does the same for a stream whose chunks split the character', async () => {
    const euro = Buffer.from('€', 'utf8');
    const stream = Readable.from([euro.subarray(0, 1), euro.subarray(1, 2), euro.subarray(2, 3)]);

    const result = await captureStream(stream, { capBytes: 3, scope: 'stdout' });

    expect(result.text).toBe('€');
    expect(result.capturedBytes).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('keeps emoji and combining sequences whole when the cap lands on a code point boundary', () => {
    const rocket = '🚀'; // four UTF-8 bytes
    const combining = 'e\u0301'; // three UTF-8 bytes: the base letter plus U+0301
    const rockets = enforceTextCap(rocket.repeat(100), 8, 'emoji');
    const marks = enforceTextCap(combining.repeat(100), 6, 'combining');

    // Eight bytes is exactly two rockets: no half a code point in the retained prefix.
    expect(rockets.capturedBytes).toBe(8);
    expect(rockets.text.startsWith(rocket.repeat(2))).toBe(true);
    expect(rockets.text.slice(0, rocket.repeat(2).length)).toBe(rocket.repeat(2));
    expect(readTruncationMarker(rockets.text)?.originalBytes).toBe(400);
    expect(readTruncationMarker(rockets.text)?.capturedBytes).toBe(8);

    // A combining mark is attached to its base character, and a six-byte cap keeps two
    // whole sequences: the mark is not separated from the letter it modifies.
    expect(marks.capturedBytes).toBe(6);
    expect(marks.text.startsWith(combining.repeat(2))).toBe(true);
    expect(readTruncationMarker(marks.text)?.capturedBytes).toBe(6);
  });

  it('preserves newlines and puts the marker on its own line', () => {
    const body = 'alpha\nbeta\ngamma\n';
    const result = enforceTextCap(body, 8, 'multiline');

    expect(result.capturedBytes).toBe(8);
    expect(result.text.startsWith('alpha\nbe')).toBe(true);
    // The marker is preceded by a newline, so a reader that splits lines never sees a
    // half-marker glued to the last line of content.
    expect(result.text.slice(8).startsWith(`\n${TRUNCATION_MARKER_PREFIX}`)).toBe(true);
    expect(readTruncationMarker(result.text)?.originalBytes).toBe(body.length);
    // Content newlines are not rewritten by the truncation.
    expect(result.text.slice(0, 8).split('\n').length).toBe(2);
  });
});

describe('output cap — the boundary itself', () => {
  it('does not truncate a chunked body that ends exactly at the cap, and does one byte past it', () => {
    const atCap = new BoundedCapture(12, 'boundary');

    atCap.write('abcd');
    atCap.write('efgh');
    atCap.write('ijkl');

    const exact = atCap.result();

    expect(exact.truncated).toBe(false);
    expect(exact.text).toBe('abcdefghijkl');
    expect(exact.capturedBytes).toBe(12);
    expect(exact.originalBytes).toBe(12);
    expect(exact.marker).toBeNull();

    // One more byte, arriving after the ceiling was reached: recorded as a drop, and the
    // retained prefix is untouched.
    expect(atCap.write('m')).toBe(false);
    expect(atCap.capturedBytes).toBe(12);

    const over = atCap.result();

    expect(over.truncated).toBe(true);
    expect(over.text.startsWith('abcdefghijkl')).toBe(true);
    expect(over.droppedBytes).toBe(1);
    expect(over.text.length).toBeGreaterThan(12);
    expect(readTruncationMarker(over.text)?.capturedBytes).toBe(12);
    expect(readTruncationMarker(over.text)?.originalBytes).toBe(13);
  });

  it('appends the marker even when the marker is longer than the remaining capacity', () => {
    // A one-byte cap cannot contain its own marker. The marker is metadata about the
    // payload, not payload, so it is appended outside the ceiling rather than displacing
    // the single captured byte or being silently dropped.
    const result = enforceTextCap('abc', 1, 'tiny');

    expect(result.capturedBytes).toBe(1);
    expect(result.text.startsWith('a')).toBe(true);
    expect(result.droppedBytes).toBe(2);
    // The cap bounds the retained payload; the marker is metadata appended outside it.
    expect(Buffer.byteLength(result.text, 'utf8')).toBeGreaterThan(1);

    if (result.marker === null) throw new Error('a truncated capture must carry a marker');
    expect(formatTruncationMarker(result.marker).length).toBeGreaterThan(1);

    const marker = readTruncationMarker(result.text);

    expect(marker).not.toBeNull();
    expect(marker?.capBytes).toBe(1);
    expect(marker?.capturedBytes).toBe(1);
    expect(marker?.originalBytes).toBe(3);
    expect(marker?.sha256).toBe(sha256('a'));
  });

  it('does not append a second marker when the result is read repeatedly', () => {
    const capture = new BoundedCapture(4, 'repeat');

    capture.write('abcdefgh');

    const first = capture.result();
    const second = capture.result();
    const third = capture.result();

    expect(occurrences(first.text, TRUNCATION_MARKER_PREFIX)).toBe(1);
    expect(second.text).toBe(first.text);
    expect(third.text).toBe(first.text);
    expect(occurrences(third.text, TRUNCATION_MARKER_PREFIX)).toBe(1);
    expect(readTruncationMarker(third.text)).toEqual(first.marker);

    // Truncating a fresh capture of already-truncated text does not stack markers either:
    // the marker is content to the second cap, but it is still one marker in, one out.
    const again = enforceTextCap(first.text, 4, 'repeat-2');
    expect(occurrences(again.text, TRUNCATION_MARKER_PREFIX)).toBe(1);
  });
});

describe('output cap — nothing grows after the ceiling', () => {
  it('measures later writes without retaining or re-encoding them', () => {
    const capture = new BoundedCapture(5, 'flood');
    const retained: Buffer[] = [];

    capture.write('abcde');
    retained.push(capture.buffer());

    const acceptedAfterCap: boolean[] = [];

    for (let index = 0; index < 64; index += 1) {
      acceptedAfterCap.push(capture.write(Buffer.alloc(65_536, index)));
      // Captured bytes are the ceiling, not a function of how much was written.
      expect(capture.capturedBytes).toBe(5);
      expect(capture.buffer().length).toBe(5);
    }

    const result = capture.result();

    expect(acceptedAfterCap.every((accepted) => accepted === false)).toBe(true);
    expect(capture.buffer()).toEqual(retained[0]);
    expect(result.capturedBytes).toBe(5);
    expect(result.originalBytes).toBe(5 + 64 * 65_536);
    expect(result.droppedBytes).toBe(64 * 65_536);
    expect(readTruncationMarker(result.text)?.sha256).toBe(sha256('abcde'));
  });

  it('holds the invariant for mixed byte sizes, text and multi-byte content', () => {
    const capabilities = [1, 2, 3, 5, 8, 13, 64];
    const pieces = ['a', 'ab', '€', '€€', '🚀', '\n', 'e\u0301', ''];

    for (const cap of capabilities) {
      const capture = new BoundedCapture(cap, `matrix:${String(cap)}`);
      let expectedOriginal = 0;

      for (let index = 0; index < 40; index += 1) {
        const piece = pieces[index % pieces.length] ?? '';
        const asBuffer = index % 3 === 0;
        const value = asBuffer ? Buffer.from(piece, 'utf8') : piece;

        expectedOriginal += Buffer.byteLength(piece, 'utf8');
        capture.write(value);

        // The invariant, checked after every write rather than at the end.
        expect(capture.capturedBytes).toBeLessThanOrEqual(cap);
        expect(capture.buffer().length).toBe(capture.capturedBytes);
      }

      const result = capture.result();

      expect(result.capturedBytes).toBeLessThanOrEqual(cap);
      expect(result.originalBytes).toBe(expectedOriginal);
      expect(result.capturedBytes + result.droppedBytes).toBe(result.originalBytes);

      if (result.truncated) {
        const marker = readTruncationMarker(result.text);

        expect(marker).toEqual(result.marker);
        expect(marker?.capturedBytes).toBe(result.capturedBytes);
        expect(marker?.originalBytes).toBe(result.originalBytes);
        expect(marker?.sha256).toBe(sha256(capture.buffer()));
      } else {
        expect(result.marker).toBeNull();
        expect(result.originalBytes).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('rejects every cap that is not a positive integer, including NaN and Infinity', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      expect(() => new BoundedCapture(bad, 's'), `cap ${String(bad)} must be refused`).toThrow(
        RangeError,
      );
    }
  });
});
