import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pinoHttp from 'pino-http';

import { AppModule } from './app.module';
import { createLogger } from './common/logger';
import { PinoLoggerService } from './common/nest-logger';
import { correlationMiddleware } from './common/request-context';
import { securityHeadersMiddleware } from './common/security-headers';
import { type AppConfig } from './config/app-config';

/**
 * Builds the HTTP application.
 *
 * Extracted from `main.ts` so the Supertest suite exercises the *same* pipeline the
 * server runs: same guards, same filter, same middleware order. A test that builds
 * its own app tests its own app.
 */
export async function createApplication(config: AppConfig): Promise<INestApplication> {
  const logger = createLogger(config);

  const app = await NestFactory.create(AppModule.forRoot(config), {
    // Buffered until `useLogger` below, so not a single startup line is printed in
    // Nest's text format before the JSON adapter is installed.
    bufferLogs: true,
  });

  app.useLogger(new PinoLoggerService(logger));

  // Express advertises itself on every response by default. The header names the
  // framework and often its major version — free reconnaissance on an
  // authentication surface, and nothing depends on it.
  (app.getHttpAdapter().getInstance() as { disable(setting: string): void }).disable('x-powered-by');

  // Headers first: every later stage, including the exception filter, writes a
  // response that already carries them.
  app.use(securityHeadersMiddleware);

  // Correlation next: `pino-http` reads the id this middleware assigns, so the
  // access log, the error body and the audit rows all carry the same value.
  app.use(correlationMiddleware);

  app.use(
    pinoHttp({
      logger,
      genReqId: (request) => {
        const candidate = (request as { correlationId?: unknown }).correlationId;

        return typeof candidate === 'string' ? candidate : randomUUID();
      },
      autoLogging: config.logLevel !== 'silent',
      customLogLevel: (_request, response) =>
        response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
    }),
  );

  /**
   * ## Validation
   *
   * There is deliberately no `app.useGlobalPipes(new ValidationPipe(...))`.
   *
   * `ValidationPipe` is class-validator-backed, and `class-validator` is not a
   * dependency of this package (the stack validates with Zod, contract §2). A global
   * Nest pipe also cannot be schema-aware: its `transform` receives
   * `ArgumentMetadata` — `type`, `metatype`, `data` — and no handler reference, so
   * there is nowhere to look up a route's schema.
   *
   * Validation is therefore `ZodValidationPipe`, bound per parameter with
   * `@ZodBody(schema)` / `@ZodQuery(schema)` in `common/pipes/zod-validation.pipe.ts`.
   * One implementation, one error shape (`400 VALIDATION_ERROR` with field details),
   * and the controller's parameter type *is* the schema's output type — a field added
   * to a schema and not to the handler signature is a compile error. Every body and
   * query in this app goes through it; there is no route that reads raw input.
   */

  app.enableCors({
    // The web client runs on 3100 and calls this API directly (contract §15 A1).
    origin: [...config.corsOrigins],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Org-Id',
      'Idempotency-Key',
      'X-Correlation-Id',
    ],
    credentials: false,
    maxAge: 600,
  });

  // Drains the Prisma pool and closes the Temporal channel on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  return app;
}
