import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Where the broker gets the provider credential.
 *
 * ## The rule this module exists to enforce
 *
 * The credential is read **here**, in the worker process, and handed to the broker's
 * outbound request. It is never written to disk, never placed in a mount, never put in
 * the sandbox environment, and never included in an error message or a log line.
 *
 * Before Phase 4 the sandbox mounted `<data>/opencode` and opencode read the credential
 * from `opencode.db` itself. That database is ~1 GB and holds every provider credential
 * on the host plus the operator's session history, so "the agent can authenticate"
 * also meant "the agent can read every key". The broker moves authentication out of the
 * sandbox, which means the sandbox no longer needs the database at all.
 *
 * ## Why SQLite and not `auth.json`
 *
 * Measured on this host: `~/.local/share/opencode/auth.json` does not exist.
 * `opencode.db` does, and its `credential` table holds one row per provider with a
 * `value` column containing `{"type":"api","key":"…"}` (or an OAuth envelope with
 * `access`/`refresh`/`expires`). That is what opencode itself reads; reading anything
 * else would be guessing at a format the binary does not use.
 *
 * ## Failure is loud and value-free
 *
 * Every failure mode throws a typed error with a message that names the source and the
 * reason but never the secret. A caller can log the error safely; that is deliberate,
 * because the alternative is an operator adding `JSON.stringify(error)` to a log.
 */

export type CredentialSource =
  | {
      /** Read the provider credential from an opencode SQLite database. */
      readonly kind: 'opencode-db';
      /** Absolute path to `opencode.db` on the **host**. */
      readonly databasePath: string;
      /** `credential.integration_id`, e.g. `velona`, `google`, `commandcode`. */
      readonly integrationId: string;
    }
  | {
      /**
       * Read the credential from the worker's own environment. Offered because a
       * deployment that injects secrets from a manager has no reason to keep a 1 GB
       * SQLite file, and the broker should not force that format on it.
       */
      readonly kind: 'env';
      /** Variable name. The value is read; it is never echoed. */
      readonly name: string;
    };

export interface ResolvedCredential {
  /** The secret. Never log, never serialise, never return from an API. */
  readonly token: string;
  /** Which store answered, for the report. Never the value. */
  readonly source: string;
}

/** The credential exists in principle but could not be produced. */
export class CredentialUnavailableError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CredentialUnavailableError';
  }
}

/** The credential was found but is expired and cannot be refreshed without the CLI. */
export class CredentialExpiredError extends Error {
  readonly code = 'CREDENTIAL_EXPIRED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CredentialExpiredError';
  }
}

interface CredentialRow {
  readonly value: string;
}

/**
 * How long a resolved credential may live in this process.
 *
 * `0` means "read on every request", which is the default: a rotation in the store takes
 * effect on the next model call, and there is no copy of the secret sitting in memory
 * for the life of the worker. A caller that measures SQLite latency may raise it.
 */
export const DEFAULT_CREDENTIAL_TTL_MS = 0;

const MINIMUM_TOKEN_LENGTH = 8;

/** Reject anything that cannot be a credential before it reaches an Authorization header. */
function assertUsable(token: unknown, source: string): string {
  if (typeof token !== 'string' || token.length < MINIMUM_TOKEN_LENGTH) {
    throw new CredentialUnavailableError(
      `Credential from ${source} is empty or too short to be a key (no value is shown).`,
    );
  }

  // A newline or space in a header value is header injection. The store is not a
  // trusted author: an operator can paste anything into it.
  if (/[\r\n]/.test(token)) {
    throw new CredentialUnavailableError(
      `Credential from ${source} contains a line break; refusing to build a header from it.`,
    );
  }

  return token;
}

interface ParsedCredentialValue {
  readonly token: string;
  /** Present for an OAuth credential; epoch millis. */
  readonly expiresAt?: number;
}

/**
 * Parse the `credential.value` envelope.
 *
 * Three shapes were observed on this host, and the parser accepts exactly those:
 * `{"type":"api","key":"…"}`, `{"type":"key","key":"…"}` and
 * `{"type":"oauth","access":"…","refresh":"…","expires":<millis>}`.
 * An OAuth credential that cannot be refreshed from here is reported, not silently sent
 * as an empty bearer token — the provider would answer 401 and the operator would spend
 * an hour looking at the wrong layer.
 */
function parseCredentialValue(raw: string, source: string): ParsedCredentialValue {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialUnavailableError(
      `Credential from ${source} is not JSON; the store format has changed (value not shown).`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new CredentialUnavailableError(`Credential from ${source} is not an object.`);
  }

  const record = parsed as Record<string, unknown>;
  const key = record['key'];
  const access = record['access'];
  const expires = record['expires'];

  if (typeof key === 'string' && key.length > 0) {
    return { token: assertUsable(key, source) };
  }

  if (typeof access === 'string' && access.length > 0) {
    const expiresAt = typeof expires === 'number' && Number.isFinite(expires) ? expires : undefined;

    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      throw new CredentialExpiredError(
        `OAuth credential from ${source} expired at ${new Date(expiresAt).toISOString()}; ` +
          're-authenticate on the host. The broker does not refresh tokens.',
      );
    }

    return { token: assertUsable(access, source), ...(expiresAt === undefined ? {} : { expiresAt }) };
  }

  throw new CredentialUnavailableError(
    `Credential from ${source} has neither a "key" nor an "access" field.`,
  );
}

/**
 * Read one credential from an opencode database.
 *
 * The database is opened read-only on every call: the worker shares this file with the
 * operator's running opencode, so a writable handle would be a second writer to a
 * database this process does not own.
 *
 * `node:sqlite` is synchronous. That is acceptable here because the query is a single
 * indexed row on a local file and the broker's alternative — holding the secret in
 * memory for the process lifetime — is worse. The measured cost is printed by
 * `infra/scripts/p4-broker-proof.ts`.
 */
export function readOpencodeCredential(input: {
  readonly databasePath: string;
  readonly integrationId: string;
}): ResolvedCredential {
  const source = `opencode-db:${input.integrationId}`;

  if (!existsSync(input.databasePath)) {
    throw new CredentialUnavailableError(
      `Credential database ${input.databasePath} does not exist. ` +
        'Point AGENT_BROKER_CREDENTIAL_DB at the opencode database, or use an env source.',
    );
  }

  let database: DatabaseSync | undefined;

  try {
    database = new DatabaseSync(input.databasePath, { readOnly: true });

    const row = database
      .prepare(
        'select value from credential where integration_id = ? and active = 1 ' +
          'order by time_updated desc limit 1',
      )
      .get(input.integrationId) as CredentialRow | undefined;

    if (row === undefined || typeof row.value !== 'string') {
      throw new CredentialUnavailableError(
        `No active credential for integration "${input.integrationId}" in ${input.databasePath}.`,
      );
    }

    const parsed = parseCredentialValue(row.value, source);

    return { token: parsed.token, source };
  } finally {
    database?.close();
  }
}

/** Read a credential from the worker's environment. The value is never echoed. */
export function readEnvCredential(name: string): ResolvedCredential {
  const value = process.env[name];

  return { token: assertUsable(value, `env:${name}`), source: `env:${name}` };
}

export function readCredential(source: CredentialSource): ResolvedCredential {
  if (source.kind === 'env') return readEnvCredential(source.name);

  return readOpencodeCredential({
    databasePath: source.databasePath,
    integrationId: source.integrationId,
  });
}
