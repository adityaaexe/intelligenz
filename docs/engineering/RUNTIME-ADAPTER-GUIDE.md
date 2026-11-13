# Runtime adapter guide — writing a second adapter

**Audience:** an engineer who has never read this repository and has to add a new agent
runtime without breaking the ones that exist.
**Date:** 2026-11-13
**Status of the guidance:** `VERIFIED` against the two shipped adapters
(`local-simulated`, `opencode-cli`) and the tests named throughout.

The platform runs agents through one port. This guide describes that port, the contract
suite every adapter must pass, the honesty rules that make a capability claim mean
something, and the parts of the current interface that will fight you.

---

## 1. Where an adapter lives, and what it may not do

```
packages/agent-runtime/src/
  types.ts              the port and the Zod schemas at the seam
  errors.ts             typed failures, including the capability gate
  registry.ts           id → instance, once per process
  runtimes/
    local-simulated.ts  the default: no work, no spend, simulated: true
    opencode-cli.ts     the real one: bwrap + opencode
  sandbox/              egress proxy, entry shim, state mounts (opencode-specific)
  process-group.ts      spawn, kill the group, report why
```

Rules that are not negotiable:

1. **Nothing outside `packages/agent-runtime` may name a vendor.** `apps/api`,
   `apps/worker/src/workflows` and `packages/contracts` depend on the types only
   (ADR-006).
2. **`apps/worker/src/runtime.ts` is the only place an adapter is constructed.** Adding an
   adapter means adding a branch there and a value for `AGENT_RUNTIME`.
3. **An adapter is untrusted input.** The worker validates every result with
   `ExecutionResult.safeParse` before it reaches Prisma. Do not rely on that as your only
   validation: a result that fails the schema becomes a `RUNTIME_RESULT_INVALID` failure,
   which is a worse outcome than returning a well-formed `failed`.
4. **No adapter may write outside its own scratch directory.** The worker copies what you
   reference; it does not grant you the workspace directly.

---

## 2. The port

```ts
// packages/agent-runtime/src/types.ts
export interface AgentRuntime {
  readonly id: string;
  capabilities(): Promise<RuntimeCapabilities>;
  health(): Promise<RuntimeHealth>;
  execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
  cancel(taskId: string): Promise<void>;
}
```

Four methods and an id. Each one has a contract that a test can check, and one that it
cannot.

### 2.1 `readonly id: string`

A stable, lowercase, hyphenated identifier. It is:

- the value of `AGENT_RUNTIME` that selects this adapter;
- persisted as `AgentRun.runtimeId`, `ExecutionAttempt.runtimeId` and
  `Artifact.runtimeId` — so changing it orphans history;
- the key the simulated-flag guard uses (`runtimeId === 'local-simulated'`);
- the registry key. Registering the same id twice throws; adapters are registered once per
  process because an instance owns state (a sandbox, a connection, a child process).

Do not encode a version in the id. A vendor upgrade is a new `runtimeVersion` on the
result, not a new adapter id.

### 2.2 `capabilities(): Promise<RuntimeCapabilities>`

```ts
{
  shell: boolean;
  network: boolean;
  filesystem: 'none' | 'read' | 'write';
  browser: boolean;
  mcp: boolean;
  imageInput: boolean;
}
```

Called by the worker at startup (logged) and **before dispatch** in
`executeAgentActivity`. `missingCapabilities()` compares the declaration against the
actions a task requires and fails the run with `RUNTIME_CAPABILITY_MISSING` before any
work or spend.

Two things to know:

- **The gate is a hook today, not a filter.** `requiredActionsFor()` in
  `execute-agent.ts` returns `[]` because the schema has no `requiredCapabilities` column.
  A declaration that is wrong will not be caught by the gate until that changes. It is
  still the honest thing to declare, and it is the field an operator reads.
- **`filesystem: 'write'` means the agent can write somewhere**, not that it can write
  anywhere. Say where in your documentation, because the type cannot.

### 2.3 `health(): Promise<RuntimeHealth>`

```ts
{ status: 'ok' | 'degraded' | 'down'; simulated: boolean; checkedAt: string;
  latencyMs?: number; detail?: string }
```

- `status` is your judgement: `ok` = a run would probably work now; `degraded` = it would
  work but something is missing (no credential, slow provider); `down` = it would not.
- `simulated` is load-bearing — it is logged at worker startup and must match the results
  you return. A real adapter reporting `simulated: true` is a lie that understates work
  and cost (F15).
- `checkedAt` is when you checked, not when the platform asked.
- **`health()` is not called before every run.** The worker calls it once at boot. Do not
  put a per-run precondition in it and assume it runs; check inside `execute()`.

### 2.4 `execute(req, signal): Promise<ExecutionResult>`

The whole run. Rules:

| Rule | Why |
|---|---|
| Return a result; do not throw for a domain outcome | A thrown error loses the partial evidence and becomes a Temporal retry decision you did not make. Return `failed`/`timeout`/`cancelled` with an `error` the workflow can persist. |
| Honour `signal` | It is the platform's only cancellation channel; `cancel(taskId)` converges on the same path. An adapter that ignores it leaves a process running after the user cancelled. |
| Never exceed `timeoutMs` silently | Return `status: 'timeout'` with `retryable: true`. The worker caps the budget at 230 s; the adapter's own timer must fire first so the *reason* survives. |
| Always return a non-empty `summary` | It is shown to the operator and stored. `ExecutionResult` rejects an empty one. |
| Return `usage` with `undefined` for unknown fields, never `0` | `0` reads as "free". The one legitimate zero is a simulated adapter, which genuinely spends nothing. |
| Reference artifacts by absolute path, checksum and size | The worker copies the bytes and **recomputes** the checksum; yours is a claim until then. |
| Keep `toolInvocations[].summary` ≤ 500 characters and redacted | The column is `VarChar(500)`; a longer value is a database error at persist time. |
| Set `runtimeVersion` from the binary, not a constant you bumped by hand | It is the only record of which build ran. |

`ExecutionRequest` fields you must respect, and fields you may not:

| Field | Status | What to do |
|---|---|---|
| `taskId` | **identity** | Use it in your run id. It is a UUID from the database today, but the type only guarantees a non-empty string — sanitise it before it becomes a path (F6). |
| `goal` | **input** | Pass it to the agent. Validate that it does not begin with `-` if your CLI parses flags (F12). |
| `timeoutMs` | **required** | Enforce it. |
| `workspaceRoot` | **required for a filesystem adapter** | Refuse the request if it is absent. Never fall back to the process cwd. |
| `allowedPaths` | advisory | Recorded; you may enforce a narrower set, not a wider one. |
| `allowedActions` | advisory | Same. |
| `budgetUsd` | **advisory** | See §8.1. Do not describe it as a spend control. |
| `riskClass` | input for logging | The platform decides approval; you do not. |
| `correlationId` | trace | Put it in your logs. |

### 2.5 `cancel(taskId): Promise<void>`

Cancels a run **by the id the caller already has**.

This signature is a correction, and the history matters because it is easy to re-introduce
the bug. The original contract (`docs/engineering/PHASE-2-CONTRACT.md` §8, and the code
block still visible in ADR-006) declared `cancel(executionId: string)`. But `execute()`
returns a *result*, never a handle — so the caller had no `executionId` to pass. The only
identifier a caller holds is the `taskId` it sent in the request. Amendment A4 changed the
signature to `cancel(taskId)`, and `types.ts` implements that.

The implementation pattern, from `opencode-cli.ts`:

```ts
private readonly running = new Map<string, () => void>();

async cancel(taskId: string): Promise<void> {
  this.running.get(taskId)?.();
}
```

- `running` is populated by `runInProcessGroup({ registerKill })` immediately after spawn,
  and removed when the group exits.
- The kill function signals **the process group** (`process.kill(-pid, 'SIGTERM')`, then
  `SIGKILL` after a grace window), not the child. A `setsid` grandchild survives a
  single-process kill; it does not survive a group kill plus `--unshare-pid` teardown.
- Cancelling an unknown or already-finished task is a **no-op, not an error**. The caller
  may race a completion; throwing would turn a harmless race into a failed activity.
- `cancel()` is best-effort by contract. The authoritative record of cancellation is the
  result the activity returns and the rows it writes, not the fact that `cancel()`
  resolved.

One adapter, one execution per task. See §8.4: `taskId` is the only key, so two concurrent
runs of the same task cannot both be cancelled correctly.

---

## 3. Registering it

`apps/worker/src/runtime.ts`:

```ts
export function createAgentRuntime(config: WorkerConfig): AgentRuntime {
  if (config.execution.runtimeId === 'codex-cli') {
    return new CodexCliRuntime({ /* ... */ });
  }
  // ...
}
```

`runtimeRequiresWorkspace(runtimeId)` returns `runtimeId !== 'local-simulated'`, so **any**
new adapter gets a leased workspace by default, whether it wants one or not. If your
adapter does not need a checkout, that is wasted work (a clone per attempt) — change the
function deliberately, with a test, rather than letting it be wrong quietly.

---

## 4. The contract suite

`packages/agent-runtime/test/runtime-contract.ts`, exported as
`@intelligenz/agent-runtime/testing`. Call it from your adapter's test file:

```ts
import { describeRuntimeContract } from '@intelligenz/agent-runtime/testing';

describeRuntimeContract(
  (context) => new CodexCliRuntime({ artifactRoot: context.artifactRoot, /* ... */ }),
  {
    deterministic: false,           // if a model is involved
    timeoutProbeMs: 1,              // default; raise for a very fast adapter
    resolveArtifact: async (uri) => readFile(uri),  // if artifacts are not local files
    request: { workspaceRoot: '/known/path', timeoutMs: 120_000 },
  },
);
```

### The eight assertions

| # | Assertion | What it catches |
|---:|---|---|
| 1 | Capabilities parse against `RuntimeCapabilities`; `id` is a non-empty string | A typo, an extra key, a missing field |
| 2 | `health()` parses; status is one of `ok/degraded/down`; `simulated` is a boolean | A health report the platform cannot store |
| 3 | `execute()` resolves with a status from the union | A vendor string leaking through |
| 4 | A result always has a summary and usage; a failed/timeout result explains itself with a code and `retryable` | Silent failures, empty rows, a UI with nothing to show |
| 5 | An already-aborted signal returns `cancelled` **without throwing** | A cancellation that becomes a retry |
| 6 | A 1 ms budget returns `timeout` with `retryable: true` | A budget that is ignored |
| 7 | A succeeded run produces ≥1 artifact whose bytes hash to the reported checksum and size | Fake artifacts, stale checksums, a copy that truncates |
| 8 | The same request twice yields the same summary and the same artifact checksums | Non-reproducible evidence |

### Which assertions a non-deterministic adapter may skip

**Only #8**, and only by declaring `deterministic: false`. It is implemented as
`it.runIf(deterministic)`, so the report shows it as **skipped**, not green. That is the
point: a skip is visible, a lie is not.

Everything else must pass. In particular:

- **#7 is not optional.** If your adapter cannot produce an artifact, it cannot be
  verified; make it produce the transcript at minimum.
- **#5 and #6 are not optional.** They are how the platform distinguishes "cancelled" from
  "failed" from "still running".
- **#1 and #2 are not optional.** They are the shapes the UI and the startup log read.

The suite has three assumptions it cannot avoid, documented in its header: a 1 ms timeout
probe is fast enough to be distinguishable; artifacts are files unless you supply
`resolveArtifact`; and determinism is a choice you declare. Override `timeoutProbeMs` if
your adapter can finish real work in under a millisecond — none can.

### Why skipping #8 weakens replay safety

This is worth being precise about, because "replay" is overloaded.

**Temporal replay is not affected.** A Temporal workflow replays its *decision history*;
activity results are recorded in that history and are not re-executed on replay. An
activity that calls a non-deterministic adapter does not make the workflow
non-deterministic, because the workflow never re-runs the activity's body.

**What is lost is the ability to reconstruct the run.** With #8 skipped:

1. **The artifact is the only copy of the evidence.** You cannot re-run the same input to
   check that the checksum you stored is the checksum the work produces. A corrupted or
   tampered artifact can be detected against its own recorded digest, but the digest
   itself cannot be independently re-derived. An operator investigating a suspicious run
   has no way to ask "does this reproduce?".
2. **A retry is not comparable to its predecessor.** Attempt 1 and attempt 2 are different
   by design, and that is fine — but a *repair* that re-executes attempt 1 (same
   `agentRunId`, same artifact identity) will now produce different bytes. The
   content-addressed artifact id means the platform stores a second artifact for the same
   attempt window rather than updating the first; attribution by time window then shows
   two diffs for one attempt. That is a correctness hazard in the read path, not just a
   philosophical one.
3. **"Same input, different result" cannot be bisected.** A regression in your adapter
   (a changed prompt, a changed default, a changed tool) is indistinguishable from model
   variance. The determinism assertion is the only test in the suite that would notice
   your adapter changed its behaviour when nothing in the request changed.
4. **Evaluation becomes incomparable across time.** A benchmark that runs today and again
   next month cannot separate "the model improved" from "the harness changed", because
   the harness has no reproducibility check.

The honest position, and the one this repository takes: a model-backed adapter **cannot**
have #8, so it must state that it does not, and every downstream claim about
reproducibility must be weakened to match. `deterministic: false` is a disclosure, not a
convenience flag.

---

## 5. Declaring capabilities honestly

A capability is a **claim about the agent's environment**, in the vocabulary the platform
has. It is not a feature list, and it is not a boundary.

### 5.1 The rule

> **A capability is not a boundary unless the execution environment enforces it.**

`capabilities().network = false` is a *description* of what the agent can reach. It stops
nothing. The boundary is `--unshare-net` plus a proxy that validates `CONNECT`. If you
report `network: false` and your sandbox has an interface, you have written a false
statement into a log line and a UI; the platform will not enforce it for you.

The same applies to `filesystem: 'write'`: the platform does not confine your writes. If
your adapter writes to `/etc`, the declaration is still `'write'` and the damage is still
done. The enforcement must exist in your adapter — a mount table, a chroot, a namespace, a
container.

### 5.2 How to write the qualified claim

`network: false` is true for `opencode-cli` **only with a qualifier**, and the qualifier is
part of the documentation, not a footnote:

> No general egress; model traffic only via an allowlisted 443 proxy; all other sockets
> blocked.

That sentence is in `types.ts`, in the adapter's `capabilities()` doc comment and in
ADR-006's implementation note, because a bare `network: false` overstates it: a tunnel to
a provider is a capability of the *adapter*, and the proxy is its boundary. If your adapter
needs a provider channel, write your version of that sentence and put it in all three
places.

### 5.3 What not to do

| Anti-pattern | Why it is wrong |
|---|---|
| `shell: true` because the vendor's product page says "agentic" | Declare what the **sandboxed process** can do. If there is no way to spawn a process, it is `false`. |
| `filesystem: 'write'` when the only write is a log file in `/tmp` | `'none'`/`'read'`/`'write'` describes the agent's access to *task data*. A temp file is not a capability. |
| `mcp: true` because the vendor supports MCP | Does *this run* have MCP servers configured and reachable? If not, `false`. |
| Copying another adapter's capability object | The object is a claim about your sandbox. Copying it copies a lie. |
| Adding a boolean to `RuntimeCapabilities` for a vendor feature | The type is `.strict()`. A new field is a contract change; see §8. |

---

## 6. The `simulated` flag

`ExecutionResult.simulated` and `RuntimeHealth.simulated` mean one thing: **this adapter
did not perform real work**.

### 6.1 When it must be `true`

- The adapter makes no model call, no network call, and produces its output
  deterministically from its input.
- Its "artifacts" are generated, not observed.
- It spends nothing.

`LocalSimulatedRuntime` is the reference: `simulated: true` on health, on every result,
and `AgentRun.model` is the literal string `simulated` when the result is persisted.

### 6.2 When it must be `false`

- Any adapter that calls a provider, spends money, or executes a tool in a real
  environment — **even if the run fails before the model answers.**

A real adapter that fails at spawn is still `simulated: false`: the attempt was real, the
credential was used (or would have been), and the failure is a real failure. The worker's
provisional value for the attempt row is `runtimeId !== 'local-simulated'`, which is the
honest default; your result replaces it.

### 6.3 The guard, and what it does not guard

`executeAgentActivity` and `persistResultActivity` both refuse
`runtimeId === 'local-simulated' && simulated === false`:

```
SIMULATED_FLAG_INCONSISTENT — A local-simulated result cannot be persisted with simulated=false.
```

That is the direction that would relabel fake work as real, and it is checked twice on
purpose. The **other** direction is not structurally guarded: a real adapter reporting
`simulated: true` would be persisted as a simulated run, understating real work and spend
(F15). Do not do it. If you find yourself wanting to, the honest move is to fix the
adapter, not the flag.

The UI labels every attempt row from `attempt.simulated`. A wrong flag is not a cosmetic
bug: it changes what an operator believes happened.

---

## 7. A worked skeleton

A hypothetical `codex-cli` adapter: a vendor CLI, a real model, a repository. The comments
separate **what any adapter must do** from **what is this environment's business**.

> The sketch does not compile as printed — `/* … */` placeholders mark the parts that
> depend on the vendor — and it is deliberately incomplete. It exists to show the shape of
> the obligations, not to be pasted.

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentRuntime, ExecutionRequest, ExecutionResult, RuntimeCapabilities, RuntimeHealth,
} from '../types';
import { runInProcessGroup } from '../process-group';
import { redactAndTruncate } from '../redact';

export class CodexCliRuntime implements AgentRuntime {
  readonly id = 'codex-cli';

  private readonly workspaceRoot: string;   // the lease root the worker configured
  private readonly scratchRoot: string;     // this adapter's own per-run directory
  private readonly model: string;
  private readonly maxUsd: number;          // a real cap, checked against reported spend
  private readonly running = new Map<string, () => void>();

  constructor(options: { workspaceRoot: string; scratchRoot: string; model: string; maxUsd: number }) {
    // ── EVERY ADAPTER ──────────────────────────────────────────────────────
    // Refuse an unusable configuration at construction, not mid-run.
    if (options.maxUsd <= 0) throw new Error('codex-cli requires maxUsd > 0');
    this.workspaceRoot = options.workspaceRoot;
    this.scratchRoot = options.scratchRoot;
    this.model = options.model;
    this.maxUsd = options.maxUsd;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    // ── EVERY ADAPTER ──────────────────────────────────────────────────────
    // A claim about the sandboxed process, in the platform's vocabulary.
    return {
      shell: true,
      network: false,        // qualified in the doc comment: allowlisted proxy only
      filesystem: 'write',   // the leased clone, nothing else
      browser: false,
      mcp: false,
      imageInput: false,
    };
  }

  async health(): Promise<RuntimeHealth> {
    // ── EVERY ADAPTER ──────────────────────────────────────────────────────
    const checkedAt = new Date().toISOString();
    // Probe the binary and the credential; never report ok on optimism.
    const version = await this.probeVersion();
    return version === null
      ? { status: 'down', simulated: false, checkedAt, detail: 'codex binary not found' }
      : { status: 'ok', simulated: false, checkedAt, detail: `codex ${version}` };
  }

  async cancel(taskId: string): Promise<void> {
    // ── EVERY ADAPTER ──────────────────────────────────────────────────────
    // Kill the group. A no-op for an unknown task. Never throw for a race.
    this.running.get(taskId)?.();
  }

  async execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult> {
    // ── EVERY ADAPTER: refusal gates, before any spend ─────────────────────
    if (signal.aborted) return this.result('cancelled', 'Cancelled before the run started');
    if (req.workspaceRoot === undefined) {
      return this.fail('WORKSPACE_REQUIRED', 'A real run needs a workspaceRoot');
    }

    // ── EVERY ADAPTER: identity and scratch, sanitised ─────────────────────
    // taskId is a UUID today; the type does not promise that. Never interpolate
    // it into a path without an allowlist (F6).
    const safeTask = req.taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const runDir = join(this.scratchRoot, this.id, `${safeTask}-${Date.now().toString(36)}`);

    // ── THIS ENVIRONMENT: the sandbox ──────────────────────────────────────
    // Do NOT copy this part into a second adapter. It is opencode's, not the port's.
    //
    //   bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /etc /etc \
    //         --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run \
    //         --bind <workspace>/repo /workspace \
    //         --unshare-pid --unshare-net --new-session --die-with-parent \
    //         --clearenv --setenv PATH … --chdir /workspace \
    //         -- node /opt/agent/sandbox-entry.mjs codex run --model … -- <goal>
    //
    //   A different adapter may need docker, a VM, a remote runner, or nothing at
    //   all. What it may NOT do is run the model's shell on the host.

    // ── EVERY ADAPTER: spawn under a deadline, never a bare spawn ──────────
    const outcome = await runInProcessGroup({
      file: 'bwrap', args: /* … */ [],
      timeoutMs: req.timeoutMs,
      signal,
      killGraceMs: 5_000,
      registerKill: (kill) => this.running.set(req.taskId, () => kill('aborted')),
      onStdout: (chunk, kill) => {
        // ── EVERY ADAPTER: a spend cap is enforced while it runs, not after ─
        const spent = this.parseReportedCost(chunk);
        if (spent !== undefined && spent > this.maxUsd) kill('cost-cap');
      },
    });
    this.running.delete(req.taskId);

    // ── EVERY ADAPTER: map the outcome, do not leak the vendor's vocabulary ─
    const status =
      outcome.reason === 'aborted' ? 'cancelled'
      : outcome.reason === 'timeout' ? 'timeout'
      : outcome.reason === 'cost-cap' ? 'failed'
      : outcome.exitCode === 0 ? 'succeeded' : 'failed';

    // ── EVERY ADAPTER: artifacts are files with real digests ───────────────
    const transcriptPath = join(runDir, 'transcript.ndjson');
    const bytes = await readFile(transcriptPath);
    const artifacts = [{
      kind: 'transcript',
      uri: transcriptPath,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
    }];

    return {
      status,
      summary: redactAndTruncate(`codex ${status} in ${outcome.exitCode}…`, 4000),
      artifacts,
      events: [],
      usage: { /* undefined for unknown, never 0 */ },
      runtimeId: this.id,
      simulated: false,                 // ── EVERY ADAPTER: a real run ──
      runtimeVersion: 'codex 0.0.0',    // from the binary, not a constant
      toolInvocations: [],              // redacted, ≤500 chars each
      ...(status === 'succeeded' ? {} : {
        error: { code: 'CODEX_FAILED', message: '…', retryable: outcome.reason === 'timeout' },
      }),
    };
  }

  private result(status: ExecutionResult['status'], summary: string): ExecutionResult {
    return { status, summary, artifacts: [], events: [], usage: {},
             runtimeId: this.id, simulated: false };
  }

  private fail(code: string, message: string): ExecutionResult {
    return { status: 'failed', summary: message, artifacts: [], events: [], usage: {},
             runtimeId: this.id, simulated: false,
             error: { code, message, retryable: false } };
  }

  private async probeVersion(): Promise<string | null> { return null; }
  private parseReportedCost(chunk: Buffer): number | undefined { return undefined; }
}
```

What is **yours** in that skeleton: the sandbox, the argv, the stream parser, the cost
extraction, the artifact set. What is **the port's**: the refusals, the result shape, the
`simulated` value, the deadline, the group kill, the redaction, the checksum. A second
adapter that reimplements the port's half is a second platform.

---

## 8. Known weaknesses of the current interface

These are not hypotheticals. They are the cost of designing a port against one real
adapter, and they are the reason ADR-006 expects a v2.

### 8.1 `budgetUsd` is advisory

`ExecutionRequest.budgetUsd` is recorded and never enforced by the port
(`types.ts` says so; contract §15 A7). `OpencodeCliRuntime` has a **separate**
`maxUsd` option that kills the run when the provider-reported cost passes it — that is a
cap on what the provider says it spent, not on what the platform authorised. An adapter
that ignores `budgetUsd` is conforming. Do not describe either field as a spend control
without saying which one you mean.

The shipped implementation of `maxUsd` has its own flaw: it sums every `"cost":` field it
sees in the stream, so a provider that repeats a cumulative total is counted repeatedly.
That can kill a run early or let it overspend, which is an availability and cost bug (F11),
not an escape. A correct implementation reads the total from the terminal `step_finish`
event only.

### 8.2 No streaming progress to the user

`execute()` returns once, at the end. The adapter can build `events` internally, but the
worker persists them after the run, so a ten-minute task shows "running" and nothing else.
The UI refuses to draw a progress bar for exactly this reason
(`execution-detail-screen.tsx`: "no step total is reported, so a percentage would be
invented"). A vendor that streams tokens has nowhere to put them.

### 8.3 `workspaceRoot` is a directory, not a checkout contract

The request carries one path. It does not say what repository, which commit, which branch,
or whether the directory is a worktree, a clone or empty. The workspace manager knows, and
the `ExecutionWorkspace` row records it, but the adapter never sees it. So an adapter
cannot assert "I am running against commit X" — it can only trust the directory it was
handed. `listFiles`/`readFile` style adapters will want more.

### 8.4 One execution per `taskId`

`cancel(taskId)` keys on the task, so a second concurrent run of the same task would share
the kill entry, and cancelling one would kill both. The platform avoids this today because
a workflow id is `task-<taskId>` with `REJECT_DUPLICATE` and one workflow per task is
open at a time. An adapter used outside that assumption — a queue, a batch runner, a
retry with a different attempt number — needs an execution id in the port. That is a v2
change.

### 8.5 The capability gate has nothing to check against

`requiredActionsFor()` returns `[]` because the schema has no `requiredCapabilities`
column. The gate works; it has no inputs. Until that column exists, `capabilities()` is
documentation with a type.

### 8.6 No partial-artifact contract

A run that writes a 400 MB artifact and then fails returns `failed` with an artifact
reference, and the worker copies it. There is no "this artifact is valid even though the
run failed" flag, and no streaming to the store during the run. ADR-006 lists this as
open; it becomes real the first time a run produces more than a few megabytes.

### 8.7 `health()` has no per-run effect

The worker calls it once at boot. A run does not re-check it. If your adapter can become
unhealthy between boot and execution, `execute()` must handle that itself.

---

## 9. Pre-registration checklist

Before you open the pull request:

- [ ] `id` is stable, lowercase, and not a vendor version.
- [ ] `capabilities()` matches what the sandboxed process can actually do, and the
      qualified `network` sentence is in the type comment, the adapter comment and the ADR
      note.
- [ ] `health()` reports `down` when the binary or credential is missing, and never
      reports `ok` without checking.
- [ ] `execute()` refuses a missing/out-of-root `workspaceRoot` before spawning.
- [ ] `execute()` returns `cancelled` for an aborted signal and `timeout` for an expired
      budget, with `retryable` set correctly.
- [ ] `cancel()` kills the **process group**, is a no-op for an unknown task, and does not
      throw.
- [ ] A spend cap is enforced during the run, not after it.
- [ ] Every artifact is an absolute path with a SHA-256 you computed from the bytes.
- [ ] Every tool summary is redacted and ≤ 500 characters.
- [ ] `simulated: false` on every result and on `health()`.
- [ ] `describeRuntimeContract` is wired in and passing, with `deterministic: false` only
      if a model is involved — and a comment saying so.
- [ ] An escape test exists for the adapter's sandbox, with a **negative control** that
      proves the payload is live (see `workspace-git.test.ts`).
- [ ] The adapter does not run a host tool against an agent-writable directory. If it
      must, it runs it inside the same sandbox the agent ran in.
