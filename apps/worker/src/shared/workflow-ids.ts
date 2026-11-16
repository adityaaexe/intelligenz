/**
 * `task-` — the derived workflow id space for task executions.
 *
 * It lives here, rather than beside the rest of the worker's configuration in `config.ts`,
 * because a **workflow** reads it: `run-programme.ts` starts every child under
 * `task-<taskId>` so that `POST /cancel` (which cancels exactly that id) and the
 * pre-dispatch completion arm (which requires exactly that id) can both reach the
 * execution. The Temporal sandbox refuses to bundle `config.ts` — it imports `node:fs` and
 * `node:os`, which are disallowed modules in a workflow bundle — so the literal has to be
 * in a module the sandbox can load. Same reasoning as `AGENT_ACTOR_ID` in `shared/actors`.
 *
 * `config.ts` re-exports this name, so there is exactly one definition and every existing
 * importer (the client wrapper, the contract test, the reaper) is unchanged.
 *
 * The API holds its own copy (`apps/api/src/orchestrator/orchestrator.service.ts`) on
 * purpose: sharing it would drag one package's dependencies into the other. A drift is a
 * one-line diff in two files, and `contract.test.ts` asserts the worker's value.
 */
export const WORKFLOW_ID_PREFIX = 'task-';
