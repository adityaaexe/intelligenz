import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { git, sha256Bytes, writeText } from '../src/exec';
import { runJudges } from '../src/judge';
import type { Benchmark, Judge } from '../src/types';

let root = '';
let workspace = '';
let commit = '';

const SOURCE = 'export const value = 1;\n';
const TEST = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n\ntest('value', () => assert.equal(1, 1));\n";

function benchmark(judge: readonly Judge[]): Benchmark {
  return {
    id: 'judge-unit',
    version: '1.0.0',
    category: 'engineering',
    fixture: 'judge-unit',
    goal: 'Unit-test the judges against a real repository.',
    judge,
    limits: { wallClockMs: 30_000, maxUsd: 0 },
    policyExpectation: 'no-violation',
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'iz-judge-'));
  workspace = join(root, 'repo');

  await writeText(join(workspace, 'src', 'value.js'), SOURCE);
  await writeText(join(workspace, 'test', 'value.test.js'), TEST);
  await writeText(join(workspace, 'package.json'), '{"type":"module"}\n');

  await git(['init', '-q', '-b', 'main'], workspace);
  await git(['add', '-A'], workspace);
  await git(
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      'base',
    ],
    workspace,
  );
  commit = await git(['rev-parse', 'HEAD'], workspace);

  // The run: one file edited, one file added.
  await writeText(join(workspace, 'src', 'value.js'), 'export const value = 2;\n');
  await writeText(join(workspace, 'notes.md'), 'added by the run\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('judges', () => {
  it('passes a command whose exit code matches', async () => {
    const [result] = await runJudges(
      benchmark([{ type: 'command', argv: ['node', '-e', 'process.exit(3)'], expectExit: 3 }]),
      workspace,
      commit,
    );

    expect(result?.status).toBe('passed');
    expect(result?.credit).toBe(1);
  });

  it('fails a command whose exit code does not match', async () => {
    const [result] = await runJudges(
      benchmark([{ type: 'command', argv: ['node', '-e', 'process.exit(0)'], expectExit: 1 }]),
      workspace,
      commit,
    );

    expect(result?.status).toBe('failed');
    expect(result?.detail).toContain('exit 0');
  });

  it('reports a missing binary as a judge error, not an agent failure', async () => {
    const [result] = await runJudges(
      benchmark([{ type: 'command', argv: ['definitely-not-a-binary-xyz'], expectExit: 0 }]),
      workspace,
      commit,
    );

    expect(result?.status).toBe('error');
    expect(result?.detail).toContain('ENOENT');
  });

  it('compares a file against a sha256', async () => {
    const [pass, fail] = await runJudges(
      benchmark([
        { type: 'file-equals', path: 'test/value.test.js', sha256: sha256Bytes(TEST) },
        { type: 'file-equals', path: 'test/value.test.js', sha256: 'b'.repeat(64) },
      ]),
      workspace,
      commit,
    );

    expect(pass?.status).toBe('passed');
    expect(fail?.status).toBe('failed');
  });

  it('checks absence, both relative and absolute', async () => {
    const [pass, fail] = await runJudges(
      benchmark([
        { type: 'file-absent', path: 'never-created.txt' },
        { type: 'file-absent', path: join(workspace, 'notes.md') },
      ]),
      workspace,
      commit,
    );

    expect(pass?.status).toBe('passed');
    expect(fail?.status).toBe('failed');
  });

  it('greps for presence and absence', async () => {
    const [present, absent, wrong] = await runJudges(
      benchmark([
        { type: 'grep', path: 'src/value.js', pattern: 'value = 2', expect: 'present' },
        { type: 'grep', path: 'src/value.js', pattern: 'value = 1', expect: 'absent' },
        { type: 'grep', path: 'src/value.js', pattern: 'value = 3', expect: 'present' },
      ]),
      workspace,
      commit,
    );

    expect(present?.status).toBe('passed');
    expect(absent?.status).toBe('passed');
    expect(wrong?.status).toBe('failed');
  });

  it('treats a missing file as absence for an absent-expectation grep', async () => {
    const [result] = await runJudges(
      benchmark([{ type: 'grep', path: 'nope.md', pattern: 'x', expect: 'absent' }]),
      workspace,
      commit,
    );

    expect(result?.status).toBe('passed');
  });

  it('counts changed files against the base commit, not HEAD', async () => {
    const [result] = await runJudges(benchmark([{ type: 'diff-files', maxChanged: 1 }]), workspace, commit);

    expect(result?.status).toBe('failed');
    expect(result?.detail).toContain('2 file(s) changed');
    expect(result?.credit).toBe(0);
  });

  it('gives partial credit one file past the limit', async () => {
    const [result] = await runJudges(benchmark([{ type: 'diff-files', maxChanged: 1 }]), workspace, commit);
    expect(result?.credit).toBe(0);

    const [lenient] = await runJudges(benchmark([{ type: 'diff-files', maxChanged: 2 }]), workspace, commit);
    expect(lenient?.status).toBe('passed');
    expect(lenient?.credit).toBe(1);
  });
});
