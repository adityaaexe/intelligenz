import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EGRESS_PORT, permitted, splitAuthority, startEgressProxy, type EgressProxy } from '../src';

/**
 * F4 regression: `network: false` was overstated.
 *
 * The audit measured that the sandboxed agent could speak proxy protocol to the egress
 * socket and tunnel to an allowlisted host **on any port**: `CONNECT api.commandcode.ai:22`
 * returned `200 Connection Established`. That is not "no network" — it is a general
 * egress path wearing a proxy's clothes.
 *
 * The policy is now: exact host match, port 443 only, `CONNECT` only. These tests drive
 * a real unix-socket client against a real proxy instance; the refusal is a real 403,
 * not a function return value.
 */

const HOST = 'api.example.test';

/** Send one proxy request and return the status line, whatever it is. */
function probe(proxy: EgressProxy, requestLine: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(proxy.socketPath);
    let response = '';

    socket.setTimeout(5_000);

    socket.once('connect', () => {
      socket.write(`${requestLine}\r\nHost: ${HOST}\r\n\r\n`);
    });

    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
    });

    socket.on('close', () => resolvePromise(response));
    socket.on('timeout', () => {
      socket.destroy();
      resolvePromise(response);
    });
    socket.on('error', reject);
  });
}

describe('egress proxy', () => {
  let dir: string;
  let proxy: EgressProxy;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'intelligenz-egress-'));
    proxy = await startEgressProxy({ socketDir: dir, allowHosts: [HOST] });
  });

  afterAll(async () => {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses CONNECT to an allowlisted host on a non-443 port, and logs it', async () => {
    const response = await probe(proxy, `CONNECT ${HOST}:22 HTTP/1.1`);

    expect(response).toContain('403');
    expect(response).not.toContain('200 Connection Established');

    const entry = proxy.requests.at(-1);
    expect(entry).toMatchObject({ host: HOST, port: 22, allowed: false, method: 'CONNECT' });
  });

  it('refuses CONNECT to a host that is not on the list, even on 443', async () => {
    const response = await probe(proxy, 'CONNECT evil.example.test:443 HTTP/1.1');

    expect(response).toContain('403');
    expect(proxy.requests.at(-1)).toMatchObject({ host: 'evil.example.test', port: 443, allowed: false });
  });

  it('refuses a suffix look-alike of an allowlisted host', async () => {
    const response = await probe(proxy, `CONNECT ${HOST}.evil.example:443 HTTP/1.1`);

    expect(response).toContain('403');
  });

  it('refuses absolute-form HTTP, so there is no second egress path', async () => {
    const response = await probe(proxy, `GET http://${HOST}/v1/models HTTP/1.1`);

    expect(response).toContain('403');
    expect(proxy.requests.at(-1)).toMatchObject({ method: 'GET', allowed: false });
  });

  it('accepts the allowlisted host on 443 at the policy layer (the upstream may not exist)', async () => {
    const response = await probe(proxy, `CONNECT ${HOST}:443 HTTP/1.1`);
    const entry = proxy.requests.at(-1);

    // The hostname does not resolve in this test environment, so the tunnel cannot be
    // established — but the *policy* decision is recorded as allowed, which is what a
    // future regression in the port check would change.
    expect(entry).toMatchObject({ host: HOST, port: 443, allowed: true, method: 'CONNECT' });
    expect(response).not.toContain('403');
  });
});

describe('egress policy primitives', () => {
  it('matches hosts exactly', () => {
    expect(permitted('api.example.test', ['api.example.test'])).toBe(true);
    expect(permitted('API.EXAMPLE.TEST', ['api.example.test'])).toBe(true);
    expect(permitted('api.example.test.evil', ['api.example.test'])).toBe(false);
    expect(permitted('other.api.example.test', ['api.example.test'])).toBe(false);
    // A wildcard is not expanded; it is just a string that will never match.
    expect(permitted('anything.example.test', ['*.example.test'])).toBe(false);
  });

  it('parses IPv4, IPv6 and bare authorities', () => {
    expect(splitAuthority('example.test:443')).toEqual({ host: 'example.test', port: 443 });
    expect(splitAuthority('example.test')).toEqual({ host: 'example.test', port: EGRESS_PORT });
    expect(splitAuthority('[2001:db8::1]:443')).toEqual({ host: '[2001:db8::1]', port: 443 });
    expect(splitAuthority('[2001:db8::1]:8443')).toEqual({ host: '[2001:db8::1]', port: 8443 });
    expect(Number.isNaN(splitAuthority('[2001:db8::1').port)).toBe(true);
  });
});
