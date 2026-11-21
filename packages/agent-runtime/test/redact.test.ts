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
    name: 'OpenAI-style sk- key',
    input: 'OPENAI_API_KEY=sk-proj-abcdef1234567890',
    leaks: ['sk-proj-abcdef1234567890'],
  },
  {
    // The fixture used to be `sk-live-…`, which the hyphen rule matched — so the test
    // and the regex agreed on a shape neither provider uses (audit F3). The real token
    // is `sk_live_`, and it is written bare here so the generic `KEY=value` rule cannot
    // be what makes this pass.
    name: 'Stripe-style sk_live_ secret',
    input: 'the credential printed by the tool was sk_live_' + 'sample0000000000000000000',
    leaks: ['sk_live_' + 'sample0000000000000000000'],
  },
  {
    name: 'Stripe-style sk_test_ secret',
    input: 'sk_test_' + 'sample0000000000000000000',
    leaks: ['sk_test_' + 'sample0000000000000000000'],
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
    // Bare: no `KEY=` name in front, no URL userinfo for the generic URL rule to catch.
    // Only the `glpat-` family can remove this one.
    name: 'GitLab personal access token',
    input: 'clone with glpat-00EXAMPLE000000000000000 then push',
    leaks: ['glpat-00EXAMPLE000000000000000'],
  },
  {
    name: 'AWS access key id',
    input: 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
    leaks: ['AKIAIOSFODNN7EXAMPLE'],
  },
  {
    // A hyphenated name: the generic `KEY|SECRET` rule could not cross the `-`, so the
    // 40-character value survived even though its name says exactly what it is.
    name: 'AWS secret access key under a hyphenated name',
    input: 'aws-secret-access-key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    leaks: ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  },
  {
    name: 'AWS secret access key in a JSON dump',
    input: '"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    leaks: ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
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
    // btoa('OPENAI_API_KEY=' + 'sk_live_' + 'sample0000000000000')
    input: `payload ${Buffer.from('OPENAI_API_KEY=' + 'sk_live_' + 'sample0000000000000', 'utf8').toString('base64')}`,
    leaks: ['T1BFTkFJX0FQSV9LRVk9c2tfbGl2ZV9zYW1wbGUwMDAwMDAwMDAwMDAw'],
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
    const once = redact('Authorization: Bearer abcdef0123456789.xyz and sk_live_' + 'sample0000000000000');
    expect(redact(once)).toBe(once);
  });

  /**
   * False-positive guards. A denylist that eats ordinary text is a denylist developers
   * route around, and a transcript with holes in it is not evidence.
   */
  it('leaves ordinary prose that merely contains "sk" alone', () => {
    const ordinary = [
      'the agent will skip the second step and ask for help',
      'task: rebuild the risk report before Friday',
      'desk: standing, chair: ergonomic',
      'the risk assessment is attached',
    ];

    for (const line of ordinary) {
      expect(redact(line)).toBe(line);
    }
  });

  it('leaves a short glpat- prefix alone, because a prefix is not a token', () => {
    expect(redact('the env var is named glpat- for short')).toBe(
      'the env var is named glpat- for short',
    );
  });

  it('leaves a git diff that mentions a token-named file alone', () => {
    // The generic rule deliberately excludes `.` from the name class so a file path in a
    // diff header is not mistaken for an assignment.
    const line = 'diff --git a/src/auth-token.js b/src/auth-token.js';
    expect(redact(line)).toBe(line);
  });
});
