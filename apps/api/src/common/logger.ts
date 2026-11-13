import pino, { type Logger } from 'pino';

import type { AppConfig } from '../config/app-config';

/**
 * Structured logging with redaction (contract §2).
 *
 * The redaction list is not decoration: `pino-http` logs the request object, and a
 * bearer token lives in `req.headers.authorization`. The bare keys cover payloads
 * a future `customProps` might add; the `req.*`/`res.*` paths cover the serializer.
 *
 * `pino` is the only logger. Nest's `Logger` is routed through the adapter in
 * `nest-logger.ts` so a framework log line and an application log line have the
 * same shape and the same redaction.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'authorization',
  'password',
  'passwordHash',
  'token',
  'secret',
  'accessToken',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.accessToken',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): Logger {
  return pino({
    level: config.logLevel,
    // The service name and environment are on every line; the process id is not
    // useful in JSON logs and adds noise to every record.
    base: { service: 'intelligenz-api', env: config.nodeEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  });
}

/**
 * The logger token. One instance per process, injected everywhere, so the HTTP
 * access log, the Nest adapter and application logs share a level and a redaction
 * config. A symbol cannot be shadowed by a string provider from another module.
 */
export const LOGGER = Symbol('LOGGER');
