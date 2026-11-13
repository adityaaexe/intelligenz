import { z } from 'zod';

/**
 * Approval decision input.
 *
 * This schema lives here rather than in `@intelligenz/contracts` because the
 * contracts package does not define it yet, and this unit must not modify another
 * package. It should move to contracts the moment the worker or the web client needs
 * the same validation — the comment is the reminder.
 *
 * `note` is optional for `approve` and required for `reject` / `request_changes`.
 * A rejection with no stated reason is not a review, it is a dead end; the requester
 * cannot act on "no".
 */
export const ApprovalDecisionInput = z
  .object({
    decision: z.enum(['approve', 'reject', 'request_changes']),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision !== 'approve' && value.note === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'A note is required when rejecting or requesting changes.',
      });
    }
  });

export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;

/** The wire decision maps onto the stored status one-to-one. */
export const DECISION_TO_STATUS = {
  approve: 'APPROVED',
  reject: 'REJECTED',
  request_changes: 'CHANGES_REQUESTED',
} as const;
