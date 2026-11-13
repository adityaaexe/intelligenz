# INTELLIGENZ — Phase 3 Baseline

> Reconnaissance recorded before any Phase 3 code was written.
> Every claim here was produced by a command in this session. Nothing is inherited on trust from the Phase 2 report.

**Branch:** `phase-3/real-agent-runtime`
**Starting commit:** `43d5c17` — `docs: phase 2 architecture decisions and engineering record`
**Working tree at start:** clean, `main`, no git remote configured.

---

## 1. What Phase 2 actually left behind

| Layer | State | Evidence |
|---|---|---|
| Monorepo | 3 apps + 4 packages, pnpm workspaces | `pnpm-workspace.yaml`, 8 workspace projects |
| Data | 12 tables, 2 migrations, seeded | `prisma migrate status` → up to date on dev + test |
| API | 14 routes, JWT, tenant-scoped queries, approval gate | `apps/api/api-contract.md`, 42 e2e tests |
| Orchestration | `runTaskWorkflow` + 6 activities, retry/timeout/cancel | live Temporal runs in Phase 2 |
| Runtime | `LocalSimulatedRuntime` only | `packages/agent-runtime/src/runtimes/local-simulated.ts` |
| Web | Next.js Overview, real API data, 0 axe violations | `pnpm --filter @intelligenz/web test:e2e` → 33 passed |
| Gates | typecheck, lint, 239 unit, 42 API e2e, 33 web e2e, build | all exit 0 at `43d5c17` |

## 2. Environment, measured

| Capability | Result |
|---|---|
| Node | v22.23.2 |
| pnpm | 10.15.1 |
| PostgreSQL | 18.6, listening, `intelligenz_dev` + `intelligenz_test` reachable as role `intelligenz` |
| Redis | 8.0.5, `PONG` |
| Temporal | CLI 1.10.0 installed at `~/.local/bin`, dev server on 7233 (UI 8233) |
| Docker | **absent** |
| `gh` | **absent** |
| git remote | **none configured** — push remains BLOCKED |

## 3. Agent runtimes available on this host

| Binary | Version | Path |
|---|---|---|
| `opencode` | **v2.2.7** | `~/.nvm/versions/node/v22.23.2/bin/opencode` |
| `pi` | **1.0.4** | same bin directory |
| `claude`, `codex`, `aider`, `gemini`, `qwen`, `goose`, `crush`, `cursor-agent`, `amp` | absent | — |

`opencode auth list` shows stored credentials for **CommandCode**, **Google**, **OpenCode Console**, **Velona AI**, and `GITHUB_TOKEN` in the environment. This means a genuine, credentialed agent runtime exists here — Phase 3 is not blocked on provider access.

`opencode run` supports the flags the adapter needs: `--model`, `--format json`, `--auto`, `--title`, `--archived`, `--worktree`.

### Live headless probe (executed, not assumed)

```
$ opencode run --model commandcode/deepseek/deepseek-v4-flash --format json \
    "Reply with exactly the word PONG and nothing else."
{"type":"step_start",...}
{"type":"text","part":{"type":"text","text":"PONG"}}
{"type":"step_finish","part":{"reason":"stop","cost":0.006542268,
  "tokens":{"input":43598,"output":3,"cache":{"read":256,"write":0}}}}
exit=0, real 7.183s
```

This matters twice: it proves the adapter can be real, and it establishes the cost shape — roughly **$0.0065 and ~43.6k input tokens even for a trivial prompt**, because of the harness system prompt. Benchmark budgets must account for that.

## 4. Sandbox primitives, measured

| Primitive | State |
|---|---|
| `bwrap` (bubblewrap) | **present** |
| `unshare`, `nsenter`, `systemd-run`, `setcap` | present |
| `firejail` | absent |
| `kernel.unprivileged_userns_clone` | `1` |
| `user.max_user_namespaces` | `27191` |
| cgroup v2 | mounted, controllers: `cpuset cpu io memory hugetlb pids rdma misc dmem` |
| Docker / containers | absent |

### Live isolation probe (executed)

```
$ bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
        --ro-bind /bin /bin --proc /proc --dev /dev --tmpfs /tmp \
        --unshare-net --unshare-pid --die-with-parent --chdir /tmp \
        /bin/sh -c 'echo sandbox-ok; (curl -s -m 3 https://example.com && echo NETWORK-REACHABLE) || echo network-blocked'
sandbox-ok
network-blocked
```

Conclusion: **network egress can be genuinely enforced**, and a read-only root with a writable workspace is achievable. `shell: true` and `network: false` can therefore be honest capability declarations for the new adapter, provided the adapter refuses to run outside `bwrap`.

## 5. Constraints that shape Phase 3 design

1. **`bwrap` is the sandbox, not Docker.** No container images. Isolation is namespace + mount + network based, with cgroup v2 available for resource limits. This is real but weaker than a VM: it shares the host kernel.
2. **Secrets live in the host environment.** The sandbox must start from `--clearenv` and receive only an explicit allowlist, or provider keys will be visible to the agent.
3. **The agent needs its own credentials to think.** `opencode` authenticates from `~/.local/share/opencode` (or equivalent), so the sandbox must mount that config **read-only** — which is itself a secret exposure decision to be recorded, not ignored.
4. **Cost is per-call and non-trivial.** Every real execution spends provider credit. The evaluation harness must cap runs and record actual cost from `step_finish`.
5. **No git remote.** All work stays local; commits accumulate on `phase-3/real-agent-runtime`.
6. **Ports 3100/4100 remain reserved.** 3000/4000 belong to `/opt/reveil/repo/backend`.

## 6. Phase 2 gaps that Phase 3 must close

| Gap | Consequence for Phase 3 |
|---|---|
| No workspace concept at all | Tasks execute with no filesystem boundary |
| `LocalSimulatedRuntime` is the only adapter | No real execution path exists |
| `allowedPaths`/`budgetUsd` are advisory with no sandbox | Capability claims would be false for a real adapter |
| Artifacts written, never read back, checksum never re-verified | Integrity claim is unproven |
| Approval is "an APPROVED row exists", never consumed | Reusable authorisation; self-approval permitted |
| No execution attempt identity | A retry cannot be distinguished from the original run |
| 15/16 nav destinations placeholder | Only Overview is implemented; execution detail UI does not exist |

## 7. Risk register for this phase

| Risk | Mitigation |
|---|---|
| Agent escapes workspace via path or symlink | Containment checks in workspace manager + `bwrap` mount layout; explicit escape tests |
| Agent reads provider secrets or host files | `--clearenv`, read-only binds, no `$HOME` bind except a minimal tmpfs home |
| Agent makes network calls | `--unshare-net`, asserted by a live test |
| Agent runs destructive commands | Sandboxed to a throwaway clone; workspace root is disposable by design |
| Real execution silently falls back to simulated | `simulated` flag required on every result; UI labels it; a mismatch is a test failure |
| Cost overrun during evaluation | Per-run cap, run count cap, recorded actuals |
| Approval bypass via direct workflow start | Gate re-checked inside the worker activity, tested directly |

## 8. Starting point for implementation

Phase 3 begins from a green tree: every Phase 2 gate passes at `43d5c17`. No Phase 3 code exists yet. The frozen Phase 1 design (`DESIGN.md`, `docs/design/**`, `prototype/**`) is not modified by this phase.
