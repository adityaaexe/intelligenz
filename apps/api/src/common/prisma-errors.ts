import { Prisma } from '@intelligenz/database';

import { AppError } from './errors';

/**
 * Prisma error classification, kept in one place.
 *
 * The point is not to save keystrokes — it is that a unique-constraint collision is
 * an expected outcome on at least one path (`(projectId, idempotencyKey)`), and
 * pattern-matching on `error.code` inline at every call site is how a `P2002` turns
 * into a 500 in one service and a 409 in another.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2003')
  );
}

/** A foreign-key violation on insert is a 409: the referenced row vanished. */
export function toConflict(error: unknown, message: string): AppError | undefined {
  if (!isUniqueConstraintError(error)) return undefined;

  return new AppError(409, 'CONFLICT', message);
}
