import { Catch, Inject, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Logger } from 'pino';

import { AppError } from './errors';
import { LOGGER } from './logger';
import type { ApiRequest, ApiResponse } from './request-context';

/**
 * The only place an error body is constructed.
 *
 * One envelope for every failure, including framework 404s and unhandled
 * exceptions:
 *
 *   { "error": { "code", "message", "details"? }, "correlationId" }
 *
 * Two rules worth stating because they are easy to undo later:
 *   - a 5xx never echoes the exception message. A Prisma error names tables and
 *     columns; a driver error can contain the connection string.
 *   - `correlationId` is on the body, not only in the log, so a user can quote it
 *     in a support request and it can be grepped.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {    const http = host.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const response = http.getResponse<ApiResponse>();
    const correlationId = request.correlationId;

    if (exception instanceof AppError) {
      // Headers the error carries (today: `Retry-After` on a 429) are applied
      // before the body, so a client that only reads headers still sees them.
      for (const [name, value] of Object.entries(exception.headers ?? {})) {
        response.setHeader(name, value);
      }

      response.status(exception.status).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details === undefined ? {} : { details: exception.details }),
        },
        correlationId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      response.status(status).json({
        error: {
          code: status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR',
          message: status === 404 ? 'Route not found.' : exception.message,
        },
        correlationId,
      });
      return;
    }

    this.logger.error(
      { err: exception, correlationId, method: request.method, url: request.url },
      'unhandled exception',
    );

    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Quote the correlationId when reporting it.',
      },
      correlationId,
    });
  }
}
