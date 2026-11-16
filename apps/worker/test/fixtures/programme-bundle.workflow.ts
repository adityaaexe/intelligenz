/**
 * The workflow bundle the programme suites start against.
 *
 * A Temporal worker registers **one module**, and every named export of it is a workflow
 * type. The production bundle (`src/workflows/index.ts`) registers the two workflows
 * production starts; this one adds the two test fixtures the programme suites need, so one
 * worker can both run a real `runProgrammeWorkflow` and host a probe execution under
 * `programme-<programmeId>`:
 *
 *   - `probeExecution` — `probe.workflow.ts`, reused here because it is a legitimate
 *     hold-open execution. The compensation test needs a workflow already running under
 *     `task-<taskId>` so the child start is refused deterministically.
 *   - `programmeProbe` — `programme-probe.workflow.ts`, which calls the four programme
 *     activities from inside an execution the authority check accepts.
 *
 * Nothing in `src/` changes for this: the fixtures are compiled into a test-only bundle.
 * `contract.test.ts` still reads the production entry point, so the ten activity names it
 * asserts are the ones production registers.
 */
export * from '../../src/workflows';
export * from './probe.workflow';
export * from './programme-probe.workflow';
