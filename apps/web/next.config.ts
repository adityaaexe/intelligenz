import type { NextConfig } from 'next';

/**
 * `apps/web` — the control centre.
 *
 * Notes that are decisions, not boilerplate:
 * - `transpilePackages` is required because the workspace packages ship TypeScript
 *   source (`main`/`exports` point at `src/index.ts`). There is no separate build
 *   step for them, by design (contract §2: no Turborepo, no per-package bundling).
 * - `eslint.ignoreDuringBuilds` is true because linting is a first-class gate of
 *   its own (`pnpm -w lint`, flat config at the repo root, `--max-warnings=0`).
 *   Running a second, differently-configured copy inside `next build` would make
 *   two sources of truth for the same rule.
 * - Type checking during build stays on: `next build` failing on a type error is
 *   the last line of defence if someone runs the build without `typecheck`.
 */

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * The origin the browser calls for data. `lib/api.ts` defaults to `:4100`, and
 * `NEXT_PUBLIC_API_URL` is the documented override; the CSP is derived from the
 * same value so the policy and the bundle cannot disagree.
 */
const apiOrigins = [
  'http://localhost:4100',
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, ''),
].filter((origin): origin is string => origin !== undefined && origin.length > 0);

/**
 * Content-Security-Policy.
 *
 * Two directives are deliberately loose, and both are required by the framework
 * this app is built on rather than by the app's own code:
 *
 *   - `script-src 'unsafe-inline'` — Next injects inline `<script>` tags that
 *     carry the React Server Component flight payload (`self.__next_f.push`) and
 *     the hydration bootstrap. With no nonce (a nonce needs middleware that
 *     rewrites the document per request) an inline script is either allowed or
 *     the page does not hydrate at all.
 *   - `style-src 'unsafe-inline'` — React writes `style` attributes for
 *     component-level styles, and CSP governs style attributes from the same
 *     directive. Without it the design system renders unstyled.
 *
 * `'unsafe-eval'` is added in development only: the dev server compiles modules
 * with `eval` and needs a websocket for HMR. Production does not.
 *
 * Everything else is closed: no `object-src`, no framing, no base-tag rewriting,
 * forms post to this origin only. `connect-src` names the API origin explicitly —
 * without it the overview and login break, which is the failure mode that gets a
 * CSP removed instead of fixed.
 */
function contentSecurityPolicy(): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isDevelopment ? ["'unsafe-eval'"] : [])];
  const connectSrc = [
    "'self'",
    ...apiOrigins,
    // HMR in development. The port is deliberately a wildcard: `next dev` may be
    // started on any port, and a policy pinned to 3100 would break the socket (and
    // therefore hydration diagnostics) the moment someone used another one.
    ...(isDevelopment ? ['ws://localhost:*'] : []),
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  // HSTS is only meaningful (and only safe) over TLS. localhost is served over
  // http, so it is emitted in production builds only, where a TLS terminator is
  // assumed to sit in front.
  ...(isDevelopment
    ? []
    : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@intelligenz/contracts', '@intelligenz/design-system'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        // Every route, including the RSC payloads and static assets: a header
        // applied to some responses is a header an attacker can find a route
        // without.
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
