import { createServer, type Server } from 'node:http';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOWED_PATHS,
  resolveUpstreamUrl,
  startEgressBroker,
  tokensMatch,
  type BrokerRequestLog,
  type EgressBroker,
} from '../src';

/**
 * The broker, exercised over its real socket against a real upstream listener.
 *
 * Every test here is a request the sandbox could make. The point is not that the
 * broker's `handle()` returns 403 — it is that a client holding the wrong token, or
 * naming the wrong destination, gets nothing, and that the refusal is recorded as
 * evidence rather than as silence.
 */

const REAL_CREDENTIAL = 'iz-upstream-credential-abcdefghijklmnop';
const CAPABILITY = 'iz-canary-this-attempt-only-0123456789';
const OTHER_CAPABILITY = 'iz-canary-a-different-attempt-9876543210';

interface UpstreamSeen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly apiKey: string | undefined;
  readonly cookie: string | undefined;
  readonly proxyAuthorization: string | undefined;
  readonly acceptEncoding: string | undefined;
  readonly bodyBytes: number;
}

interface WireResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function call(
  socketPath: string,
  input: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
): Promise<WireResponse> {
  return new Promise((resolvePromise, reject) => {
    const payload = input.body ?? '';
    const probe = request(
      {
        socketPath,
        method: input.method ?? 'POST',
        path: input.path ?? '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(input.headers ?? {}),
        },
        timeout: 15_000,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers,
          }),
        );
      },
    );

    probe.on('error', reject);
    probe.on('timeout', () => {
      probe.destroy(new Error('probe timeout'));
    });
    probe.end(payload);
  });
}

describe('egress broker', () => {
  let upstream: Server;
  let upstreamUrl: string;
  let seen: UpstreamSeen[];
  let directory: string;
  let broker: EgressBroker;
  let logFile: string;
  let delayMs = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'intelligenz-broker-'));
    seen = [];

    upstream = createServer((req, res) => {
      let bytes = 0;

      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });

      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers['authorization'],
          apiKey: req.headers['x-api-key'] as string | undefined,
          cookie: req.headers['cookie'],
          proxyAuthorization: req.headers['proxy-authorization'] as string | undefined,
          acceptEncoding: req.headers['accept-encoding'],
          bodyBytes: bytes,
        });

        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id: 'chatcmpl-test' }));
        }, delayMs);
      });
    });

    await new Promise<void>((resolvePromise) => {
      upstream.listen(0, '127.0.0.1', () => resolvePromise());
    });

    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('no upstream address');

    upstreamUrl = `http://127.0.0.1:${String(address.port)}/v1`;
    logFile = join(directory, 'broker.ndjson');

    broker = await startEgressBroker({
      socketDir: join(directory, 'socket'),
      attemptId: 'attempt-a',
      capabilityToken: CAPABILITY,
      upstream: {
        baseUrl: upstreamUrl,
        credential: { kind: 'env', name: 'IZ_BROKER_TEST_CREDENTIAL' },
      },
      maxRequestBytes: 4096,
      maxRequests: 50,
      logFile,
    });

    process.env.IZ_BROKER_TEST_CREDENTIAL = REAL_CREDENTIAL;
  });

  afterAll(async () => {
    await broker.close();
    delete process.env.IZ_BROKER_TEST_CREDENTIAL;
    await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts a request that carries the attempt capability', async () => {
    const response = await call(broker.socketPath, {
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('chatcmpl-test');
  });

  it('injects the real credential and strips every inbound auth header', async () => {
    seen = [];

    await call(broker.socketPath, {
      headers: {
        // What a compromised agent would send if it found a key of its own, wanted to
        // confuse the broker, or tried to smuggle the operator's session.
        authorization: `Bearer ${CAPABILITY}`,
        'x-api-key': 'attacker-supplied-key',
        cookie: 'session=operator',
        'proxy-authorization': 'Basic attacker',
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    expect(seen).toHaveLength(1);
    const request = seen[0];

    expect(request?.authorization).toBe(`Bearer ${REAL_CREDENTIAL}`);
    expect(request?.apiKey).toBeUndefined();
    expect(request?.cookie).toBeUndefined();
    expect(request?.proxyAuthorization).toBeUndefined();
    // Stripped so the broker never has to decompress a stream it is passing through.
    expect(request?.acceptEncoding).toBeUndefined();
  });

  it('maps the sandbox path onto the configured upstream, and nowhere else', async () => {
    seen = [];

    await call(broker.socketPath, {
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: '{}',
    });

    expect(seen[0]?.url).toBe('/v1/chat/completions');
  });

  it('refuses a request with no capability token', async () => {
    const response = await call(broker.socketPath, { body: '{}' });

    expect(response.status).toBe(403);
    expect(response.body).toContain('BROKER_TOKEN');
  });

  it("refuses another attempt's token", async () => {
    const other = await startEgressBroker({
      socketDir: join(directory, 'socket-b'),
      attemptId: 'attempt-b',
      capabilityToken: OTHER_CAPABILITY,
      upstream: {
        baseUrl: upstreamUrl,
        credential: { kind: 'env', name: 'IZ_BROKER_TEST_CREDENTIAL' },
      },
    });

    try {
      // Each token works only on its own broker.
      expect(
        (await call(broker.socketPath, { headers: { authorization: `Bearer ${OTHER_CAPABILITY}` } }))
          .status,
      ).toBe(403);
      expect(
        (await call(other.socketPath, { headers: { authorization: `Bearer ${CAPABILITY}` } })).status,
      ).toBe(403);
      expect(
        (await call(other.socketPath, { headers: { authorization: `Bearer ${OTHER_CAPABILITY}` } }))
          .status,
      ).toBe(200);
    } finally {
      await other.close();
    }
  });

  it('refuses a destination that is not an approved path', async () => {
    const response = await call(broker.socketPath, {
      path: '/v1/secrets',
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain('BROKER_PATH');
  });

  it('refuses a path traversal dressed as an approved endpoint', async () => {
    const response = await call(broker.socketPath, {
      path: '/v1/chat/completions/../../../admin',
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: '{}',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a method the broker does not serve', async () => {
    const response = await call(broker.socketPath, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${CAPABILITY}` },
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain('BROKER_METHOD');
  });

  it('refuses a request body over the configured ceiling', async () => {
    const response = await call(broker.socketPath, {
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: JSON.stringify({ padding: 'x'.repeat(8192) }),
    });

    expect(response.status).toBe(413);
  });

  it('refuses with 403 rather than sending an empty credential when the store has none', async () => {
    const broken = await startEgressBroker({
      socketDir: join(directory, 'socket-c'),
      attemptId: 'attempt-c',
      capabilityToken: 'iz-canary-attempt-c-0123456789',
      upstream: {
        baseUrl: upstreamUrl,
        credential: { kind: 'env', name: 'IZ_BROKER_TEST_ABSENT' },
      },
    });

    try {
      const response = await call(broken.socketPath, {
        headers: { authorization: 'Bearer iz-canary-attempt-c-0123456789' },
        body: '{}',
      });

      // 403, not 503: a retryable status makes the provider SDK retry a condition that
      // cannot change. Measured against opencode: 503 → 9 retries in 60 s; 403 → exit
      // in 2 s.
      expect(response.status).toBe(403);
      expect(response.body).toContain('BROKER_CREDENTIAL');
    } finally {
      await broken.close();
    }
  });

  it('reports itself unready once closed, which is what a preflight depends on', async () => {
    const ephemeral = await startEgressBroker({
      socketDir: join(directory, 'socket-ready'),
      attemptId: 'attempt-ready',
      capabilityToken: 'iz-canary-attempt-ready-0123456789',
      upstream: {
        baseUrl: upstreamUrl,
        credential: { kind: 'env', name: 'IZ_BROKER_TEST_CREDENTIAL' },
      },
    });

    expect(await ephemeral.ready()).toBe(true);
    await ephemeral.close();
    expect(await ephemeral.ready()).toBe(false);
  });

  it('enforces the per-attempt request counter', async () => {
    const limited = await startEgressBroker({
      socketDir: join(directory, 'socket-d'),
      attemptId: 'attempt-d',
      capabilityToken: 'iz-canary-attempt-d-0123456789',
      upstream: {
        baseUrl: upstreamUrl,
        credential: { kind: 'env', name: 'IZ_BROKER_TEST_CREDENTIAL' },
      },
      maxRequests: 2,
    });

    try {
      const headers = { authorization: 'Bearer iz-canary-attempt-d-0123456789' };
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        statuses.push((await call(limited.socketPath, { headers, body: '{}' })).status);
      }

      expect(statuses.slice(0, 2)).toEqual([200, 200]);
      expect(statuses.slice(2)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });

  it('enforces bounded concurrency', async () => {
    const serial = await startEgressBroker({
      socketDir: join(directory, 'socket-e'),
      attemptId: 'attempt-e',
      capabilityToken: 'iz-canary-attempt-e-0123456789',
      upstream: {
        baseUrl: upstreamUrl,
        credential: { kind: 'env', name: 'IZ_BROKER_TEST_CREDENTIAL' },
      },
      maxConcurrent: 1,
    });

    delayMs = 700;

    try {
      const headers = { authorization: 'Bearer iz-canary-attempt-e-0123456789' };
      const first = call(serial.socketPath, { headers, body: '{}' });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));

      const second = await call(serial.socketPath, { headers, body: '{}' });

      expect(second.status).toBe(429);
      expect((await first).status).toBe(200);
    } finally {
      delayMs = 0;
      await serial.close();
    }
  });

  it('records every decision without a token, a header or a body', async () => {
    await broker.close();

    const lines = (await readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as BrokerRequestLog);

    expect(lines.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(lines);

    expect(serialised).not.toContain(REAL_CREDENTIAL);
    expect(serialised).not.toContain(CAPABILITY);
    expect(serialised).not.toContain(OTHER_CAPABILITY);

    // Shape check: exactly the documented fields, nothing free-form.
    for (const entry of lines) {
      expect(Object.keys(entry).sort()).toEqual(
        ['at', 'attemptId', 'bytes', 'durationMs', 'method', 'path', 'status'].concat(
          entry.denied === undefined ? [] : ['denied'],
        ).sort(),
      );
      expect(entry.attemptId).toBe('attempt-a');
    }

    // Tidy up for the remaining assertions in this file.
    broker = await startEgressBroker({
      socketDir: join(directory, 'socket'),
      attemptId: 'attempt-a',
      capabilityToken: CAPABILITY,
      upstream: {
        baseUrl: upstreamUrl,
        credential: { kind: 'env', name: 'IZ_BROKER_TEST_CREDENTIAL' },
      },
      logFile,
    });
  });

  it('creates a 0600 socket in a 0700 directory', async () => {
    const socketMode = (await stat(join(directory, 'socket', 'broker.sock'))).mode & 0o777;
    const directoryMode = (await stat(join(directory, 'socket'))).mode & 0o777;

    expect(socketMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
  });
});

describe('resolveUpstreamUrl', () => {
  it('appends the sandbox path to the configured base', () => {
    expect(
      resolveUpstreamUrl('https://api.example.test/v1beta/openai', '/v1/chat/completions')
        ?.toString(),
    ).toBe('https://api.example.test/v1beta/openai/chat/completions');
  });

  it('never leaves the configured origin', () => {
    for (const path of [
      '/v1//evil.test/x',
      '/v1/../../etc/passwd',
      '/v1/..%2f..%2fadmin',
      '/v1/chat/../..',
    ]) {
      const resolved = resolveUpstreamUrl('https://api.example.test/v1', path);

      if (resolved !== null) {
        expect(resolved.origin).toBe('https://api.example.test');
        expect(resolved.pathname.startsWith('/v1/')).toBe(true);
      }
    }
  });

  it('rejects a base that is not a URL', () => {
    expect(() => resolveUpstreamUrl('not-a-url', '/v1/chat/completions')).toThrow();
  });

  it('ships an allowlist that covers the OpenAI-compatible surface and nothing else', () => {
    expect(DEFAULT_ALLOWED_PATHS).toContain('/v1/chat/completions');
    expect(DEFAULT_ALLOWED_PATHS).not.toContain('/v1/files');
    expect(DEFAULT_ALLOWED_PATHS).not.toContain('/');
  });
});

describe('tokensMatch', () => {
  it('is exact and rejects undefined', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abcd', 'abc')).toBe(false);
    expect(tokensMatch(undefined, 'abc')).toBe(false);
    expect(tokensMatch('', '')).toBe(true);
  });
});
