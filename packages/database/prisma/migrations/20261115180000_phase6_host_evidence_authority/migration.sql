-- Phase 6 (AG-606, Gate G): the agent stops authoring the evidence that judges it.
--
-- Additive only. Seven nullable columns, one boolean defaulted to false, no back-fill,
-- nothing narrowed, nothing reinterpreted and no index (these are read by id, not
-- filtered on).
--
-- The defect this closes, measured rather than argued. Evidence was `git status` plus
-- `git diff`, collected against a repository the agent controls:
--
--   git add -A                     -> diff hunks 0, tree fully changed
--   .gitattributes clean filter    -> diff hunks 0, bytes on disk rewritten
--   git add + git commit           -> status 0, diff 0, tree entirely different
--
-- The third is the dangerous one: not a tampering signal, a confident **negative**. The
-- patch an approver reads asserts "nothing changed" while it is not the same tree. No
-- amount of `--no-textconv`/`--no-ext-diff` fixes it, because those flags govern a
-- different mechanism and because the index/worktree pair is empty by definition after
-- a commit.
--
-- So authority moves to a host walk (`workspace-manager/snapshot.ts`): `lstat`, hashes,
-- one canonical body, one digest, no subprocess and no repository config. The two
-- snapshots of an attempt (before the agent runs, after it finishes) are compared into a
-- `change-manifest` artifact. Everything git produced is kept and explicitly demoted.
--
-- Why NULL rather than a default for the digests: a row written before the walk existed
-- has no measured baseline, and a fabricated one is indistinguishable from a real one.
-- Why `authoritative` defaults to false: an artifact written yesterday was never
-- authority, and a migration that says it was is a rewrite of history.
ALTER TABLE "ExecutionWorkspace" ADD COLUMN "initialManifestDigest" TEXT;
ALTER TABLE "ExecutionWorkspace" ADD COLUMN "finalManifestDigest" TEXT;
ALTER TABLE "ExecutionWorkspace" ADD COLUMN "snapshotAt" TIMESTAMP(3);

ALTER TABLE "Artifact" ADD COLUMN "evidenceSource" TEXT;
ALTER TABLE "Artifact" ADD COLUMN "authoritative" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Artifact" ADD COLUMN "manifestDigest" TEXT;
ALTER TABLE "Artifact" ADD COLUMN "initialManifestDigest" TEXT;
ALTER TABLE "Artifact" ADD COLUMN "finalManifestDigest" TEXT;
