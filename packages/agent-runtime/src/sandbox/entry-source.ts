/**
 * Source of the sandbox entry shim, as a string.
 *
 * It is written to `<runDir>/entry/sandbox-entry.mjs` at execution time and mounted
 * read-only at `/opt/agent/sandbox-entry.mjs`. Inlined rather than shipped as an
 * asset because `apps/worker` compiles this package to CommonJS, where `import.meta`
 * does not exist — a file-path lookup would tie the adapter to one module system.
 *
 * The shim does three things inside the sandbox:
 *
 *   1. listens on `127.0.0.1:$IZ_BROKER_PORT` and pipes every byte to the unix socket
 *      the host bound in (`$IZ_BROKER_SOCKET`). Loopback inside a fresh network
 *      namespace is real, so this is a working TCP endpoint that terminates at the
 *      host's egress broker — not at the internet;
 *   2. applies resource ceilings with `prlimit` before exec'ing the agent, so a
 *      runaway tool call cannot take the host down with it;
 *   3. spawns the agent with no proxy variables at all.
 *
 * ## Why there is no `HTTPS_PROXY` any more
 *
 * Phase 3 pointed the agent at a host proxy that tunnelled `CONNECT` to an allowlist of
 * provider hosts on 443. That kept the credential *working* but it did not keep it
 * *out*: opencode still read the key from the mounted database. Phase 4 moves
 * authentication to the broker, so the relay only has to carry requests that the agent
 * is already authorised to make, and a general TLS tunnel would be a second, unneeded
 * egress path. There is now no proxy variable and no `CONNECT` tunnel: the only socket
 * the sandbox can reach is this one, and the host decides where it goes.
 *
 * ## What `prlimit` cannot do
 *
 * `RLIMIT_NPROC` is per **real uid**, not per process tree. The sandbox runs as the
 * worker's uid (there is no user namespace on this host), so the ceiling counts every
 * process the worker already has. It is a coarse backstop against a fork bomb, not a
 * per-run quota; cgroup v2 `pids.max` inside a delegated scope is the correct control.
 * `RLIMIT_AS` bounds virtual address space, not RSS.
 *
 * No template literals or `${` inside, deliberately: this string is embedded in one.
 */
export const SANDBOX_ENTRY_SOURCE = `#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const socketPath = process.env.IZ_BROKER_SOCKET;
const port = Number(process.env.IZ_BROKER_PORT || '8899');
const argv = process.argv.slice(2);

if (!socketPath) {
  process.stderr.write('sandbox-entry: IZ_BROKER_SOCKET is not set; refusing to start without a model channel\\n');
  process.exit(78);
}

if (argv.length === 0) {
  process.stderr.write('sandbox-entry: no command given\\n');
  process.exit(78);
}

const PRLIMIT = '/usr/bin/prlimit';

function limitArgs() {
  const out = [];

  const add = (flag, raw, minimum) => {
    if (raw === undefined || raw === '') return;

    const value = Number(raw);

    if (!Number.isInteger(value) || value < minimum) {
      process.stderr.write('sandbox-entry: ignoring invalid ' + flag + ' value ' + String(raw) + '\\n');
      return;
    }

    // util-linux parses the long form as one argv element (flag=value); passing the
    // number separately makes prlimit treat it as the command to execute.
    out.push(flag + '=' + String(value));
  };

  add('--nofile', process.env.AGENT_RLIMIT_NOFILE, 64);
  add('--nproc', process.env.AGENT_RLIMIT_NPROC, 64);
  add('--as', process.env.AGENT_RLIMIT_AS, 268435456);

  return out;
}

const requested = limitArgs();
let executable = argv[0];
let childArgv = argv.slice(1);

if (requested.length > 0) {
  if (existsSync(PRLIMIT)) {
    executable = PRLIMIT;
    childArgv = [...requested, '--', argv[0], ...argv.slice(1)];
  } else {
    process.stderr.write('sandbox-entry: prlimit is unavailable; resource ceilings were NOT applied\\n');
  }
}

const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);

  client.pipe(upstream);
  upstream.pipe(client);

  client.on('error', () => upstream.destroy());
  upstream.on('error', () => {
    // The broker is gone. Say so; do not retry elsewhere. There is nowhere else.
    client.destroy();
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const child = spawn(executable, childArgv, {
  stdio: 'inherit',
  // No HTTPS_PROXY, no HTTP_PROXY, no NO_PROXY: the agent speaks plain HTTP to
  // loopback, and the broker — not the agent — chooses the upstream.
  env: { ...process.env },
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('exit', (code, signal) => {
  server.close();
  if (signal) process.exit(143);
  process.exit(code === null ? 1 : code);
});
`;
