# Consolidation migration

`batch-24-multiAG` owns scheduler/lock/queue/worker/landing/recovery and create/dev/review/QA/repair/model/evidence code.
`engine/runtime` is a module directory, not another installable skill. Runner push-guard re-exports its canonical runtime module.
All legacy regression suites are retained alongside the implementation. Original file hashes and destinations are listed in
`consolidation-inventory.json`. Historical recovery/design/review documents are retained under `references/`.

## Users

1. Copy only `batch-24-multiAG` into both `~/.claude/skills/` and `~/.codex/skills/`.
2. From a project root run `node <canonical-skill>/install.mjs --force` at a verified idle batch boundary.
3. Keep existing auto.config.json, manual queue, stateDir, ledger, logs and task IDs. Configure the applicable quality scripts.
4. Run model-routing and quality tests, then `node tools/auto/plan-queue.mjs --dry`.
5. After isolated install/full-regression success, archive and remove the two old global skill folders.

New commands: `node tools/auto/finish-stories.mjs --from 4-1 --to 4-4`,
`node tools/auto/run-night.mjs --auto-plan`, `node tools/auto/runtime/quality-gates.mjs --base HEAD`,
`node tools/auto/runtime/quality-gates.mjs --phase landing --base <landing-base>`.

Old `auto-story-finish/*` and `night-batch-ops/*` schema names are accepted by `schema-migration.mjs`.
Unknown fields survive migration. New records use `batch-24-multiag/*`; schema-less state files retain their filenames.
Old model-health numeric schema 1 remains readable. A historical unverified result never becomes ready merely by migration.
Existing scheduled task identities/triggers remain valid because their project `tools/auto/run-night.mjs` entry is unchanged.
The installer retains legacy task IDs as rollback paths; inspect and disable only the duplicates relevant to this project.

Project pinned runtimes continue to work after both old globals are removed. A missing pinned module fails with a reinstall instruction,
never by mixing a different global engine into a live batch. The explicit AUTO_STORY_RUNTIME override remains a compatibility escape hatch;
it must point to a complete matched runtime tree.

## Operational rollout

Implementation and smoke occur in an isolated worktree. Do not overwrite an active runner.
Require BOTH no active runner lock and no matching PID, disable the scheduled task, then recheck that boundary to close the launch race.
Preserve existing story changes, untracked artifacts and logs. Apply only reviewed tooling changes; no reset/clean of the project.
Run routing tests, quality tests and dry plan. Re-enable only after success; retain the paused task and report failure otherwise.
No operational remote push is authorized by this migration procedure.
