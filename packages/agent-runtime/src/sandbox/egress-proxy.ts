import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The **only** network channel a sandboxed agent gets.
 *
 * ## Why this exists
 *
 * `--unshare-net` is a real block: it gives the sandbox a network namespace with
 * nothing in it, so `curl` cannot resolve or reach anything. That is what makes the
 * capability honest — but an LLM agent cannot answer without reaching its provider,
 * and the provider is on the internet.
 *
 * Rather than choose between "honest capability" and "working agent", the two are
 * split:
 *
 *   - every process the **agent** can spawn has no IP egress;
 *   - the **model transport** is tunnelled through a unix socket bound into the
 *     sandbox, terminating in this proxy on the host, which speaks only to an
 *     allowlist of provider hosts **on port 443**.
 *
 * ## The policy, exactly
 *
 * - `CONNECT host:port` is accepted only when `host` is an **exact** allowlist entry
 *   and `port` is exactly **443**. Everything else is a `403` and a log line.
 * - Absolute-form HTTP (`GET http://…`) is refused outright: it is not how a provider
 *   is reached, and allowing it would mean a second, TLS-less egress path with its own
 *   port semantics. The only permitted shape is one CONNECT tunnel to one host:443.
 *
 * That is narrower than "an HTTP proxy": the agent cannot use this endpoint to reach
 * an arbitrary port on an allowlisted host, and cannot reach any host that is not on
 * the list. It follows that the agent has **no general egress** — model traffic only,
 * through this allowlisted 443 tunnel, and all other sockets blocked by the network
 * namespace.
 *
 * ## What it does not do
 *
 * It does not inspect TLS (a CONNECT tunnel is opaque), so it cannot tell a provider
 * request from any other request to the same host:443. It does not rate-limit. It is a
 * reachability control, not a content control.
 */

export interface EgressRequestLog {
  readonly at: string;
  readonly host: string;
  /** Resolved destination port. `443` is the only value that can be allowed. */
  readonly port: number;
  readonly allowed: boolean;
  readonly method: string;
}

export interface EgressProxyOptions {
  /** Directory the unix socket is created in. Must be writable by this process. */
  readonly socketDir: string;
  /**
   * Exact hostnames. A `*.suffix` pattern is **not** expanded: it would let a
   * compromised provider subdomain become an egress path, and the adapter's own list
   * has never needed one. Empty means "deny everything".
   */
  readonly allowHosts: readonly string[];
  /** Called for every denied or allowed request, for the report. */
  readonly onRequest?: (entry: EgressRequestLog) => void;
}

export interface EgressProxy {
  readonly socketPath: string;
  readonly requests: readonly EgressRequestLog[];
  close(): Promise<void>;
}

/** The only port this proxy will tunnel to. */
export const EGRESS_PORT = 443;

/**
 * `[::1]:443`, `host:443`, or a bare `host` (defaults to 443, the only useful port
 * here). Split explicitly rather than with `split(':').pop()`, which turns
 * `[2001:db8::1]:443` into `1]:443` and would then compare a mangled host.
 */
export function splitAuthority(authority: string): { host: string; port: number } {
  const trimmed = authority.trim().toLowerCase();

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return { host: trimmed, port: Number.NaN };

    const host = trimmed.slice(0, end + 1);
    const rest = trimmed.slice(end + 1);

    return {
      host,
      port: rest.startsWith(':') ? Number(rest.slice(1)) : EGRESS_PORT,
    };
  }

  const index = trimmed.lastIndexOf(':');

  if (index === -1) return { host: trimmed, port: EGRESS_PORT };

  return { host: trimmed.slice(0, index), port: Number(trimmed.slice(index + 1)) };
}

/** Exact match, case-insensitive. No suffix, no wildcard, no implicit subdomain. */
export function permitted(host: string, allow: readonly string[]): boolean {
  const normalised = host.toLowerCase();

  return allow.some((candidate) => candidate.toLowerCase() === normalised);
}

/**
 * Start the proxy on a unix socket. The socket is `0600`-equivalent in practice: it
 * lives in a directory only the adapter and the sandbox can reach.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const socketPath = join(options.socketDir, 'egress.sock');
  const requests: EgressRequestLog[] = [];

  const record = (host: string, port: number, method: string, allowed: boolean): void => {
    const entry: EgressRequestLog = {
      at: new Date().toISOString(),
      host,
      port,
      allowed,
      method,
    };
    requests.push(entry);
    options.onRequest?.(entry);
  };

  /**
   * Absolute-form HTTP. Refused on purpose — see the header. The request is still
   * logged with its resolved port so a denied attempt is evidence, not a silence.
   */
  const server: Server = createServer((req, res) => {
    const target = req.url ?? '';
    let host = '';
    let port = Number.NaN;

    try {
      const parsed = new URL(target);
      host = parsed.hostname;
      port =
        parsed.port === ''
          ? parsed.protocol === 'https:'
            ? EGRESS_PORT
            : 80
          : Number(parsed.port);
    } catch {
      port = Number.NaN;
    }

    record(host, port, req.method ?? 'GET', false);

    res
      .writeHead(403, {
        'content-type': 'text/plain',
        connection: 'close',
      })
      .end('egress denied: only CONNECT to an allowlisted host on port 443 is permitted');
  });

  // CONNECT: the only tunnel the provider traffic may use.
  server.on('connect', (req, clientSocket, head) => {
    const { host, port } = splitAuthority(req.url ?? '');
    const allowed = port === EGRESS_PORT && permitted(host, options.allowHosts);

    record(host, port, 'CONNECT', allowed);

    if (!allowed) {
      // One refusal body for both failures: a caller learns "denied", not whether the
      // host is unknown or the port is wrong. The log line keeps the distinction.
      clientSocket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      return;
    }

    const upstream = netConnect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  return {
    socketPath,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
