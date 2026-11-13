/**
 * Redaction for anything that leaves the adapter: tool summaries, an error tail, and
 * **every line of the persisted transcript**.
 *
 * This is a *denylist*, and a denylist is never complete. It exists because the
 * failure modes it prevents are catastrophic rather than theoretical:
 *
 *   1. a token in a `ToolInvocation.summary`, which is a `VarChar(500)` on a table
 *      every admin screen lists;
 *   2. a token in an `error.message`, which ends up in `AgentRun.error` and then in a
 *      UI that shows raw JSON;
 *   3. a token in `transcript.ndjson`, which is an artifact a `VIEWER` can download.
 *
 * The allowlist is upstream: the sandbox carries no credential in its environment
 * (`--clearenv`), and mounts only the provider's own data directory. This function is
 * the second line, not the first. The third line is the API: a raw transcript download
 * requires `ADMIN`.
 *
 * ## The base64 pass
 *
 * A tool that prints `btoa(os.environ)` defeats every pattern below, because the
 * plaintext never appears. `decodeBase64Secrets` finds long base64 runs, decodes them,
 * and redacts the run when the decoded bytes contain something the plain patterns
 * would have caught. It is deliberately conservative in both directions: only runs of
 * 40+ base64 characters are considered (shorter than that is a checksum, not a
 * credential), and a run that decodes to ordinary prose is left alone.
 */

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // `Authorization: Bearer …` and `Authorization: <scheme+token>`. The header name is
  // kept so a reader can tell what was removed.
  [/\b(authorization\s*:\s*)(?:[a-z]+\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  // A bare scheme, with or without an `Authorization:` in front.
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 [redacted]'],
  // Bare JWT: three dot-separated base64url segments, the first always `{"` in base64.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g, '[redacted]'],
  // Provider keys with recognisable prefixes.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\bghp_[A-Za-z0-9]{10,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{12,}/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\bnpm_[A-Za-z0-9]{20,}/g, '[redacted]'],
  // Credentials embedded in a URL: `postgres://user:pass@host`, `https://x:y@host`.
  // The scheme survives so a reader still knows what kind of endpoint it was.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  // Generic long hex: session tokens, checksums of secrets, sha-looking keys. A
  // 32-hex run is also what a sha256 prefix looks like, which is acceptable: a
  // truncated checksum in a summary is not worth a leaked key.
  [/\b[0-9a-f]{32,}\b/gi, '[redacted]'],
  // `KEY=value` / `token: value` pairs, which is how a shell trace leaks. Case
  // insensitive: `password=` and `Password:` are the same leak as `PASSWORD=`. The
  // value stops at whitespace *and* at the characters that end a value inside JSON or
  // a shell word — otherwise redacting a line of NDJSON would eat its closing braces
  // and turn valid evidence into unparseable text.
  [
    /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*[=:]\s*[^\s"'`,;}]+/gi,
    '$1=[redacted]',
  ],
];

/** Base64 alphabet runs long enough to be a wrapped credential, not a checksum. */
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;

/**
 * What a decoded blob must contain to be treated as a secret. This is the same
 * denylist in a cheaper form — it is only ever consulted after a decode.
 */
const SECRET_HINT =
  /(?:eyJ[A-Za-z0-9_-]{8,}\.|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,}|authorization\s*:|[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[=:]|[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@)/i;

/** Longest prefix of a candidate this pass decodes. A credential is not a megabyte. */
const BASE64_DECODE_LIMIT = 8192;

function decodeBase64Secrets(input: string): string {
  return input.replace(BASE64_RUN, (candidate) => {
    const prefix = candidate.slice(0, BASE64_DECODE_LIMIT);

    let decoded: string;

    try {
      decoded = Buffer.from(prefix, 'base64').toString('utf8');
    } catch {
      return candidate;
    }

    return SECRET_HINT.test(decoded) ? '[redacted:base64]' : candidate;
  });
}

/** Replace anything that looks like a credential. Idempotent. */
export function redact(input: string): string {
  let output = decodeBase64Secrets(input);

  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }

  return output;
}

/** Redact, then cut to a hard limit without splitting the marker. */
export function redactAndTruncate(input: string, limit: number): string {
  const redacted = redact(input);

  if (redacted.length <= limit) return redacted;

  return `${redacted.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Collapse an arbitrary tool payload into one line, then redact and truncate it.
 * Newlines are the enemy of a `VarChar(500)` summary: they turn one row into a
 * pasted stack trace in every list view.
 */
export function summarizeToolPayload(payload: unknown, limit = 500): string {
  const text =
    typeof payload === 'string'
      ? payload
      : (() => {
          try {
            return JSON.stringify(payload);
          } catch {
            return String(payload);
          }
        })();

  const oneLine = text.replace(/\s+/g, ' ').trim();

  return redactAndTruncate(oneLine.length > 0 ? oneLine : '(no output)', limit);
}
