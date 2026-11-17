import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Tunnel landing rewrite for the operator preview.
 *
 * `/preview` is the only public surface of this app: a read-only page that
 * renders a programme snapshot with no session, no tenant data, and no mutating
 * control. It carries **no application-level credential**. Authentication and
 * authorisation are handled once, at the edge, by **Cloudflare Access** on the
 * tunnel, which admits only the operator's mailbox. The origin itself is not
 * exposed: `start:preview` binds the server to `127.0.0.1`, so the tunnel is the
 * only path in and reaching port 3100 from the LAN is not a bypass.
 *
 * Having no credential in this file is acceptable only because of what the route
 * cannot do. It is read-only, it holds no tenant data, it establishes no
 * session, and it exposes no mutating control, so a stolen URL grants nothing
 * beyond viewing a static snapshot. If the route ever gains a session, tenant
 * data, or a write path, an application-level gate becomes mandatory again.
 *
 * A visitor arriving through a Cloudflare tunnel is served the preview at the
 * same URL by an internal **rewrite**, not a redirect. A redirect has to name an
 * absolute origin, and the origin is exactly what is uncertain here: cloudflared
 * may forward the tunnel hostname or `127.0.0.1:3100` in `Host`, and the server
 * itself was started with a localhost origin. Picking the wrong one told the
 * phone to retry on its own loopback. A rewrite emits no `Location` header —
 * `request.url` is only the base of the internal target and is never sent to the
 * browser — so there is no absolute origin to get wrong.
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
 * intended surface for that URL.
 */

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

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const isPreviewPath = pathname === '/preview' || pathname.startsWith('/preview/');

  // `/preview` is deliberately not a rewrite source here — rewriting it onto
  // itself is pointless work on every subresource request.
  if ((pathname === '/' || pathname === '/login') && isTunnelRequest(request)) {
    return NextResponse.rewrite(new URL('/preview', request.url), { status: 200 });
  }

  // `/` and `/login` are only in the matcher for the tunnel case above; on every
  // other host they must stay exactly as untouched as they were before.
  if (!isPreviewPath) return NextResponse.next();

  // Cloudflare Access gates the tunnel and the server binds to loopback, so
  // there is nothing left to check. No credential is read, compared, or stored.
  return NextResponse.next();
}
