/**
 * `@intelligenz/worker` — the Temporal worker (ADR-003, contract §9 and §16).
 *
 * The process entry point is `main.ts`; this module is the import surface for tests,
 * scripts and anything that needs the workflow or the client without starting a poller.
 *
 * `main.ts` is deliberately **not** re-exported: importing it would connect to Temporal
 * and install signal handlers as a side effect.
 */

export {
  WORKFLOW_ID_PREFIX,
  WORKFLOW_TYPE,
  TASK_QUEUE,
  getWorkerConfig,
  loadNearestEnvFile,
  loadWorkerConfig,
  resolveArtifactRoot,
  type WorkerConfig,
} from './config';
export { activities } from './activities';
export { runTaskWorkflow } from './workflows/run-task';
export {
  TemporalTaskClient,
  DEFAULT_NAMESPACE,
  DEFAULT_TASK_QUEUE,
  DEFAULT_TEMPORAL_ADDRESS,
  type CancelOutcome,
  type StartedTaskWorkflow,
  type TemporalTaskClientOptions,
} from './client';
export { createLogger, serializeError, type WorkerLogger } from './logger';
export { getAgentRuntime, resetAgentRuntime } from './runtime';
export type {
  CompleteTaskActivityInput,
  CompleteTaskActivityResult,
  EmitEventActivityInput,
  EmitEventActivityResult,
  ExecuteAgentActivityInput,
  ExecuteAgentActivityResult,
  PersistResultActivityInput,
  PersistResultActivityResult,
  RecordStartActivityInput,
  RecordStartActivityResult,
  RunTaskWorkflowInput,
  RunTaskWorkflowResult,
  ValidateTaskActivityInput,
  ValidateTaskActivityResult,
} from './shared/contracts';
