/**
 * The task-content hash and approval binding, **imported** from the one implementation.
 *
 * ## Why this file exists instead of a copy
 *
 * The worker has to answer one question the API already answers: "is this approval bound
 * to the task as it exists right now?" The answer is a sha256 over a canonical preimage
 * of title, goal, acceptance criteria, effective risk class and the execution binding. A
 * second implementation of that preimage — even one that looks identical today — is a
 * gate that disagrees with itself the first time either side is edited. The failure is
 * silent in the worst direction: the worker would compute a different digest, refuse
 * every legitimate run as `APPROVAL_STALE`, or (if the preimages were reordered to
 * match by accident) accept a grant that was issued for different content.
 *
 * So the worker imports `computeTaskContentHash`, `readTaskBinding` and `resolveBinding`
 * from the module the API uses. This one file is the seam: if those helpers move to a
 * shared package (the right long-term home — `apps/worker` should not reach into
 * `apps/api`), only this import changes and every call site is unchanged.
 *
 * The imported module is pure: `node:crypto`, a type from `@intelligenz/contracts`, and
 * two constants from the risk-policy table. Nothing in it pulls Nest, Prisma or an HTTP
 * client into the worker's program.
 */

export {
  TASK_CONTENT_HASH_VERSION,
  computeTaskContentHash,
  readTaskBinding,
  resolveBinding,
  type TaskBinding,
  type TaskContentInput,
} from '../../../api/src/approvals/approval-binding';
