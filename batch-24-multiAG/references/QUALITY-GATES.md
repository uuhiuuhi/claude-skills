# Quality gates and evidence

| Class | Required worker gates |
|---|---|
| docs | None: documents, comments and static resources only |
| fast / standard | typecheck, lint, affected unit, changed-lines/branches coverage >= 90% |
| api | standard + affected API integration + authorization policy report |
| auth-db | standard + authorization matrix + security; API integration if routes changed |
| performance | standard + performance; combine with API/auth gates when applicable |

Risk classifications are additive. Deletions count. Performance does not trigger merely because a directory is named batch/queue.
Unsupported or missing mandatory evidence fails closed. An inapplicable optional script is never required.

## Project scripts

Define `typecheck`, `lint`, `test:affected`, `coverage` (or `test:coverage:changed`),
`test:api`, `test:authorization`, `test:security`, `test:perf` as applicable.
For landing define `test:all` (or `test`) and `test:integration`.
Affected test adapters receive `BATCH_BASE` and JSON `BATCH_CHANGED_FILES`.
Use a verbose or TAP reporter: changed test names must appear in passing test results, not merely in source.
The current evidence reader supports literal `it/test` cases with expect/assert assertions and TAP or verbose checkmark results.
Parameterized/custom test runners need a compatible reporter/adapter; missing evidence is not a pass.

Return LCOV at `coverage/lcov.info`. Every executable changed line must be instrumented.
Missing files/lines are `not-verified`; whole-repository coverage cannot mask excluded new code.
Changed branch coverage is also >= 90% when the LCOV includes branches.
Coverage percentage has no denominator for comment/import/structural-only changes; this is explicitly recorded.

Optional `tools/auto/quality.config.json` sets `lcov`, `authorizationReport`, `apiReport`, `timeoutMs`.
`sensitivePaths` accepts `api`, `authDb`, `performance` arrays of project-relative prefixes; these can add scopes, never remove detected risks.
`test:affected` (or `test:unit:affected`) is mandatory for code workers; there is no whole-suite fallback.
Reports must stay inside the project. Old report files are removed before a fresh run.
Keep coverage artifacts out of git. Test commands must not mutate source; before/after SHA-256 must match.

## Authorization and API adapters

The `test:api` command writes `BATCH_API_REPORT` with:
`{ nonce: BATCH_VERIFICATION_NONCE, codeFingerprint: BATCH_CODE_FINGERPRINT, endpoints: [...] }`.
Each endpoint has `source`, `method`, `route`, and `authorizationApplied: true`.
Intentionally public endpoints instead record `public: true` with a specific `publicReason` reviewed by the independent reviewer.
Every affected API source file must appear. This report is an integration-test contract, not a proof that a boolean declaration alone enforces middleware.

For auth/permission/DB/RLS changes, `test:authorization` must execute:
anonymous=401, authenticated forbidden=403, allowed role=2xx, existing foreign tenant/company resource=403 or 404.
Use `tools/auto/runtime/authorization-matrix.mjs`: `verifyAuthorization()` sends actual requests;
`writeAuthorizationReport()` writes a nonce/fingerprint-bound report. Use isolated test data and real application middleware.
Unit mocks and fixture-only tests are not evidence of production authentication/tenant isolation.
A missing security script blocks completion even if every other gate passes.

## Execution and cache

Run cheap diff/integrity/test-presence checks first. Typecheck, lint and independent unit commands run concurrently.
Stateful security/API/performance commands run sequentially. Identical script bodies share a single promise and result.
Prefer an affected-unit command that emits both verbose results and LCOV; alias coverage to that same command to avoid rerunning tests.
The cache key includes HEAD, baseline, content SHA-256, full diff, scripts, config, phase, policy implementation, Node version, platform and architecture.
Only ready results are cached. Old or malformed cache is a miss. Cache storage is project-local pipeline logs.
Do not treat editable local cache as a security boundary against an administrator who can modify the engine itself.

Worker manifests record commands, exit status, reason, timing, coverage, observed tests, risk and code fingerprints.
Worker integration is explicitly outside its scope; landing manifests record the combined full/integration result.
Landing failure blocks push and preserves rollback evidence. A missing/non-ready worker manifest blocks publication.
A post-landing source change invalidates publication. `not-ready` and `not-verified` never authorize done/commit/push.
Partial `--stages dev` can return its phase result while leaving completion unverified and refusing commit/push.

## Limits requiring independent review

Diff heuristics are conservative, not a language-complete AST/security analyzer. Test names/coverage do not prove assertion quality.
Review middleware placement, all changed endpoints/methods, tenant fixture setup, thresholds and test-report adapters.
Comments containing lint/coverage disabling directives are not exempt documentation.
Measure real application workloads separately from deterministic stub benchmarks; never label stub latency as LLM throughput.

Claude reviews request `--output-format stream-json --verbose`. Only successful Read tool results for every requested story/diff/changed path establish review evidence; prose and failed reads do not. Codex review evidence continues to use its structured CLI events. Raw CLI output is redacted before storage.

Legacy `integrationGate.retry` is read but ignored. The first landing RED immediately preserves evidence, rolls back and blocks publication; it is never retried into GREEN.
