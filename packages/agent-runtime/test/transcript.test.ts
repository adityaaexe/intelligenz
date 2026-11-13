import { describe, expect, it } from 'vitest';

import { TranscriptBuffer } from '../src/runtimes/opencode-cli';

/**
 * `transcript.ndjson` is the highest-risk artifact the platform stores: it is what the
 * agent read, printed and was told, and until this change it was written verbatim.
 *
 * These tests pin the two properties the persistence path depends on:
 *
 *   1. **Redaction happens at collection**, before the bytes exist in a string the
 *      writer can use. There is no second, unredacted copy.
 *   2. **The buffer is bounded.** A run that prints without end cannot make the worker
 *      allocate without end; the 5 MiB ceiling is a real cut with an explicit marker.
 */

const MAX = 5 * 1024 * 1024;

describe('TranscriptBuffer', () => {
  it('redacts every line before it is retained', () => {
    const buffer = new TranscriptBuffer();

    buffer.push(
      Buffer.from(
        [
          '{"type":"tool","part":{"output":"Authorization: Bearer abcdef0123456789"}}',
          '{"type":"text","part":{"text":"OPENAI_API_KEY=sk-live-abcdef1234567890"}}',
        ].join('\n') + '\n',
        'utf8',
      ),
    );

    const transcript = buffer.finish();

    expect(transcript).not.toContain('abcdef0123456789');
    expect(transcript).not.toContain('sk-live-abcdef1234567890');
    expect(transcript).toContain('[redacted');
    // Still valid NDJSON, which the parser downstream relies on.
    for (const line of transcript.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('redacts a line that arrives split across chunks', () => {
    const buffer = new TranscriptBuffer();
    const line = '{"type":"text","part":{"text":"token ghp_abcdefghijklmnopqrstuvwxyz"}}\n';

    // Split mid-token, which is how a real pipe delivers it.
    buffer.push(Buffer.from(line.slice(0, 44), 'utf8'));
    buffer.push(Buffer.from(line.slice(44), 'utf8'));

    expect(buffer.finish()).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
  });

  it('caps the transcript at 5 MiB and appends an explicit truncated line', () => {
    const buffer = new TranscriptBuffer();
    const line = `${'x'.repeat(1023)}\n`;

    // 6 MiB of input: the cap must bite well before the end.
    for (let index = 0; index < 6 * 1024; index += 1) buffer.push(Buffer.from(line, 'utf8'));

    const transcript = buffer.finish();
    const bytes = Buffer.byteLength(transcript, 'utf8');

    expect(bytes).toBeLessThanOrEqual(MAX);
    expect(bytes).toBeGreaterThan(MAX - 4096);

    const lines = transcript.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { type?: string };

    expect(last.type).toBe('truncated');
  });

  it('stops growing after truncation instead of buffering the tail', () => {
    const buffer = new TranscriptBuffer();
    const line = `${'y'.repeat(1023)}\n`;

    for (let index = 0; index < 6 * 1024; index += 1) buffer.push(Buffer.from(line, 'utf8'));

    const first = buffer.finish();
    buffer.push(Buffer.from(line.repeat(1000), 'utf8'));

    expect(Buffer.byteLength(buffer.finish(), 'utf8')).toBe(Buffer.byteLength(first, 'utf8'));
  });

  it('describes an unterminated line instead of holding it forever', () => {
    const buffer = new TranscriptBuffer();

    buffer.push(Buffer.from('z'.repeat(MAX + 1024), 'utf8'));

    const transcript = buffer.finish();

    expect(Buffer.byteLength(transcript, 'utf8')).toBeLessThanOrEqual(MAX);
    expect(transcript).toContain('"type":"truncated"');
  });
});
