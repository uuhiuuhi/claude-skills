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

## Reviewed local runtime pin (no operational remote push)

Prepare tooling changes on a separate project worktree based on the latest local `auto/<date>` tip.
Commit only reviewed tooling, project adapter configuration and dependency changes. Review that exact commit.
At the idle boundary, pause every scheduled entry that can launch this project and recheck lock AND PID.
If the operational workspace has unfinished story/log changes, preserve them in place and defer the switch.
Do not stash, reset, clean or force-checkout to make the workspace look clean.

Fast-forward the intended local `auto/<date>` branch to the reviewed tooling commit only when its old tip
is an ancestor and that branch is not checked out by another task. Use ordinary `git switch` in the idle
runner workspace. If the local branch diverges, reconcile in an isolated worktree and review the result first.
A separate clone can fetch the reviewed commit from the local preparation repository; no GitHub push is needed.

Write `<stateDir>/runtime-pin.json` after verifying the installed files against the commit:
`{"schema":"batch-24-multiag/runtime-pin/1","commit":"<reviewed 40-character project commit>"}`.
This is local deployment state, not a quality pass or a story completion record. Back it up with the prior
runtime and task state. Startup requires the selected tip to contain the pin; local ahead commits survive
remote lag and date rollover. A remote change to loaded tooling stops the runner for a reviewed update.
Dirty files, divergent refs, stale local branches, failed fetches and malformed pins fail closed.

Run installed routing/quality tests and `plan-queue.mjs --dry`. Restore only the prior enabled schedules
on success. On failure, restore reviewed tooling/pin from the backup and report the failure; do not silently
retry a failed application QA into green. Existing project test debt must be reported separately from
engine installation checks. Missing applicable API/auth/security/performance evidence still blocks stories.

For this migration set `auto.config.json` `runtimePin.required: true` before enabling a marker runner.
New installation defaults require this pin; existing configs are preserved and must be migrated explicitly.
Legacy unconfigured runners retain their historical compatibility until migration and are not described as
verified deployments. Required pins cannot be omitted. Before main synchronization, the runner rejects
incoming tooling changes; after synchronization and before worker launch it rechecks the installed pin.
Application commits may advance after the pin, but any tooling change requires a new reviewed pin at an idle boundary.
