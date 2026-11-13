import { Body, Query, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import { AppError, type ErrorDetails } from '../errors';

/**
 * Zod validation — the single validation implementation for the API.
 *
 * ## Why this is applied per parameter instead of `app.useGlobalPipes`
 *
 * A global Nest pipe receives `ArgumentMetadata` (`type`, `metatype`, `data`) and
 * nothing else: no handler reference, so it cannot look up a route's schema. The
 * idiomatic way to bind a schema to an argument is the pipe argument on the
 * parameter decorator, which is what `ZodBody` / `ZodQuery` below do.
 *
 * The guarantee that matters is "no unvalidated input reaches a service", and it is
 * enforced by convention plus tests: every `@Body()`/`@Query()` in this app goes
 * through one of these two decorators. `ZodBody` is also how the controller gets a
 * typed DTO — the type is the schema's output type, so a field added to the schema
 * and not to the controller signature is a compile error.
 *
 * ## Error shape
 *
 * A Zod failure is a `400 VALIDATION_ERROR` with `details` keyed by the dotted
 * field path, which is what the web client maps onto form inputs:
 *
 *   { "error": { "code": "VALIDATION_ERROR", "details": { "riskClass": ["..."] } } }
 */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);

    if (result.success) return result.data;

    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'The request body or query is invalid.',
      toFieldErrors(result.error.issues),
    );
  }
}

interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export function toFieldErrors(issues: readonly ZodIssueLike[]): ErrorDetails {
  const details: ErrorDetails = {};

  for (const issue of issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.map(String).join('.');
    const bucket = details[key];

    if (bucket === undefined) details[key] = [issue.message];
    else bucket.push(issue.message);
  }

  return details;
}

/** `@Body()` + Zod. The parameter type is the caller's; the schema is the gate. */
export function ZodBody<TSchema extends z.ZodType>(schema: TSchema): ParameterDecorator {
  return Body(new ZodValidationPipe(schema));
}

/**
 * `@Query()` + Zod. Passing the schema directly to `@Query` also handles Nest's
 * `@Query('name')` semantics: the whole query object is parsed, so `?limit=abc`
 * fails here instead of reaching a service as a string.
 */
export function ZodQuery<TSchema extends z.ZodType>(schema: TSchema): ParameterDecorator {
  return Query(new ZodValidationPipe(schema));
}
