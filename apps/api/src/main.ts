import 'reflect-metadata';

import type { Logger } from 'pino';

import { createApplication } from './app.factory';
import { LOGGER } from './common/logger';
import { loadConfig } from './config/app-config';
import { loadNearestEnvFile } from './config/load-env';

/**
 * Process entry point.
 *
 * Failures before `listen` are fatal and exit non-zero: a missing `JWT_SECRET` or an
 * unusable `API_PORT` must stop the container, not produce a process that is up but
 * cannot authenticate anyone. Failures after `listen` are logged and handled per
 * request by the exception filter.
 */
async function bootstrap(): Promise<void> {
  loadNearestEnvFile();

  const config = loadConfig();
  const app = await createApplication(config);

  await app.listen(config.port, config.host);

  const logger = app.get<Logger>(LOGGER);
  logger.info(
    { port: config.port, host: config.host, env: config.nodeEnv },
    'intelligenz api listening',
  );
}

void bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (the failure can be in config loading), so this is
  // the one place a raw write to stderr is the correct choice.
  process.stderr.write(
    `[intelligenz-api] failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
