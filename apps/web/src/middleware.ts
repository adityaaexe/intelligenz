import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * HTTP Basic auth for `/preview`, plus tunnel landing redirection.
 *
 * The preview is the only route that renders live programme data without a
 * session, so it is the only route behind a second gate. `/` and `/login` are
 * matched only so the tunnel can be redirected; they stay unauthenticated and
 * untouched on every other host.
 *
 * A visitor arriving through a Cloudflare quick tunnel is sent to the preview.
 * The tenant app is not exposed publicly: `/login` would make the phone's
 * browser call `NEXT_PUBLIC_API_URL` directly, which is a localhost address or,
 * if opened, a mutating API behind a public URL. The read-only preview is the
 * intended surface for that URL. Only the `.trycloudflare.com` suffix matches —
 * the tunnel hostname changes on every restart and must never be hardcoded.
 *
 * The gate **fails closed**. With `PREVIEW_USER` or `PREVIEW_PASSWORD` missing
 * or empty, every preview request is 503 — never an unauthenticated page. There
 * is no development bypass, because a bypass is the thing that ships.
 *
 * Credentials are compared in constant time and never logged, echoed, or written
 * into a header. The failure response is a fixed sentence.
 */

const REALM = 'INTELLIGENZ preview';

/** Suffix only. Quick-tunnel hostnames are random per restart. */
const TUNNEL_HOST_SUFFIX = '.trycloudflare.com';

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

  // Tunnel root and login send the visitor to the read-only preview. `/preview`
  // is deliberately not a source here — redirecting it to itself would loop.
  if (
    (pathname === '/' || pathname === '/login') &&
    isTunnelHost(normalizeHost(request.headers.get('host')))
  ) {
    return NextResponse.redirect(new URL('/preview', request.url), 307);
  }

  // `/` and `/login` are only in the matcher for the tunnel case above; on every
  // other host they must stay exactly as unauthenticated as they were before.
  if (!isPreviewPath) return NextResponse.next();

  // Bracket access on purpose: a non-public variable read at runtime survives
  // bundling as a real lookup. `PREVIEW_*` is not `NEXT_PUBLIC_*`, so it is never
  // inlined into a client bundle either way — but this keeps the intent explicit.
  const expectedUser = process.env['PREVIEW_USER'] ?? '';
  const expectedPassword = process.env['PREVIEW_PASSWORD'] ?? '';

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

  return NextResponse.next();
}
