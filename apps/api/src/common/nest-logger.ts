import { randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

/**
 * Routes Nest's own `Logger` output through pino.
 *
 * Without this, framework logs (`Nest application successfully started`, route
 * mapping, guard errors) are printed in Nest's text format while everything else
 * is JSON — two log formats, two places to look, and no redaction on the text one.
 */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: unknown): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, stack?: unknown, context?: unknown): void {
    this.logger.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: unknown): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: unknown): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: unknown): void {
    this.logger.trace({ context }, String(message));
  }

  fatal(message: unknown, context?: unknown): void {
    this.logger.fatal({ context }, String(message));
  }
}

/**
 * Correlation ids.
 *
 * A caller may supply `X-Correlation-Id`, but only in the shape the audit envelope
 * accepts (`EventEnvelope.correlationId` is a UUID). A non-UUID header is replaced
 * rather than coerced: the same id must be usable in the error body and in
 * `AuditEvent`, and silently rewriting it halfway through would break the trail.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveCorrelationId(headerValue: string | string[] | undefined): string {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (candidate !== undefined && UUID_PATTERN.test(candidate)) return candidate;

  return randomUUID();
}
