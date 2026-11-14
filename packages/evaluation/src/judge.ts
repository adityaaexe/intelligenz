/**
 * Judges: five deterministic assertions over the workspace as the run left it.
 *
 * There is no LLM in this file on purpose. A benchmark that needs a model to decide
 * whether it passed cannot be trusted to tell you whether a model is any good — the
 * judge would inherit the failure modes it is supposed to measure.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { judgeDimension } from './benchmark';
import {
  judgeEnvironment,
  readTextIfSmall,
  resolveArgv,
  runProcess,
  sha256File,
} from './exec';
import type { Benchmark, Judge, JudgeDimension, JudgeResultView } from './types';
import { changedFiles } from './workspace';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

/** Absolute paths are used as-is; everything else resolves inside the workspace. */
export function resolveJudgePath(workspace: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workspace, path);
}

function clip(text: string, limit = 240): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

function dimensionOf(judge: Judge): JudgeDimension {
  return judgeDimension(judge);
}

/**
 * `diff-files` credit is graded rather than binary.
 *
 * The judge's `passed` status is still strict — more than `maxChanged` files *fails* —
 * but the dimension credit decays instead of collapsing, because "four files instead of
 * two" is a smaller indictment than "the agent rewrote the repository", and a rubric
 * that cannot tell those apart is not measuring diff quality.
 */
export function diffCredit(changed: number, maxChanged: number): number {
  if (changed <= maxChanged) return 1;
  if (maxChanged === 0) return 0;
  const overshoot = changed - maxChanged;
  return Math.max(0, (maxChanged - overshoot) / maxChanged);
}

interface JudgeFailure {
  readonly status: 'failed' | 'error';
  readonly detail: string;
  readonly credit: number;
}

function failed(detail: string): JudgeFailure {
  return { status: 'failed', detail: clip(detail), credit: 0 };
}

function errored(detail: string): JudgeFailure {
  return { status: 'error', detail: clip(detail), credit: 0 };
}

export async function runJudges(
  benchmark: Benchmark,
  workspace: string,
  baseCommit: string,
): Promise<readonly JudgeResultView[]> {
  const results: JudgeResultView[] = [];
  let changedCount: number | null = null;

  for (const [index, judge] of benchmark.judge.entries()) {
    const startedAt = Date.now();
    const dimension = dimensionOf(judge);

    let outcome: JudgeFailure | { status: 'passed'; detail: string; credit: number };

    switch (judge.type) {
      case 'command': {
        const argv = resolveArgv(judge.argv);
        const file = argv[0] ?? '';
        const args = argv.slice(1);

        if (file.length === 0) {
          outcome = errored('argv is empty');
          break;
        }

        const run = await runProcess(file, args, {
          cwd: workspace,
          env: judgeEnvironment(workspace),
          timeoutMs: judge.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        });

        if (run.spawnError !== null) {
          outcome = errored(`${file} could not be spawned (${run.spawnError})`);
          break;
        }

        if (run.timedOut) {
          outcome = failed(
            `command timed out after ${String(judge.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)}ms`,
          );
          break;
        }

        const passed = run.code === judge.expectExit;
        const observed = `exit ${String(run.code)} (expected ${String(judge.expectExit)})`;
        const tail = run.stderr.trim().length > 0 ? `: ${run.stderr}` : run.stdout;

        outcome = {
          status: passed ? 'passed' : 'failed',
          detail: passed ? observed : clip(`${observed} — ${tail}`),
          credit: passed ? 1 : 0,
        };
        break;
      }

      case 'file-equals': {
        const path = resolveJudgePath(workspace, judge.path);
        const digest = await sha256File(path);

        if (digest === null) {
          outcome = failed(`${judge.path} is missing`);
          break;
        }

        const passed = digest === judge.sha256;
        outcome = {
          status: passed ? 'passed' : 'failed',
          detail: passed ? `sha256 ${digest}` : clip(`sha256 ${digest} != ${judge.sha256}`),
          credit: passed ? 1 : 0,
        };
        break;
      }

      case 'file-absent': {
        const path = resolveJudgePath(workspace, judge.path);
        const exists = await stat(path)
          .then(() => true)
          .catch(() => false);

        outcome = exists
          ? failed(`${judge.path} exists`)
          : { status: 'passed', detail: `${judge.path} absent`, credit: 1 };
        break;
      }

      case 'grep': {
        const path = resolveJudgePath(workspace, judge.path);
        const text = await readTextIfSmall(path, MAX_SCANNED_FILE_BYTES);

        if (text === null) {
          outcome =
            judge.expect === 'absent'
              ? { status: 'passed', detail: `${judge.path} absent or unreadable`, credit: 1 }
              : failed(`${judge.path} is missing or unreadable`);
          break;
        }

        let matched: boolean;
        try {
          matched = new RegExp(judge.pattern, 'm').test(text);
        } catch {
          outcome = errored('pattern is not a valid regular expression');
          break;
        }

        const passed = judge.expect === 'present' ? matched : !matched;
        outcome = {
          status: passed ? 'passed' : 'failed',
          detail: passed
            ? `${judge.path}: /${judge.pattern}/ ${judge.expect === 'present' ? 'found' : 'absent'}`
            : `${judge.path}: /${judge.pattern}/ unexpectedly ${matched ? 'found' : 'absent'}`,
          credit: passed ? 1 : 0,
        };
        break;
      }

      case 'diff-files': {
        if (changedCount === null) {
          changedCount = (await changedFiles(workspace, baseCommit)).length;
        }

        const passed = changedCount <= judge.maxChanged;
        outcome = {
          status: passed ? 'passed' : 'failed',
          detail: `${String(changedCount)} file(s) changed (max ${String(judge.maxChanged)})`,
          credit: diffCredit(changedCount, judge.maxChanged),
        };
        break;
      }
    }

    results.push({
      index,
      type: judge.type,
      dimension,
      status: outcome.status,
      credit: Math.round(outcome.credit * 1000) / 1000,
      detail: outcome.detail,
      durationMs: Date.now() - startedAt,
    });
  }

  return results;
}
