# Sol high independent release review

**Latest worktree status:** the reviewed remediation at implementation
fingerprint
`02ff9429f77ad3c7b1ebd1988da8b3fa658e47e72e163044e1df7166676c5245`
has no remaining code release blocker. Operational rollout remains blocked by
the project-specific readiness items listed below. The `93f6c44` decision and
three findings in the first part of this document are retained as the historical
review of that commit; they were corrected in the later uncommitted worktree.

Target: `93f6c44b1f91b681a15a06ab99ca0e9884000330` on
`codex/quality-gates-9-consolidation`, compared with
`166e28cf4af31c3309f9f19a7b8ed0f0219f94c3`.

This is an independent-model review performed with OpenAI Codex Sol at high
reasoning effort. It is not evidence of a different provider. The engine's
Claude/Codex cross-provider review policy remains a separate runtime contract.

## Decision

**Block release and operational rollout.** Repository evidence is internally
consistent and the focused regression checks pass, but three publication and
rollout paths can still accept unverified code or discard work.

## Release blockers

### 1. API and authorization evidence covers a source file, not every changed endpoint

- Severity: high
- Release blocker: yes
- Files: `engine/runtime/quality-gates.mjs:31-45`, `:152-174`
- Contract affected: `QUALITY-GATES.md` API/authorization adapter contract and
  `SOL-HIGH-REVIEW.md` requirement to verify every changed endpoint and method.

`classifyRisk()` reduces the API surface to `apiFiles`. Both
`apiAuthorizationVerdict()` and `authorizationVerdict()` then accept the report
when at least one row names each source file. They never derive or compare
`source + method + route` descriptors for every changed endpoint.

Minimal reproduction against the reviewed commit used one source diff adding
`POST /users` and `DELETE /users/:id`, then supplied a report containing only
the POST row. Both verdict functions returned `pass`:

```text
apiFiles: ["src/api/users.ts"]
api.result: pass
authorization.result: pass
reported endpoint: POST /users
omitted endpoint: DELETE /users/:id
```

Expected: `fail` or `not-verified` until both endpoint/method pairs have fresh,
fingerprint-bound evidence. Actual: the partial report passes, so an untested or
unauthorized endpoint can be published.

### 2. Marker worktree refresh can erase preserved work and has no durable local tooling pin

- Severity: high
- Release blocker: yes
- Files: `engine/run-night.mjs:530-613`, `install.mjs:231-251`,
  `references/MIGRATION.md:30-36`
- Contract affected: preservation of story changes, untracked artifacts and
  logs during operational rollout.

When `.auto-batch-worktree` exists, the runner attempts a stash for valuable
changes. If the stash fails, line 557 explicitly logs that loss is possible and
continues to `git clean -fdq` and `git checkout -f`. The refresh therefore turns
an archival failure into destructive cleanup instead of stopping.

The same refresh chooses an existing remote `auto/*`, a limited local dated
`auto/*` inheritance ref, or `origin/main`. A reviewed tooling commit applied
only to the operational checkout on another local branch or detached HEAD is
not a candidate and is removed by the next refresh. The installer already
states this behavior and prescribes `commit + push` followed by `git pull`, while
the migration contract explicitly says that no operational remote push is
authorized. The documented rollout therefore lacks a durable local source for
the installed tooling.

Expected: abort refresh when preservation fails; select and verify a reviewed,
durable local tooling ref without requiring an unauthorized remote push; never
clean/reset project work during migration. Actual: cleanup continues after
stash failure, and normal local tooling commits can be replaced by a remote
baseline.

No committed test exercises `.auto-batch-worktree`, stash failure, or survival
of a local tooling commit through startup refresh.

### 3. The publication fingerprint is sampled after the landing gate, so a post-gate change can become the trusted fingerprint

- Severity: high
- Release blocker: yes
- File: `engine/run-night.mjs:1098-1119`, `:1204-1208`
- Contract affected: a post-landing source change must invalidate publication.

The landing quality process writes `landing-quality.json` with the fingerprint
that it actually checked. `runIntegrationGate()` does not read and bind to that
fingerprint. After the process exits it samples the current tree into
`integration.codeFingerprint`, then samples the current tree again into
`landingPublicationFingerprint`. `pushBranchOnce()` compares the tree against
that second post-gate sample.

If a source change lands after the gate exits but before those samples, the
change was not tested, yet its fingerprint becomes the publication baseline and
the pre-push comparison succeeds.

Expected: require a ready landing report, copy its validated
`afterFingerprint`/`codeFingerprint`, and compare that exact value with the tree
immediately before publication. Actual: the post-gate current tree defines what
counts as verified. Existing tests cover mutation during `runQuality()` but not
the boundary between the child gate and publication.

## Evidence that passed review

- The target commit, base commit and branch in `verification/manifest.json`
  match the requested review target.
- All nine recorded evidence files match their `evidenceSha256` values.
- All recorded Git-index source hashes match the blobs in commit `93f6c44`.
- Changed coverage is 97.79% for lines (1150/1176) and 90.51% for branches
  (734/811), with no unknown changed lines in the recorded report.
- Focused checks passed: `quality-gates.test.mjs`, `consolidation.test.mjs`, and
  `worker-pool.test.mjs`. The existing full-regression evidence was inspected
  rather than rerun.
- Worker completion rejects missing mandatory scripts, stale LCOV and reports,
  incomplete test-kind evidence, same-provider review, and non-ready worker
  manifests. The first landing RED rolls back and blocks push in the covered
  paths.
- `git diff --check` passes for the reviewed range.

## Unverified scope and residual risks

- Operational `jng-os`/`jng-os-auto` installation and real scheduler execution
  remain unverified and were not run or modified by this review.
- Real application middleware, production auth/tenant fixtures, and real LLM
  latency were not exercised; the submitted report correctly identifies those
  limits.
- Rollback preservation depends on unchecked `git tag` and archive writes in
  `run-night.mjs:1129-1168`. Failures are logged but rollback continues, so a
  disk/permission/ref failure can remove the convenient source/evidence handle.
  This should be hardened before treating artifact preservation as guaranteed.
- `install.mjs --force` copies over the runtime tree but does not remove files
  absent from the new source. The reviewed old and new runtime inventories do
  not currently expose an old-only executable file, so this is not a blocker for
  this exact migration, but future upgrades are not an exact canonical mirror.

## Focused commands

```text
node --test batch-24-multiAG/engine/runtime/quality-gates.test.mjs batch-24-multiAG/engine/consolidation.test.mjs batch-24-multiAG/engine/worker-pool.test.mjs
git diff --check 166e28c..93f6c44
git show 93f6c44:<path>  # source-hash comparison
```

No implementation file was changed by this review.

## Re-review of the uncommitted remediation worktree

This section reviews the later, uncommitted remediation visible in the shared
worktree on 2026-09-06. It does not change the decision for commit `93f6c44` or
make the old verification manifest evidence for the new files.

### Remediation decision

**No release-blocking code finding remains in the reviewed remediation paths.**
The three blockers above are fixed in the current worktree. The remediation
still needs its own commit and a freshly generated verification manifest before
it is a releasable artifact, because the submitted manifest remains correctly
bound to `93f6c44`.

The reviewed remediation code-set fingerprint is
`02ff9429f77ad3c7b1ebd1988da8b3fa658e47e72e163044e1df7166676c5245`.
This is SHA-256 over each sorted repository-relative path, a NUL byte, its
bytes, and a trailing NUL byte for the eleven non-test implementation files in
`adapters/vitest-quality.mjs`, `engine/{landing-publication,run-night,runtime-pin,worktree-refresh}.mjs`,
`engine/runtime/{api-surface,auto-story-pipeline,quality-gates,quality-rules}.mjs`,
`engine/runtime/providers/codex.mjs`, and `install.mjs`.

### Blockers resolved

1. API scope is now derived and compared as `source + method + route`. Static
   Express methods and Next route exports are discovered. Dynamic dispatch,
   mounted routers and unsupported frameworks require a source-SHA-256-bound
   project inventory. A report cannot supply its own expected inventory, and
   partial method coverage fails.
2. Marker startup no longer stashes, cleans, resets or force-checks out
   unfinished work. It stops on dirty/staged/untracked content, preserves an
   ahead local auto-branch anchor, and rejects divergent or stale refs. The
   reviewed runtime pin is exact for tracked tooling: descendants may change
   application code but may not change installed tooling. Marker migrations
   set `runtimePin.required: true`. The final containment guard also rejects a
   tooling directory equal to the worktree root, its exact parent, or any other
   path outside the worktree before fetching or checking out.
3. Runtime identity is rechecked before and after startup refresh, before an
   incoming `origin/main` merge, after down-sync, and immediately before both
   sequential and parallel child launches. A parallel guard failure stops new
   launches, waits for an already-started worker, removes only never-started
   worktrees, and retains the started worker's output for recovery.
4. Landing publication now deletes a stale report before execution and binds
   authorization to a ready report with the exact phase, base, HEAD and
   before/after fingerprint. The same verified fingerprint is checked again
   immediately before push, so a post-gate mutation blocks publication.
5. The installer supplies the Vitest adapter and migration/runtime-pin
   procedure without requiring an operational remote push. The adapter uses
   explicit unit/integration scopes, exact Vitest/coverage-v8 versions, Vitest's
   dependency graph, one affected run for LCOV, mandatory environment checks,
   and strict integration skip rejection.

### Focused re-verification

- The API, quality-gate, worktree-refresh and landing-publication focused suite
  passed 77/77 after the first remediation round. The frozen publication,
  runtime-pin, API-surface and worktree-refresh boundary run then passed 36/36
  with zero skips. The latest runtime-pin pool boundary tests also passed 2/2
  in this review, including preservation of a real temporary output file from
  an already-started worker.
- The submitted real Vitest fixture log passes 9/9, including actual Vitest 4
  dependency mapping, real LCOV production, DB exclusion from the unit scope,
  and rejection of a skipped integration test.
- `node --check batch-24-multiAG/engine/run-night.mjs` and `git diff --check`
  pass for the current worktree. The existing full-regression run was not
  duplicated by this review. The newer full run completed 1006/1010 with zero
  skips: four failed assertions came from two fixture child processes reaching
  their 300-second spawn deadline with `status: null`, both after their logs
  reached `[INTEGRATION][RUN]`. Focused reruns passed the same assertions:
  `runBench` passed 1/1 in 45.64 seconds, and the integration-RED fixture passed
  3/3 in 28.43 seconds. The normal performance comparison also passed 6/6 over
  three pairs. The final candidate evidence records a 21.756-second baseline
  median and 26.124-second candidate median, a +20.077% increase and a pass
  against the unchanged 30% investigation threshold. The
  timed-out full run is still recorded as 1006/1010 rather than relabelled
  green; the targeted results establish that its four assertions were
  reproducible only as host child-process timeouts in that run.
- Before the final containment correction, the frozen changed-code calculation
  for the four new boundary modules reported 152/160 lines (95%) and 156/168
  branches (92.857%), with no unknown changed lines. That aggregate is retained
  as historical evidence and is not presented as a calculation for the new
  implementation fingerprint.
- The final merged changed-code calculation for the current implementation
  fingerprint passes both thresholds: 1523/1573 lines (96.8214%) and 1051/1165
  branches (90.2146%), with no unknown changed lines.
- Source review of the six added `worktree-refresh` boundary cases found no
  weakened assertion or threshold. The first instrumented run passed 18/19 and
  exposed that an exact parent directory produces `toolingPath === '..'`, which
  the former `startsWith('../')` condition rejected only later through Git. The
  one-condition product correction rejects that path before fetch. The final
  19/19 run passed with zero skips and 100% line, branch and function coverage
  for `worktree-refresh.mjs`. The test also covers the worktree root, a sibling
  path, an empty auto chain, non-date and lost local anchors, a reviewed pin
  outside the selected history, and a concurrent runtime change during
  checkout, including preservation and absence of destructive Git fallbacks.
  The reviewed implementation SHA-256 is
  `39f8d6b8c6113333ce363db567450c4bf946c606d35a6e9eed9bd4b7d5b79dcd`;
  the test SHA-256 is
  `ef28047683c4a64a28fe9ea0d6f9a7af19500dce9458a7c875b8899a7153c99a`.
- The new installer-contract suite runs the real installer and permits only its
  declared capability probes. It asserts exact bundled payload bytes, fresh
  `runtimePin.required: true`, byte-preservation of a legacy config and queue,
  preservation of package scripts, and exclusion of test artifacts. Its
  instrumented run passed 2/2 with zero skips in 517 ms; the reviewed test file
  SHA-256 is
  `ecb66c4ab9a583241eb26e4fd409ce188da5fa27cb1b1c742dc205a01a179e17`.
- The three added benchmark CLI tests preserve the existing performance
  assertions and product threshold. They execute the real CLI with a missing
  baseline, `--samples 2`, and non-integer samples, while a preload turns any
  fixture creation or child-process launch into an observable failure. They
  require exit 1 without a signal, the exact input error, no cost-run output,
  and no result or attempt-log artifact. The instrumented run passed 3/3 with
  zero skips in 463 ms.
- The three added runtime-pin input tests require unresolved revision output to
  stop after one `rev-parse`, missing or malformed merge-base output to stop
  before a tooling diff, and missing or empty paths to stop before any Git
  subprocess. Their focused instrumented run passed 3/3 with zero skips in
  104 ms.
- In the isolated `C:\Projects\jng-os-batch24-release` installation, the
  installed adapter, runtime pin, refresh, landing publication, API-surface and
  runner files match the reviewed sources by SHA-256. The lockfile resolves
  Vitest and `@vitest/coverage-v8` to 4.1.10. `test:affected` and
  `test:coverage:changed` use the same adapter command, while `test:all` and
  `test:integration` use the explicit full-unit and DB scopes. The submitted
  installed routing/quality/authorization regression passed 71/71 with zero
  skips, and the project lint command exited zero.

### Remaining rollout limits

- The isolated project currently reports integration unavailable because its
  four declared database/auth environment variables are absent. API,
  authorization, security and performance project adapters are also absent.
  These capabilities remain fail-closed. The application cannot claim an
  operational quality pass until every applicable required matrix runs and the
  strict landing integration suite passes with zero skips.
- The existing project's DB/integration placeholder and skip debt has not been
  converted into a pass or allowlisted. Keeping the current strict failure is
  the safe engine behavior. A required core integration scope should remain
  zero-skip; optional external/write suites should be reported separately and
  must not count as a successful required gate.
- The configured unit and integration include patterns cover the observed
  `tests`/`src` unit paths and `tests/db` split, but retaining the project's
  complete historical suite is a reviewed project-configuration obligation;
  the adapter cannot infer an omitted historical test directory.
- The operational `C:\Projects\jng-os-auto` workspace and scheduler were not
  accessed, modified or executed by this review. Operational rollout remains
  blocked until the project-specific integration scope is resolved, required
  environments are deliberately armed, the exact tooling commit is recorded in
  `runtime-pin.json`, and the stopped-boundary migration checks pass.

### Separate legacy-continuity migration review

The prepared `inspectier-legacy-continuity` transaction was inspected without
executing it or reading either target project. Its PowerShell parser reports
zero errors, every one of the 28 declared payload rows matches its SHA-256, and
the script hard-codes exactly two allowed roots. It refuses an existing runtime,
requires the original runner hash, verifies the one-line ENGINE patch, journals
backups, validates both projects before mutation, and blocks rollback over a
later runner or generated-file edit.

The initially reviewed script did not bind `manifest.json`, which would have
allowed the plan and all of its expected hashes to be replaced together. The
prepared script now verifies the literal reviewed manifest SHA-256 before
parsing it. Its parser still reports zero errors, so no code blocker remains in
the prepared transaction. The reviewed prepared hashes are:

- `apply.ps1`: `8de000b0ae43e46d2ba3d42da79b8ca6a1af5ef35e601957978709d13c8d7035`
- `manifest.json`: `c74b196a8556d301419ad04127056aea8b25b5032bcd504888a7294533223fe5`
- prepared `receipt.json`: `5276933f40a9d7cacf527e19728f5a32e230168f2ab6228d50d5321008b8c2b1`

The separately documented checks that both schedules are disabled and that no
matching runner PID or lock is active remain mandatory application
preconditions. This review did not perform or authorize `-Apply`.
