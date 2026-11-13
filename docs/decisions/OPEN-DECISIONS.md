# Open decisions

Findings that are **not** defects to fix silently. Each one is a product or policy
choice with a security consequence; changing the behaviour without the decision
would be guessing on the owner's behalf. Recorded here with the trade-off and a
recommendation so the decision is made once, in the open.

Status values: `OPEN` (needs a decision), `ACCEPTED` (decided, with a named owner),
`DEFERRED` (decided not to decide yet).

---

## D-001 — Separation of duties on approvals

**Status:** OPEN · **Raised:** 2026-11-13 (Phase 2 security review) · **Severity:** Medium

### What happens today

- `POST /v1/orgs/:orgId/tasks` creates the `PENDING` `ApprovalRequest` with
  `requestedById = <the creator>`.
- `POST /v1/orgs/:orgId/approvals/:approvalId/decision` requires `ADMIN` or higher.
  It does **not** compare `requestedById` with the deciding user.
- An `APPROVED` row is a standing authorisation: the approval gate asks "does an
  `APPROVED` request exist for this task", so once approved, **every** future run of
  that task — including a run started a month later by a different member — passes
  the gate. There is no "this approval is for run N".

So an `ADMIN` who creates a `CRITICAL` task can approve their own request and run it.
The control that a `HIGH`/`CRITICAL` task needs a second person exists in the schema
and in the UI, but not in the enforcement.

### Why this is not a bug to patch quietly

Both halves are legitimate designs:

- **Self-approval allowed** is normal in small teams where the only `ADMIN` is also
  the person doing the work. Blocking it can deadlock an organisation with one
  admin — a real availability failure traded for a control that the same person
  could bypass by inviting a second admin account.
- **Self-approval refused** is what "four eyes" means, and it is what an auditor
  will assume when the approvals queue is presented as a control.

The second half is the larger issue. A standing approval that authorises unbounded
future executions is a different (weaker) control than "one approval per run", and
which one is intended changes the data model (`ApprovalRequest` needs a `runId` or a
consumed-at timestamp for per-run semantics).

### Options

| Option | Change | Cost |
|---|---|---|
| A. Keep as-is, document it | No code change; state the limitation in the operator guide | The approvals screen overstates the control |
| B. Refuse self-approval | `409 SELF_APPROVAL_FORBIDDEN` when `requestedById === actorId`, unless the org has a single `ADMIN` | Needs an escape hatch or it can deadlock a one-admin org |
| C. One approval per run | Add `ApprovalRequest.consumedByRunId`, set it when a run starts; the gate requires an unconsumed `APPROVED` row | Schema migration, worker/run changes, a re-approval step for every retry |
| D. B + C | Four eyes, per run | Highest assurance, highest friction; likely needs an "auto-approve LOW/MEDIUM" path so it is not felt on every task |

### Recommendation

**B now, C when retries become common.** B is a ~10-line check in
`ApprovalsService.decide` plus a test, and it closes the obvious "approve your own
critical task" path. C changes the meaning of an existing row and should not ride
along with a security fix; it needs a migration plan and a UI that shows "this
approval has been used". Until C, the operator guide must say that an approved task
stays approved for its lifetime.

### Owner

Product owner + whoever owns the approvals surface. Not an engineering call: it
decides how much friction a critical change carries.

---

## D-002 — Artifact `uri` is returned verbatim to any member

**Status:** OPEN · **Raised:** 2026-11-13 · **Severity:** Low (information disclosure)

`GET /v1/orgs/:orgId/tasks/:taskId` returns `artifacts[].uri`. Today those are
`file://`/relative paths under `ARTIFACT_ROOT`. Any `MEMBER` of the org can read the
path. Paths can disclose the host layout, the artifact root, and (in the future) an
object-store bucket name. They are not directly fetchable through the API, so this is
disclosure, not access.

**Recommendation:** keep the field (the UI shows provenance) but normalise it to a
storage-relative key, and serve bytes through a signed URL endpoint when artifact
download exists. Do not "fix" by removing the field — that breaks the artifact
provenance display the design calls for.

---

## D-003 — Audit trail is append-only by convention, not by enforcement

**Status:** OPEN · **Raised:** 2026-11-13 · **Severity:** Medium

`AuditEvent` rows are written through one service (`AuditService`) and nothing in the
schema prevents `UPDATE`/`DELETE`. The database role used by the API can modify
history. An audit trail that the application can rewrite is evidence, not proof.

**Recommendation:** revoke `UPDATE`/`DELETE` on `AuditEvent` from the application
role and add a `BEFORE UPDATE OR DELETE` trigger that raises. That is an
infrastructure/migration change, not an application change, and needs a migration
window. It should be scheduled with the deployment work (ADR-010), not bolted onto
this unit.

---

## D-004 — Transitive dependency advisories (PostCSS, glob, minimatch)

**Status:** OPEN · **Raised:** 2026-11-13 · **Severity:** Low–Medium (build-time)

`pnpm audit` reports advisories in transitive build tooling (PostCSS, `glob`,
`minimatch`) pulled in by the Next.js/ESLint toolchain. None of them are reachable
from request handling: they run at build time on repository content, not on user
input. Upgrading them means moving the Next.js/ESLint versions, which is a separate
change with its own regression surface.

**Recommendation:** track them, upgrade with the next framework bump, and do not
suppress them silently. A blanket `pnpm.overrides` pin here would replace a known
advisory with an untested resolution.

**Measured 2026-11-13 (DOC-301):** the severity classification above is out of date.
`pnpm audit --audit-level high` now **exits 1**: 7 advisories, of which **2 are rated
`high`** (both PostCSS, reached through `next`; also 4 moderate and 1 low). The advisories
are still build-time transitive dependencies, not request-path code, so the exposure
argument stands — but the gate is red, not "Low–Medium". `PHASE-3-TEST-RESULTS.md` §1.7
records the literal output and the path list. The decision itself is unchanged.

---

## D-005 — `Cache-Control` is not set on authenticated API responses

**Status:** OPEN · **Raised:** 2026-11-13 · **Severity:** Low (deployment-dependent)

No API response sets `Cache-Control`. There is no shared cache in front of the API
today, so nothing stores them. If a CDN or reverse proxy is placed in front without
`Vary: Authorization` or `Cache-Control: private, no-store`, a `GET /v1/orgs`
response could be served to a different tenant.

**Recommendation:** when the deployment topology (ADR-010) is finalised, set
`Cache-Control: no-store` on every authenticated response — one middleware, same
place as the security headers — **or** prove the proxy never caches. Do not add it
blindly now: it would disable caching for a future endpoint that legitimately wants
it, and the current topology has no cache to defeat.

---

## D-006 — Risk class is self-attested at task creation, so the approval gate is voluntary

**Status:** OPEN · **Raised:** 2026-11-13 (Phase 3 security audit, finding F5) · **Severity:** High (policy)

### What happens today

- `POST /v1/orgs/:orgId/tasks` accepts `riskClass` **from the caller**. A `MEMBER` can
  create a task labelled `LOW` whatever the work actually is.
- Approval is required for `HIGH` and `CRITICAL` only
  (`packages/contracts/src/approval.ts:13`). A `LOW` task gets no `ApprovalRequest` at
  all.
- `POST /v1/orgs/:orgId/tasks/:taskId/run` checks "is there an `APPROVED` request for
  this task" only when `requiresApproval(riskClass)` is true.

So any `MEMBER` can execute arbitrary agent work with no second pair of eyes by typing
`"riskClass": "LOW"`. The approvals screen presents a control that the caller can opt
out of. That is not a bug in the check — the check does what it says — it is a question
about **who is allowed to decide that work is low risk**.

This is recorded rather than changed because the answer changes the product:

- Some teams genuinely want a member to run a small, reversible change unattended.
  Gating every run on an `ADMIN` turns the approval queue into a rubber stamp, which is
  worse than no control because it looks like one.
- An auditor will read "approvals required for HIGH/CRITICAL" as a control, and will
  expect the classification to be trustworthy.

`apps/api/test/tasks.e2e-spec.ts` contains a test that **documents the current
behaviour** (a `MEMBER` creates and runs a `LOW` task with zero approval rows). If the
policy changes, that test fails and this decision is updated — the bypass is visible
rather than assumed.

### Options

| Option | Change | Cost |
|---|---|---|
| A. Keep as-is, document it | No code change; say "risk class is set by the requester; only HIGH/CRITICAL are gated" in the operator guide | The approvals screen overstates the control; a member can self-serve any work |
| B. Server-side floor per project | Project (or org) carries a minimum risk class; `requiresApproval` uses `max(requested, floor)` | One column + migration; an admin sets it once; no per-task friction |
| C. `ADMIN` confirms risk on real runs | `POST /run` requires `ADMIN` for any real runtime; `LOW` stays self-service only for the simulated adapter | Highest assurance, most friction; blocks unattended work entirely |
| D. Approve the *capability*, not the task | Approval attaches to (member, project, budget, runtime) for a time window; individual tasks inherit it | A different product: standing grants need expiry, revocation and an audit story |

### Recommendation

**B, with C's wording in the operator guide.** A per-project minimum risk class is one
migration and one `max()` in the gate, and it closes the "type LOW to skip approval"
path without turning every small change into an approval. C is the right answer for an
organisation that does not trust its members at all, but it makes the queue the
bottleneck and should be a deliberate choice, not the default.

Whichever is chosen, the **worker** must re-check at execution time
(`executeAgentActivity` currently does not — finding F18 in the Phase 3 report), or the
gate is only an API-layer courtesy.

### Owner

Founder / product owner. This is a risk-appetite decision, not an engineering one.
