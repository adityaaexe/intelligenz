import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * HTTP Basic auth at the origin for the operator preview, plus the tunnel landing
 * redirect.
 *
 * The gate is here because the gate in front of us stopped working. Cloudflare
 * Access was the only credential on the tunnel, bound to the operator's mailbox,
 * but its one-time-PIN flow now fails for that account before the request ever
 * reaches this app: `sso.cloudflare.dev/...cf-standard-user-authentication-flow`
 * ends at `/access-denied`. It cannot be repaired from this host — the policy,
 * the identity provider and the mailbox all live in the Cloudflare dashboard and
 * in the operator's account, not in this repository. The preview was therefore
 * either unreachable or, with the Access application removed, ungated. Neither is
 * acceptable, so the origin checks a credential itself again.
 *
 * The origin is not a second door beside the tunnel: `start:preview` binds it to
 * `127.0.0.1`, so a request can only arrive through cloudflared or from a local
 * process. The route is read-only — a programme snapshot with no session, no
 * tenant data, and no mutating control.
 *
 * A shared credential is plainly weaker than an identity provider. It does not
 * identify a person, cannot be revoked per device, has no second factor, no
 * expiry, and no audit trail of who used it; anyone who learns it is the
 * operator. It is accepted here for a read-only, temporary preview: the identity
 * provider is the thing that is broken, the page cannot write or disclose tenant
 * data, the credential is held by one operator, and the server is loopback-bound
 * so the credential is not exposed on the LAN. This is a stopgap, not the target
 * state. When Cloudflare Access works again, the origin gate should be removed
 * again; if this route ever gains a session, tenant data, or a write path, an
 * identity provider becomes mandatory and this gate is not a substitute.
 *
 * The gate **fails closed**. With `PREVIEW_USER` or `PREVIEW_PASSWORD` missing or
 * empty, every gated request is 503 — never an unauthenticated page. There is no
 * development bypass, because a bypass is the thing that ships. Both variables are
 * read at request time: middleware is bundled, and a module-level read would
 * freeze the value the process happened to start with.
 *
 * Credentials are compared in constant time and never logged, echoed, or written
 * into a header. The failure response is a fixed sentence; the 401 carries only
 * the realm, which is what makes a browser prompt appear.
 *
 * A visitor arriving through a Cloudflare tunnel is sent from `/` or `/login` to
 * `/preview` by an explicit **redirect**, not an internal rewrite. A rewrite
 * inherits the forwarded `https` scheme: Next treats an absolute rewrite target
 * carrying a scheme as an external proxy and opens TLS against its own origin,
 * which serves plain HTTP, so the hop dies with `EPROTO: wrong version number`
 * and the visitor gets a 500. A redirect happens in the browser instead, which
 * already has the right scheme, so it is built from the visitor's own `Host` and
 * `x-forwarded-proto` — never from `request.url`, whose scheme is the forwarded
 * one and whose host is this origin's, not the tunnel's. The redirect happens
 * only after the credential is checked: an unauthenticated tunnel request for
 * `/` is a 401, not a redirect.
 *
 * Detection does not depend on the forwarded `Host` either. Cloudflare always
 * sets `cf-connecting-ip` on a tunnel request and a local browser never sends
 * it, so that header is the authority for "this came through the tunnel". The
 * `.trycloudflare.com` host suffix is kept as a secondary signal; the hostname
 * changes on every quick-tunnel restart and must never be hardcoded.
 *
 * The tenant app is not exposed publicly: `/login` would make the phone's
 * browser call `NEXT_PUBLIC_API_URL` directly, which is a localhost address or,
 * if opened, a mutating API behind a public URL. The read-only preview is the
 * intended surface for that URL. Locally, `/` and `/login` stay unauthenticated
 * and untouched — only `/preview` and tunnelled traffic cross the gate.
 */

const REALM = 'INTELLIGENZ preview';

/** Suffix only. Quick-tunnel hostnames are random per restart. */
const TUNNEL_HOST_SUFFIX = '.trycloudflare.com';

/** Cloudflare sets this on every tunnelled request; a local browser never does. */
const CF_CONNECTING_IP_HEADER = 'cf-connecting-ip';

export const config = {
  matcher: ['/', '/login', '/preview', '/preview/:path*'],
};

/** Lower-cased host without the port. `[::1]:3100` keeps its brackets. */
function normalizeHost(hostHeader: string | null): string {
  const host = (hostHeader ?? '').trim().toLowerCase();
  if (host.length === 0) return '';

  const closingBracket = host.lastIndexOf(']');
  if (closingBracket >= 0) return host.slice(0, closingBracket + 1);

  const colon = host.indexOf(':');
  return colon >= 0 ? host.slice(0, colon) : host;
}

function isTunnelHost(host: string): boolean {
  return host.length > TUNNEL_HOST_SUFFIX.length && host.endsWith(TUNNEL_HOST_SUFFIX);
}

/**
 * True when the request arrived through the tunnel. The Cloudflare header is
 * checked first because it survives any forwarded-`Host` rewriting.
 */
function isTunnelRequest(request: NextRequest): boolean {
  if (request.headers.has(CF_CONNECTING_IP_HEADER)) return true;
  return isTunnelHost(normalizeHost(request.headers.get('host')));
}

interface Credentials {
  readonly user: string;
  readonly password: string;
}

/**
 * Compares without an early return on the first differing byte.
 *
 * `difference` starts at the length XOR, so different lengths can never compare
 * equal; the loop then always runs to the longer input. Length is not treated as
 * secret — it is visible in the header the client sent — but no prefix of a
 * correct credential makes the comparison cheaper.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    const a = index < left.length ? left.charCodeAt(index) : 0;
    const b = index < right.length ? right.charCodeAt(index) : 0;
    difference |= a ^ b;
  }

  return difference === 0;
}

/** `Authorization: Basic base64(user:password)`. The password may contain `:`. */
function parseBasicAuthorization(header: string | null): Credentials | null {
  if (header === null) return null;

  const match = /^Basic +([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  const encoded = match?.[1];
  if (encoded === undefined) return null;

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    // Malformed base64 is a failed credential, not an exception in the response.
    return null;
  }
}

function plainResponse(body: string, status: number, extraHeaders?: Record<string, string>) {
  return new NextResponse(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const isPreviewPath = pathname === '/preview' || pathname.startsWith('/preview/');
  const tunnelRequest = isTunnelRequest(request);

  // `/` and `/login` are only in the matcher for the tunnel landing. On a local
  // request they must stay exactly as untouched and unauthenticated as before.
  if (!isPreviewPath && !tunnelRequest) return NextResponse.next();

  // Bracket access on purpose: a non-public variable read at runtime survives
  // bundling as a real lookup. `PREVIEW_*` is not `NEXT_PUBLIC_*`, so it is never
  // inlined into a client bundle either way — but this keeps the intent explicit.
  const expectedUser = process.env['PREVIEW_USER'] ?? '';
  const expectedPassword = process.env['PREVIEW_PASSWORD'] ?? '';

  // Fail closed: a preview with no credential is not a public preview.
  if (expectedUser.length === 0 || expectedPassword.length === 0) {
    return plainResponse('Preview is not configured.\n', 503);
  }

  const provided = parseBasicAuthorization(request.headers.get('authorization'));
  // Both comparisons evaluate before the branch, so the failure path does not
  // reveal which half was wrong by doing measurably less work.
  const userMatches = provided !== null && constantTimeEquals(provided.user, expectedUser);
  const passwordMatches = provided !== null && constantTimeEquals(provided.password, expectedPassword);

  if (!(userMatches && passwordMatches)) {
    return plainResponse('Authentication required.\n', 401, {
      'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    });
  }

  // Authorised. A tunnel visitor at the root or login is sent to the preview.
  // A redirect, not a rewrite: a rewrite inherits the forwarded `https` scheme and
  // Next proxies over TLS to its own plain-HTTP port, which fails with EPROTO. The
  // redirect is resolved by the browser, which already has the right scheme.
  if ((pathname === '/' || pathname === '/login') && tunnelRequest) {
    const host = normalizeHost(request.headers.get('host'));
    const protocol = request.headers.get('x-forwarded-proto') === 'http' ? 'http' : 'https';

    // `Host` is mandatory in HTTP/1.1 and cloudflared always forwards it; an empty
    // one cannot produce an absolute target, and a thrown URL error would be a 500.
    if (host.length === 0) return plainResponse('Bad request.\n', 400);

    return NextResponse.redirect(new URL('/preview', `${protocol}://${host}`), 307);
  }

  return NextResponse.next();
}
