/**
 * Response headers for the API.
 *
 * `helmet` is not a dependency of this workspace (checked: it is absent from
 * `pnpm-lock.yaml`), and adding one for four static headers is a poor trade — a
 * new transitive surface on an authentication service to save six lines. These
 * are the four that matter for a JSON API, plus a CSP that permits nothing,
 * because nothing on this origin is ever a document.
 *
 *   - `X-Content-Type-Options: nosniff` — a browser must not re-interpret a JSON
 *     body as HTML. Without it, a response containing user-controlled text could
 *     be sniffed into a script context by a legacy client.
 *   - `X-Frame-Options: DENY` — no page may frame an API response. Framing a JSON
 *     document is how content-sniffing XSS gets a click target.
 *   - `Referrer-Policy: strict-origin-when-cross-origin` — API URLs contain
 *     organisation and task ids; a link followed from an error page must not leak
 *     the full path to a third party.
 *   - `Cross-Origin-Resource-Policy: same-site` — blocks another site embedding
 *     these responses (`<script>`, `<img>`, speculative loads). CORS already
 *     blocks *reading* a cross-origin response; CORP blocks the request being
 *     usable at all. `same-site`, not `same-origin`, because the web client is
 *     `localhost:3100` and the API is `localhost:4100` — same site, different
 *     origin, and the browser does send these requests.
 *   - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` —
 *     belt and braces for the case where a proxy serves an API error page as
 *     `text/html`.
 *
 * `X-Powered-By` is removed in `app.factory.ts`; Express advertises itself by
 * default and the version is free reconnaissance.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

interface HeaderWriter {
  setHeader(name: string, value: string): void;
}

/**
 * Express middleware. Registered before every other middleware so a response
 * produced by any later stage — including the exception filter — carries them.
 */
export function securityHeadersMiddleware(
  _request: unknown,
  response: HeaderWriter,
  next: () => void,
): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }

  next();
}
