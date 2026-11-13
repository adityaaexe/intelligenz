import { describe, expect, it } from 'vitest';

import { describeJwtSecretProblem, loadConfig } from '../src/config/app-config';

/**
 * The signing key is the whole authentication model.
 *
 * These tests exist because a `length >= 32` check is not a secret check: the
 * placeholder this repository published in `.env.example` was 35 characters and
 * was used to sign a token that the live API accepted as `OWNER`.
 */

const DATABASE_URL = 'postgresql://intelligenz:intelligenz@localhost:5432/intelligenz_test';

/** `openssl rand -hex 32` — 32 random bytes, only ever two character classes. */
const GENERATED_HEX = 'a3f1c9d47b2e80615af3c7d92b0e6481f5a9c3d7e2b4061893acd5f72e6b8140';

/** 34 characters, three classes, no placeholder substring. */
const MIXED = 'Kq7-tR2#vLm9!pXz4w8@nB3yS6-cQ1eF';

function configWith(secret: string): () => unknown {
  return () =>
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL,
      JWT_SECRET: secret,
    });
}

describe('loadConfig — JWT_SECRET', () => {
  it('rejects the placeholder that shipped in .env.example, even though it is 35 characters', () => {
    const placeholder = 'replace-me-with-openssl-rand-hex-32';

    expect(placeholder.length).toBeGreaterThanOrEqual(32);
    expect(configWith(placeholder)).toThrow(/placeholder/i);
  });

  it('rejects the .env.example value a fresh clone would copy verbatim', () => {
    // Kept in sync with .env.example by assertion, not by memory: if someone
    // "helpfully" makes the template boot, this fails.
    expect(configWith('REPLACE_ME')).toThrow(/placeholder/i);
  });

  it.each(['changeme', 'change-me', 'secret', 'test', 'development', 'your-secret-here'])(
    'rejects the published weak value %s',
    (weak) => {
      // Padded past 32 characters: the point is that length alone must not pass.
      expect(configWith(`${weak}-${weak}-${weak}-${weak}`)).toThrow(/placeholder|entropy/i);
      expect(configWith(weak)).toThrow(/JWT_SECRET/);
    },
  );

  it('rejects a single repeated character regardless of length', () => {
    expect(configWith('a'.repeat(64))).toThrow(/single repeated character/i);
  });

  it('rejects a value without enough character classes', () => {
    // 32 lower-case letters: long enough, but a dictionary, not a key.
    expect(configWith('abcdefghijklmnopqrstuvwxyzabcdef')).toThrow(/entropy/i);
  });

  it('rejects a hex key shorter than 64 characters', () => {
    expect(configWith(GENERATED_HEX.slice(0, 48))).toThrow(/entropy/i);
  });

  it('accepts a generated 64-character hex key', () => {
    expect(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL, JWT_SECRET: GENERATED_HEX }).jwtSecret,
    ).toBe(GENERATED_HEX);
  });

  it('accepts a mixed 3-class key of at least 32 characters', () => {
    expect(loadConfig({ NODE_ENV: 'test', DATABASE_URL, JWT_SECRET: MIXED }).jwtSecret).toBe(MIXED);
  });

  it('reports a missing secret as a boot failure, not a default', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL })).toThrow(/is not set/i);
  });

  it('returns a reason string for a value, so callers can log without the secret', () => {
    expect(describeJwtSecretProblem(GENERATED_HEX)).toBeUndefined();
    expect(describeJwtSecretProblem('changeme')).toMatch(/placeholder/i);
  });
});
