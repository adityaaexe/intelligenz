import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Membership, LoginResponse, UserRef } from '../../src/lib/types';
import type { Session } from '../../src/lib/session';

/**
 * The one place the suite talks to the API directly.
 *
 * Two reasons it exists rather than being inlined in a spec:
 * - signing in once per run instead of once per test (the login form is the
 *   subject of exactly one test; everywhere else the session is a precondition),
 * - and giving the "real data" test an independent source of truth to compare
 *   the rendered table against, instead of asserting on the page's own output.
 *
 * `API_BASE_URL` is env-overridable so the suite can point at a stack that is
 * not on the default ports, without editing the config.
 */
export const API_BASE_URL = process.env.INTELLIGENZ_API_URL ?? 'http://localhost:4100';

/** Seed credentials from the Phase 2 contract (§15 A5). Overridable, never required. */
export const CREDENTIALS = {
  email: process.env.INTELLIGENZ_E2E_EMAIL ?? 'owner@northwind.test',
  password: process.env.INTELLIGENZ_E2E_PASSWORD ?? 'Passw0rd!demo',
} as const;

/** Where the sign-in happens: the workspace every seeded membership contains. */
export const WORKSPACE_SLUG = process.env.INTELLIGENZ_E2E_WORKSPACE ?? 'reveilchat';

export const OVERVIEW_PATH = `/${WORKSPACE_SLUG}/overview`;

/** The session record as the tab stores it (`lib/session.ts`), plus its own life. */
export interface StoredSession extends Session {
  readonly expiresAt: number;
}

/**
 * Session file location, derived from the config file's own path rather than
 * `process.cwd()` or the Playwright root directory — the suite has to work
 * whether it is started from the repo root (`pnpm -w`) or from `apps/web`, and
 * it is `.ts` compiled to CommonJS, so `import.meta` is not available either.
 */
export function sessionFilePath(configFile: string | null | undefined): string {
  if (typeof configFile !== 'string' || configFile.length === 0) {
    throw new Error('Playwright did not report a config file; cannot locate the session file.');
  }
  return resolve(dirname(configFile), 'e2e', '.auth', 'session.json');
}

function isUser(value: unknown): value is UserRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<UserRef>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.email === 'string'
  );
}

function isMembership(value: unknown): value is Membership {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Membership>;
  return (
    typeof candidate.orgId === 'string' &&
    typeof candidate.orgSlug === 'string' &&
    typeof candidate.role === 'string' &&
    Array.isArray(candidate.workspaces)
  );
}

function isLoginResponse(value: unknown): value is LoginResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<LoginResponse>;
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.expiresIn === 'number' &&
    candidate.expiresIn > 0 &&
    isUser(candidate.user) &&
    Array.isArray(candidate.memberships) &&
    candidate.memberships.every(isMembership)
  );
}

/**
 * `POST /v1/auth/login` against the real API. Throws with the server's own
 * message when the seed account is not there, because "the fixture failed" is
 * useless next to "invalid email or password".
 */
export async function apiLogin(): Promise<StoredSession> {
  const response = await fetch(`${API_BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CREDENTIALS),
  });

  const body = (await response.json().catch(() => null)) as {
    readonly data?: unknown;
    readonly error?: { readonly message?: unknown };
  } | null;

  if (!response.ok || body === null || !isLoginResponse(body.data)) {
    const detail =
      typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
    throw new Error(
      `E2E sign-in failed for ${CREDENTIALS.email} at ${API_BASE_URL}: ${detail}. ` +
        'The suite needs a seeded database and a running API (contract §15 A5).',
    );
  }

  const login = body.data;
  return {
    accessToken: login.accessToken,
    expiresAt: Date.now() + login.expiresIn * 1000,
    user: login.user,
    memberships: login.memberships,
  };
}

/** Headers for a direct API read with the seeded session's own token. */
export function authorizationFor(session: Session): Record<string, string> {
  const orgId = session.memberships[0]?.orgId;
  if (orgId === undefined) {
    throw new Error('The seeded session has no org membership; cannot scope an API read.');
  }
  return { authorization: `Bearer ${session.accessToken}`, 'x-org-id': orgId };
}

/**
 * A read straight from the API, used where a test needs a fact the page cannot
 * be trusted to be the source of (`api-contract.md` §1 envelope: `{ data }`).
 */
export async function apiGet<T>(path: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  const body = (await response.json().catch(() => null)) as {
    readonly data?: T;
    readonly error?: { readonly message?: unknown };
  } | null;

  if (!response.ok || body === null || body.data === undefined) {
    const detail =
      typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`GET ${path} failed: ${detail}`);
  }

  return body.data;
}

/** The workspace the URL scope points at, resolved the same way the app does. */
export function scopeOf(session: Session): {
  readonly orgId: string;
  readonly workspaceId: string;
} {
  for (const membership of session.memberships) {
    for (const workspace of membership.workspaces) {
      if (workspace.slug === WORKSPACE_SLUG) {
        return { orgId: membership.orgId, workspaceId: workspace.id };
      }
    }
  }
  throw new Error(
    `The seeded session has no membership for workspace "${WORKSPACE_SLUG}". ` +
      'Set INTELLIGENZ_E2E_WORKSPACE to a workspace the seed account belongs to.',
  );
}

export async function saveSession(file: string, session: StoredSession): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(session, null, 2), 'utf8');
}

/**
 * The session for this worker: read once, used by every test in the process.
 *
 * A 15-minute token with no refresh endpoint cannot outlive a long run, so a
 * file whose remaining life is under a minute is renewed rather than letting a
 * test fail on an expired token and look like a broken app.
 */
let cached: StoredSession | null = null;

export async function loadSession(file: string): Promise<StoredSession> {
  if (cached !== null) {
    return cached;
  }

  const fromFile = await readFile(file, 'utf8')
    .then((raw) => JSON.parse(raw) as StoredSession)
    .catch(() => null);

  if (fromFile !== null && fromFile.expiresAt - Date.now() > 60_000) {
    cached = fromFile;
    return cached;
  }

  cached = await apiLogin();
  await saveSession(file, cached);
  return cached;
}
