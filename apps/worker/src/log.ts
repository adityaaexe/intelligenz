import { getWorkerConfig } from './config';
import { createLogger, type WorkerLogger } from './logger';

/**
 * The worker's process-wide logger, for code that runs outside `main.ts`.
 *
 * `main.ts` builds its own logger because it needs the level before anything else exists.
 * Activities, the reaper and the capability probe run later and need the same sink and
 * the same shape; passing a logger through every activity signature would change the
 * Temporal contract for a logging concern, so they share one.
 *
 * Nothing here reads `process.env` at import time: the config is resolved on first use,
 * after `.env` has been loaded.
 */

let shared: WorkerLogger | undefined;

export function workerLogger(): WorkerLogger {
  shared ??= createLogger(getWorkerConfig().logLevel, { service: 'intelligenz-worker' });

  return shared;
}

/** Test seam: replace or reset the shared logger. */
export function setWorkerLogger(logger: WorkerLogger | undefined): void {
  shared = logger;
}
