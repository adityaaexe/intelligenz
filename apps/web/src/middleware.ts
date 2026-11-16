import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * HTTP Basic auth for `/preview` only.
 *
 * The preview is the only route that renders live programme data without a
 * session, so it is the only route behind a second gate. The matcher is scoped:
 * `/` and `/login` must keep working exactly as before, and a challenge on
 * every route would be a product-wide change disguised as a preview.
 *
 * The gate **fails closed**. With `PREVIEW_USER` or `PREVIEW_PASSWORD` missing
 * or empty, every preview request is 503 — never an unauthenticated page. There
 * is no development bypass, because a bypass is the thing that ships.
 *
 * Credentials are compared in constant time and never logged, echoed, or written
 * into a header. The failure response is a fixed sentence.
 */

const REALM = 'INTELLIGENZ preview';

export const config = {
  matcher: ['/preview', '/preview/:path*'],
};

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
