import { NativeConnection, Worker } from '@temporalio/worker';

import { activities } from './activities';
import {
  WORKFLOW_TYPE,
  getWorkerConfig,
  loadNearestEnvFile,
  type WorkerConfig,
} from './config';
import { createLogger, serializeError, type WorkerLogger } from './logger';
import { getAgentRuntime } from './runtime';

/**
 * Worker bootstrap.
 *
 * ## Fail fast, and say why
 *
 * A worker that starts happily with no engine to poll is worse than one that refuses:
 * workflows queue up and nothing reports it. The connection is established *before* the
 * worker is created, and a failure exits non-zero with an actionable message.
 *
 * ## Structured logs only
 *
 * One JSON object per line on stdout: level, timestamp, message, and fields. No
 * `console.log`, no multi-line banners — an operator greps `level:"error"` and gets
 * exactly the failures.
 *
 * ## Graceful shutdown
 *
 * `SIGTERM`/`SIGINT` trigger `worker.shutdown()`, which stops polling and lets in-flight
 * activities finish (bounded by `shutdownGraceTime`). Killing an activity midway is the
 * one thing Temporal cannot make idempotent for us.
 */

const SHUTDOWN_GRACE_TIME = '20s';

async function main(): Promise<void> {
  loadNearestEnvFile();

  const config = getWorkerConfig();
  const logger = createLogger(config.logLevel, { service: 'intelligenz-worker' });

  logger.info(
    {
      nodeEnv: config.nodeEnv,
      taskQueue: config.temporal.taskQueue,
      temporalAddress: config.temporal.address,
      namespace: config.temporal.namespace,
      workflowType: WORKFLOW_TYPE,
      artifactRoot: config.artifactRoot,
      databaseHost: redactDatabaseUrl(config.databaseUrl),
      faultInjection: config.faultInjection,
    },
    'worker starting',
  );

  const runtime = getAgentRuntime(config);
  const [capabilities, health] = await Promise.all([runtime.capabilities(), runtime.health()]);

  logger.info(
    {
      runtimeId: runtime.id,
      simulated: health.simulated,
      health: health.status,
      detail: health.detail,
      capabilities,
      // Real runs are opt-in; log the boundary they will execute in, not just the id.
      ...(health.simulated
        ? {}
        : {
            workspaceRoot: config.workspace.root,
            sourceRepoConfigured: config.workspace.sourceRepo !== undefined,
            model: config.execution.model ?? '(adapter default)',
            maxUsd: config.execution.maxUsd ?? '(adapter default)',
          }),
    },
    health.simulated
      ? 'agent runtime registered — SIMULATED, performs no real work'
      : 'agent runtime registered — REAL execution enabled (opt-in via AGENT_RUNTIME)',
  );

  let connection: NativeConnection;

  try {
    connection = await NativeConnection.connect({ address: config.temporal.address });
  } catch (error) {
    logger.error(
      {
        temporalAddress: config.temporal.address,
        err: serializeError(error),
        hint: 'Start the dev server with `bash infra/scripts/start-temporal.sh` (port 7233).',
      },
      'cannot reach Temporal — refusing to start an idle worker',
    );

    process.exitCode = 1;
    return;
  }

  const worker = await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    // Type-only imports keep Prisma and `node:fs` out of the sandboxed workflow bundle;
    // the bundler follows only this path (ADR-003).
    workflowsPath: require.resolve('./workflows/run-task'),
    activities,
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
    shutdownGraceTime: SHUTDOWN_GRACE_TIME,
  });

  logger.info(
    {
      taskQueue: config.temporal.taskQueue,
      maxConcurrentActivities: config.maxConcurrentActivities,
      activities: Object.keys(activities),
    },
    'worker polling',
  );

  installSignalHandlers(worker, logger);

  try {
    await worker.run();
    logger.info({}, 'worker stopped');
  } finally {
    await connection.close().catch((error: unknown) => {
      logger.warn({ err: serializeError(error) }, 'connection close failed');
    });
  }
}

function installSignalHandlers(worker: Worker, logger: WorkerLogger): void {
  let shuttingDown = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal received — shutdown already in progress');
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested; draining activities');

    try {
      // `shutdown()` returns void in SDK 1.x: it stops polling and lets in-flight
      // activities finish; `worker.run()` is what resolves when draining completes.
      worker.shutdown();
    } catch (error) {
      logger.error({ err: serializeError(error) }, 'shutdown failed');
      process.exitCode = 1;
    }
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** A connection string carries a password. Logs never do (contract §12, case 8). */
function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.protocol}//${parsed.username}:***@${parsed.host}${parsed.pathname}`;
  } catch {
    return 'postgresql://<unparseable>';
  }
}

main().catch((error: unknown) => {
  const logger = createLogger('error', { service: 'intelligenz-worker' });
  logger.error({ err: serializeError(error) }, 'worker crashed during startup');
  process.exitCode = 1;
});

export type { WorkerConfig };
