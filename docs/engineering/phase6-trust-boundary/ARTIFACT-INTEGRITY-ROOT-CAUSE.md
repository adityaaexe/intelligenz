# Artifact and diff integrity — root cause

**Gate:** G (`docs/engineering/phase5-recovery/REMEDIATION-REGISTER.md`)
**Status at Phase 5 close:** FAIL — "a repository-defined Git filter can shape
`diff.patch`."

## What the evidence pipeline is today

`diff.patch` is produced by the adapter from git commands executed **inside the
sandbox** (`packages/agent-runtime/src/runtimes/opencode-cli.ts:394`,
`collectWorkspaceEvidence`), then materialised by
`apps/worker/src/activities/artifacts.ts` with a re-computed SHA-256 over the bytes
it actually copies.

The in-sandbox move was itself a Phase 3 security fix: the previous host-side
`execFile('git', ['-C', repoPath, …])` interpreted an agent-writable repository,
so `.git/config` (`core.fsmonitor`) and `.git/hooks/*` were agent-authored programs
run by the worker user on the host. Running git inside the sandbox removed a host
RCE.

The hardening around it is real: `--unshare-net`, `--clearenv`, a single rw bind at
`/workspace`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
`GIT_ATTR_NOSYSTEM=1`, `--no-ext-diff`, `--no-textconv`, and
`SANDBOX_GIT_CONFIG` neutralising `core.fsmonitor`, `core.hooksPath` and
`diff.external`.

The module's own comment is honest about the limit:

> `.gitattributes` can name a filter, an external diff driver or a textconv
> program. … the repository's own is agent-writable and cannot be switched off,
> which is why "the sandbox holds no secret" is the control and these are belt and
> braces.

That is a correct statement about **exfiltration**. It is not a statement about
**integrity**, and integrity is what an approver relies on.

## The defect, measured

I ran three attacks against the exact command shape above, in a scratch repository
in `/tmp` — not against the product, against the command it uses.

### Attack A — staging alone

```
printf 'SECRET=COMPROMISED\n' > config.txt      # was SECRET=original
git diff --no-ext-diff --no-textconv … | wc -l  →  2 hunks
git add -A
git diff --no-ext-diff --no-textconv … | wc -l  →  0 hunks
```

`git diff` compares index to worktree. Staging empties it. No malicious
configuration is required — `git add` is a normal thing an agent does. The artifact
retains a ` M config.txt` status line and **no content**, which reads as a
whitespace-only change.

### Attack B — a clean filter hides content, and `--no-textconv` does not stop it

```
cat > .gitattributes <<'EOF'
config.txt filter=hide
EOF
git config filter.hide.clean "sed 's/COMPROMISED/original/'"

printf 'SECRET=COMPROMISED\n' > config.txt
cat config.txt                       →  SECRET=COMPROMISED     (bytes on disk)
git diff --no-ext-diff --no-textconv →  0 lines
git status --porcelain               →   M config.txt ?? .gitattributes
```

`--no-textconv` disables the *textconv diff driver*. A **clean filter** is a
different mechanism; it applies to content as git compares the worktree against the
index, so the comparison sees the rewritten content and reports no change. The file
on disk is compromised, the diff is empty, and the status still says modified.

### Attack C — commit, and the evidence asserts nothing happened

```
printf 'SECRET=COMPROMISED-AND-COMMITTED\n' > config.txt
git add -A && git commit -m "agent work"
git status --porcelain →  0 lines
git diff               →  0 lines
cat config.txt         →  SECRET=COMPROMISED-AND-COMMITTED
git rev-list --count HEAD → 2
```

Both sections of `diff.patch` are empty. The artifact does not say "unknown" or
"suspicious" — it says, with full confidence, that the workspace is unchanged,
while the repository is entirely different.

Attack C is the important one. A tampering signal can be investigated. A confident
negative is believed.

## Root cause

**The tool used to describe the change is a tool the agent controls.**

Not a missing flag — `--no-ext-diff`, `--no-textconv`, `GIT_CONFIG_GLOBAL` and
`/dev/null` are all in place, and each closes a real hole. But the description is
produced by interpreting repository state through a program whose behaviour the
repository configures, and by comparing two positions of a pointer (`HEAD`, the
index) that the agent can move at will.

Three specific consequences:

1. **A diff is relative to a pointer the agent can move.** `git add` and
   `git commit` move it. Any evidence keyed on it inherits that.
2. **Filters are not textconv.** Neutralising the diff driver while leaving
   `.gitattributes` filters active leaves a content-hiding path open.
3. **"No diff" is indistinguishable from "no change."** The artifact format has no
   way to say *"I could not establish what changed"*, so absence is read as
   nothing.

## What integrity requires instead

A baseline the agent cannot touch, taken before it runs; a final state read the same
way; and a comparison performed by host code that consults no repository-configurable
program. The authoritative output must be a **manifest of what changed**, with the
old and new hash of each path — not a patch that some interpreter produced.

A unified diff remains useful for human reading, but it is *display*, and must be
labelled as such rather than serving as the evidence.

## What a snapshot can and cannot prove

| Question | Snapshot answer |
|---|---|
| Which paths were added, modified, deleted? | **Yes** — authoritative |
| What are the before/after hashes and modes? | **Yes** |
| Was a symlink retargeted? | **Yes** |
| Did the repository's own config, index or hooks change? | **Yes**, recorded as a separate metadata digest |
| What did the *content* of the change look like? | **No** — the pre-image is gone once the file is overwritten; a display patch may be derived only where the pre-image was retained |
| Did a change happen and get reverted within the run? | **No** — a snapshot pair observes endpoints, not history |
| Did the agent attempt an exfiltration via a filter? | **Not from the manifest** — that is the sandbox's no-secret property, a different control |

Those last three are the honest limits, and they are why the manifest is described
as authoritative *for the change set*, not as a general oracle.

## Evidence paths

- `packages/agent-runtime/src/runtimes/opencode-cli.ts:352-450` — `collectWorkspaceEvidence`, `SANDBOX_GIT_CONFIG`
- `apps/worker/src/activities/artifacts.ts` — materialisation, re-hash, output budget
- `packages/workspace-manager/src/sandbox.ts:302-333` — the bind set
- Scratch reproductions A/B/C in `/tmp/opencode/gitev` (commands reproduced above)
- `docs/engineering/phase6-trust-boundary/TRUSTED-SNAPSHOT-DESIGN.md`
- `docs/engineering/phase6-trust-boundary/ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md`
