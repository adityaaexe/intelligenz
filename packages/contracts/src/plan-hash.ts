import { createHash } from 'node:crypto';

import { canonicalPlanContent, type ProposedPlanV1 } from './plan';

/**
 * The approval hash: sha256 hex of `canonicalPlanContent`.
 *
 * ## Why this is a separate module and a separate export path
 *
 * `@intelligenz/contracts` is imported by `apps/worker/src/workflows/run-programme.ts`, and
 * Temporal bundles workflow code with webpack, which refuses the `node:` scheme
 * (`UnhandledSchemeError: Reading from "node:crypto" is not handled`). Exporting this from
 * the root barrel compiled the whole contract — including a Node built-in — into the
 * workflow sandbox, and every programme suite failed to build.
 *
 * The fix is a boundary, not a polyfill: the **canonical serialisation** is pure and lives
 * in `plan.ts` (importable from the barrel, safe in a workflow); the **digest** is a
 * platform operation and lives here, exported as `@intelligenz/contracts/plan-hash`. A
 * workflow has no business hashing an approval, and a browser has no synchronous sha256 to
 * call, so neither needs this module.
 *
 * The digest is computed at the decision and recomputed at submission. A mismatch refuses
 * (`409 PLAN_CONTENT_CHANGED`), which is what binds an approval to specific bytes.
 */
export function planContentHash(plan: ProposedPlanV1): string {
  return createHash('sha256').update(canonicalPlanContent(plan), 'utf8').digest('hex');
}
