/**
 * Validate the programme execution state. Run it before trusting the file.
 *
 *   pnpm programme:check
 *   pnpm programme:check docs/engineering/programme/EXECUTION-STATE.json
 *
 * Exit codes: 0 = valid; 1 = unreadable, not JSON, or a schema violation (each printed
 * with its path). This file is not exported from the package index — it reads the
 * filesystem, and `@intelligenz/contracts` is imported by the browser.
 */
import { readFile } from 'node:fs/promises';

import { openTaskIds, validateProgrammeState } from './programme';

const DEFAULT_PATH = 'docs/engineering/programme/EXECUTION-STATE.json';

async function main(): Promise<void> {
  const path = process.argv[2] ?? DEFAULT_PATH;

  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    process.stderr.write(
      `programme state: cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    process.stderr.write(
      `programme state: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const result = validateProgrammeState(parsed);

  if (!result.ok || result.state === undefined) {
    process.stderr.write(
      `programme state: INVALID — ${String(result.issues.length)} violation(s) in ${path}\n`,
    );

    for (const issue of result.issues) process.stderr.write(`  ${issue}\n`);

    process.exitCode = 1;
    return;
  }

  const state = result.state;
  const open = openTaskIds(state);
  const byStatus = new Map<string, number>();

  for (const task of state.tasks) {
    byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1);
  }

  const lines = [
    `programme state: VALID`,
    `  file      : ${path}`,
    `  branch    : ${state.branch} @ ${state.head.slice(0, 12)}`,
    `  phase     : ${state.phase}`,
    `  tasks     : ${String(state.tasks.length)} (${[...byStatus].map(([status, count]) => `${status}=${String(count)}`).join(' ')})`,
    `  completed : ${state.completedTasks.join(' ') || '(none)'}`,
    `  open      : ${open.join(' ') || '(none)'}`,
    `  updated   : ${state.updatedAt}`,
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`programme state: validator crashed: ${String(error)}\n`);
  process.exitCode = 1;
});
