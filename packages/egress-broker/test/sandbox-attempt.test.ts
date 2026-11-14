import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startEgressBroker, type EgressBroker } from '../src';

/**
 * The broker, attacked from **inside a real `bwrap` sandbox**.
 *
 * A unit test that calls the request handler would prove the handler returns 403. It
 * would not prove that a process with no credentials, no network and a shell can only
 * reach the broker — which is the actual claim. So every attempt below is a real
 * `bwrap` run with `--unshare-net`, a read-only root and one bound socket.
 *
 * The client is deliberately written as the worst case: it is a program the agent could
 * have written itself, it speaks raw HTTP, and it holds whatever the sandbox holds.
 */

const REAL_CREDENTIAL = 'iz-sandbox-upstream-credential-0123456789';
const CAPABILITY = 'iz-canary-attempt-in-sandbox-0123456789';
const OTHER_CAPABILITY = 'iz-canary-attempt-somewhere-else-9876543210';
const RELAY_PORT = 8899;

interface ClientResult {
  readonly brokered: Record<string, { status: number; body: string }>;
  readonly directTcp: string;
  readonly dns: string;
  readonly canReadHostHome: boolean;
}

const CLIENT_SOURCE = `
import net from 'node:net';
import http from 'node:http';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';

const relay = net.createServer((client) => {
  const upstream = net.connect('/run/agent-broker/broker.sock');
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});

await new Promise((res, rej) => {
  relay.once('error', rej);
  relay.listen(${String(RELAY_PORT)}, '127.0.0.1', res);
});

const call = (path, headers, method) =>
  new Promise((res) => {
    const body = JSON.stringify({ model: 'test', messages: [] });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: ${String(RELAY_PORT)},
        path,
        method: method ?? 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
        timeout: 8000,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => res({ status: response.statusCode, body: text }));
      },
    );
    req.on('error', (error) => res({ status: 0, body: String(error.message) }));
    req.on('timeout', () => { req.destroy(); res({ status: 0, body: 'timeout' }); });
    req.end(body);
  });

const brokered = {};
brokered.withToken = await call('/v1/chat/completions', { authorization: 'Bearer ${CAPABILITY}' });
brokered.noToken = await call('/v1/chat/completions', {});
brokered.otherAttemptToken = await call('/v1/chat/completions', { authorization: 'Bearer ${OTHER_CAPABILITY}' });
brokered.unapprovedPath = await call('/v1/admin', { authorization: 'Bearer ${CAPABILITY}' });
brokered.methodNotAllowed = await call('/v1/chat/completions', { authorization: 'Bearer ${CAPABILITY}' }, 'DELETE');

const directTcp = await new Promise((res) => {
  const socket = net.connect(443, '1.1.1.1');
  const timer = setTimeout(() => { socket.destroy(); res('timeout'); }, 4000);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); res('REACHABLE'); });
  socket.on('error', (error) => { clearTimeout(timer); res('blocked:' + error.code); });
});

const dns = await new Promise((res) => {
  import('node:dns').then((dns) =>
    dns.lookup('api.commandcode.ai', (error, address) => res(error ? 'blocked:' + error.code : 'resolved:' + address)),
  );
});

let canReadHostHome = false;
try {
  readFileSync('/tmp/home/.local/share/opencode/opencode.db');
  canReadHostHome = true;
} catch {}

process.stdout.write(JSON.stringify({ brokered, directTcp, dns, canReadHostHome }));
relay.close();
process.exit(0);
`;

describe('the broker from inside a real sandbox', () => {
  let directory: string;
  let upstream: Server;
  let upstreamSeen: string[];
  let broker: EgressBroker;
  let result: ClientResult;
  let logPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'intelligenz-broker-sandbox-'));
    upstreamSeen = [];
    logPath = join(directory, 'broker.ndjson');

    upstream = createServer((req, res) => {
      upstreamSeen.push(String(req.headers['authorization'] ?? ''));
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolvePromise) => {
      upstream.listen(0, '127.0.0.1', () => resolvePromise());
    });

    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('no upstream address');

    broker = await startEgressBroker({
      socketDir: join(directory, 'socket'),
      attemptId: 'attempt-sandbox',
      capabilityToken: CAPABILITY,
      upstream: {
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        credential: { kind: 'env', name: 'IZ_BROKER_SANDBOX_TEST_CREDENTIAL' },
      },
      logFile: logPath,
      maxRequests: 20,
    });

    process.env.IZ_BROKER_SANDBOX_TEST_CREDENTIAL = REAL_CREDENTIAL;

    const clientDir = join(directory, 'client');
    const workspace = join(directory, 'workspace');

    await mkdir(join(workspace, 'repo'), { recursive: true });
    await mkdir(clientDir, { recursive: true });
    await writeFile(join(clientDir, 'run.mjs'), CLIENT_SOURCE, { mode: 0o500 });

    const nodeRoot = dirname(dirname(resolve(process.execPath)));
    const bwrap = [
      '/usr/bin/bwrap',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/bin',
      '/bin',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind',
      '/lib64',
      '/lib64',
      '--ro-bind',
      '/etc',
      '/etc',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/run',
      '--dir',
      '/tmp/home',
      '--bind',
      join(workspace, 'repo'),
      '/workspace',
      '--ro-bind',
      clientDir,
      '/client',
      '--ro-bind',
      nodeRoot,
      nodeRoot,
      // Exactly one host path is bound for the agent's use: the socket.
      '--ro-bind',
      join(directory, 'socket'),
      '/run/agent-broker',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-net',
      '--new-session',
      '--die-with-parent',
      '--clearenv',
      '--setenv',
      'PATH',
      `${join(nodeRoot, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
      '--setenv',
      'HOME',
      '/tmp/home',
      '--chdir',
      '/workspace',
      join(nodeRoot, 'bin', 'node'),
      '/client/run.mjs',
    ];

    const stdout = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        bwrap[0] as string,
        bwrap.slice(1),
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, out, err) => {
          if (error !== null && out.trim().length === 0) {
            reject(new Error(`sandbox failed: ${error.message} ${err.slice(0, 500)}`));
            return;
          }

          resolvePromise(out);
        },
      );
    });

    result = JSON.parse(stdout.trim()) as ClientResult;
  }, 120_000);

  afterAll(async () => {
    await broker.close();
    delete process.env.IZ_BROKER_SANDBOX_TEST_CREDENTIAL;
    await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  });

  it('serves a request that carries this attempt\'s capability', () => {
    expect(result.brokered.withToken?.status).toBe(200);
    // And the upstream saw the real credential, not the capability.
    expect(upstreamSeen).toContain(`Bearer ${REAL_CREDENTIAL}`);
    expect(upstreamSeen).not.toContain(`Bearer ${CAPABILITY}`);
  });

  it('refuses a request with no capability token', () => {
    expect(result.brokered.noToken?.status).toBe(403);
    expect(result.brokered.noToken?.body).toContain('BROKER_TOKEN');
  });

  it("refuses another attempt's capability token", () => {
    expect(result.brokered.otherAttemptToken?.status).toBe(403);
    expect(result.brokered.otherAttemptToken?.body).toContain('BROKER_TOKEN');
  });

  it('refuses an unapproved upstream path', () => {
    expect(result.brokered.unapprovedPath?.status).toBe(403);
    expect(result.brokered.unapprovedPath?.body).toContain('BROKER_PATH');
  });

  it('refuses a method outside the model surface', () => {
    expect(result.brokered.methodNotAllowed?.status).toBe(403);
  });

  it('has no direct egress and no DNS', () => {
    expect(result.directTcp).not.toBe('REACHABLE');
    expect(result.dns.startsWith('blocked:')).toBe(true);
  });

  it('cannot read the host credential store from the sandbox', () => {
    expect(result.canReadHostHome).toBe(false);
  });

  it('wrote a log with no credential and no token in it', async () => {
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');

    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.join('\n')).not.toContain(REAL_CREDENTIAL);
    expect(lines.join('\n')).not.toContain(CAPABILITY);

    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry['attemptId']).toBe('attempt-sandbox');
      expect(typeof entry['method']).toBe('string');
      expect(typeof entry['path']).toBe('string');
      expect(typeof entry['status']).toBe('number');
    }
  });
});
