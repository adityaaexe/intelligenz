# Programme execution state

Machine-checkable programme state for the INTELLIGENZ host-boundary programme, plus the
handoff a cold session reads first.

## Files

| File                     | What it is                                                                   |
| ------------------------ | ---------------------------------------------------------------------------- |
| `EXECUTION-STATE.json`   | The state. Tasks, dependencies, statuses, evidence requirements, history.     |
| `NEXT-SESSION-HANDOFF.md`| Where the work stands, what blocks it, and the traps already paid for.        |
| `README.md`              | This file: the schema's rules and how to validate.                            |

## Validate it

```bash
pnpm programme:check
```

Exit 0 means valid. Exit 1 prints one line per violation, each prefixed with its path:

```
programme state: INVALID — 3 violation(s) in docs/engineering/programme/EXECUTION-STATE.json
  tasks.1.dependsOn.0: depends on "P83-999", which is not a task in this file
  tasks.0.status: "P83-001" has status "completed" but is missing from completedTasks and is present in pendingTasks
  head: must be a full 40-character commit sha
```

The schema lives in `packages/contracts/src/programme.ts` (zod, already a dependency of that
package) and is enforced by `packages/contracts/src/programme.test.ts`, which parses **the
committed file** as one of its inputs. A document that passes `programme:check` locally but
fails that test is a document that has drifted since it was written.

## Task record

| Field                 | Rule                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `id`                  | `P<2-digit phase>-<3-digit sequence>` — `P83-001`. Stable: never renumber a task.        |
| `title`               | 8–180 characters. One sentence, no status in the title.                                  |
| `phase`               | `8`, `8.3`, `8.4` — a number, not `Phase 8`.                                             |
| `dependsOn`           | Task ids in this file. Self-dependencies and cycles are rejected.                         |
| `riskClass`           | `critical` · `high` · `moderate` · `low`. Drives how much evidence the task needs.        |
| `executionPolicy`     | `enforcement` (`fail-closed` / `advisory`), the `gate` that carries it, and a rationale.  |
| `acceptanceCriteria`  | At least one. Each must be checkable — a thing that can be false.                         |
| `evidenceRequirement` | `kind` + the `artifact` path that must exist for `completed` to be believable.            |
| `owner`               | A role or agent, not "the team".                                                          |
| `status`              | `planned` · `ready` · `in-progress` · `blocked` · `completed` · `abandoned` · `superseded` |
| `createdAt`/`updatedAt` | ISO-8601 with a timezone. `updatedAt` may not precede `createdAt`.                     |

## Statuses and the two lists

- **Open**: `planned`, `ready`, `in-progress`, `blocked` → must appear in `pendingTasks`.
- **Completed**: `completed` → must appear in `completedTasks`.
- **Terminal but not completed**: `abandoned`, `superseded` → must appear in **neither**.

That third rule is deliberate. If `abandoned` could sit in `pendingTasks`, the open count
would never reach zero and nobody would notice; if it could sit in `completedTasks`, giving
up would read as finishing.

`pendingTasks` and `completedTasks` are redundant *on purpose*: a document where the list and
the status disagree is the drift this validator exists to catch, and redundancy is what makes
the disagreement visible. `openTaskIds()` derives the answer from statuses so a consumer never
has to trust the list.

## What the validator rejects

Unknown status · unknown top-level key (a misspelled `pendingTasks` would otherwise silently
drop every open task) · duplicate task id · dependency on a missing task · self-dependency ·
dependency cycle · an id in a list that is not a task · the same id twice in a list · a task
in both lists · a status that contradicts the list it is in · terminal-not-completed work in
either list · `updatedAt` before `createdAt` · a document older than its newest task or than
its last history entry · history entries that go backwards · a date that matches the regex but
is not a date · a commit sha that is not 40 hex characters · an unknown `schemaVersion` · any
credential shape (provider key, GitHub token, Slack token, AWS key id, private key block,
bearer token, database URL with a password).

## What the validator cannot check

Whether a status is *true*. An honest `completed` and a dishonest one have the same four
fields. That is what `evidenceRequirement.artifact` is for: the claim is only as good as the
artefact, and the artefact is checked by whoever reads it — or by a test that parses the
document, which is the case here.

## Adding a task

1. Pick the next sequence number in the phase. Do not reuse or renumber.
2. `dependsOn` only ids that already exist in this file, or add them in the same edit.
3. Set `createdAt` to now, `updatedAt` to now, and raise the document `updatedAt` to at least
   the newest task's — the document may not claim to predate its own contents.
4. Add a `history` entry with the evidence paths that justify the change.
5. `pnpm programme:check`.
