import type { LoginResponse, Membership, UserRef } from './types';

/**
 * The in-memory + `sessionStorage` session record. `expiresAt` is an absolute
 * epoch millisecond value computed at sign-in, so a clock change mid-session
 * expires the token rather than extending it.
 */
export interface Session {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly user: UserRef;
  readonly memberships: readonly Membership[];
}

/**
 * Session storage — and the trade-off, stated plainly.
 *
 * The access token lives in memory for the life of the tab and is mirrored into
 * `sessionStorage` so a reload does not sign the operator out. That is a real
 * compromise and it is not hidden:
 *
 * - `sessionStorage` is readable by any script that achieves XSS in this origin.
 *   An `httpOnly` cookie is not.
 * - An `httpOnly` cookie would require a same-origin backend-for-frontend to
 *   hold it and to translate it into the `Authorization` header, because the
 *   API contract (`api-contract.md` §2) authenticates with a bearer token and
 *   does not define cookie auth.
 *
 * Phase 2 has no BFF, so the choice is between a token in JS-reachable storage
 * and no persistence at all. Persisting is the better trade for an operator
 * tool used all day; the mitigating controls are: `sessionStorage` (not
 * `localStorage`, so it dies with the tab), a 15-minute token TTL with no
 * refresh endpoint, and a strict CSP in the deployment unit. Recorded here, in
 * the code, because a security decision that lives only in a chat log is not a
 * decision.
 */

/**
 * Where the tab keeps its session. Exported because the E2E suite has to seed a
 * signed-in tab the same way the app writes one (`e2e/support/session.ts`); a
 * second copy of this string in the tests would let the app rename it silently.
 */
export const SESSION_STORAGE_KEY = 'intelligenz.session.v1';

let cached: Session | null = null;
let hydrated = false;

function storage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be blocked by policy; the in-memory copy still works.
    return null;
  }
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Session>;
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.expiresAt === 'number' &&
    typeof candidate.user === 'object' &&
    candidate.user !== null &&
    Array.isArray(candidate.memberships)
  );
}

/** Memory first, then `sessionStorage` once per tab. */
export function readSession(): Session | null {
  if (cached !== null) {
    return cached;
  }
  if (hydrated) {
    return null;
  }
  hydrated = true;
  const store = storage();
  if (store === null) {
    return null;
  }
  const raw = store.getItem(SESSION_STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSession(parsed)) {
      cached = parsed;
      return cached;
    }
  } catch {
    // A corrupt entry is treated as no entry.
  }
  store.removeItem(SESSION_STORAGE_KEY);
  return null;
}

export function saveFromLogin(response: LoginResponse, now: number = Date.now()): Session {
  const session: Session = {
    accessToken: response.accessToken,
    expiresAt: now + response.expiresIn * 1000,
    user: response.user,
    memberships: response.memberships,
  };
  cached = session;
  hydrated = true;
  storage()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function clearSession(): void {
  cached = null;
  hydrated = true;
  storage()?.removeItem(SESSION_STORAGE_KEY);
}

/**
 * No refresh endpoint exists (`api-contract.md` §4 defines login only), so an
 * expired token is a sign-in, not a silent renewal.
 */
export function sessionExpired(session: Session | null, now: number = Date.now()): boolean {
  if (session === null) {
    return true;
  }
  return session.expiresAt <= now;
}

export interface ResolvedScope {
  readonly membership: Membership;
  readonly workspace: Membership['workspaces'][number];
}

/** The workspace slug in the URL is the scope; a slug the caller has no
 *  membership for resolves to `null` rather than to the first workspace. */
export function resolveScope(session: Session | null, workspaceSlug: string): ResolvedScope | null {
  if (session === null) {
    return null;
  }
  for (const membership of session.memberships) {
    for (const workspace of membership.workspaces) {
      if (workspace.slug === workspaceSlug) {
        return { membership, workspace };
      }
    }
  }
  return null;
}

/** Where to send an operator who has just signed in and has not chosen a scope. */
export function defaultScopeHref(session: Session): string {
  const first = session.memberships[0]?.workspaces[0];
  if (first === undefined) {
    return '/no-access';
  }
  return `/${first.slug}/overview`;
}

export const ROLE_LABELS: Readonly<Record<string, string>> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
