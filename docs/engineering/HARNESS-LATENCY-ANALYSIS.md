# HARNESS LATENCY ANALYSIS — Subagent Performance

**Task ID:** HO-001
**Agent:** @harness-optimizer
**Mode:** diagnosis + proposal. No config was modified.
**Date:** 2026-11-14
**Harness:** OpenCode v2.3.0, config `~/.config/opencode/opencode.jsonc`
**Evidence base:** `~/.local/share/opencode/opencode.db` (709 sessions, 72,769 messages), `~/.local/share/opencode/log/opencode.log` (49 MB), config files on disk.

---

## 1. Verdict

**The single largest cause is a fixed ~8.4 second pre-token wait on the default model endpoint, paid once per model turn, multiplied by ~96 sequential turns per subagent session.** The default model (`deepseek/deepseek-v4.1-flash`, variant `max`) has a median time-to-first-token of **8,467 ms** (n=332), while the same model family on the `-fast` endpoint (`deepseek/deepseek-v4.1-flash-fast`, variant `max`) has a median TTFT of **1,904 ms** (n=30) — a **4.4× gap at identical reasoning effort**. Because pre-token wait is **63% of a 13.3 s turn** and turns are serial, a median subagent session spends **~800 s of its ~1,414 s of model time waiting for a first token** and doing nothing. This is not caused by prompt size: across a 171% increase in cached context (85 k → 230 k tokens) TTFT moved only **+7%** (8,137 ms → 8,724 ms). It is not caused by retries either: the TTFT distribution is tight and unimodal (p10 7,808 / p50 8,467 / p90 10,406 ms), the shape of a fixed pipeline cost, not exponential backoff. Prompt trimming — the intuitive fix — is a **cost** lever here, not a latency lever; the latency lever is **endpoint routing plus turn-count reduction**.

---

## 2. Cost model

### 2.1 Locked prompt prefix — measured from disk

| Layer | Bytes | ≈ Tokens | Source |
|---|---:|---:|---|
| `<available_skills>` catalog — 263 skills (228 global + 35 Reveil) | 90,570 | **22,642** | rendered from all `SKILL.md` frontmatter in the exact `<skill><id><name><description>` shape |
| └ of which pure XML/`id`/`name` tag overhead | 31,423 | 7,855 | same |
| Instructions — `00-harness-contract.md` (7,945) + `INSTRUCTIONS.md` (28,671) + `openflow-usage.md` (6,701) | 43,317 | 10,829 | `wc -c` |
| `~/.commandcode/AGENTS.md` (loaded via symlink `~/.config/opencode/AGENTS.md`) | 1,341 | 335 | `wc -c` |
| Agent prompt — `node-backend-developer.md` / `react-frontend-developer.md` / `it-leader.md` / `nuxt-frontend-developer.md` | 10,023 / 14,299 / 15,546 / 18,973 | 2,506 / 3,575 / 3,887 / 4,743 | `wc -c` |
| **Locked prefix before any project file** | **~145–155 k** | **~36,300–38,500** | sum |
| — measured against reality: median **first-turn input** | 47,838 tokens (cache read = 0) | prefix = **75%** of it | `session_message`, first assistant message, n=40 |
| Tool schemas | not measured | *(inferred: ~5–25 k)* | Code Mode surfaces 1 tool per namespace; full schemas are not injected. Not verifiable from on-disk state. |

### 2.2 Per-turn cost — measured from `session_message`

Sample: assistant messages with `time.created`, `time.firstToken`, `time.completed` and a `tokens` object (n=355 on `commandcode`).

| Component | Tokens | Seconds | How measured |
|---|---:|---:|---|
| Locked prefix prefill | 36–38 k | **≤0.1 s** | derived from the context-sensitivity slope below — already *inside* TTFT |
| Delegation contract (first turn only) | 2,000–3,300 | ~0.5–0.8 s, once | 1,500–2,500 words at 1.33 tok/word |
| Tool output pulled into context | variable | inside the 4.85 s below | not separable — `session_part` is empty (0 rows) |
| **Model pre-token wait** (`created → firstToken`) | — | **8.38 s** | direct timestamp delta |
| **Generation + tool execution** (`firstToken → completed`) | 184 out + 243 reasoning | **4.85 s** | direct timestamp delta |
| **Total per turn** | | **≈ 13.2 s** | |

### 2.3 Per-session

| Metric | Value | n |
|---|---:|---|
| Median assistant turns per subagent session (recent) | **96** | 60 recent subagent sessions |
| Median assistant turns per subagent session (all-time) | 65 (mean 75, p90 140) | 645 subagent sessions |
| Median summed turn time per session | **1,414 s** (mean 1,904, p90 4,374) | 60 sessions |
| Median session span | 1,456 s | 60 sessions |
| Median seconds per turn | **13.3** | 60 sessions |
| └ of which pure pre-token wait | **~800 s (57%)** | 96 × 8.38 |
| Median input tokens per session | **196,839** (mean 379,075, max 11,432,736) | 200 recent sessions |
| Median cached tokens re-read per turn | ~168,000 | 355 turns |
| Fleet-wide median turn duration (all providers, all ages) | 6.6 s (mean 19.3, p90 29.6) | 68,427 turns |

The fleet-wide 6.6 s median is itself evidence for F1: turns routed to faster endpoints already exist in this database and run at **half** the cost per turn of the default endpoint.

The locked prefix is **75% of the median first turn** (36–38 k of 47,838 tokens) and is amortised to near-zero *cost* by prompt caching from roughly turn 5 onward. Hypothesis 1 in the brief — "20–40 k tokens before it reads a single project file" — is **confirmed in magnitude**. What the measurement does *not* support is that those tokens are expensive in **time**: see F4.

---

## 3. Ranked findings

### F1 — Default endpoint has a fixed ~8.4 s pre-token latency. **Largest impact.**

| Endpoint (both variant `max`) | n | p10 | p50 | p90 | pre-token tok/s |
|---|---:|---:|---:|---:|---:|
| `deepseek/deepseek-v4.1-flash` | 332 | 7,808 ms | **8,467 ms** | 10,406 ms | 28 |
| `deepseek/deepseek-v4.1-flash-fast` | 30 | 1,699 ms | **1,904 ms** | 3,290 ms | 179 |

The fast endpoint is not doing less work — it produced **more** output (median 458 vs 184 tokens) and **more** reasoning (344 vs 243) in **less** time.

**Expected saving:** 96 turns × (8,467 − 1,904) ms = **−630 s per subagent session (−45% of 1,414 s model time)**. Zero quality change: same model family, same reasoning variant.

### F2 — Turn count is the multiplier. 65–96 serial round-trips per subagent session.

`frontend-react` 76 median turns, `node-developer` 91, `code-reviewer` 72 — and **2,012 turns across 21 `code-reviewer` sessions (96/session)**. Each round-trip costs a full 13.3 s regardless of how small the step is. Every tool call issued sequentially is a separate tax.

**Expected saving:** batching ordinary read/grep calls 2:1 (the `execute`/parallel-call path already exists) removes ~48 turns/session → **−638 s**. Combined with F1 the two changes attack different terms: −630 s (endpoint) and −638 s (batching) against a 1,414 s baseline, i.e. a ~24-minute session can plausibly finish in 3–5 minutes.

### F3 — No model routing. 508 sessions on one model, 2 on the fast one.

`sessions by model`: `deepseek-v4.1-flash|max` via `opencode-go` **508**, via `commandcode` **85**, `-flash-fast` **2**, `crouton-alpha-free` 27, everything else ≤4. Only **one** agent config in the entire file sets `model` (`custom agent` → `opencode-go/glm-5.3`); there is **no top-level `model` key**. Every subagent inherits whatever the primary session last used.

**Expected saving:** this is the *mechanism* for F1. Also removes the failure modes in F6 by pinning a funded provider.

### F4 — Skill catalog is 22.6 k tokens per turn — but costs ~0.05 s, not seconds.

Measured context sensitivity (same model, cached tokens vs TTFT):

| Quartile | median cached tokens | median TTFT |
|---|---:|---:|
| Q1 | 84,992 | 8,137 ms |
| Q2 | 132,736 | 8,285 ms |
| Q3 | 188,544 | 8,429 ms |
| Q4 | 230,272 | 8,724 ms |

+171% context → **+587 ms (+7%)**. Extrapolating linearly, 22,642 tokens ≈ **+49 ms/turn** — 0.4% of a turn.

**Correction to the brief:** the 8.5 MB skills directory is **not** the cost. Only frontmatter is injected: **90,570 B total**, and 35% of *that* is XML tag overhead. `unslop` (3.5 MB), `impeccable` (2.4 MB) and `apple-design` (1.5 MB) contribute 660 B, 907 B and 866 B respectively to the prompt.

**Real saving if 66 mismatched skills are removed:** 21,929 B → 5,482 tokens/turn → **~526 k tokens per 96-turn session**. This is a **cost/token-budget win (~24% of catalog), not a latency win.**

### F5 — Instructions are 11.2 k tokens, of which 1,675 are dead weight.

`openflow-usage.md` (6,701 B ≈ 1,675 tok) is loaded globally and describes 56 tools whose use is **explicitly prohibited** until the API key is installed ("Generation is prohibited until the gates below are cleared"). It is a policy document, not a working instruction.

**Expected saving:** 1,675 tok/turn ≈ **−161 k tokens per 96-turn session**, ~+4 ms latency. Small but free.

### F6 — Reliability failures burn whole turns. Measured, not inferred.

97 `Failed to drain Session` errors in `opencode.log`, by cause:

| Cause | Count |
|---|---:|
| Free usage limit reached | 38 |
| Rate limit exceeded | 15 |
| Insufficient account funds | 13 |
| Invalid API key format | 5 |
| `StepFailedError` rate-limit / free-limit variants | 8 |
| Compaction summary reached output token limit | 4 |
| Other (upstream invalid response, forbidden, Google quota) | 14 |

A failed turn is a **fully paid request that returns nothing**, and the session usually dies ("Failed to drain Session"). Free-tier providers are the dominant source.

**Correction to the brief:** the "11 retry attempts on one call" claim is **not reproducible** from the available log. The 851 grep hits for `429`/`RESOURCE_EXHAUSTED` are overwhelmingly **tool output quoting project source code** (`res.status(429)`, test files, `retryAfterMs` symbols). There is no provider-level retry/backoff trace in this log. The real shape of the failure is hard failure, not backoff — consistent with the unimodal TTFT distribution in F1.

**Expected saving:** pinning a funded provider (D1/D2 route everything to `commandcode`) removes the free-tier and insufficient-funds causes — **53 of 97 errors** — and therefore most of the sessions that die mid-run.

### F7 — Context growth and compaction are unbounded by config.

- No `compaction` key in `opencode.jsonc` → running on defaults.
- 216 compaction events recorded; 5 in the 120 most recent sessions; **4 failed** with "Compaction summary reached the output token limit".
- Median 196,839 input tokens per session; max 11.4 M.
- The `-flash` TTFT distribution has a p99 of **23.5 s** (n=332) against a p50 of 8.5 s — the tail is where compaction-sized calls land.

**Expected saving:** bounding retained tokens makes compaction predictable and removes the `p99` outliers. Low-frequency, high-amplitude cost.

---

## 4. Proposed changes — exact diffs (NOT APPLIED)

All diffs are against `~/.config/opencode/opencode.jsonc`. Each is independently reversible.

### D1 — Route the default to the fast endpoint (highest impact, smallest diff)

Insert after line 3 (`"formatter": true,`):

```jsonc
  // HO-001: default model routed to the fast endpoint.
  // Measured: TTFT p50 1,904 ms (-fast) vs 8,467 ms (-flash) at identical
  // variant=max, n=30 vs n=332. Reasoning effort unchanged.
  "model": { "providerID": "commandcode", "model": "deepseek/deepseek-v4.1-flash-fast", "variant": "max" },
```

Then pin the primary orchestrator to the stronger endpoint so delegation quality does not regress. In the `leader` block (line 531), after `"mode": "primary",`:

```jsonc
      "model": { "providerID": "commandcode", "model": "deepseek/deepseek-v4.1-flash", "variant": "max" },
```

**Rollback:** delete both keys. **Risk:** low — `commandcode/deepseek/deepseek-v4.1-flash-fast` is the endpoint this very session runs on, and 30 turns of telemetry already exist for it.

### D2 — Routing table (only for agents that must differ from D1)

D1 already routes every unlisted agent to `-fast`. Set the strong endpoint only where multi-step reasoning is the product:

| Agent class | Agents | Model | Rationale |
|---|---|---|---|
| Orchestration / architecture | `leader`, `agent-engineer`, `harness-optimizer`, `designer`, `security-architect` (subagent type), `backend-architect`, `software-architect` | `commandcode/deepseek/deepseek-v4.1-flash` `#max` | long-horizon planning, contract authoring |
| Mechanical implementation | `node-developer`, `frontend-react`, `frontend-nuxt`, `database`, `devops`, `seo`, `android`, `flutter`, `ci3`, `laravel`, `python`, `rust`, `swift`, `dotnet`, `angular`, `cpp`, `java-developer`, `go-developer` | **inherit** (`-fast`) | edit-and-verify loops, bounded scope |
| Review / verification | `reviewer`, `code-reviewer`, `php-reviewer`, `go-reviewer`, `rust-reviewer`, `cpp-reviewer`, `java-reviewer`, `python-reviewer`, `kotlin-reviewer` | **inherit** (`-fast`) | pattern matching over a diff |
| Exploration | `fast-explorer`, `explore`, `docs-lookup` | **inherit** (`-fast`) | grep/glob only |
| Bulk/agentic | `custom agent` | already `opencode-go/glm-5.3` | leave as-is |

Only the first row needs edits — five `"model":` lines. Pattern, applied inside each block after `"mode": "subagent",` / `"mode": "primary",`:

```jsonc
      "model": { "providerID": "commandcode", "model": "deepseek/deepseek-v4.1-flash", "variant": "max" },
```

**Rollback:** delete the five lines. **Risk:** low.

### D3 — Move 66 stack-mismatched skills out of the global root

Measured saving: 21,929 B → **5,482 tokens per turn** (24% of catalog).

```bash
# quarantine, do not delete — fully reversible
mkdir -p ~/.config/opencode/skills-archive/ho-001
cd ~/.config/opencode/skills
mv dart-* flutter flutter-* \
   swift-actor-persistence swift-concurrency-6-2 swiftui-patterns foundation-models-on-device apple-design \
   cpp-coding-standards cpp-testing rust-patterns rust-testing golang-patterns golang-testing \
   android-clean-architecture android-jetpack-compose android-kotlin-compose jetpack-compose \
   compose-multiplatform-patterns java-coding-standards jpa-patterns kotlin-coroutines-flows \
   kotlin-exposed-patterns kotlin-ktor-patterns kotlin-patterns kotlin-testing \
   springboot-patterns springboot-security springboot-tdd springboot-verification \
   csharp-testing dotnet-patterns fsharp-testing \
   ci3-rest-api laravel-patterns laravel-plugin-discovery laravel-security \
   laravel-service-repository laravel-tdd laravel-verification \
   clickhouse-io kubernetes-patterns \
   ~/.config/opencode/skills-archive/ho-001/ 2>/dev/null
# verify
find ~/.config/opencode/skills -name SKILL.md | wc -l   # expect 227 → 161
```

**Deliberately kept** (crypto-adjacent, may apply to `nodejs-keccak256` / `evm-token-decimals` usage): leave both in place unless the project is confirmed crypto-free — that is 158 tokens, not worth the risk.

**Do not remove:** anything matching `agent-*`, `harness-*`, `eval*`, `cost-*`, `*-review*`, `security*`, `safety-guard`, `verification*`, `tdd*`, `test*`, `prisma*`, `postgres*`, `redis*`, `react*`, `next*`, `node*`, `typescript`, `documentation*`, `git-*`, `codebase-*`, `skills-*`. Those are the working set.

### D4 — Unload the prohibited-tool policy from the always-on set

In the `instructions` array (line 249–253), remove:

```jsonc
    "/home/ubuntu/.config/opencode/instructions/openflow-usage.md"
```

Replace the `mcp.servers.openflow` block with a pointer comment, and keep the file on disk so it can be re-added when generation is actually enabled.

**Expected saving:** 1,675 tok/turn. **Risk:** low — the file's own §2 says generation is prohibited, so it constrains nothing that can currently run. **Caveat:** if image/video generation is re-enabled, this must be restored in the same change.

### D5 — Bound context growth explicitly

Add at top level:

```jsonc
  "compaction": { "auto": true, "keep": { "tokens": 40000 } },
  "tool_output": { "max_lines": 400, "max_bytes": 20480 },
```

**Expected effect:** predictable compaction instead of the 4 observed "summary reached output token limit" failures; smaller per-turn growth from large tool dumps.

**Risk: medium.** Defaults are 2,000 lines / 51,200 bytes for tool output; 400/20,480 may truncate useful build logs. Land this **after** D1 so its effect is measured separately, and watch for "output truncated" in agent reports.

### D6 — Delegation contract budget (process, no config change)

Current contracts are 1,500–2,500 words ≈ 2,000–3,300 tokens. At the measured slope this costs ~0.5 s — negligible. It matters because it is re-read on every turn of the child session. Target template:

```
SCOPE: <files/dirs, exact>            (≤1 line)
GOAL: <one sentence>
CONSTRAINTS: <≤3 bullets, only non-obvious ones>
ACCEPTANCE: <exact command + expected result>
OUTPUT: <artifact path> + verification status
```

Budget: **≤300 words / 400 tokens.** Everything else belongs in a file the child reads on demand. Expected saving: ~1,600–2,900 tokens of first-turn context and less prompt drift, not wall clock.

---

## 5. What must not be changed

These carry the harness's safety and truth guarantees. Trimming them trades correctness for tokens — a bad trade at any measured price.

1. **`00-harness-contract.md` in full.** The tool-existence protocol, the evidence-level table (verified / inferred / recalled / unknown), the forbidden-claims list, and the "simulating a tool result is the worst failure mode" rule are what stop the harness from confidently reporting unverified work. 7,945 B ≈ 1,986 tok is cheap insurance.
2. **Global `permission` block** — `git push*`, `git reset --hard*`, `git clean*`, `rm -rf*`, `rm -fr*`, `sudo *`, `npm publish*`, `docker system prune*`, `kubectl delete*` all set to `ask`.
3. **`external_directory` read restrictions** and the `bash` allow/ask split.
4. **The Quality Gate checklist in `INSTRUCTIONS.md`** — type-check / no-`console.log` / loading-error-empty states / verification-status reporting. This is the only thing preventing `verified` from being self-certified.
5. **The security checklist** (secrets, input validation, SQLi/XSS/CSRF, rate limiting) — pre-commit gates.
6. **`fast-explorer` / `code-reviewer` / `ui-craft` permission denials** in the `agents` block (`edit`, `shell`, `webfetch`, `subagent`, `question` denied). Removing them would let read-only reviewers mutate the repo.
7. **`subagent_depth`** behaviour (default 1) — prevents runaway delegation trees, which multiply every cost in this report.
8. **Do not raise `temperature`** on reviewers to make them faster. It trades determinism for noise.

Safe to trim if a trade is needed: `INSTRUCTIONS.md` framework sections for stacks you do not run (Nuxt/Flutter/Android detail duplicates the skills), and the `openflow-usage.md` file per D4. Both are *reference*, not *gate*.

---

## 6. How to verify the improvement

### 6.1 Definition of the benchmark

Use a fixed, short, single-purpose task so the measurement is dominated by turn count and TTFT, not by task difficulty:

> **Benchmark task:** "In `/home/ubuntu/intelligenz`, find every API route that returns 429 and list file:line. Do not edit."

Run it 5× before and 5× after, always in a **fresh** session (no warm cache), always with the same agent.

### 6.2 Primary metric — median wall clock

From the DB, no instrumentation needed:

```python
import sqlite3, json, statistics as st, os
c = sqlite3.connect(f"file:{os.path.expanduser('~/.local/share/opencode/opencode.db')}?mode=ro", uri=True)
cur = c.cursor()
cur.execute("""SELECT s.id, s.agent, s.model, s.time_created, s.time_updated,
                 (SELECT count(*) FROM session_message m
                  WHERE m.session_id = s.id AND m.type='assistant') turns
               FROM session_v2 s
               WHERE s.time_created > ? ORDER BY s.time_created DESC""", (START_MS,))
for sid, agent, model, t0, t1, turns in cur.fetchall():
    print(f"{(t1-t0)/1000:7.0f}s  turns={turns:4d}  {(t1-t0)/1000/max(turns,1):5.1f}s/turn  {agent}  {model}")
```

**Pass criteria:** median `s/turn` drops from ~13.3 s to ≤7 s, and median turns do not increase. If `s/turn` improves but turns rise, the batching change made the agent dither — revert D6.

### 6.3 Secondary metric — TTFT by endpoint

```python
# median created -> firstToken, grouped by model+variant
cur.execute("""SELECT json_extract(data,'$.model.id'),
                      json_extract(data,'$.model.variant'),
                      json_extract(data,'$.time.firstToken') - json_extract(data,'$.time.created')
               FROM session_message
               WHERE type='assistant' AND json_extract(data,'$.time.firstToken') IS NOT NULL""")
```

**Pass criteria:** p50 TTFT on `-fast` ≤ 2,500 ms. **Fail:** > 4,000 ms → the endpoint regressed; restore D1's previous value.

### 6.4 Prompt-token metric — the only way to prove the catalog change

`cli.json` already has `debug: { turn_tokens: false, timing: false }`. Set `turn_tokens: true` for the measurement window. **Expected:** first-turn input drops by ~5.5 k tokens after D3, ~1.7 k after D4.

### 6.5 Reliability metric

```bash
grep "Failed to drain Session" ~/.local/share/opencode/log/opencode.log | wc -l
```
Record the count before and after; expect the free-tier and insufficient-funds causes (53 of 97) to disappear entirely once D1 pins `commandcode`.

### 6.6 Measurement hygiene

- Measure TTFT only from turns that reached `firstToken` — failed turns are censored, not slow.
- Never compare across providers: `-fast` and `-flash` on different providers are not the same experiment.
- Run the 5 trials **consecutively**; provider load varies by hour and the p99 already shows 23 s outliers.
- Re-run §6.2 monthly. This report is a snapshot of 709 sessions ending 2026-11-14.

---

## 7. What could not be measured

| Question | Status | Why | What would answer it |
|---|---|---|---|
| Tool execution vs generation split inside the 4.85 s | **not separable** | `session_part` has 0 rows; `part` has 0 rows; content types are stored inside the assistant message but carry no per-part timing | populate `session_part` (`experimental.part_rows`), then diff `time.completed` across `type='tool'` parts |
| Whether ~8.4 s includes a hidden retry | **inferred: no** | no provider retry events in the log; TTFT distribution is unimodal and narrow | provider-side request log, or a direct `curl` timing against `commandcode` with the same prompt |
| Effect of `warming: true` | **untested** | config default is `false`; if the provider unloads the model between turns this is exactly the 8.4 s | set `"warming": true`, re-run §6.3, compare p50 TTFT |
| Full tool-schema token cost | **not measured** | schemas are assembled at request time, not stored | `cli.json` `debug.turn_tokens` + a single-turn capture |
| Whether 65 turns is "necessary" | **unknown** | turn count is task-dependent; 2,012 turns for 21 reviews is a workload signal, not a defect | per-task baseline from the benchmark in §6.1 |
| Log coverage | **partial** | `opencode.log` covers 2026-10-13 → 2026-11-14 and is dominated by tool-spawn lines | rotating structured logs with request-id + latency |

---

## 8. Do this first

1. **D1** — one top-level key + one leader pin. **−630 s/session**, measured, reversible, no quality risk.
2. **§6.1 benchmark, 5 runs** — establish the real baseline before touching anything else.
3. **D6 contract budget** — process change, no config risk, compounds with D1.
4. **D3 skills** — 24% catalog reduction; a token-budget win, so it can wait behind latency work.
5. **D5 compaction** — land last, after D1's effect is isolated.

Do not do all of them at once. D1 alone is a falsifiable experiment with a 4.4× measured gap behind it; stacking five changes makes the next diagnosis harder than this one was.
