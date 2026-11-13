import { describe, expect, it } from 'vitest';

import { redact } from '../src/redact';

/**
 * One case per credential shape the transcript sink has to survive.
 *
 * These are deliberately written as "the secret bytes are gone", not "the marker is
 * present": a redaction that replaces the wrong half of a line and leaves the token
 * would still satisfy a naive marker check.
 */

interface Case {
  readonly name: string;
  readonly input: string;
  /** Substrings that must not survive. */
  readonly leaks: readonly string[];
}

const CASES: readonly Case[] = [
  {
    name: 'Authorization: Bearer header',
    input: 'headers: { Authorization: Bearer abcdef0123456789.xyz }',
    leaks: ['abcdef0123456789.xyz'],
  },
  {
    name: 'lower-case authorization header without a scheme',
    input: 'authorization: tok_live_9911223344',
    leaks: ['tok_live_9911223344'],
  },
  {
    name: 'bare JWT with three segments',
    input:
      'session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    leaks: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'],
  },
  {
    name: 'sk- provider key',
    input: 'OPENAI_API_KEY=sk-live-abcdef1234567890',
    leaks: ['sk-live-abcdef1234567890'],
  },
  {
    name: 'GitHub personal access token',
    input: 'remote https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r',
    leaks: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  },
  {
    name: 'GitHub fine-grained token',
    input: 'token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    leaks: ['github_pat_11ABCDEFG0123456789'],
  },
  {
    name: 'AWS access key id',
    input: 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
    leaks: ['AKIAIOSFODNN7EXAMPLE'],
  },
  {
    name: '32+ hex run',
    input: 'digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    leaks: ['9f86d081884c7d659a2feaa0c55ad015'],
  },
  {
    name: 'KEY=value pair',
    input: 'DATABASE_PASSWORD=hunter2',
    leaks: ['hunter2'],
  },
  {
    name: 'lower-case key: value pair',
    input: 'client_secret: s3cr3t-value',
    leaks: ['s3cr3t-value'],
  },
  {
    name: 'URL with user:pass@',
    input: 'postgresql://intelligenz:sup3rs3cret@localhost:5432/intelligenz',
    leaks: ['sup3rs3cret'],
  },
  {
    name: 'base64 of an env assignment',
    // btoa('OPENAI_API_KEY=sk-live-abcdef1234567890')
    input: `payload ${Buffer.from('OPENAI_API_KEY=sk-live-abcdef1234567890', 'utf8').toString('base64')}`,
    leaks: ['T1BFTkFJX0FQSV9LRVk9c2stbGl2ZS1hYmNkZWYxMjM0NTY3ODkw'],
  },
  {
    name: 'base64 of a bearer token with a scheme',
    input: `header ${Buffer.from('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz', 'utf8').toString('base64')}`,
    leaks: ['QXV0aG9yaXphdGlvbjogQmVhcmVy'],
  },
];

describe('redact', () => {
  for (const testCase of CASES) {
    it(`removes a ${testCase.name}`, () => {
      const output = redact(testCase.input);

      for (const leak of testCase.leaks) {
        expect(output).not.toContain(leak);
      }

      expect(output).toContain('[redacted');
    });
  }

  it('leaves ordinary prose and diffs alone', () => {
    const ordinary = [
      'read src/sum.js',
      'diff --git a/src/sum.js b/src/sum.js',
      '+  return a + b;',
      'node --test: 3 passed',
      'https://github.com/intelligenz/intelligenz/pull/42',
    ];

    for (const line of ordinary) {
      expect(redact(line)).toBe(line);
    }
  });

  it('is idempotent', () => {
    const once = redact('Authorization: Bearer abcdef0123456789.xyz and sk-live-abcdef1234567890');
    expect(redact(once)).toBe(once);
  });
});
