/* ==========================================================================
   INTELLIGENZ — Fixtures
   All data on every screen comes from this file. Nothing is fetched.
   IDs, costs, durations and model names are engineering-plausible and are
   intentionally consistent with docs/design/screens/*.md.
   ========================================================================== */

window.IZData = (function () {
  "use strict";

  var org = {
    name: "Northwind Labs",
    plan: "Enterprise",
    owner: "M. Okafor"
  };

  var user = {
    name: "M. Okafor",
    initials: "MO",
    role: "Owner",
    email: "m.okafor@northwind.example"
  };

  var workspace = {
    id: "wsp_reveilchat",
    name: "ReveilChat",
    slug: "reveilchat",
    plan: "Enterprise",
    role: "Owner",
    memberCount: 14,
    projectCount: 4
  };

  var workspaces = [
    { id: "wsp_reveilchat", name: "ReveilChat", meta: "4 projects · 14 members", current: true },
    { id: "wsp_northwind", name: "Northwind", meta: "6 projects · 22 members" },
    { id: "wsp_intelligenz", name: "INTELLIGENZ", meta: "2 projects · 5 members" }
  ];

  var project = { id: "prj_control-plane", name: "Control Plane" };
  var environment = "prod";
  var branch = { name: "main", sha: "8f2c1a4" };

  var modes = [
    { id: "autopilot", label: "Autopilot", icon: "i-play", hint: "Executes previously approved, bounded tasks" },
    { id: "copilot", label: "Copilot", icon: "i-eye", hint: "Prepares work, requests approval before material change" },
    { id: "manual", label: "Manual", icon: "i-hand", hint: "Operator controls all execution" }
  ];

  var posture = {
    state: "nominal",
    word: "Nominal",
    reason: "all systems within contract",
    since: "2026-11-13T04:12:00Z",
    activeRuns: 4,
    queuedRuns: 7,
    awaitingApproval: 3,
    failed24h: 2,
    spend: { today: 186.4, ceiling: 600, forecast: 412 },
    monthly: { used: 3142, ceiling: 9000 }
  };

  var constraints = {
    maxRisk: "Medium",
    dailyBudget: "$600 / day",
    repos: "4 repos",
    environment: "sandbox:firecracker",
    rollback: "revert + slot"
  };

  /* ---- navigation ---- */
  var navGroups = [
    {
      id: "pinned",
      label: "",
      pinned: true,
      items: [
        { id: "overview", label: "Overview", href: "#/overview", icon: "i-grid" },
        { id: "approvals", label: "Approvals", href: "#/approvals", icon: "i-check-badge", badge: 3, badgeKind: "awaiting" },
        { id: "agents", label: "Agent Command Centre", href: "#/agents", icon: "i-hex" },
        { id: "projects", label: "Projects", href: "#/projects", icon: "i-folder" }
      ]
    },
    {
      id: "engineering",
      label: "Engineering",
      items: [
        { id: "code", label: "Code Intelligence", href: "#/code", icon: "i-code" },
        { id: "design", label: "Design Intelligence", href: "#/design", icon: "i-pen" },
        { id: "creative", label: "Creative Studio", href: "#/creative", icon: "i-spark" },
        { id: "workflows", label: "Workflow Studio", href: "#/workflows", icon: "i-nodes" },
        { id: "schedules", label: "Schedules", href: "#/schedules", icon: "i-clock" }
      ]
    },
    {
      id: "intelligence",
      label: "Intelligence",
      items: [
        { id: "research", label: "Research Lab", href: "#/research", icon: "i-flask" },
        { id: "models", label: "Model Intelligence", href: "#/models", icon: "i-chip" },
        { id: "knowledge", label: "Knowledge Base", href: "#/knowledge", icon: "i-book" }
      ]
    },
    {
      id: "assurance",
      label: "Assurance",
      items: [
        { id: "security", label: "Security", href: "#/security", icon: "i-shield" },
        { id: "reports", label: "Reports", href: "#/reports", icon: "i-doc" }
      ]
    },
    {
      id: "platform",
      label: "Platform",
      items: [
        { id: "integrations", label: "Integrations", href: "#/integrations", icon: "i-plug" },
        { id: "marketplace", label: "Marketplace", href: "#/marketplace", icon: "i-bag" }
      ]
    }
  ];

  /* ---- runs ---- */
  var runs = [
    {
      id: "run_01JB7Q2K8M4X", short: "run_01JB7Q2K8M4X",
      title: "Rotate refresh tokens in auth middleware",
      state: "active", stateLabel: "Running",
      agent: "Atlas", agentId: "agt_eng_04", avatar: "AT",
      repo: "reveilchat/backend", model: "claude-sonnet-4-5",
      cost: 2.14, duration: "14m 22s", started: "04:04Z", startedAbs: "2026-11-13T04:04:11Z",
      task: "tsk_01JB7P3N8Q", project: "Control Plane",
      step: "Step 4 of 9 · running tests", tokensIn: 412880, tokensOut: 31844,
      detail: "128 of 214 tests passed. 86 pending. No failures yet.",
      branch: "feature/token-rotation"
    },
    {
      id: "run_01JB7Q4R2C9P", short: "run_01JB7Q4R2C9P",
      title: "Regenerate design tokens for dark theme",
      state: "active", stateLabel: "Running",
      agent: "Wren", agentId: "agt_des_01", avatar: "WR",
      repo: "intelligenz/design-system", model: "gpt-5.1",
      cost: 0.61, duration: "6m 08s", started: "04:12Z", startedAbs: "2026-11-13T04:12:40Z",
      task: "tsk_01JB7Q6T1M", project: "Design System",
      step: "Step 2 of 5 · generating contrast pairs", tokensIn: 98420, tokensOut: 12044,
      detail: "41 tokens generated, 6 pairs below AA and flagged for review.",
      branch: "feat/dark-tokens"
    },
    {
      id: "run_01JB7P9XW3N2", short: "run_01JB7P9XW3N2",
      title: "Merge PR #412 rate-limit middleware",
      state: "awaiting", stateLabel: "Awaiting approval",
      agent: "Kestrel", agentId: "agt_eng_02", avatar: "KE",
      repo: "reveilchat/backend", model: "claude-sonnet-4-5",
      cost: 1.87, duration: "22m", started: "03:24Z", startedAbs: "2026-11-13T03:24:02Z",
      task: "tsk_01JB7P2V6R", project: "Control Plane",
      step: "Step 9 of 9 · awaiting merge approval", tokensIn: 288410, tokensOut: 41220,
      detail: "Approval apr_01JB8M3XQ2 is waiting on a second approver.",
      branch: "feat/rate-limit"
    },
    {
      id: "run_01JB7Q8T5H6V", short: "run_01JB7Q8T5H6V",
      title: "Audit WCAG contrast on onboarding flow",
      state: "queued", stateLabel: "Queued",
      agent: "Audra", agentId: "agt_audit_01", avatar: "AU",
      repo: "reveilchat/mobile", model: "gemini-2.5-pro",
      cost: 0, duration: "—", started: "04:18Z", startedAbs: "2026-11-13T04:18:07Z",
      task: "tsk_01JB7Q8S2D", project: "Mobile",
      step: "Waiting for a worker slot", tokensIn: 0, tokensOut: 0,
      detail: "Queued behind 2 runs on the audit pool. Estimated start 04:24Z.",
      branch: "main"
    },
    {
      id: "run_01JB7N1K7D4S", short: "run_01JB7N1K7D4S",
      title: "Partition sessions table by month",
      state: "failed", stateLabel: "Failed",
      agent: "Forge", agentId: "agt_eng_07", avatar: "FG",
      repo: "reveilchat/infra", model: "claude-sonnet-4-5",
      cost: 4.92, duration: "41m 06s", started: "03:41Z", startedAbs: "2026-11-13T03:41:55Z",
      task: "tsk_01JB7M8K2P", project: "Infrastructure",
      step: "Failed at step 4 of 9 · test", tokensIn: 612400, tokensOut: 88410,
      detail: "12 of 214 tests failing in services/auth. Retry from step 4 or roll back to build 8841.",
      branch: "feat/partition-sessions"
    },
    {
      id: "run_01JB7Q0M8B1L", short: "run_01JB7Q0M8B1L",
      title: "Index research corpus (1.2M docs)",
      state: "degraded", stateLabel: "Degraded",
      agent: "Sift", agentId: "agt_res_02", avatar: "SF",
      repo: "intelligenz/knowledge", model: "qwen3-embedding-8b",
      cost: 0.38, duration: "2h 08m", started: "02:10Z", startedAbs: "2026-11-13T02:10:19Z",
      task: "tsk_01JB7PZ4A", project: "Knowledge",
      step: "Step 3 of 5 · embedding shard 7 of 12", tokensIn: 1204880, tokensOut: 0,
      detail: "Throughput 41% below contract. Provider latency 4.2s p95 against 1.5s target.",
      branch: "main"
    },
    {
      id: "run_01JB7K5T9F3Q", short: "run_01JB7K5T9F3Q",
      title: "Generate Q4 delivery report for Northwind",
      state: "completed", stateLabel: "Completed",
      agent: "Ledger", agentId: "agt_rep_01", avatar: "LG",
      repo: "intelligenz/reports", model: "gpt-5.1",
      cost: 0.44, duration: "8m 41s", started: "02:02Z", startedAbs: "2026-11-13T02:02:31Z",
      task: "tsk_01JB7K2R8C", project: "Reports",
      step: "Completed · verification passed", tokensIn: 74120, tokensOut: 18400,
      detail: "Report rpt_01JB7K9Q2 published. Evidence set hash 9f3c…a21e.",
      branch: "main"
    },
    {
      id: "run_01JB7J8V2R6D", short: "run_01JB7J8V2R6D",
      title: "Contract tests for /v2/matches",
      state: "completed", stateLabel: "Completed",
      agent: "Kestrel", agentId: "agt_eng_02", avatar: "KE",
      repo: "reveilchat/backend", model: "claude-sonnet-4-5",
      cost: 1.12, duration: "11m 19s", started: "01:48Z", startedAbs: "2026-11-13T01:48:12Z",
      task: "tsk_01JB7H6T4N", project: "Control Plane",
      step: "Completed · 41 contract tests passed", tokensIn: 198240, tokensOut: 22110,
      detail: "No schema drift detected against openapi 2026-11-01.",
      branch: "main"
    }
  ];

  /* ---- approvals ---- */
  var approvals = [
    {
      id: "apr_01JB8F7T1K",
      short: "apr_01JB8F7T1K",
      title: "Drop legacy match_events table",
      actionVerb: "delete",
      summary: "Drop the legacy match_events table (412,880 rows) and re-point the analytics job at match_events_v2.",
      risk: { level: "critical", score: 84, factors: [
        { label: "irreversible data deletion", weight: 34 },
        { label: "production environment", weight: 18 },
        { label: "412,880 rows affected", weight: 14 },
        { label: "retention policy exception granted", weight: 8 },
        { label: "backup verified 02:40Z", weight: -10 }
      ]},
      state: "awaiting",
      requestedBy: { name: "Forge", agentId: "agt_eng_07", avatar: "FG", runtime: "OpenHands" },
      requestedAt: "2026-11-13T02:46:11Z",
      age: "1h 04m",
      runId: "run_01JB7M8K2P",
      taskId: "tsk_01JB7M8K2P",
      blast: { files: 2, additions: 46, deletions: 12, repos: ["reveilchat/infra"], services: ["analytics-worker", "reporting-api"], envs: ["prod"], records: 412880 },
      cost: { runtime: 0, monthlyDelta: -18.4, note: "Storage saving, offset by one-off export" },
      guardrails: {
        permission: "db:ddl · table:match_events · no:drop-without-backup",
        budget: { perRun: 40, used: 6.2, perDay: 120 },
        repos: ["reveilchat/infra"],
        environment: "sandbox:firecracker · 4 vCPU · 8 GiB · egress deny-all",
        rollback: "restore from snapshot snap_01JB7N2 (verified 02:40Z), 26m RTO"
      },
      policies: [
        { id: "pol_data_retention_v4", name: "Data retention", status: "warn", message: "match_events is referenced by 2 exports older than 90 days. Owner sign-off required.", at: "02:46Z" },
        { id: "pol_backup_verify_v2", name: "Backup verification", status: "pass", message: "Snapshot snap_01JB7N2 verified restorable in 26m", at: "02:40Z" },
        { id: "pol_prod_ddl_v3", name: "Production DDL", status: "pass", message: "Second approver required; change window 02:00–05:00Z", at: "02:46Z" },
        { id: "pol_secret_scan_v3", name: "Secret scan on diff", status: "pass", message: "0 findings across 46 added lines", at: "02:46Z" },
        { id: "pol_audit_trail_v1", name: "Decision recorded", status: "pass", message: "Audit entry will be written on decision", at: "02:46Z" }
      ],
      evidence: { total: 8, verified: 6, failed: 1, unverified: 1 },
      evidenceItems: [
        { kind: "test-run", label: "dry-run migration on prod clone · 0 errors", producer: "Forge (agt_eng_07)", age: "1h 02m", state: "verified" },
        { kind: "artifact", label: "row count parity · 412,880 source / 412,880 target", producer: "Forge", age: "1h 01m", state: "verified" },
        { kind: "policy-eval", label: "backup restore drill · 26m RTO", producer: "Policy engine", age: "1h 06m", state: "verified" },
        { kind: "log", label: "sandbox transcript · 388 lines", producer: "OpenHands", age: "1h 02m", state: "verified" },
        { kind: "artifact", label: "export manifest · 2 consumers re-pointed", producer: "Forge", age: "58m", state: "verified" },
        { kind: "human-note", label: "S. Idris: retention exception approved for analytics export", producer: "S. Idris", age: "47m", state: "verified" },
        { kind: "test-run", label: "analytics-worker integration suite · 4 failed", producer: "CI (github-actions)", age: "55m", state: "failed" },
        { kind: "log", label: "consumer audit · 1 unlisted reader found", producer: "Forge", age: "52m", state: "unverified" }
      ],
      diff: {
        files: [
          { path: "migrations/20261113_drop_match_events.sql", change: "added", add: 18, del: 0, hunks: [
            { header: "@@ -0,0 +1,18 @@", lines: [
              { t: "ctx", old: "", nw: "1", text: "-- Destructive: gated by approval apr_01JB8F7T1K" },
              { t: "add", old: "", nw: "2", text: "BEGIN;" },
              { t: "add", old: "", nw: "3", text: "LOCK TABLE match_events IN ACCESS EXCLUSIVE MODE;" },
              { t: "add", old: "", nw: "4", text: "CREATE TABLE match_events_archive AS" },
              { t: "add", old: "", nw: "5", text: "  SELECT * FROM match_events WHERE created_at < now() - interval '400 days';" },
              { t: "add", old: "", nw: "6", text: "-- 412,880 rows exported to s3://northwind-archive/2026-11-13/" },
              { t: "add", old: "", nw: "7", text: "DROP TABLE match_events;" },
              { t: "add", old: "", nw: "8", text: "COMMIT;" }
            ]}
          ]},
          { path: "services/analytics/reader.ts", change: "modified", add: 28, del: 12, hunks: [
            { header: "@@ -14,7 +14,9 @@ export async function loadEvents(range: Range) {", lines: [
              { t: "ctx", old: "14", nw: "14", text: "export async function loadEvents(range: Range) {" },
              { t: "del", old: "15", nw: "", text: "  const rows = await db.query('select * from match_events where ...');" },
              { t: "add", old: "", nw: "15", text: "  const rows = await db.query(" },
              { t: "add", old: "", nw: "16", text: "    'select * from match_events_v2 where created_at between $1 and $2'," },
              { t: "add", old: "", nw: "17", text: "    [range.from, range.to]" },
              { t: "add", old: "", nw: "18", text: "  );" },
              { t: "ctx", old: "16", nw: "19", text: "  return rows.map(toEvent);" }
            ]}
          ]}
        ],
        additions: 46, deletions: 12
      },
      audit: [
        { at: "02:46:11Z", text: "Proposal created from run_01JB7M8K2P step 8" },
        { at: "02:46:12Z", text: "5 policy checks evaluated · 1 warning" },
        { at: "02:47:30Z", text: "Backup snapshot verified by policy engine" },
        { at: "03:31:02Z", text: "Reminder sent to Release role (S. Idris)" }
      ],
      requiredApprovers: 2,
      received: [{ name: "M. Okafor", role: "Owner", at: "03:02Z" }],
      blockedReason: null
    },
    {
      id: "apr_01JB8M3XQ2",
      short: "apr_01JB8M3XQ2",
      title: "Merge token-rotation refactor into reveilchat/backend",
      actionVerb: "merge",
      summary: "Merge 7 files that rotate refresh tokens on use and revoke the token family on reuse detection.",
      risk: { level: "high", score: 68, factors: [
        { label: "auth surface", weight: 22 },
        { label: "production environment", weight: 18 },
        { label: "7 files changed", weight: 9 },
        { label: "no prior incident in this area", weight: -6 },
        { label: "rollback tested", weight: -12 }
      ]},
      state: "awaiting",
      requestedBy: { name: "Atlas", agentId: "agt_eng_04", avatar: "AT", runtime: "OpenCode" },
      requestedAt: "2026-11-13T03:56:40Z",
      age: "22m",
      runId: "run_01JB7Q2K8M4X",
      taskId: "tsk_01JB7P3N8Q",
      blast: { files: 7, additions: 128, deletions: 64, repos: ["reveilchat/backend"], services: ["auth-api", "session-worker", "gateway"], envs: ["prod"], records: 0 },
      cost: { runtime: 0, monthlyDelta: 0, note: "No infrastructure change" },
      guardrails: {
        permission: "repo:write · branch:feature/* · no:merge-protected · no:deploy",
        budget: { perRun: 40, used: 12.4, perDay: 120 },
        repos: ["reveilchat/backend"],
        environment: "sandbox:firecracker · 4 vCPU · 8 GiB · egress allowlist (pypi, npm)",
        rollback: "git revert 8f2c1a4 + slot-2 traffic shift (tested 03:52Z)"
      },
      policies: [
        { id: "pol_auth_change_v4", name: "Auth surface requires second approver", status: "warn", message: "Second approver required: S. Idris (Release role)", at: "03:56Z" },
        { id: "pol_branch_protect_v2", name: "Protected branch merge path", status: "pass", message: "Merge via PR only; direct push blocked", at: "03:56Z" },
        { id: "pol_secret_scan_v3", name: "Secret scan on diff", status: "pass", message: "0 findings across 128 added lines", at: "03:56Z" },
        { id: "pol_test_gate_v2", name: "Test gate", status: "pass", message: "214/214 passing on the merge commit", at: "03:57Z" },
        { id: "pol_audit_trail_v1", name: "Decision recorded", status: "pass", message: "Audit entry will be written on decision", at: "03:56Z" }
      ],
      evidence: { total: 12, verified: 9, failed: 2, unverified: 1 },
      evidenceItems: [
        { kind: "test-run", label: "214/214 passing · merge commit 8f2c1a4", producer: "CI (github-actions)", age: "21m", state: "verified" },
        { kind: "test-run", label: "auth suite · 92 tests · 1.8s", producer: "Atlas (agt_eng_04)", age: "22m", state: "verified" },
        { kind: "diff", label: "7 files · +128 −64", producer: "Atlas", age: "22m", state: "verified" },
        { kind: "policy-eval", label: "pol_secret_scan_v3 · 0 findings", producer: "Policy engine", age: "21m", state: "verified" },
        { kind: "log", label: "sandbox transcript · 1,204 lines", producer: "Runtime opencode", age: "22m", state: "verified" },
        { kind: "artifact", label: "coverage report · auth 91.4%", producer: "Atlas", age: "22m", state: "verified" },
        { kind: "artifact", label: "benchmark · p95 118ms (target 120ms)", producer: "Atlas", age: "20m", state: "verified" },
        { kind: "human-note", label: "M. Okafor: reviewed rotate.ts, approved direction", producer: "M. Okafor", age: "16m", state: "verified" },
        { kind: "policy-eval", label: "pol_branch_protect_v2 · pass", producer: "Policy engine", age: "21m", state: "verified" },
        { kind: "test-run", label: "e2e · 3 of 41 flaky on first attempt", producer: "CI", age: "19m", state: "failed" },
        { kind: "artifact", label: "rollback rehearsal · slot-2 shift 03:52Z", producer: "Forge (agt_eng_07)", age: "26m", state: "failed" },
        { kind: "log", label: "linter · 2 warnings (unused import)", producer: "Atlas", age: "22m", state: "unverified" }
      ],
      diff: {
        files: [
          { path: "services/auth/rotate.ts", change: "modified", add: 62, del: 18, hunks: [
            { header: "@@ -41,8 +41,14 @@ export async function rotate(refreshToken: string) {", lines: [
              { t: "ctx", old: "41", nw: "41", text: "export async function rotate(refreshToken: string) {" },
              { t: "ctx", old: "42", nw: "42", text: "  const session = await store.get(refreshToken);" },
              { t: "ctx", old: "43", nw: "43", text: "  if (!session) throw new AuthError('invalid_token');" },
              { t: "del", old: "44", nw: "", text: "  await store.delete(refreshToken);" },
              { t: "del", old: "45", nw: "", text: "  return issue(session.userId);" },
              { t: "add", old: "", nw: "44", text: "  if (session.reusedAt) {" },
              { t: "add", old: "", nw: "45", text: "    await audit.record('token_reuse', { userId: session.userId, tokenId: session.id });" },
              { t: "add", old: "", nw: "46", text: "    await store.revokeFamily(session.familyId);" },
              { t: "add", old: "", nw: "47", text: "    throw new AuthError('token_reuse_detected');" },
              { t: "add", old: "", nw: "48", text: "  }" },
              { t: "add", old: "", nw: "49", text: "  await store.markUsed(refreshToken);" },
              { t: "add", old: "", nw: "50", text: "  return issue(session.userId, { familyId: session.familyId });" },
              { t: "ctx", old: "46", nw: "51", text: "}" }
            ]}
          ]},
          { path: "services/auth/token.ts", change: "modified", add: 31, del: 22, hunks: [
            { header: "@@ -12,6 +12,9 @@ export function issue(userId: string, opts: IssueOptions = {}) {", lines: [
              { t: "ctx", old: "12", nw: "12", text: "export function issue(userId: string, opts: IssueOptions = {}) {" },
              { t: "del", old: "13", nw: "", text: "  const familyId = undefined;" },
              { t: "add", old: "", nw: "13", text: "  const familyId = opts.familyId ?? randomUUID();" },
              { t: "ctx", old: "14", nw: "15", text: "  const access = sign({ sub: userId }, ACCESS_TTL);" },
              { t: "ctx", old: "15", nw: "16", text: "  const refresh = sign({ sub: userId, familyId }, REFRESH_TTL);" }
            ]}
          ]},
          { path: "services/auth/rotate.spec.ts", change: "added", add: 18, del: 0, hunks: [
            { header: "@@ -0,0 +1,18 @@", lines: [
              { t: "add", old: "", nw: "1", text: "describe('rotate', () => {" },
              { t: "add", old: "", nw: "2", text: "  it('revokes the family when a used token is replayed', async () => {" },
              { t: "add", old: "", nw: "3", text: "    const first = await rotate(seed);" },
              { t: "add", old: "", nw: "4", text: "    await expect(rotate(seed)).rejects.toThrow('token_reuse_detected');" },
              { t: "add", old: "", nw: "5", text: "    await expect(rotate(first.refresh)).rejects.toThrow('invalid_token');" },
              { t: "add", old: "", nw: "6", text: "  });" }
            ]}
          ]}
        ],
        additions: 128, deletions: 64
      },
      audit: [
        { at: "03:56:40Z", text: "Proposal created from run_01JB7Q2K8M4X step 8" },
        { at: "03:56:41Z", text: "5 policy checks evaluated · 1 warning" },
        { at: "03:57:10Z", text: "Test gate passed on merge commit 8f2c1a4" },
        { at: "04:02:18Z", text: "M. Okafor recorded approval 1 of 2" },
        { at: "04:11:02Z", text: "Reminder sent to S. Idris (second approver)" }
      ],
      requiredApprovers: 2,
      received: [{ name: "M. Okafor", role: "Owner", at: "04:02Z" }],
      blockedReason: null
    },
    {
      id: "apr_01JB8D2M7V",
      short: "apr_01JB8D2M7V",
      title: "Publish pricing page variant B",
      actionVerb: "publish",
      summary: "Publish variant B of the pricing page to staging, changing plan order and the enterprise CTA.",
      risk: { level: "medium", score: 41, factors: [
        { label: "staging only", weight: 6 },
        { label: "3 pages changed", weight: 9 },
        { label: "no billing logic touched", weight: -8 },
        { label: "conversion claim unverified", weight: 18 }
      ]},
      state: "awaiting",
      requestedBy: { name: "Wren", agentId: "agt_des_01", avatar: "WR", runtime: "Claude Code" },
      requestedAt: "2026-11-13T01:06:40Z",
      age: "3h 12m",
      runId: "run_01JB7Q4R2C9P",
      taskId: "tsk_01JB7Q6T1M",
      blast: { files: 3, additions: 94, deletions: 71, repos: ["reveilchat/marketing"], services: ["web"], envs: ["staging"], records: 0 },
      cost: { runtime: 0, monthlyDelta: 0, note: "Static assets only" },
      guardrails: {
        permission: "content:publish · env:staging · no:prod",
        budget: { perRun: 20, used: 3.1, perDay: 60 },
        repos: ["reveilchat/marketing"],
        environment: "sandbox:firecracker · 2 vCPU · 4 GiB · egress allowlist (npm)",
        rollback: "instant slot revert (static), < 30s"
      },
      policies: [
        { id: "pol_brand_copy_v2", name: "Brand copy review", status: "warn", message: "2 claims lack a cited source; marketing owner sign-off required", at: "01:06Z" },
        { id: "pol_staging_only_v1", name: "Environment scope", status: "pass", message: "Target is staging; production publish requires a separate approval", at: "01:06Z" },
        { id: "pol_secret_scan_v3", name: "Secret scan on diff", status: "pass", message: "0 findings", at: "01:06Z" },
        { id: "pol_a11y_gate_v2", name: "Contrast gate on changed pages", status: "pass", message: "All foreground pairs ≥ 4.5:1", at: "01:08Z" },
        { id: "pol_audit_trail_v1", name: "Decision recorded", status: "pass", message: "Audit entry will be written on decision", at: "01:06Z" }
      ],
      evidence: { total: 7, verified: 7, failed: 0, unverified: 0 },
      evidenceItems: [
        { kind: "artifact", label: "variant B screenshots · 3 pages · desktop + mobile", producer: "Wren (agt_des_01)", age: "3h 10m", state: "verified" },
        { kind: "test-run", label: "visual regression · 0 diffs outside the change set", producer: "CI", age: "3h 08m", state: "verified" },
        { kind: "artifact", label: "contrast report · 46 pairs, all ≥ 4.5:1", producer: "Audra (agt_audit_01)", age: "3h 02m", state: "verified" },
        { kind: "diff", label: "3 files · +94 −71", producer: "Wren", age: "3h 11m", state: "verified" },
        { kind: "policy-eval", label: "pol_a11y_gate_v2 · pass", producer: "Policy engine", age: "3h 08m", state: "verified" },
        { kind: "log", label: "build transcript · 41s", producer: "CI", age: "3h 07m", state: "verified" },
        { kind: "human-note", label: "Wren: copy sources attached, 2 claims marked provisional", producer: "Wren", age: "3h 05m", state: "verified" }
      ],
      diff: {
        files: [
          { path: "app/pricing/page.tsx", change: "modified", add: 52, del: 40, hunks: [
            { header: "@@ -18,10 +18,12 @@ export default function Pricing() {", lines: [
              { t: "ctx", old: "18", nw: "18", text: "export default function Pricing() {" },
              { t: "del", old: "19", nw: "", text: "  const plans = [starter, growth, enterprise];" },
              { t: "add", old: "", nw: "19", text: "  const plans = [growth, starter, enterprise];" },
              { t: "ctx", old: "20", nw: "21", text: "  return (" },
              { t: "del", old: "21", nw: "", text: "    <PlanGrid plans={plans} cta=\"Start free\" />" },
              { t: "add", old: "", nw: "22", text: "    <PlanGrid plans={plans} cta=\"Start free\" enterpriseCta=\"Book a review\" />" }
            ]}
          ]},
          { path: "app/pricing/plan-card.tsx", change: "modified", add: 30, del: 24, hunks: [
            { header: "@@ -9,7 +9,9 @@ export function PlanCard({ plan, cta }: PlanCardProps) {", lines: [
              { t: "ctx", old: "9", nw: "9", text: "export function PlanCard({ plan, cta }: PlanCardProps) {" },
              { t: "add", old: "", nw: "10", text: "  const emphasis = plan.tier === 'growth' ? 'primary' : 'quiet';" },
              { t: "del", old: "10", nw: "", text: "  const emphasis = 'quiet';" },
              { t: "ctx", old: "11", nw: "12", text: "  return <article data-emphasis={emphasis}>" }
            ]}
          ]},
          { path: "content/pricing.yaml", change: "modified", add: 12, del: 7, hunks: [
            { header: "@@ -30,4 +30,5 @@ enterprise:", lines: [
              { t: "ctx", old: "30", nw: "30", text: "enterprise:" },
              { t: "del", old: "31", nw: "", text: "  cta: Contact sales" },
              { t: "add", old: "", nw: "31", text: "  cta: Book a review" },
              { t: "add", old: "", nw: "32", text: "  claim_source: provisional" }
            ]}
          ]}
        ],
        additions: 94, deletions: 71
      },
      audit: [
        { at: "01:06:40Z", text: "Proposal created from run_01JB7Q4R2C9P step 5" },
        { at: "01:06:41Z", text: "5 policy checks evaluated · 1 warning" },
        { at: "01:08:12Z", text: "Contrast gate passed on changed pages" },
        { at: "02:20:04Z", text: "Reminder sent to workspace owner" }
      ],
      requiredApprovers: 1,
      received: [],
      blockedReason: null
    },
    {
      id: "apr_01JB7R6N4X",
      short: "apr_01JB7R6N4X",
      title: "Grant release-bot write access to infra",
      actionVerb: "permission-grant",
      summary: "Grant the release-bot service identity write access to reveilchat/infra to enable automated hotfix branches.",
      risk: { level: "high", score: 76, factors: [
        { label: "privilege escalation", weight: 38 },
        { label: "infrastructure repository", weight: 20 },
        { label: "non-human identity", weight: 12 },
        { label: "scoped to one repo", weight: -6 }
      ]},
      state: "blocked",
      requestedBy: { name: "Forge", agentId: "agt_eng_07", avatar: "FG", runtime: "OpenHands" },
      requestedAt: "2026-11-13T00:41:00Z",
      age: "3h 37m",
      runId: "run_01JB7N1K7D4S",
      taskId: "tsk_01JB7M8K2P",
      blast: { files: 1, additions: 8, deletions: 0, repos: ["reveilchat/infra"], services: ["infra"], envs: ["prod"], records: 0 },
      cost: { runtime: 0, monthlyDelta: 0, note: "Policy change only" },
      guardrails: {
        permission: "iam:grant · repo:reveilchat/infra · write",
        budget: { perRun: 0, used: 0, perDay: 0 },
        repos: ["reveilchat/infra"],
        environment: "control-plane · no sandbox",
        rollback: "revoke grant via iam policy version rollback"
      },
      policies: [
        { id: "pol_least_privilege_v5", name: "Least privilege", status: "fail", message: "Service identity requests write on a protected repository without a time bound.", at: "00:41Z" },
        { id: "pol_human_identity_v2", name: "Human approval required", status: "fail", message: "Privilege grants cannot be approved by the requesting agent's owner alone.", at: "00:41Z" },
        { id: "pol_secret_scan_v3", name: "Secret scan on diff", status: "pass", message: "0 findings", at: "00:41Z" },
        { id: "pol_audit_trail_v1", name: "Decision recorded", status: "pass", message: "Audit entry will be written on decision", at: "00:41Z" }
      ],
      evidence: { total: 3, verified: 2, failed: 0, unverified: 1 },
      evidenceItems: [
        { kind: "policy-eval", label: "iam diff · 1 statement added", producer: "Policy engine", age: "3h 35m", state: "verified" },
        { kind: "log", label: "justification note · 214 chars", producer: "Forge", age: "3h 36m", state: "verified" },
        { kind: "artifact", label: "blast-radius estimate · 1 repo, 0 services", producer: "Forge", age: "3h 30m", state: "unverified" }
      ],
      diff: { files: [{ path: "iam/release-bot.tf", change: "modified", add: 8, del: 0, hunks: [
        { header: "@@ -22,3 +22,11 @@ resource \"aws_iam_policy\" \"release_bot\" {", lines: [
          { t: "ctx", old: "22", nw: "22", text: "resource \"aws_iam_policy\" \"release_bot\" {" },
          { t: "add", old: "", nw: "23", text: "  statement {" },
          { t: "add", old: "", nw: "24", text: "    actions   = [\"codecommit:GitPush\"]" },
          { t: "add", old: "", nw: "25", text: "    resources = [\"arn:aws:codecommit:eu-west-1:reveilchat/infra\"]" },
          { t: "add", old: "", nw: "26", text: "  }" }
        ]}
      ]}], additions: 8, deletions: 0 },
      audit: [
        { at: "00:41:00Z", text: "Proposal created by Forge" },
        { at: "00:41:01Z", text: "2 policy checks failed · approval blocked" },
        { at: "00:41:02Z", text: "Blocked state set; requester notified" }
      ],
      requiredApprovers: 2,
      received: [],
      blockedReason: "Blocked by pol_least_privilege_v5: the grant has no time bound. Add an expiry and resubmit."
    }
  ];

  /* ---- agents ---- */
  var agents = [
    { id: "agt_eng_04", name: "Atlas", avatar: "AT", runtime: "OpenCode", state: "active", stateLabel: "Running", assign: "Rotate refresh tokens in auth middleware", elapsed: "14m 22s", runs: 14, success: "96.2%", median: "12m 40s", route: ["claude-opus-4-5", "claude-sonnet-4-5", "gpt-5.1"] },
    { id: "agt_des_01", name: "Wren", avatar: "WR", runtime: "Claude Code", state: "active", stateLabel: "Running", assign: "Regenerate design tokens for dark theme", elapsed: "6m 08s", runs: 9, success: "100%", median: "5m 12s", route: ["gpt-5.1", "claude-sonnet-4-5", "gemini-2.5-pro"] },
    { id: "agt_eng_02", name: "Kestrel", avatar: "KE", runtime: "Codex", state: "awaiting", stateLabel: "Awaiting approval", assign: "Merge PR #412 rate-limit middleware", elapsed: "22m", runs: 11, success: "90.9%", median: "9m 48s", route: ["o3", "gpt-5.1-codex", "claude-sonnet-4-5"] },
    { id: "agt_eng_07", name: "Forge", avatar: "FG", runtime: "OpenHands", state: "failed", stateLabel: "Failed", assign: "Partition sessions table by month", elapsed: "41m 06s", runs: 6, success: "66.7%", median: "21m 04s", route: ["claude-sonnet-4-5", "claude-sonnet-4-5", "gpt-5.1"], intervention: true },
    { id: "agt_res_02", name: "Sift", avatar: "SF", runtime: "Pi", state: "degraded", stateLabel: "Degraded", assign: "Index research corpus (1.2M docs)", elapsed: "2h 08m", runs: 3, success: "100%", median: "48m 20s", route: ["gemini-2.5-pro", "qwen3-coder-30b", "claude-sonnet-4-5"] },
    { id: "agt_audit_01", name: "Audra", avatar: "AU", runtime: "OpenCode", state: "queued", stateLabel: "Queued", assign: "Audit WCAG contrast on onboarding flow", elapsed: "0m", runs: 5, success: "100%", median: "7m 30s", route: ["gpt-5.1", "claude-sonnet-4-5", "o3"] },
    { id: "agt_rep_01", name: "Ledger", avatar: "LG", runtime: "Codex", state: "offline", stateLabel: "Idle", assign: "— (last: Q4 delivery report)", elapsed: "18m idle", runs: 4, success: "100%", median: "8m 12s", route: ["gpt-5.1", "gpt-5.1-codex", "claude-sonnet-4-5"] },
    { id: "agt_idx_03", name: "Vector", avatar: "VC", runtime: "custom", state: "offline", stateLabel: "Offline", assign: "Index shard 3 compaction", elapsed: "12m", runs: 2, success: "50%", median: "31m 40s", route: ["claude-sonnet-4-5", "—", "—"] },
    { id: "agt_doc_02", name: "Quill", avatar: "QL", runtime: "Claude Code", state: "active", stateLabel: "Running", assign: "Update API reference for /v2/matches", elapsed: "3m 41s", runs: 7, success: "100%", median: "6m 04s", route: ["gpt-5.1", "claude-sonnet-4-5", "gemini-2.5-pro"] },
    { id: "agt_sec_01", name: "Probe", avatar: "PB", runtime: "OpenCode", state: "active", stateLabel: "Running", assign: "Dependency CVE sweep, 214 manifests", elapsed: "9m 12s", runs: 8, success: "100%", median: "10m 18s", route: ["gpt-5.1", "claude-sonnet-4-5", "o3"] },
    { id: "agt_eng_09", name: "Mason", avatar: "MS", runtime: "OpenHands", state: "offline", stateLabel: "Paused", assign: "Migrate webhook retries to queue", elapsed: "0m", runs: 3, success: "100%", median: "14m 02s", route: ["claude-sonnet-4-5", "claude-sonnet-4-5", "gpt-5.1"] },
    { id: "agt_support_01", name: "Echo", avatar: "EC", runtime: "Pi", state: "awaiting", stateLabel: "Awaiting approval", assign: "Reply to enterprise security questionnaire", elapsed: "1h 12m", runs: 5, success: "80%", median: "22m 40s", route: ["gemini-2.5-pro", "qwen3-coder-30b", "claude-sonnet-4-5"] }
  ];

  var agentDetail = {
    id: "agt_eng_04",
    name: "Atlas",
    runtime: { adapter: "OpenCode", version: "0.9.4", isolation: "firecracker-microvm", vcpu: 4, memory: "8 GiB" },
    state: "active",
    stateLabel: "Running",
    current: { runId: "run_01JB7Q2K8M4X", title: "Rotate refresh tokens in auth middleware", step: "Step 4 of 9 · running tests", elapsed: "14m 22s" },
    metrics: [
      { label: "Success 24h", value: "96.2%", sub: "13 of 14 runs" },
      { label: "Median run", value: "12m 40s", sub: "p95 28m 10s" },
      { label: "Cost today", value: "$41.28", sub: "of $120 ceiling" },
      { label: "Tokens", value: "2.41M in", sub: "318k out" }
    ],
    route: [
      { role: "Reasoner", model: "claude-opus-4-5" },
      { role: "Engineer", model: "claude-sonnet-4-5" },
      { role: "Verifier", model: "gpt-5.1" }
    ],
    guardrails: {
      permission: "repo:write · branch:feature/* · no:merge-protected · no:deploy",
      budget: { perRun: 40, used: 41.28, perDay: 120 },
      repos: ["reveilchat/backend", "reveilchat/infra"],
      environment: "sandbox:firecracker · 4 vCPU · 8 GiB · egress allowlist (pypi, npm)",
      rollback: "git revert + slot-2 traffic shift"
    },
    steps: [
      { n: 1, title: "Plan", dur: "00:41", state: "completed" },
      { n: 2, title: "Read 34 files", dur: "01:12", state: "completed" },
      { n: 3, title: "Patch 7 files", dur: "03:28", state: "completed" },
      { n: 4, title: "Run tests", dur: "09:02", state: "active", meta: "128 / 214 passed" },
      { n: 5, title: "Verify", dur: "—", state: "queued" },
      { n: 6, title: "Lint", dur: "—", state: "queued" },
      { n: 7, title: "Security scan", dur: "—", state: "queued" },
      { n: 8, title: "Commit branch", dur: "—", state: "queued" },
      { n: 9, title: "Open PR", dur: "—", state: "queued", meta: "requires approval" }
    ],
    log: [
      { t: "04:18:58", lv: "INFO", m: "test auth/rotate.spec.ts › rotates on reuse (2.1s)" },
      { t: "04:18:56", lv: "WARN", m: "test auth/session.spec.ts › legacy cookie path skipped" },
      { t: "04:18:52", lv: "INFO", m: "128 passed, 0 failed, 86 pending" },
      { t: "04:18:44", lv: "INFO", m: "read_file services/auth/token.ts (8ms)" },
      { t: "04:18:41", lv: "INFO", m: "apply_patch services/auth/rotate.ts +62 −18 (41ms)" },
      { t: "04:18:02", lv: "WARN", m: "npm warning: deprecated punycode@2.1.0 (transitive)" },
      { t: "04:17:02", lv: "INFO", m: "run_tests --suite auth --shard 2" }
    ],
    handoffs: [
      { from: "Atlas", to: "Audra", task: "WCAG audit of changed onboarding screens", reason: "Specialism routing", state: "completed", at: "03:12Z", note: null },
      { from: "Wren", to: "Atlas", task: "Apply token changes to component CSS", reason: "Build required", state: "completed", at: "02:48Z", note: null },
      { from: "Kestrel", to: "Forge", task: "Partition sessions table", reason: "Needs infra scope", state: "failed", at: "03:41Z", note: "Forge exceeded its retry budget at step 4" },
      { from: "Forge", to: "Atlas", task: "Retry partition migration", reason: "Capability escalation", state: "failed", at: "03:44Z", note: "permission ceiling: Atlas cannot write to reveilchat/infra" },
      { from: "Sift", to: "Quill", task: "Draft findings summary", reason: "Output format", state: "awaiting", at: "01:20Z", note: null }
    ],
    runs: [
      { id: "run_01JB7Q2K8M4X", title: "Rotate refresh tokens", state: "active", cost: 2.14, dur: "14m 22s" },
      { id: "run_01JB7J8V2R6D", title: "Contract tests for /v2/matches", state: "completed", cost: 1.12, dur: "11m 19s" },
      { id: "run_01JB6Z2M4K", title: "Cache invalidation on profile update", state: "completed", cost: 1.88, dur: "9m 04s" },
      { id: "run_01JB6X8Q1T", title: "Migrate webhook retries", state: "failed", cost: 3.42, dur: "22m 40s" }
    ]
  };

  /* ---- activity stream ---- */
  var activity = [
    { t: "04:18:58", agent: "Atlas", text: "test passed <b>auth/rotate.spec.ts</b>", kind: "ok" },
    { t: "04:18:52", agent: "Atlas", text: "<b>128 passed</b>, 0 failed, 86 pending", kind: "ok" },
    { t: "04:18:44", agent: "Probe", text: "read <b>package-lock.json</b> · 214 manifests queued", kind: "read" },
    { t: "04:18:41", agent: "Atlas", text: "patched <b>services/auth/rotate.ts</b> +62 −18", kind: "write" },
    { t: "04:18:22", agent: "Wren", text: "generated <b>41 tokens</b>, 6 contrast pairs flagged", kind: "warn" },
    { t: "04:18:07", agent: "Audra", text: "queued · waiting for worker slot", kind: "queue" },
    { t: "04:17:58", agent: "Sift", text: "embedding shard <b>7 of 12</b> · latency 4.2s p95", kind: "warn" },
    { t: "04:17:40", agent: "Kestrel", text: "waiting on <b>apr_01JB8M3XQ2</b> second approver", kind: "queue" },
    { t: "04:17:02", agent: "Atlas", text: "run_tests --suite auth --shard 2", kind: "read" },
    { t: "04:16:44", agent: "Quill", text: "updated <b>api/reference/matches.md</b>", kind: "write" },
    { t: "04:16:12", agent: "Forge", text: "run failed at step 4 · <b>12 tests failing</b>", kind: "fail" },
    { t: "04:15:58", agent: "Vector", text: "heartbeat missed · last seen 04:04Z", kind: "fail" },
    { t: "04:15:19", agent: "Probe", text: "CVE sweep · 3 advisories, 0 critical", kind: "ok" },
    { t: "04:14:51", agent: "Echo", text: "drafting questionnaire response · 41% complete", kind: "read" }
  ];

  /* ---- research ---- */
  var campaigns = [
    { id: "cmp_01JB6R2T8K", title: "Runtime adapter comparison for enterprise isolation", state: "active", stateLabel: "Active", findings: 6, conf: 0.74, coverage: 78, gaps: 3, window: "41d", budget: "$18.00 / $25.00" },
    { id: "cmp_01JB5N8Q2V", title: "Buyer expectations for on-prem AI tooling, EU mid-market", state: "active", stateLabel: "Active", findings: 11, conf: 0.81, coverage: 86, gaps: 1, window: "22d", budget: "$9.40 / $20.00" },
    { id: "cmp_01JAZ4M7T1", title: "Competitive pricing: 6 agent platforms", state: "completed", stateLabel: "Completed", findings: 9, conf: 0.88, coverage: 91, gaps: 0, window: "30d", budget: "$14.20 / $20.00" },
    { id: "cmp_01JAV2K9R6", title: "Auth token rotation: current best practice", state: "completed", stateLabel: "Completed", findings: 7, conf: 0.93, coverage: 94, gaps: 0, window: "14d", budget: "$4.10 / $10.00" },
    { id: "cmp_01JAT8P3D2", title: "Mobile onboarding drop-off causes", state: "completed", stateLabel: "Completed", findings: 5, conf: 0.66, coverage: 61, gaps: 4, window: "28d", budget: "$11.80 / $15.00" },
    { id: "cmp_01JAR6T4N8", title: "WCAG 2.2 failures in fintech dashboards", state: "active", stateLabel: "Active", findings: 4, conf: 0.71, coverage: 69, gaps: 3, window: "9d", budget: "$3.20 / $12.00" },
    { id: "cmp_01JAP2V7K4", title: "Temporal vs custom durable execution", state: "completed", stateLabel: "Completed", findings: 8, conf: 0.84, coverage: 88, gaps: 1, window: "35d", budget: "$7.60 / $15.00" },
    { id: "cmp_01JAM9X2Q6", title: "Vector DB cost at 50M embeddings", state: "degraded", stateLabel: "Degraded", findings: 3, conf: 0.52, coverage: 44, gaps: 6, window: "60d", budget: "$16.90 / $18.00" },
    { id: "cmp_01JAK4M8R1", title: "Open-source agent runtimes: licence risk", state: "completed", stateLabel: "Completed", findings: 6, conf: 0.79, coverage: 82, gaps: 2, window: "26d", budget: "$5.50 / $10.00" }
  ];

  var campaign = {
    id: "cmp_01JB6R2T8K",
    title: "Runtime adapter comparison for enterprise isolation",
    question: "Which agent runtime gives the strongest sandbox isolation per dollar for private deployment?",
    state: "active",
    owner: { name: "Sift", id: "agt_res_02", avatar: "SF", runtime: "Pi" },
    started: "2026-10-02",
    window: { from: "2026-10-02", to: "2026-11-12", days: 41 },
    budget: { used: 18, ceiling: 25 },
    coverage: { score: 78, gaps: 3, sources: 42, primary: 11, stale: 6, unreachable: 2, prevScore: 84 },
    corpus: { docs: "1.2M", indexed: "2026-11-13T02:10:00Z" },
    health: [
      { label: "Coverage", value: "78%", sub: "was 84% on 09 Nov" },
      { label: "Sources", value: "42", sub: "11 primary" },
      { label: "Freshness", value: "0.81", sub: "6 older than 30d" },
      { label: "Independence", value: "19 domains", sub: "top domain 12%" }
    ],
    gaps: [
      { title: "No primary source for Pi isolation", detail: "Vendor FAQ is 375 days old and marketing-grade.", mit: "Excluded from the ranking; labelled unverified in the comparison." },
      { title: "No published enterprise pricing for 2 of 5 vendors", detail: "Quote-only pricing.", mit: "Cost comparison uses list price for 3 and marks the others not comparable." },
      { title: "Retrieval window closed 2026-11-12", detail: "Anything published after that date is not represented.", mit: "A new CVE or entrant would not appear until the next run." }
    ],
    comparison: {
      criteria: ["Isolation strength", "Cold start", "Cost per 8 GiB run", "Egress default", "Independent audit", "Sources"],
      vendors: ["Firecracker", "gVisor", "OpenHands", "Codex", "Pi"],
      rows: [
        { c: "Isolation strength", v: ["Strong", "Strong", "Moderate", "Moderate", "Unknown"], thin: [false, false, false, false, true] },
        { c: "Cold start", v: ["1.8s", "0.9s", "3.1s", "4.3s", "2.2s"], thin: [false, false, false, false, true] },
        { c: "Cost per 8 GiB run", v: ["$0.0031", "$0.0044", "$0.0028", "$0.0051", "not comparable"], thin: [false, false, false, true, true] },
        { c: "Egress default", v: ["deny", "allow", "allow", "allow", "deny"], thin: [false, false, false, false, false] },
        { c: "Independent audit", v: ["Yes (2)", "Yes (3)", "No", "No", "No — gap"], thin: [false, false, false, false, true] },
        { c: "Sources", v: ["12", "9", "7", "6", "4"], thin: [false, false, false, false, true] }
      ]
    }
  };

  var findings = [
    { id: "fnd_01JB6S4M2Q", claim: "Firecracker microVMs give the strongest isolation per dollar for single-tenant deployment", conf: 0.87, band: "high", sources: 12, state: "supported", verified: "2026-11-11" },
    { id: "fnd_01JB6T1R8N", claim: "OpenHands requires outbound egress for dependency resolution in 3 of 5 configurations", conf: 0.72, band: "moderate", sources: 7, state: "supported", verified: "2026-11-10" },
    { id: "fnd_01JB6V3K2D", claim: "Pi runtime has no published independent security audit as of 2026-10", conf: 0.61, band: "moderate", sources: 4, state: "gap", verified: "2026-11-09" },
    { id: "fnd_01JB6W7Q5M", claim: "Codex runtime cold-start is 2.4× slower than OpenCode at 4 vCPU", conf: 0.44, band: "low", sources: 3, state: "contested", verified: "2026-11-06" },
    { id: "fnd_01JB6X9T1P", claim: "Per-run isolation cost is $0.0031 at 8 GiB, 4 vCPU", conf: 0.38, band: "insufficient", sources: 2, state: "insufficient", verified: "2026-11-04" },
    { id: "fnd_01JB6Y2M7C", claim: "Egress allowlisting is supported by all five runtimes, with different default postures", conf: 0.79, band: "moderate", sources: 9, state: "supported", verified: "2026-11-12" }
  ];

  var findingDetail = {
    id: "fnd_01JB6S4M2Q",
    claim: "Firecracker microVMs give the strongest isolation per dollar for single-tenant deployment",
    conf: 0.87, band: "high", sources: 12, state: "supported", oldest: "2026-09-18",
    reasoning: "Three independent benchmarks and two vendor architecture documents agree on isolation properties; cost per run is 31% below the nearest alternative at equal vCPU and memory.",
    assumptions: [
      "Single-tenant deployment is the requirement; multi-tenant changes the isolation calculus",
      "8 GiB / 4 vCPU is representative of the workload",
      "Vendor-published benchmarks are directionally reliable; two were cross-checked against independent runs"
    ],
    disconfirming: [
      { claim: "Firecracker cold-start adds 1.8s per run, which dominates at runs shorter than 30s", source: "gVisor vs Firecracker isolation benchmark, 2026", strength: "moderate" },
      { claim: "gVisor narrows the isolation gap at 40% lower operational complexity", source: "Agent runtime security posture survey", strength: "weak" }
    ],
    whatWouldChangeIt: "A published independent penetration test showing a Firecracker escape, or a workload profile where runs are shorter than 45s.",
    supporting: [
      { label: "Firecracker design document · isolation model", producer: "firecracker-microvm.github.io", age: "retrieved 2026-10-04", state: "verified" },
      { label: "gVisor vs Firecracker isolation benchmark, 2026", producer: "arxiv.org", age: "retrieved 2026-10-06", state: "verified" },
      { label: "Agent runtime security posture survey", producer: "nccgroup.com", age: "retrieved 2026-10-11", state: "verified" },
      { label: "AWS Lambda isolation architecture", producer: "docs.aws.amazon.com", age: "retrieved 2026-10-04", state: "verified" }
    ]
  };

  var sources = [
    { group: "bad", title: "OpenHands deployment requirements", domain: "docs.all-hands.dev", published: "2026-09-02", retrieved: "2026-10-12", type: "vendor", status: "Unreachable", statusKind: "failed", note: "403 since 2026-11-09" },
    { group: "bad", title: "Enterprise agent platform pricing, 2026", domain: "gartner.com", published: "2026-07-01", retrieved: "2026-10-08", type: "secondary", status: "Paywalled", statusKind: "warn", note: "Abstract only" },
    { group: "warn", title: "Pi runtime security FAQ", domain: "pi.dev", published: "2025-11-03", retrieved: "2026-10-02", type: "vendor", status: "Stale · 375d", statusKind: "warn", note: "Marketing-grade" },
    { group: "warn", title: "Codex runtime benchmarks", domain: "github.com/openai/codex", published: "2026-05-14", retrieved: "2026-10-19", type: "primary", status: "Stale · 208d", statusKind: "warn", note: "Pre-2.0 numbers" },
    { group: "ok", title: "Firecracker: secure and fast microVMs (design doc)", domain: "firecracker-microvm.github.io", published: "2024-06-11", retrieved: "2026-10-04", type: "primary", status: "Retrieved", statusKind: "ok" },
    { group: "ok", title: "gVisor vs Firecracker isolation benchmark, 2026", domain: "arxiv.org", published: "2026-03-18", retrieved: "2026-10-06", type: "primary", status: "Retrieved", statusKind: "ok" },
    { group: "ok", title: "AWS Lambda isolation architecture", domain: "docs.aws.amazon.com", published: "2026-01-22", retrieved: "2026-10-04", type: "vendor", status: "Retrieved", statusKind: "ok" },
    { group: "ok", title: "Agent runtime security posture survey", domain: "nccgroup.com", published: "2026-08-30", retrieved: "2026-10-11", type: "primary", status: "Retrieved", statusKind: "ok" },
    { group: "ok", title: "Sandbox escape CVE roundup 2026", domain: "nvd.nist.gov", published: "2026-10-28", retrieved: "2026-11-02", type: "primary", status: "Retrieved", statusKind: "ok" },
    { group: "ok", title: "Community thread: Firecracker cold-start", domain: "news.ycombinator.com", published: "2026-09-19", retrieved: "2026-10-04", type: "forum", status: "Retrieved", statusKind: "ok" }
  ];

  /* ---- overview extras ---- */
  var decisions = [
    { at: "03:52Z", actor: "M. Okafor", actorKind: "human", verb: "Approved", object: "apr_01JB7Z2K4M", note: "deploy rate-limit middleware to staging" },
    { at: "03:48Z", actor: "Atlas", actorKind: "agent", verb: "Auto-approved", object: "apr_01JB7Y8Q1C", note: "dependency patch, risk Low" },
    { at: "03:31Z", actor: "pol_retention_v3", actorKind: "policy", verb: "Blocked", object: "apr_01JB7X4T7N", note: "drop audit_log partition" },
    { at: "02:55Z", actor: "S. Idris", actorKind: "human", verb: "Rejected", object: "apr_01JB7W1M9P", note: "raise Autopilot risk ceiling to High" },
    { at: "02:40Z", actor: "Wren", actorKind: "agent", verb: "Auto-approved", object: "apr_01JB7V6R3D", note: "regenerate icon set" },
    { at: "02:12Z", actor: "pol_egress_v2", actorKind: "policy", verb: "Warned", object: "run_01JB7Q0M8B1L", note: "corpus index egress 4.1 GB" }
  ];

  var alerts = [
    { sev: "P2", kind: "degraded", title: "model-router degraded", detail: "2 of 5 providers responding", age: "6m" },
    { sev: "P1", kind: "awaiting", title: "schedule-missed", detail: "nightly-eval passed its window", age: "41m" },
    { sev: "P2", kind: "degraded", title: "budget 80%", detail: "project control-plane at $480 / $600", age: "1h 12m" }
  ];

  var schedules = [
    { name: "nightly-eval", cron: "0 2 * * *", next: "02:00Z +1d", state: "queued", width: 18, offset: 62 },
    { name: "token-audit", cron: "0 6 * * 1", next: "16 Nov 06:00Z", state: "queued", width: 12, offset: 8 },
    { name: "client-report-northwind", cron: "0 14 * * 5", next: "14:00Z", state: "active", width: 22, offset: 34 },
    { name: "dependency-sweep", cron: "0 */6 * * *", next: "10:00Z", state: "queued", width: 10, offset: 74 },
    { name: "retention-enforce", cron: "0 0 * * 0", next: "missed 41m ago", state: "failed", width: 14, offset: 0 }
  ];

  var notifications = [
    { id: "ntf_01", sev: "P0", cls: "Policy violation", title: "pol_least_privilege_v5 failed", detail: "release-bot requested write access to reveilchat/infra", age: "3h 37m", unread: true, href: "#/approvals/apr_01JB7R6N4X" },
    { id: "ntf_02", sev: "P1", cls: "Approval requested", title: "apr_01JB8M3XQ2 needs a second approver", detail: "Auth surface change · 1 of 2 approvals recorded", age: "22m", unread: true, href: "#/approvals/apr_01JB8M3XQ2" },
    { id: "ntf_03", sev: "P1", cls: "Run failed", title: "run_01JB7N1K7D4S failed at step 4", detail: "12 of 214 tests failing in services/auth", age: "41m", unread: true, href: "#/overview" },
    { id: "ntf_04", sev: "P1", cls: "Approval requested", title: "apr_01JB8F7T1K requires typed confirmation", detail: "Critical risk · dropping 412,880 rows", age: "1h 04m", unread: true, href: "#/approvals/apr_01JB8F7T1K" },
    { id: "ntf_05", sev: "P2", cls: "Dependency degraded", title: "model-router: 2 of 5 providers responding", detail: "New runs queue rather than fail; approvals unaffected", age: "6m", unread: false, href: "#/overview" },
    { id: "ntf_06", sev: "P2", cls: "Budget threshold", title: "control-plane at 80% of daily ceiling", detail: "$480.00 of $600.00", age: "1h 12m", unread: false, href: "#/overview" },
    { id: "ntf_07", sev: "P3", cls: "Run completed", title: "rpt_01JB7K9Q2 published", detail: "Q4 delivery report for Northwind", age: "2h 16m", unread: false, href: "#/reports" },
    { id: "ntf_08", sev: "P3", cls: "Decision recorded", title: "M. Okafor approved apr_01JB7Z2K4M", detail: "Deploy rate-limit middleware to staging", age: "26m", unread: false, href: "#/approvals" }
  ];

  var searchIndex = [];
  runs.forEach(function (r) {
    searchIndex.push({ type: "Run", id: r.id, title: r.title, sub: r.repo + " · " + r.stateLabel, href: "#/overview", icon: "i-play" });
  });
  approvals.forEach(function (a) {
    searchIndex.push({ type: "Approval", id: a.id, title: a.title, sub: a.state + " · risk " + a.risk.level, href: "#/approvals/" + a.id, icon: "i-check-badge" });
  });
  campaigns.forEach(function (c) {
    searchIndex.push({ type: "Research", id: c.id, title: c.title, sub: c.stateLabel + " · coverage " + c.coverage + "%", href: "#/research/" + c.id, icon: "i-flask" });
  });
  agents.forEach(function (a) {
    searchIndex.push({ type: "Agent", id: a.id, title: a.name, sub: a.runtime + " · " + a.stateLabel, href: "#/agents/" + a.id, icon: "i-hex" });
  });
  searchIndex.push({ type: "Report", id: "rpt_01JB7K9Q2", title: "Q4 delivery report for Northwind", sub: "published 02:16Z · 14 pages", href: "#/reports", icon: "i-doc" });
  searchIndex.push({ type: "Report", id: "rpt_01JB4M8T2", title: "Runtime isolation evaluation, November", sub: "draft · partial evidence", href: "#/reports", icon: "i-doc" });

  var commands = [
    { group: "Go to", label: "Overview", href: "#/overview", icon: "i-grid", hint: "g o" },
    { group: "Go to", label: "Approvals", href: "#/approvals", icon: "i-check-badge", hint: "g a" },
    { group: "Go to", label: "Agent Command Centre", href: "#/agents", icon: "i-hex" },
    { group: "Go to", label: "Research Lab", href: "#/research", icon: "i-flask", hint: "g r" },
    { group: "Go to", label: "Projects", href: "#/projects", icon: "i-folder", hint: "g p" },
    { group: "Go to", label: "State inspector", href: "#/states", icon: "i-layers" },
    { group: "Actions", label: "Toggle density: compact", act: "density-compact", icon: "i-layers" },
    { group: "Actions", label: "Toggle density: default", act: "density-default", icon: "i-layers" },
    { group: "Actions", label: "Switch theme", act: "theme-toggle", icon: "i-moon" },
    { group: "Actions", label: "Open state inspector", act: "state-open", icon: "i-layers" },
    { group: "Actions", label: "Keyboard shortcuts", act: "shortcuts", icon: "i-help" },
    { group: "Help", label: "Simulated data notice", act: "notice", icon: "i-info" }
  ];

  /* Stable evidence identifiers. Every evidence item is addressable as evd_… */
  approvals.forEach(function (a) {
    (a.evidenceItems || []).forEach(function (e, i) {
      e.id = "evd_" + a.id.slice(4, 10) + "_" + String(i + 1).padStart(2, "0");
      e.approvalId = a.id;
    });
  });

  return {
    org: org, user: user, workspace: workspace, workspaces: workspaces,
    project: project, environment: environment, branch: branch,
    modes: modes, posture: posture, constraints: constraints,
    navGroups: navGroups, runs: runs, approvals: approvals, agents: agents,
    agentDetail: agentDetail, activity: activity,
    campaigns: campaigns, campaign: campaign, findings: findings,
    findingDetail: findingDetail, sources: sources,
    decisions: decisions, alerts: alerts, schedules: schedules,
    notifications: notifications, searchIndex: searchIndex, commands: commands
  };
})();
