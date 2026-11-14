import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSandboxCommand } from '@intelligenz/workspace-manager';

import { runInProcessGroup } from '../src';

/**
 * F3 regression: a wall-clock kill must reap **descendants**, not just the child.
 *
 * An agent that runs `(sleep 300; curl …) &` would otherwise survive the kill of the
 * `bwrap` process: the adapter would report `timeout`, the crew would move on, and an
 * orphan would still be running inside a namespace with no supervisor. The kill is
 * `SIGTERM` to the process group (`-pid`), then `SIGKILL` to the group after the grace
 * window.
 *
 * Two tests, because the sandbox adds a second reason descendants die (`--unshare-pid`
 * plus `--die-with-parent`) and the group kill must be provable on its own:
 *
 *   1. a plain shell, no sandbox — only the group signal can explain the result;
 *   2. the production path, through `buildSandboxCommand`.
 *
 * Each has a positive control: the same command with a deadline longer than the
 * grandchild's sleep does write the file, so a passing test cannot be a test that never
 * ran anything.
 */

const exists = (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch(() => false);

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

describe('runInProcessGroup', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'intelligenz-pg-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('kills a backgrounded grandchild with the process group', async () => {
    const late = join(dir, 'late-plain.txt');
    const script = `(sleep 2; echo late > ${late}) & sleep 30`;

    const result = await runInProcessGroup({
      file: '/bin/sh',
      args: ['-c', script],
      timeoutMs: 250,
      signal: new AbortController().signal,
      killGraceMs: 250,
      // Required, never defaulted: see `GroupedProcessOptions.env`.
      env: { PATH: '/usr/bin:/bin' },
    });

    expect(result.reason).toBe('timeout');

    // Well past the grandchild's sleep: if it survived the group kill, it has written.
    await sleep(2_800);
    expect(await exists(late)).toBe(false);
  }, 20_000);

  it('positive control: the same script does write when it is allowed to finish', async () => {
    const late = join(dir, 'late-allowed.txt');
    const script = `(sleep 1; echo late > ${late}) & sleep 30`;

    await runInProcessGroup({
      file: '/bin/sh',
      args: ['-c', script],
      timeoutMs: 1_800,
      signal: new AbortController().signal,
      killGraceMs: 250,
      env: { PATH: '/usr/bin:/bin' },
    });

    await sleep(300);
    expect(await exists(late)).toBe(true);
  }, 20_000);

  it('kills a grandchild inside the sandbox the adapter actually uses', async () => {
    const root = join(dir, 'ws');
    await mkdir(join(root, 'repo'), { recursive: true });

    const command = buildSandboxCommand(
      { rootPath: root },
      ['/bin/sh', '-c', '(sleep 2; echo late > /workspace/late-sandbox.txt) & sleep 30'],
      { env: { PATH: '/usr/bin:/bin' } },
    );

    const result = await runInProcessGroup({
      file: command.file,
      args: command.args,
      timeoutMs: 400,
      signal: new AbortController().signal,
      killGraceMs: 500,
      // The builder's scrubbed env, which is what production passes.
      env: command.env,
    });

    expect(result.reason).toBe('timeout');

    await sleep(2_800);
    expect(await exists(join(root, 'repo', 'late-sandbox.txt'))).toBe(false);
  }, 30_000);

  it('reports how it was stopped, so the caller does not have to guess', async () => {
    const controller = new AbortController();
    const pending = runInProcessGroup({
      file: '/bin/sh',
      args: ['-c', 'sleep 30'],
      timeoutMs: 30_000,
      signal: controller.signal,
      killGraceMs: 250,
      env: { PATH: '/usr/bin:/bin' },
    });

    controller.abort();

    expect((await pending).reason).toBe('aborted');
  }, 20_000);
});
