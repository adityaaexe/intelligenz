/**
 * The workflow entry point Temporal bundles.
 *
 * A worker registers a **module**, and every named export of it is a workflow type. There
 * is one bundle per worker, so adding a workflow means adding it here — the alternative,
 * two `workflowsPath` values, is not a thing `Worker.create` accepts.
 *
 * Both exports are deliberately kept: `runProgrammeWorkflow` starts `runTaskWorkflow` as a
 * child by importing it directly, and the child being registered independently is what lets
 * a programme-dispatched task and an API-dispatched task share one implementation rather
 * than two code paths that must agree.
 */
export { runProgrammeWorkflow } from './run-programme';
export { runTaskWorkflow } from './run-task';
