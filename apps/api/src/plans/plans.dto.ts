import { z } from 'zod';

/**
 * The plan API's request bodies.
 *
 * ## What is deliberately absent from every one of them
 *
 * No approver identity, no status, no content hash, no programme id, no provider and no
 * `simulated` flag. Those are facts the server observes or decides; accepting them from a
 * body would let a caller authorise its own proposal, skip the human decision, or claim a
 * model call that never happened. `.strict()` makes the absence enforceable: a body that
 * carries one of them is a `400`, not a silently ignored field.
 *
 * The approver is `request.auth.userId` from the verified JWT (`@CurrentUser`), the plan's
 * project is resolved inside `orgId`, and the hash is computed from the stored proposal at
 * decision time.
 */

/** `POST /plans`. The objective is the only model-visible input. */
export const ProposePlanInput = z
  .object({
    projectId: z.uuid(),
    objective: z.string().trim().min(1).max(500),
  })
  .strict();

export type ProposePlanInput = z.infer<typeof ProposePlanInput>;

/** `POST /plans/:planId/approve`. A note, and nothing that could carry authority. */
export const ApprovePlanInput = z
  .object({
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export type ApprovePlanInput = z.infer<typeof ApprovePlanInput>;

/** `POST /plans/:planId/reject`. A rejection must say why; an approval need not. */
export const RejectPlanInput = z
  .object({
    note: z.string().trim().min(1).max(2000),
  })
  .strict();

export type RejectPlanInput = z.infer<typeof RejectPlanInput>;
