# ADR-002 — Service boundaries

Status: Accepted
Date: 2026-11-13

## Context

`BRIEF.md` presents six layers — Intelligence & Planning, Research, Engineering, Creative, Memory & Learning, Durable Execution & Governance. `INFORMATION-ARCHITECTURE.md` presents sixteen operator destinations. Both are **product** decompositions: they describe how an operator thinks about the system and how the UI is organised.

Contract §3 fixes the engineering layout at three apps and four packages, and explicitly forbids creating `apps/orchestrator`, `apps/research`, `apps/engineering`, `apps/creative`.

The architectural question is whether those four refusals are correct, and what actually enforces a boundary when there is only one deployable API.

## Decision

```
apps/
  web/      Next.js control centre — presentation only
  api/      NestJS — auth, tenancy, state machine, orchestration entry points
  worker/   Temporal worker — activities, runtime invocation, persistence
packages/
  contracts/      Zod schemas, DTOs, event envelope, error codes, state machine
  database/       Prisma schema, generated client, tenant-scoped access, seed
  design-system/  --iz-* tokens + Overview primitives
  agent-runtime/  AgentRuntime interface + LocalSimulatedRuntime
```

**A modular monolith with enforced package boundaries, not a service mesh.**

Boundaries are enforced by four mechanisms, in this order of strength:

1. **Package dependency direction.** `contracts` depends on nothing. `database` depends on `contracts`. `agent-runtime` depends on `contracts`. `api` and `worker` depend on all three. Nothing depends on `api` or `worker`. `web` depends on `contracts` only — never on `database`.
2. **No Prisma import outside `packages/database` and `apps/worker`'s activity layer.** Lint rule (`no-restricted-imports`), not convention.
3. **Module boundaries inside `apps/api`.** `AuthModule`, `TenancyModule`, `ProjectsModule`, `TasksModule`, `RunsModule`, `AuditModule`. Cross-module access goes through an exported service, never a repository.
4. **Temporal's own boundary.** Workflow code cannot import Prisma, `fs`, or `fetch` (see ADR-003). That constraint is enforced by the sandbox, not by review.

Each module owns its tables. A module may read another module's table only through that module's service. This is a rule with no automatic enforcement in Phase 2 — it is a review obligation and is recorded here so a future violation is a documented breach rather than a surprise.

## Why `apps/orchestrator`, `apps/research`, `apps/engineering`, `apps/creative` are NOT created now

Because **there is no behaviour to put in them.** Concretely:

- No research campaign, source, or finding entity exists in the Phase 2 schema.
- No code-intelligence, design-audit, or creative-asset pipeline exists.
- No orchestrator logic exists beyond one Temporal workflow with five steps.
- The contract's vertical slice ends at `Task → WorkflowRun → AgentRun → Artifact → AuditEvent`.

Creating four applications now would produce four packages containing a `main.ts`, a config loader, a health controller, and an empty module — roughly 200 lines each of duplicated bootstrap. That is not a boundary; it is a boundary-shaped decoration. It would also:

- quadruple the CI matrix for code that does nothing,
- create four ports, four Dockerfiles, four `.env` surfaces,
- and, worst, **assert a decomposition that has not been tested by a single caller**. The first real research pipeline will almost certainly need entities (`Source`, `Retrieval`, `Claim`) that cross the assumed boundary.

The honest position is that these capabilities are **modules waiting to be extracted**, and extraction is cheap precisely because they do not exist yet. A package that has never had a consumer has no compatibility cost.

What Phase 2 does instead: puts each future capability behind a seam that already exists — `AgentRuntime` for execution (ADR-006), `ModelRoute` metadata for routing (ADR-007), `AuditEvent` for governance (ADR-009), and the `Task` aggregate for work intake.

## Consequences

### Positive

- One deploy target per role; three processes to operate, not seven.
- Refactoring across a module boundary is a rename, not a versioned API change.
- The worker can share `packages/database` with the API without a network hop, so persisting a result and writing its audit event can share a transaction.
- Extraction later is mechanical: a module with a service interface and its own tables lifts out.

### Negative / costs

- **No independent scaling.** Research crawling and code execution will have very different resource profiles from CRUD; today they share the worker's process and its memory ceiling.
- **No independent failure isolation.** A memory leak in one activity family takes down all execution.
- **The module boundary inside `apps/api` is unenforced.** The first developer under deadline pressure will import another module's repository directly, and nothing will stop them.
- **One database, one blast radius.** A bad migration affects every capability.
- Shared `packages/database` means the worker's build breaks when the API's schema changes, even if the worker does not use the changed model.

## Alternatives considered

**One microservice per BRIEF layer (six services).** Rejected. The layers are capabilities, not bounded contexts with independent lifecycles. Planning calls research, research calls engineering, engineering calls creative — a synchronous call chain across six network boundaries for a single task. Failure modes multiply, tracing becomes mandatory infrastructure before there is anything to trace, and the team is one person.

**Two services now: `api` and `worker`, with web folded into `api` as server-rendered pages.** Rejected — see ADR-001. It couples UI deploys to the state machine and removes the ability to test the API without a Next build.

**Feature folders inside a single Nest app, with the worker as a Nest microservice transport.** Rejected as premature: it introduces a message transport (Redis or NATS) before there is a reason to prefer it over Temporal, which already provides the durable queue and retry semantics the worker needs.

**An `apps/orchestrator` that owns Temporal workflows separately from the worker.** Rejected. Workflows and their activities are one unit of versioning; splitting them means two deployables that must be released together, which is the worst of both models.

## Revisit trigger

Create a new app when a module needs one of: a different runtime (Python for ML, a browser for UI automation), a hard security boundary (untrusted code execution), independent scaling beyond one host, or ownership by a separate team. Create `apps/research` first, because it is the capability with the most distinct data model and the most external I/O.
