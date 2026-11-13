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
 *   1. listens on `127.0.0.1:$AGENT_PROXY_PORT` and pipes every byte to the unix
 *      socket the host bound in (`$AGENT_PROXY_SOCKET`). Loopback inside a fresh
 *      network namespace is real, so this is a working TCP endpoint that terminates
 *      at the host's allowlisting proxy — not at the internet;
 *   2. applies resource ceilings with `prlimit` before exec'ing the agent, so a
 *      runaway tool call cannot take the host down with it;
 *   3. spawns the agent with `HTTPS_PROXY`/`HTTP_PROXY` pointing at the loopback
 *      listener.
 *
 * Without it, the agent would have to be given the host network namespace, which is
 * exactly the capability the sandbox exists to remove.
 *
 * ## Why `prlimit` and not `bwrap --rlimit-*`
 *
 * The installed `bwrap` (0.11.1 on Ubuntu) does not parse `--rlimit-*`; passing an
 * unknown option fails the whole sandbox. `buildSandboxCommand` therefore emits the
 * flags only when the local binary advertises them, and this wrapper is what actually
 * enforces the ceilings here. `prlimit` is util-linux, present in the read-only `/usr`
 * bind. If it is missing, the limits are skipped **and a line is written to stderr** —
 * a silently unlimited run would be the failure this exists to prevent.
 *
 * ## What `prlimit` cannot do
 *
 * `RLIMIT_NPROC` is per **real uid**, not per process tree. The sandbox runs as the
 * worker's uid (there is no user namespace on this host), so the ceiling counts every
 * process the worker already has. It is a coarse backstop against a fork bomb, not a
 * per-run quota; cgroup v2 `pids.max` inside a delegated scope is the correct control
 * and needs the deployment work ADR-010 owns. `RLIMIT_AS` bounds virtual address
 * space, not RSS, so it stops an allocation runaway but does not cap resident pages.
 * `RLIMIT_FSIZE` bounds a single file, not the total bytes a run may write.
 *
 * No template literals or `${` inside, deliberately: this string is embedded in one.
 */
export const SANDBOX_ENTRY_SOURCE = `#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const socketPath = process.env.AGENT_PROXY_SOCKET;
const port = Number(process.env.AGENT_PROXY_PORT || '8888');
const argv = process.argv.slice(2);

if (!socketPath) {
  process.stderr.write('sandbox-entry: AGENT_PROXY_SOCKET is not set\\n');
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
  upstream.on('error', () => client.destroy());
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const proxyUrl = 'http://127.0.0.1:' + port;
const child = spawn(executable, childArgv, {
  stdio: 'inherit',
  env: {
    ...process.env,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  },
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
