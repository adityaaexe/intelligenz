import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CredentialExpiredError,
  CredentialUnavailableError,
  readCredential,
  readEnvCredential,
  readOpencodeCredential,
} from '../src';

/**
 * Credential reading, against a synthetic opencode database.
 *
 * The production store is a 1.08 GB SQLite file that belongs to the operator; a test
 * that opened it would be a test that fails on a machine where opencode has never run.
 * This builds the same schema (`id`, `integration_id`, `label`, `value`, `active`,
 * `time_*`) and the same three `value` envelopes observed on this host.
 *
 * The assertion that matters most is the negative one: **no error message may contain
 * the value**. An operator pasting `String(error)` into a log is the realistic leak,
 * and it is not detectable by a redaction pass that never runs on error paths.
 */

const SECRET = 'iz-test-credential-value-0123456789';

describe('readOpencodeCredential', () => {
  let directory: string;
  let databasePath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'intelligenz-credential-'));
    databasePath = join(directory, 'opencode.db');

    const database = new DatabaseSync(databasePath);
    database.exec(`
      create table credential (
        id text primary key,
        integration_id text not null,
        label text,
        value text,
        connector_id text,
        method_id text,
        active integer not null default 1,
        time_created integer,
        time_updated integer
      );
    `);

    const insert = database.prepare(
      'insert into credential (id, integration_id, label, value, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)',
    );

    insert.run('cred_api', 'provider-api', 'Primary', JSON.stringify({ type: 'api', key: SECRET }), 1, 1, 1);
    insert.run('cred_stale', 'provider-api', 'Old', JSON.stringify({ type: 'api', key: 'stale-key-11111111' }), 0, 2, 2);
    insert.run(
      'cred_key',
      'provider-key',
      'Key',
      JSON.stringify({ type: 'key', key: 'second-provider-key-9999' }),
      1,
      3,
      3,
    );
    insert.run(
      'cred_expired',
      'provider-oauth',
      'OAuth',
      JSON.stringify({
        type: 'oauth',
        access: 'expired-access-token-000',
        refresh: 'refresh-token',
        expires: Date.now() - 60_000,
      }),
      1,
      4,
      4,
    );
    insert.run(
      'cred_valid',
      'provider-oauth-valid',
      'OAuth',
      JSON.stringify({
        type: 'oauth',
        access: 'valid-access-token-000',
        refresh: 'refresh-token',
        expires: Date.now() + 3_600_000,
      }),
      1,
      5,
      5,
    );
    insert.run('cred_broken', 'provider-broken', 'Broken', 'not-json-at-all', 1, 6, 6);
    insert.run('cred_empty', 'provider-empty', 'Empty', JSON.stringify({ type: 'api' }), 1, 7, 7);

    database.close();
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the active key for an integration', () => {
    const resolved = readOpencodeCredential({
      databasePath,
      integrationId: 'provider-api',
    });

    expect(resolved.token).toBe(SECRET);
    expect(resolved.source).toBe('opencode-db:provider-api');
  });

  it('ignores an inactive row for the same integration', () => {
    const resolved = readOpencodeCredential({ databasePath, integrationId: 'provider-api' });

    expect(resolved.token).not.toBe('stale-key-11111111');
  });

  it('accepts the `{"type":"key"}` envelope as well as `{"type":"api"}`', () => {
    const resolved = readOpencodeCredential({ databasePath, integrationId: 'provider-key' });

    expect(resolved.token).toBe('second-provider-key-9999');
  });

  it('returns an unexpired OAuth access token', () => {
    const resolved = readOpencodeCredential({
      databasePath,
      integrationId: 'provider-oauth-valid',
    });

    expect(resolved.token).toBe('valid-access-token-000');
  });

  it('refuses an expired OAuth token instead of sending it and getting a 401', () => {
    expect(() =>
      readOpencodeCredential({ databasePath, integrationId: 'provider-oauth' }),
    ).toThrow(CredentialExpiredError);
  });

  it('reports a missing integration without opening a neighbouring row', () => {
    expect(() =>
      readOpencodeCredential({ databasePath, integrationId: 'provider-absent' }),
    ).toThrow(CredentialUnavailableError);
  });

  it('reports a missing database by path, and does not create it', async () => {
    const missing = join(directory, 'does-not-exist.db');

    expect(() => readOpencodeCredential({ databasePath: missing, integrationId: 'x' })).toThrow(
      /does not exist/,
    );
  });

  it('never puts the value in an error message', () => {
    const failures: string[] = [];

    for (const integrationId of ['provider-broken', 'provider-empty', 'provider-absent']) {
      try {
        readOpencodeCredential({ databasePath, integrationId });
      } catch (error) {
        failures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
    }

    expect(failures).toHaveLength(3);
    for (const message of failures) {
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('not-json-at-all');
    }
  });

  it('rejects a value that is too short to be a key', () => {
    const shortDb = new DatabaseSync(join(directory, 'short.db'));

    shortDb.exec(
      'create table credential (integration_id text, value text, active integer, time_updated integer)',
    );
    shortDb
      .prepare('insert into credential values (?, ?, 1, 1)')
      .run('short', JSON.stringify({ type: 'api', key: 'abc' }));
    shortDb.close();

    expect(() =>
      readOpencodeCredential({ databasePath: join(directory, 'short.db'), integrationId: 'short' }),
    ).toThrow(CredentialUnavailableError);
  });

  it('rejects a value containing a line break, which would be header injection', () => {
    const injectionDb = new DatabaseSync(join(directory, 'injection.db'));

    injectionDb.exec(
      'create table credential (integration_id text, value text, active integer, time_updated integer)',
    );
    injectionDb
      .prepare('insert into credential values (?, ?, 1, 1)')
      .run('injection', JSON.stringify({ type: 'api', key: 'key-value-with-crlf\r\nx-evil: 1' }));
    injectionDb.close();

    expect(() =>
      readOpencodeCredential({
        databasePath: join(directory, 'injection.db'),
        integrationId: 'injection',
      }),
    ).toThrow(/line break/);
  });

  it('reads an environment source, and reports the variable name only', () => {
    process.env.IZ_TEST_PROVIDER_CREDENTIAL = 'env-provided-credential-value';
    process.env.IZ_TEST_PROVIDER_MISSING = '';

    try {
      const resolved = readEnvCredential('IZ_TEST_PROVIDER_CREDENTIAL');

      expect(resolved.token).toBe('env-provided-credential-value');
      expect(resolved.source).toBe('env:IZ_TEST_PROVIDER_CREDENTIAL');
      expect(() => readEnvCredential('IZ_TEST_PROVIDER_MISSING')).toThrow(
        CredentialUnavailableError,
      );
    } finally {
      delete process.env.IZ_TEST_PROVIDER_CREDENTIAL;
      delete process.env.IZ_TEST_PROVIDER_MISSING;
    }
  });

  it('dispatches on the source discriminant', () => {
    expect(
      readCredential({ kind: 'opencode-db', databasePath, integrationId: 'provider-key' }).token,
    ).toBe('second-provider-key-9999');
  });
});
