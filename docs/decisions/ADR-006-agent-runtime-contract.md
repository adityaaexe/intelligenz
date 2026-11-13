# ADR-006 — Agent runtime contract

Status: Accepted
Date: 2026-11-13

## Context

`BRIEF.md` §3.2 states the product's position: runtime adapters are replaceable — Pi, OpenCode, Codex, Claude Code, OpenHands, custom. That is a product claim, and it is either true in the code or it is marketing.

The Phase 2 constraint is that **no real runtime is available or authorised**: no vendor API keys, no budget approval, no sandbox, no container runtime to isolate an executing agent. Contract §8 also fixes the interface shape and requires exactly one implementation, `LocalSimulatedRuntime`, clearly named as simulated.

The architectural risk is the opposite of the usual one: not that the abstraction leaks a vendor, but that the abstraction is designed against **zero** real implementations and is therefore confidently wrong.

## Decision

`packages/agent-runtime` defines a runtime-neutral port. The orchestrator depends on the port; nothing in `apps/api`, `apps/worker/src/workflows`, or `packages/contracts` may name a vendor.

```ts
interface RuntimeCapabilities {
  shell: boolean; network: boolean; filesystem: 'none' | 'read' | 'write';
  browser: boolean; mcp: boolean; imageInput: boolean;
}

interface ExecutionRequest {
  taskId: string; goal: string; allowedPaths: string[]; allowedActions: string[];
  riskClass: RiskClass; timeoutMs: number; budgetUsd: number; correlationId: string;
}

interface ExecutionResult {
  status: 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  summary: string; artifacts: ArtifactReference[]; events: ExecutionEvent[];
  usage: { tokensIn?: number; tokensOut?: number; usd?: number };
  error?: { code: string; message: string; retryable: boolean };
}

interface AgentRuntime {
  readonly id: string;
  capabilities(): Promise<RuntimeCapabilities>;
  health(): Promise<RuntimeHealth>;
  execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
}
```

### Capability declaration is a precondition, not documentation

`capabilities()` is called **before** dispatch. If a task requires `shell` and the runtime reports `shell: false`, the activity fails with `RUNTIME_CAPABILITY_MISSING` before any work starts or any money is spent. The alternative — discovering the gap mid-execution — produces a half-finished run and a misleading artifact.

Capabilities are declared by the adapter, so an adapter can lie. The mitigation is that each adapter's declaration is a reviewed constant with a documented basis, and `health()` is expected to detect the lie (e.g. a shell probe). Neither is proof. Recorded as residual risk.

### Normalised results

Every adapter maps its vendor's output into `ExecutionResult`. Rules:

- `status` is the adapter's judgement, not the vendor's string. A vendor "success" with failed tests maps to `failed`.
- `artifacts` are references (checksum + media type + size), not bytes. Bytes go through the artifact store (ADR-008).
- `usage` is best-effort and optional per field. Missing is `undefined`, never `0` — a zero would be read as "free".
- `events` are normalised execution events (step started, tool called, message), not raw vendor logs. Raw logs are an artifact, not an event stream.
- `error.retryable` is the adapter's judgement and is what the Temporal retry policy consumes.

### Exactly one implementation: `LocalSimulatedRuntime`

It is deterministic, performs no network access, reads nothing outside its own fixture set, and writes **one real artifact file** to the configured artifact root so the persistence, checksum, evidence, and audit path is exercised end to end rather than stubbed.

Mandatory labelling, enforced in code and in the UI:

- `id = "local-simulated"`.
- `capabilities()` returns `network: false`, `shell: false`, `filesystem: 'write'` (artifact only).
- Every `ExecutionResult` carries `runtimeId: "local-simulated"` and `simulated: true`.
- `health()` returns `{ status: 'ok', simulated: true }`.
- The web surfaces render a `Simulated` chip wherever a run's runtime is shown.

**It must never be described as a real integration** — not in a commit message, not in a status report, not in a demo, not in the UI. Contract §13 is explicit: a stub is never described as a working integration. A run executed by this adapter proves the *plumbing*; it proves nothing about model quality, coding ability, or cost realism.

## Consequences

### Positive

- The orchestrator can be written and tested before any vendor exists, and swapping in a real adapter is one file plus a registration.
- Capability gating prevents a whole class of silent failures (a task that needs a browser dispatched to a runtime without one).
- Normalised `usage` and `error.retryable` give the workflow a single vocabulary, so retry policy does not need vendor knowledge.
- `AbortSignal` makes cancellation a language-level contract rather than a convention.

### Negative / costs

- **The interface is a guess.** It has no field for a repository checkout/workspace, no environment-variable allowlist, no container image, no streaming progress, no mid-run human approval, and no partial-artifact contract for a run that fails after writing output. Expect a v2 that breaks `ExecutionRequest` when the first real adapter lands. That is a known, scheduled cost — not a surprise.
- `budgetUsd` is **advisory**, not enforced. No runtime can be trusted to stop at a dollar figure; a real adapter must be metered externally. Until then, the field is a declared intent and must not be described as a spend control.
- `allowedPaths` and `allowedActions` are advisory too. Enforcement requires a sandbox (filesystem namespace, seccomp, network policy). Without Docker there is no sandbox in this environment. This is a stated limitation, not an implementation detail.
- One implementation means no conformance test suite can be meaningful yet; a test suite with one implementation tests the implementation, not the contract.
- Adapter authors will be tempted to leak vendor specifics through `events` payloads. The normalisation rules are review-enforced.

## Alternatives considered

**Integrate one real agent now (e.g. an HTTP coding agent) and abstract later.** Rejected. It produces a demo that works and an architecture that lies. "Abstract later" is the decision that never gets made, and by then vendor semantics are threaded through the workflow. It is also blocked: no credentials, no budget, no sandbox.

**A generic "command runner" port (`spawn(cmd, args)`).** Rejected. It is thinner than the domain and pushes every vendor's semantics — how to detect failure, how to count tokens, how to cancel — into the workflow. The workflow would then contain per-vendor branches, which is exactly the coupling the port exists to prevent.

**An MCP-client-only abstraction (the runtime is an MCP server).** Rejected for now. MCP standardises tool access, not execution lifecycle, artifact production, cost, or cancellation. It may become a *capability* of future adapters (`mcp: true`), which is why that flag exists.

**Run agents in the API process instead of a worker.** Rejected — see ADR-001/ADR-003. Execution must survive request lifetime and process restart.

## Open items

- Whether a real runtime can honour `timeoutMs` at all (many are single HTTP calls with server-side limits). **Unknown — must be resolved before the first real adapter ships.**
- Whether artifacts can be streamed to the store during execution rather than returned at the end. **Unknown — must be resolved before any run produces more than a few megabytes.**
- `cancel(executionId)` takes an id that `execute()` never returns. This is a contract defect inherited from §8: the interface cannot cancel an execution it has not identified. Phase 2 works around it by tracking `taskId → AbortSignal` in the activity. Flagged to the Leader; the type should be `cancel(taskId)` or `execute()` should return a handle.

## Revisit trigger

Revisit at the **first real adapter** — expect a v2 of `ExecutionRequest` and possibly `ExecutionResult`, because the interface has never been exercised against vendor reality. Specific triggers: a runtime that streams partial output; a run that needs mid-execution approval; an artifact larger than memory; a runtime that cannot honour `timeoutMs`; or any adapter that must expose a vendor capability with no home in `RuntimeCapabilities`.
