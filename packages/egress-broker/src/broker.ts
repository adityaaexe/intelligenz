import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CredentialExpiredError,
  readCredential,
  type CredentialSource,
} from './credential';

/**
 * `@intelligenz/egress-broker` — provider authentication, terminated **outside** the
 * sandbox.
 *
 * ## The problem it removes
 *
 * A coding agent must authenticate to think. Phase 3 let it: `opencode.db` was mounted
 * into the sandbox so opencode could read its own credential. Measured, that database
 * is 1.08 GB and contains the provider key **and 696 sessions of operator history**.
 * The sandbox therefore held a live credential by construction, and no amount of
 * masking fixed it, because masking the credential also broke the agent.
 *
 * ## What replaces it
 *
 * ```
 *  sandbox (--unshare-net)                                 host
 *  ┌────────────────────────────────┐   unix socket   ┌──────────────────────────┐
 *  │ opencode                       │   (0600, per    │  egress broker           │
 *  │   baseURL http://127.0.0.1:8899│   attempt dir)  │   1. capability token    │
 *  │   key     iz-canary-…          │ ──────────────> │   2. path allowlist      │
 *  │                                │                 │   3. strip client auth   │
 *  │  no provider credential,       │                 │   4. inject real key ────┼──> provider
 *  │  no credential database,       │                 │      (read host-side)    │
 *  │  no provider config            │                 │   5. log method+path     │
 *  └────────────────────────────────┘                 └──────────────────────────┘
 * ```
 *
 * The sandbox holds a **canary**: a random, per-attempt string that is not a credential
 * and authenticates nothing. It exists so the broker can prove the request came through
 * this attempt's channel. The real key is read from the host store at request time and
 * exists only in this process's memory for the duration of one outbound request.
 *
 * ## Why the broker chooses the destination
 *
 * The sandbox never names a host. It sends `/v1/chat/completions`; the broker maps that
 * onto its configured `upstreamBaseUrl`. There is no header, path or query the caller
 * can use to redirect the request, so an agent that fully controls its own HTTP client
 * still cannot reach a host the operator did not configure. That is a stronger property
 * than an allowlist that the caller's request is matched against.
 *
 * ## What it is not
 *
 * It does not inspect request or response bodies, and it does not redact them. It is a
 * credential boundary and a destination boundary, not a content filter. It is also not
 * a substitute for the network namespace: `--unshare-net` remains the control that
 * stops the agent from opening any other socket.
 */

/** Socket file name inside the per-attempt directory. */
export const BROKER_SOCKET_NAME = 'broker.sock';

/**
 * Endpoints the broker will forward.
 *
 * Exact paths, not prefixes. `POST /v1/chat/completions` is what opencode sends; the
 * rest are the OpenAI-compatible surface a future provider might need. A path that is
 * not on this list is refused with `403` and a log line rather than silently forwarded,
 * so a provider SDK that starts calling `/v1/files` is a visible event.
 */
export const DEFAULT_ALLOWED_PATHS = [
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/models',
  '/v1/responses',
] as const;

/** Methods a model call needs. Anything else is refused before it reaches upstream. */
export const DEFAULT_ALLOWED_METHODS = ['POST', 'GET'] as const;

/**
 * Headers that must never reach the provider from inside the sandbox.
 *
 * `authorization`, `x-api-key`, `cookie` and `proxy-authorization` are the directive's
 * requirement: whatever the agent put there is the agent's, and the broker replaces it
 * with the operator's credential. `host` is stripped because the broker chooses the
 * upstream. `accept-encoding` is stripped because the broker streams bytes without
 * decompressing them: forwarding `gzip` produced a corrupt SSE stream in testing (the
 * upstream gzipped the event stream, the broker passed the bytes through and dropped
 * the header, and the client saw binary garbage). Hop-by-hop headers are stripped for
 * the usual reason.
 */
export const STRIPPED_REQUEST_HEADERS: readonly string[] = [
  'authorization',
  'x-api-key',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'proxy-authenticate',
  'host',
  'accept-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
];

/** Response headers worth passing through. Everything else is broker-local. */
const FORWARDED_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'content-encoding',
  'retry-after',
  'x-request-id',
  'request-id',
  'openai-processing-ms',
  'openai-version',
];

export type BrokerDenial =
  | 'token'
  | 'method'
  | 'path'
  | 'size'
  | 'concurrency'
  | 'counter'
  | 'credential'
  | 'upstream'
  | 'client';

/**
 * One line of broker evidence.
 *
 * Deliberately cannot hold a header, a body or a token: this shape is the guarantee that
 * a log file can be attached to a report without a redaction pass.
 */
export interface BrokerRequestLog {
  readonly at: string;
  readonly attemptId: string;
  readonly method: string;
  /** Path only, no query string: a query can carry an API key from a careless client. */
  readonly path: string;
  readonly status: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly denied?: BrokerDenial;
}

export interface EgressBrokerOptions {
  /**
   * Per-attempt directory the socket is created in. Created with mode `0700`; the
   * socket itself is `0600`. It must be short enough for a unix socket path
   * (107 bytes on Linux) — the worker checks that at boot.
   */
  readonly socketDir: string;
  /** Identifier written on every log line and returned by the health endpoint. */
  readonly attemptId: string;
  /**
   * The per-attempt capability. Must be unguessable and must not be reused across
   * attempts. It is compared in constant time and never logged.
   */
  readonly capabilityToken: string;
  /** Where the request goes, and where its credential comes from. Host-side only. */
  readonly upstream: {
    /** e.g. `https://api.example.test/v1` — the broker appends the request's path. */
    readonly baseUrl: string;
    readonly credential: CredentialSource;
  };
  /** Exact request paths, default `DEFAULT_ALLOWED_PATHS`. */
  readonly allowedPaths?: readonly string[];
  readonly allowedMethods?: readonly string[];
  /** Request body ceiling. Default 32 MiB. */
  readonly maxRequestBytes?: number;
  /** Response body ceiling. Default 32 MiB. */
  readonly maxResponseBytes?: number;
  /** Time allowed to establish the upstream connection. Default 15 s. */
  readonly connectTimeoutMs?: number;
  /** Time allowed between bytes once the response has started. Default 120 s. */
  readonly idleTimeoutMs?: number;
  /** Simultaneous upstream requests. Default 4. */
  readonly maxConcurrent?: number;
  /** Requests one attempt may make. Default 400. */
  readonly maxRequests?: number;
  /** NDJSON evidence file. Contains only `BrokerRequestLog` fields. */
  readonly logFile?: string;
  /** Called for every decision, for callers that report in memory instead of a file. */
  readonly onRequest?: (entry: BrokerRequestLog) => void;
}

export interface EgressBroker {
  readonly socketPath: string;
  readonly requestCount: number;
  readonly logs: readonly BrokerRequestLog[];
  /** Round-trips the health endpoint over the socket. False means "do not start a run". */
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

const DEFAULTS = {
  maxRequestBytes: 32 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 120_000,
  maxConcurrent: 4,
  maxRequests: 400,
} as const;

/** Health endpoint. Never forwarded, never counted against the request cap. */
export const HEALTH_PATH = '/__iz/health';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time comparison.
 *
 * Both sides are hashed first so the comparison is over equal-length buffers: a
 * `timingSafeEqual` on raw strings throws when lengths differ, which would itself leak
 * the length of the token.
 */
export function tokensMatch(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;

  return timingSafeEqual(digest(presented), digest(expected));
}

function bearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;

  const match = /^Bearer[ \t]+(.+)$/i.exec(value.trim());

  return match?.[1]?.trim();
}

function headerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;

  return value === undefined || value.length === 0 ? undefined : value;
}

/** Path only. A query string is dropped from both the log and the upstream URL. */
function splitPath(rawUrl: string | undefined): { path: string; query: string } {
  const raw = rawUrl ?? '/';

  try {
    const parsed = new URL(raw, 'http://broker.invalid');

    return { path: parsed.pathname, query: parsed.search };
  } catch {
    return { path: '/', query: '' };
  }
}

/**
 * Map a sandbox-facing path onto the configured upstream.
 *
 * `/v1/<rest>` → `<baseUrl>/<rest>`. Nothing in the request can change the origin: the
 * result is checked against the configured base before it is used, so a path that
 * escapes (encoded traversal, protocol-relative URL, absolute URL) fails here rather
 * than becoming an SSRF primitive.
 */
export function resolveUpstreamUrl(baseUrl: string, requestPath: string): URL | null {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const relative = requestPath.replace(/^\/+/, '').replace(/^v1\/?/, '');

  if (relative.length === 0 || relative.includes('..') || relative.includes('\\')) {
    return null;
  }

  let resolved: URL;

  try {
    resolved = new URL(relative, base);
  } catch {
    return null;
  }

  if (resolved.origin !== base.origin) return null;

  // `new URL` normalises `%2e%2e` only after decoding in some cases; compare the final
  // path prefix so an encoded traversal cannot land outside the configured base path.
  if (!resolved.pathname.startsWith(base.pathname)) return null;

  return resolved;
}

export async function startEgressBroker(options: EgressBrokerOptions): Promise<EgressBroker> {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULTS.maxRequestBytes;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
  const maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
  const maxRequests = options.maxRequests ?? DEFAULTS.maxRequests;
  const allowedPaths = new Set(options.allowedPaths ?? DEFAULT_ALLOWED_PATHS);
  const allowedMethods = new Set(options.allowedMethods ?? DEFAULT_ALLOWED_METHODS);

  if (options.capabilityToken.length < 16) {
    throw new Error('EgressBroker: capabilityToken must be at least 16 characters');
  }

  const socketPath = join(options.socketDir, BROKER_SOCKET_NAME);
  const logs: BrokerRequestLog[] = [];
  let requests = 0;
  let inflight = 0;
  let listening = false;
  let logQueue: Promise<void> = Promise.resolve();

  await mkdir(options.socketDir, { recursive: true, mode: 0o700 });

  const record = (entry: BrokerRequestLog): void => {
    logs.push(entry);
    options.onRequest?.(entry);

    if (options.logFile !== undefined) {
      const line = `${JSON.stringify(entry)}\n`;
      logQueue = logQueue.then(() => appendFile(options.logFile as string, line, { mode: 0o600 }));
    }
  };

  const deny = (
    res: ServerResponse,
    input: {
      readonly startedAt: number;
      readonly method: string;
      readonly path: string;
      readonly status: number;
      readonly denial: BrokerDenial;
      readonly message: string;
    },
  ): void => {
    record({
      at: new Date().toISOString(),
      attemptId: options.attemptId,
      method: input.method,
      path: input.path,
      status: input.status,
      bytes: 0,
      durationMs: Date.now() - input.startedAt,
      denied: input.denial,
    });

    if (res.headersSent) {
      res.destroy();
      return;
    }

    const body = JSON.stringify({
      error: { type: 'broker_denied', code: `BROKER_${input.denial.toUpperCase()}`, message: input.message },
    });

    res
      .writeHead(input.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        connection: 'close',
      })
      .end(body);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const { path, query } = splitPath(req.url);

    // ── 1. Capability token ────────────────────────────────────────────────────
    // Checked before anything else, including the health route, so an unauthenticated
    // caller learns nothing about which paths exist.
    const presented =
      bearer(req.headers['authorization']) ?? headerToken(req.headers['x-iz-broker-token']);

    if (!tokensMatch(presented, options.capabilityToken)) {
      deny(res, {
        startedAt,
        method,
        path,
        status: 403,
        denial: 'token',
        message: 'A valid per-attempt capability token is required.',
      });
      return;
    }

    if (path === HEALTH_PATH) {
      const body = JSON.stringify({ ok: true, attemptId: options.attemptId });

      record({
        at: new Date().toISOString(),
        attemptId: options.attemptId,
        method,
        path,
        status: 200,
        bytes: Buffer.byteLength(body),
        durationMs: Date.now() - startedAt,
      });

      res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(body);
      return;
    }

    // ── 2. Method and destination ──────────────────────────────────────────────
    if (!allowedMethods.has(method)) {
      deny(res, {
        startedAt,
        method,
        path,
        status: 403,
        denial: 'method',
        message: `Method ${method} is not permitted through the broker.`,
      });
      return;
    }

    if (!allowedPaths.has(path)) {
      deny(res, {
        startedAt,
        method,
        path,
        status: 403,
        denial: 'path',
        message: 'This path is not an approved provider endpoint.',
      });
      return;
    }

    const target = resolveUpstreamUrl(options.upstream.baseUrl, path);

    if (target === null) {
      deny(res, {
        startedAt,
        method,
        path,
        status: 403,
        denial: 'path',
        message: 'This path does not resolve inside the configured upstream.',
      });
      return;
    }

    // ── 3. Budgets ─────────────────────────────────────────────────────────────
    if (requests >= maxRequests) {
      deny(res, {
        startedAt,
        method,
        path,
        status: 429,
        denial: 'counter',
        message: `This attempt has used its ${String(maxRequests)} broker requests.`,
      });
      return;
    }

    if (inflight >= maxConcurrent) {
      deny(res, {
        startedAt,
        method,
        path,
        status: 429,
        denial: 'concurrency',
        message: `The broker is already serving ${String(maxConcurrent)} requests for this attempt.`,
      });
      return;
    }

    const declaredLength = Number(req.headers['content-length'] ?? '0');

    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
      deny(res, {
        startedAt,
        method,
        path,
        status: 413,
        denial: 'size',
        message: `Request body exceeds ${String(maxRequestBytes)} bytes.`,
      });
      return;
    }

    // ── 4. The credential, read host-side, at request time ─────────────────────
    let credential: string;

    try {
      credential = readCredential(options.upstream.credential).token;
    } catch (error) {
      // The message is produced by `credential.ts`, which is written so that no branch
      // can include the value. That is why it is safe to log; it is not an accident.
      const detail =
        error instanceof CredentialExpiredError
          ? 'the stored OAuth credential has expired'
          : error instanceof Error
            ? error.message
            : 'the credential could not be read';

      // 403, not 503. A retryable status makes a provider SDK retry with backoff against
      // a condition that cannot change: measured, opencode retried a 503 nine times in
      // 60 s and would have consumed the whole attempt budget. This is a refusal to
      // authorise, and it is final for this attempt.
      deny(res, {
        startedAt,
        method,
        path,
        status: 403,
        denial: 'credential',
        message: `Provider credential unavailable: ${detail}`,
      });
      return;
    }

    requests += 1;
    inflight += 1;

    // ── 5. Build the outbound request ──────────────────────────────────────────
    const headers: OutgoingHttpHeaders = {};

    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (STRIPPED_REQUEST_HEADERS.includes(name.toLowerCase())) continue;
      headers[name] = value;
    }

    // The only Authorization that reaches the provider is this one.
    headers['authorization'] = `Bearer ${credential}`;

    const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    let responded = false;
    let upstreamBytes = 0;

    const upstream = requestFn(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        path: `${target.pathname}${query}`,
        method,
        headers,
      },
      (upstreamResponse) => {
        responded = true;
        upstream.setTimeout(idleTimeoutMs);

        const responseHeaders: OutgoingHttpHeaders = { 'cache-control': 'no-store' };

        for (const name of FORWARDED_RESPONSE_HEADERS) {
          const value = upstreamResponse.headers[name];
          if (value !== undefined) responseHeaders[name] = value;
        }

        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

        upstreamResponse.on('data', (chunk: Buffer) => {
          upstreamBytes += chunk.length;

          if (upstreamBytes > maxResponseBytes) {
            upstreamResponse.destroy();
            res.destroy();
          }
        });

        upstreamResponse.on('end', () => {
          record({
            at: new Date().toISOString(),
            attemptId: options.attemptId,
            method,
            path,
            status: upstreamResponse.statusCode ?? 502,
            bytes: upstreamBytes,
            durationMs: Date.now() - startedAt,
          });

          inflight -= 1;
        });

        upstreamResponse.on('error', () => {
          res.destroy();
        });

        upstreamResponse.pipe(res);
      },
    );

    // Two different budgets on one socket: establishing a connection and then waiting
    // for bytes are different failures, and only one of them is worth retrying.
    upstream.setTimeout(connectTimeoutMs, () => {
      upstream.destroy(new Error(`connect timeout after ${String(connectTimeoutMs)}ms`));
    });

    upstream.on('response', () => {
      upstream.setTimeout(idleTimeoutMs, () => {
        upstream.destroy(new Error(`idle timeout after ${String(idleTimeoutMs)}ms`));
      });
    });

    let requestBytes = 0;

    req.on('data', (chunk: Buffer) => {
      requestBytes += chunk.length;

      if (requestBytes > maxRequestBytes) {
        upstream.destroy(new Error('request body exceeded the broker limit'));
        req.destroy();
      }
    });

    upstream.on('error', (error: Error) => {
      inflight = Math.max(0, inflight - 1);

      if (responded) {
        // Bytes are already flowing to the client; the only honest signal left is a
        // truncated response, not a second status line.
        res.destroy();
        return;
      }

      deny(res, {
        startedAt,
        method,
        path,
        status: 502,
        denial: 'upstream',
        message: `Upstream request failed (${error.message}).`,
      });
    });

    // A client that disconnects must not leave an upstream request running.
    res.on('close', () => {
      if (!responded) upstream.destroy(new Error('client closed the connection'));
    });

    req.pipe(upstream);
  });

  // A stalled client must not hold a slot forever. Node's own header timeout is the
  // cheapest defence; the per-request budgets above cover the rest.
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // long model calls are legitimate

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  // The socket is the whole access control for the host side: mode 0600 means only the
  // worker uid can connect, and the directory is 0700.
  await chmod(socketPath, 0o600);
  listening = true;

  return {
    socketPath,
    get requestCount(): number {
      return requests;
    },
    get logs(): readonly BrokerRequestLog[] {
      return logs;
    },
    async ready(): Promise<boolean> {
      if (!listening) return false;

      return new Promise<boolean>((resolvePromise) => {
        const probe = httpRequest(
          {
            socketPath,
            path: HEALTH_PATH,
            method: 'GET',
            headers: { 'x-iz-broker-token': options.capabilityToken },
            timeout: 5_000,
          },
          (response) => {
            response.resume();
            response.on('end', () => resolvePromise(response.statusCode === 200));
          },
        );

        probe.on('error', () => resolvePromise(false));
        probe.on('timeout', () => {
          probe.destroy();
          resolvePromise(false);
        });
        probe.end();
      });
    },
    async close(): Promise<void> {
      listening = false;

      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await logQueue.catch(() => undefined);
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

/**
 * Measure a credential read without exposing the value.
 *
 * Used by the proof script: the report needs a latency figure for "read at request
 * time" to be a claim rather than an intention, and the only safe way to publish a
 * measurement of a secret read is to publish the duration.
 */
export function credentialReadLatencyMs(source: CredentialSource): number {
  const startedAt = process.hrtime.bigint();

  readCredential(source);

  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
