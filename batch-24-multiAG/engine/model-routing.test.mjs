import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageRouter } from './runtime/stage-router.mjs';
import { codexDevPolicy, claudeCrossPolicy, claudePairCross, failureKind, limitDowngradeMode, modelCandidates, selectModel, MODEL_CATALOG } from './runtime/model-policy.mjs';
import { crossReviewResult } from './runtime/completion-rules.mjs';
import { taskReadiness } from './readiness.mjs';
import { recordModelEvent, readModelHealth } from './runtime/model-health.mjs';
import { assignWorkers } from './assign.mjs';
import { requestPlan } from './orchestrate.mjs';
import { asfCandidates } from './asf-resolve.mjs';
import { buildCodexCommand } from './runtime/providers/codex.mjs';
import { buildDag, validatePlan } from './plan-dag.mjs';
import { parseSprint } from './story-ledger.mjs';
import { sequentialPolicyFlags } from './runner-rules.mjs';

const providers = { claude: { enabled: true, max: 3 }, codex: { enabled: true, max: 1, roles: ['dev', 'review'] } };
test('Fable quota is shared across independent routers; Opus runs immediately; reset restores Fable', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-health-'));
  let now = 1000;
  const one = new StageRouter({ stateDir, providers, now: () => now });
  const input = { role: 'replan', risk: 4, difficulty: 8, preferred: 'fable' };
  assert.equal(one.choose(input).model, 'fable');
  one.record('fable', 'limit', { retryAt: 5000 });
  const two = new StageRouter({ stateDir, providers, now: () => now });
  assert.equal(two.choose(input).model, 'opus');
  now = 5000;
  assert.equal(two.choose(input).model, 'fable');
});
test('auth/spend block that provider; quota blocks only the affected model', () => {
  for (const kind of ['auth', 'spend', 'limit']) {
    const dir = mkdtempSync(join(tmpdir(), 'routing-scope-'));
    recordModelEvent(dir, { model: 'fable', kind, now: 1000 });
    const health = readModelHealth(dir, 1001);
    assert.equal(health.blocked('fable'), true);
    assert.equal(health.blocked('opus'), kind !== 'limit');
    assert.equal(health.blocked('codex:gpt-6-astra'), false);
  }
});
test('late success from an earlier in-flight request cannot reopen a failed model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-race-'));
  recordModelEvent(dir, { model: 'fable', kind: 'limit', now: 1000 });
  recordModelEvent(dir, { model: 'fable', kind: 'success', now: 1200, startedAt: 900 });
  assert.equal(readModelHealth(dir, 1300).blocked('fable'), true);
  recordModelEvent(dir, { model: 'fable', kind: 'success', now: 1500, startedAt: 1400 });
  assert.equal(readModelHealth(dir, 1600).blocked('fable'), false);
});
test('a later-started success clears provider failures but never another model quota', () => {
  for (const kind of ['auth', 'spend', 'transient']) {
    const dir = mkdtempSync(join(tmpdir(), 'routing-provider-recovery-'));
    recordModelEvent(dir, { model: 'fable', kind, now: 1000, startedAt: 900 });
    recordModelEvent(dir, { model: 'opus', kind: 'success', now: 1300, startedAt: 1100 });
    assert.equal(readModelHealth(dir, 1400).blocked('fable'), false);
  }
  const dir = mkdtempSync(join(tmpdir(), 'routing-quota-isolation-'));
  recordModelEvent(dir, { model: 'fable', kind: 'limit', now: 1000 });
  recordModelEvent(dir, { model: 'opus', kind: 'success', now: 1300, startedAt: 1100 });
  assert.equal(readModelHealth(dir, 1400).blocked('fable'), true);
});
test('a dependent story cannot execute in the same parallel batch as its prerequisite', () => {
  const stories = [{ key: '2-1-a', files: ['src/a.ts'], deps: [] }, { key: '2-2-b', files: ['src/b.ts'], deps: ['2-1-a'] }];
  const dag = buildDag({ stories });
  const result = validatePlan({ batches: [{ stories: stories.map((s) => s.key), stages: ['dev'] }] }, dag, { batchMax: 3 });
  assert.ok(result.errors.some((e) => e.code === 'dep-order'));
});
test('duplicate sprint rows schedule a story once and keep the latest status', () => {
  const rows = parseSprint('  2-1-a: in-progress\n  2-2-b: backlog\n  2-1-a: review\n');
  assert.deepEqual(rows, [
    { key: '2-1-a', status: 'review', epic: 2 },
    { key: '2-2-b', status: 'backlog', epic: 2 },
  ]);
});
test('health failure details are redacted at the persistence boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-redact-'));
  recordModelEvent(dir, { model: 'fable', kind: 'auth', detail: 'Authorization: Bearer abcdefghijklmnop123456' });
  const file = readdirSync(join(dir, 'model-health'))[0];
  assert.ok(!readFileSync(join(dir, 'model-health', file), 'utf8').includes('abcdefghijklmnop123456'));
});
test('high-risk reviewer never falls to Opus/Sol/Terra; no same-provider self review', () => {
  assert.equal(selectModel({ role: 'review', risk: 7, avoid: 'opus', providers }).model, 'codex:gpt-6-astra');
  assert.equal(selectModel({ role: 'review', risk: 7, avoid: 'opus', providers,
    blocked: (m) => m === 'codex:gpt-6-astra' }), null);
  assert.equal(selectModel({ role: 'dev', risk: 7, providers, preferred: 'codex:gpt-6-astra' }).provider, 'claude');
});
test('six catalog models form three cross-provider quality pairs', () => {
  for (const [difficulty, risk, dev, review] of [[2, 0, 'sonnet', 'codex:gpt-5.6-terra'], [6, 0, 'opus', 'codex:gpt-5.6-sol'], [8, 6, 'fable', 'codex:gpt-6-astra']]) {
    assert.equal(selectModel({ role: 'dev', risk, difficulty, providers }).model, dev);
    assert.equal(selectModel({ role: 'review', risk, difficulty, providers, avoid: dev }).model, review);
  }
  assert.equal(Object.keys(MODEL_CATALOG).length, 6);
  assert.notEqual(selectModel({ preferred: 'sonnet', role: 'dev', difficulty: 8, providers }).model, 'sonnet');
});
test('Codex max=1 queues multiple review assignments without consuming an assignment budget', () => {
  const result = assignWorkers({ stories: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], providers,
    config: { models: { dev: 'fable', review: 'codex:gpt-6-astra' } } });
  assert.equal(result.filter((r) => r.reviewProvider === 'codex').length, 3);
});
test('unavailable providers do not get routed; empty scope does not qualify for cheap models', () => {
  const [unknown] = assignWorkers({ stories: [{ key: 'x' }], providers, config: { modelPolicy: { enabled: true } } });
  assert.ok(unknown.risk >= 4 && unknown.difficulty >= 8);
  assert.equal(unknown.dev, 'fable');
  assert.equal(selectModel({ providers: { claude: { enabled: false }, codex: { enabled: false } } }), null);
});
test('orchestrator cannot omit candidates, reduce stages, or assign identical dev/review models', async () => {
  const candidates = [{ key: 'a', stages: ['create', 'dev', 'review'] }];
  for (const batches of [[], [{ stories: ['a'], stages: ['dev'] }], [{ stories: ['a'], models: { dev: 'opus', review: 'opus' } }]]) {
    const result = await requestPlan({ context: { candidates, mode: 'full' }, deterministic: { batches: [{ stories: ['a'], stages: candidates[0].stages }] }, runner: () => ({ batches }) });
    assert.match(result.source, /deterministic-fallback\(contract:/);
    assert.deepEqual(result.plan.batches[0].stages, candidates[0].stages);
  }
});
test('guarded orchestration may choose a safe subset while full mode must cover all candidates', async () => {
  const candidates = [{ key: 'a', stages: ['dev'] }, { key: 'b', stages: ['dev'] }];
  const deterministic = { batches: candidates.map((c) => ({ stories: [c.key], stages: c.stages })) };
  const runner = () => ({ batches: [{ stories: ['a'], stages: ['dev'] }] });
  assert.equal((await requestPlan({ context: { candidates, mode: 'guarded' }, deterministic, runner })).source, 'fable');
  assert.match((await requestPlan({ context: { candidates, mode: 'full' }, deterministic, runner })).source, /missing-candidates/);
});
test('pinned runtime is selected ahead of global installation', () => {
  assert.match(asfCandidates('auto-story-pipeline.mjs')[0], /runtime[\\/]auto-story-pipeline\.mjs$/);
});
test('Codex reasoning effort reaches argv as a config value', () => {
  const cmd = buildCodexCommand({ cwd: tmpdir(), model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  assert.ok(cmd.argv.includes('gpt-5.6-sol'));
  assert.ok(cmd.argv.includes('model_reasoning_effort="high"'));
  assert.throws(() => buildCodexCommand({ cwd: tmpdir(), reasoningEffort: 'high; rm' }), /SPAWN-SAFE/);
});
test('provider-level exhaustion blocks every model from that provider', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-provider-exhausted-'));
  const router = new StageRouter({ stateDir, providers, exhausted: ['codex'] });
  assert.equal(router.choose({ role: 'review', risk: 0, difficulty: 2 }), null);
  const [assignment] = assignWorkers({ stories: [{ key: 'a', text: 'small', files: ['a.ts'] }], roles: ['review'], providers,
    config: { modelPolicy: { enabled: true }, exhaustedModels: ['codex'] } });
  assert.equal(assignment.review, '');
});
test('failure classification separates model errors, quotas, provider spending, and transport errors', () => {
  for (const [text, expected] of [['API Error: 401 unauthorized', 'auth'], ['spending limit reached', 'spend'],
    ['usage limit reached', 'limit'], ['429 too many requests', 'limit'], ['model fable not found', 'unavailable'],
    ['HTTP 404 backend-api/codex/responses', 'transient'], ['503 overloaded', 'transient']]) assert.equal(failureKind(text), expected);
});

test('limit downgrade policy (👤 2026-09-07): review never re-chooses on a usage limit; only recovery dev may relax to sonnet', () => {
  assert.equal(limitDowngradeMode({ stage: 'review', batchKind: 'closeout' }), 'block');
  assert.equal(limitDowngradeMode({ stage: 'review', batchKind: 'new' }), 'block');
  assert.equal(limitDowngradeMode({ stage: 'dev', batchKind: 'recovery' }), 'relax');
  assert.equal(limitDowngradeMode({ stage: 'dev', batchKind: 'new' }), 'floor');
  assert.equal(limitDowngradeMode({ stage: 'dev', batchKind: 'closeout' }), 'floor');
  for (const stage of ['create', 'replan', 'mockup']) assert.equal(limitDowngradeMode({ stage, batchKind: 'recovery' }), 'floor');
  // project config can widen or narrow the policy; unknown shapes fall back to the default
  assert.equal(limitDowngradeMode({ stage: 'review', policy: { review: true } }), 'floor');
  assert.equal(limitDowngradeMode({ stage: 'dev', batchKind: 'new', policy: { dev: { new: true } } }), 'relax');
  assert.equal(limitDowngradeMode({ stage: 'dev', batchKind: 'recovery', policy: { dev: { recovery: false } } }), 'floor');
  assert.equal(limitDowngradeMode({ stage: 'dev', batchKind: 'recovery', policy: 'garbage' }), 'relax');
});

test('limitRelief lowers the dev floor to sonnet but never the review floor', () => {
  const exclude = ['fable', 'opus'];
  assert.equal(selectModel({ role: 'dev', risk: 7, difficulty: 8, providers, exclude }), null);
  assert.equal(selectModel({ role: 'dev', risk: 7, difficulty: 8, providers, exclude, limitRelief: true }).model, 'sonnet');
  assert.equal(selectModel({ role: 'dev', risk: 0, difficulty: 6, providers, exclude, limitRelief: true }).model, 'sonnet');
  // review: high-risk floor stays tier 3, mid floor stays tier 2 — relief is ignored for the reviewer
  assert.equal(selectModel({ role: 'review', risk: 7, avoid: 'opus', providers, exclude: ['codex:gpt-6-astra'], limitRelief: true }), null);
  assert.equal(selectModel({ role: 'review', risk: 0, difficulty: 6, avoid: 'opus', providers, exclude: ['codex:gpt-5.6-sol', 'codex:gpt-6-astra'], limitRelief: true }), null);
  assert.equal(selectModel({ role: 'replan', risk: 7, providers, exclude, limitRelief: true }), null);
});

test('StageRouter.choose honours limitRelief on top of shared quota state', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-relief-'));
  const router = new StageRouter({ stateDir, providers });
  router.record('fable', 'limit', { role: 'dev' });
  router.record('opus', 'limit', { role: 'dev' });
  assert.equal(router.choose({ role: 'dev', risk: 7, difficulty: 8 }), null);
  assert.equal(router.choose({ role: 'dev', risk: 7, difficulty: 8, limitRelief: true }).model, 'sonnet');
  assert.equal(router.choose({ role: 'review', risk: 7, avoid: 'opus', attempted: ['codex:gpt-6-astra'], limitRelief: true }), null);
});

test('pipeline/runner source contract: the runner passes --batch-kind on both argv builders and the pipeline gates limit downgrades by it', () => {
  const runner = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8');
  assert.equal((runner.match(/'--batch-kind'/g) || []).length, 2, 'parallel + sequential builders');
  const pipe = readFileSync(new URL('./runtime/auto-story-pipeline.mjs', import.meta.url), 'utf8');
  assert.match(pipe, /opt\('batch-kind'/);
  assert.equal((pipe.match(/limitDowngradeMode\(\{ stage, batchKind/g) || []).length, 2, 'legacy runStage + routed stage');
  assert.match(pipe, /if \(mode === 'block'\) \{[\s\S]{0,400}process\.exit\(5\)/);
  // Sol-high 16 H1: legacy ladder and the boundary probe honour the same mode (floor = no sonnet · dev limit = claude only)
  assert.match(pipe, /nextWorkerSpec\(stage, story, avoid, limitMode\)/);
  assert.match(pipe, /const allowed = limitMode && stage === "dev" \? \["claude"\] : allowedProvidersFor\(stage\);/);
  assert.match(pipe, /const ladder = limitMode === "floor" \? MODEL_LADDER\.filter\(\(m\) => m !== "sonnet"\) : MODEL_LADDER;/);
  assert.match(pipe, /const probeMode = limitDowngradeMode\(\{ stage: "dev", batchKind/);
  assert.match(pipe, /nextModelDown\(models\.dev, null, probeLadder\)/);
});

test('codexDev (👤 2026-09-26 「astra·sol 을 더 써서 opus 사용량을 줄여줘」 (나)): sol 구현은 설정이 켜진 때만 · 리뷰는 codex 의 다른 모델(astra) · 같은 모델·claude 끼리는 여전히 금지', () => {
  const codexDev = { enabled: true, maxRisk: 10 };
  // 켜짐 — 고위험이라도 sol 구현 허용 · astra 는 dev 후보가 아니다(리뷰 몫)
  assert.equal(selectModel({ role: 'dev', risk: 8, difficulty: 8, providers, preferred: 'codex:gpt-5.6-sol', codexDev }).model, 'codex:gpt-5.6-sol');
  assert.equal(selectModel({ role: 'dev', risk: 8, difficulty: 8, providers, preferred: 'codex:gpt-6-astra', preferProvider: 'codex', codexDev }).model, 'codex:gpt-5.6-sol');
  // 상한 밖이면 Claude — maxRisk 는 존중된다
  assert.equal(selectModel({ role: 'dev', risk: 8, difficulty: 8, providers, preferred: 'codex:gpt-5.6-sol', codexDev: { enabled: true, maxRisk: 5 } }).provider, 'claude');
  // 리뷰 — sol 구현 뒤 astra(모델이 다르다) · astra 구현이면 고위험 리뷰 후보가 없다(null · 리뷰 품질 하한은 내려가지 않는다)
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-5.6-sol', codexDev }).model, 'codex:gpt-6-astra');
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-6-astra', codexDev }), null);
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-5.6-sol', preferred: 'codex:gpt-5.6-sol', codexDev }).model, 'codex:gpt-6-astra');
  // 꺼짐(기본) — 종전 경계: 고위험 codex dev 거부 · codex 구현 뒤 codex 리뷰 거부
  assert.equal(selectModel({ role: 'dev', risk: 8, difficulty: 8, providers, preferred: 'codex:gpt-5.6-sol' }).provider, 'claude');
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-5.6-sol' }), null);
  // 후보 목록 — 켜지면 dev 후보에 sol 이 들고(preferProvider codex 면 앞) · 꺼지면 Claude 만
  assert.deepEqual(modelCandidates({ role: 'dev', risk: 8, preferProvider: 'codex', codexDev }), ['codex:gpt-5.6-sol', 'fable', 'opus']);
  assert.deepEqual(modelCandidates({ role: 'dev', risk: 8, preferProvider: 'claude', codexDev }), ['fable', 'opus', 'codex:gpt-5.6-sol']);
  assert.deepEqual(modelCandidates({ role: 'dev', risk: 8, preferProvider: 'codex' }), ['fable', 'opus']);
  // 정책 정규화 — 잘못된 모델은 걸러지고 기본(sol)으로 · enabled 가 true 가 아니면 꺼짐
  assert.deepEqual(codexDevPolicy({ enabled: true, models: ['opus', 'nope'] }).models, ['codex:gpt-5.6-sol']);
  assert.equal(codexDevPolicy({ enabled: 'yes' }).enabled, false);
  assert.equal(codexDevPolicy(null).maxRisk, 3);
  // 라우터 — 한도로 sol 이 막히면 Claude 로 내려간다(배치가 서지 않는다)
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-codex-dev-'));
  let now = 1000;
  const router = new StageRouter({ stateDir, providers, codexDev, now: () => now });
  const ask = { role: 'dev', risk: 8, difficulty: 8, preferred: 'codex:gpt-5.6-sol', preferProvider: 'codex' };
  assert.equal(router.choose(ask).model, 'codex:gpt-5.6-sol');
  router.record('codex:gpt-5.6-sol', 'limit', { retryAt: 5000 });
  assert.equal(new StageRouter({ stateDir, providers, codexDev, now: () => now }).choose(ask).provider, 'claude');
  now = 5000;
  assert.equal(new StageRouter({ stateDir, providers, codexDev, now: () => now }).choose(ask).model, 'codex:gpt-5.6-sol');
  // 배정기(정책 경로) — codexDev 가 켜지면 범위 미상(고위험 취급) 스토리도 sol/astra 짝
  const [a] = assignWorkers({ stories: [{ key: 'x' }], providers, config: { modelPolicy: { enabled: true, codexDev } } });
  assert.deepEqual([a.dev, a.review], ['codex:gpt-5.6-sol', 'codex:gpt-6-astra']);
});

test('codexDev.review (👤 2026-09-26 20:5x 「opus 를 astra 로 대체 · astra 하던 일을 opus 가」): astra 구현 → opus 리뷰 · 고위험이라도 opus 리뷰 허용 · Claude 구현 스토리는 종전대로 codex 리뷰', () => {
  const codexDev = { enabled: true, maxRisk: 10, models: ['codex:gpt-6-astra'], review: 'opus' };
  assert.deepEqual(codexDevPolicy(codexDev).models, ['codex:gpt-6-astra']);
  assert.equal(codexDevPolicy(codexDev).review, 'opus');
  assert.equal(codexDevPolicy({ enabled: true, review: 'codex:gpt-6-astra' }).review, '', 'review 는 Claude 모델만');
  // dev — 고위험이라도 astra
  assert.equal(selectModel({ role: 'dev', risk: 8, difficulty: 8, providers, preferred: 'codex:gpt-6-astra', codexDev }).model, 'codex:gpt-6-astra');
  // review — astra 구현 뒤 opus(tier 2)가 고위험 하한(3) 예외로 통과 · 후보 목록은 [opus, astra]
  assert.deepEqual(modelCandidates({ role: 'review', risk: 8, codexDev, avoid: 'codex:gpt-6-astra' }), ['opus', 'codex:gpt-6-astra']);
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-6-astra', preferred: 'opus', codexDev }).model, 'opus');
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-6-astra', codexDev }).model, 'opus');
  // Claude(opus) 가 구현한 스토리(마감 재검수 등)는 opus 리뷰가 아니라 codex(astra) — 예외는 Codex 구현에만
  assert.deepEqual(modelCandidates({ role: 'review', risk: 8, codexDev, avoid: 'opus' }), ['codex:gpt-6-astra']);
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'opus', preferred: 'opus', codexDev }).model, 'codex:gpt-6-astra');
  // sonnet 처럼 하한 밖 Claude 모델을 review 로 적어도 그 모델까지만 내려간다 — 다른 Claude 모델은 종전 하한
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-6-astra', preferred: 'sonnet', codexDev }).model, 'opus');
  // review 를 비우면 종전(나) 규칙 — codex 의 다른 모델
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'codex:gpt-5.6-sol', codexDev: { enabled: true, maxRisk: 10 } }).model, 'codex:gpt-6-astra');
  // 라우터 — opus 가 한도면 review 는 astra(같은 모델)를 못 쓰니 null(리셋 대기 · 품질을 깎지 않는다)
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-codex-dev-review-'));
  const router = new StageRouter({ stateDir, providers, codexDev, now: () => 1000 });
  assert.equal(router.choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'codex:gpt-6-astra', preferred: 'opus' }).model, 'opus');
  router.record('opus', 'limit', { retryAt: 5000 });
  assert.equal(new StageRouter({ stateDir, providers, codexDev, now: () => 1000 }).choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'codex:gpt-6-astra', preferred: 'opus' }), null);
  // 배정기(정책 경로) — astra/opus 짝
  const [a] = assignWorkers({ stories: [{ key: 'x' }], providers, config: { modelPolicy: { enabled: true, codexDev } } });
  assert.deepEqual([a.dev, a.review], ['codex:gpt-6-astra', 'opus']);
});

test('codexDev maxRisk -1 은 새 Codex 구현을 0건으로 만들고 교차 검토 설정은 남긴다', () => {
  const off = codexDevPolicy({ enabled: true, maxRisk: -1, models: ['codex:gpt-5.6-sol'], review: 'opus' });
  assert.equal(off.enabled, true);
  assert.equal(off.maxRisk, -1);
  assert.equal(off.review, 'opus');
  for (const risk of [0, 1, 3, 10]) {
    const dev = modelCandidates({ role: 'dev', risk, difficulty: 3, preferProvider: 'claude', codexDev: { enabled: true, maxRisk: -1, models: ['codex:gpt-5.6-sol'], review: 'opus' } });
    assert.ok(!dev.includes('codex:gpt-5.6-sol') || MODEL_CATALOG[dev[0]].provider === 'claude', `위험도 ${risk} 의 첫 구현 후보는 Claude 여야 한다`);
  }
  // 범위 밖 값은 잘라 낸다
  assert.equal(codexDevPolicy({ enabled: true, maxRisk: -5, models: ['codex:gpt-5.6-sol'] }).maxRisk, -1);
  assert.equal(codexDevPolicy({ enabled: true, maxRisk: 99, models: ['codex:gpt-5.6-sol'] }).maxRisk, 10);
});

test('reviewMinTier (👤 2026-10-21 「위험도 높은 스토리 검토도 sol로」): 기본 = astra 유지 · 2 = sol 먼저 · sol 막히면 astra · 위험도 4 미만은 불변', () => {
  const base = { role: 'review', risk: 8, difficulty: 8, avoid: 'opus', providers };
  // 기본(키 없음·범위 밖 값) — 종전과 같이 astra 만
  assert.deepEqual(modelCandidates({ role: 'review', risk: 8, difficulty: 8 }), ['codex:gpt-6-astra']);
  assert.equal(selectModel(base).model, 'codex:gpt-6-astra');
  assert.equal(selectModel({ ...base, preferred: 'codex:gpt-5.6-sol' }).model, 'codex:gpt-6-astra');
  assert.equal(selectModel({ ...base, preferred: 'codex:gpt-5.6-sol', reviewMinTier: 9 }).model, 'codex:gpt-6-astra');
  // 2 — sol 먼저, 선호 sol 그대로, sol 이 막히면 astra
  assert.deepEqual(modelCandidates({ role: 'review', risk: 8, difficulty: 8, reviewMinTier: 2 }), ['codex:gpt-5.6-sol', 'codex:gpt-6-astra']);
  assert.equal(selectModel({ ...base, reviewMinTier: 2 }).model, 'codex:gpt-5.6-sol');
  assert.equal(selectModel({ ...base, reviewMinTier: 2, preferred: 'codex:gpt-5.6-sol' }).model, 'codex:gpt-5.6-sol');
  assert.equal(selectModel({ ...base, reviewMinTier: 2, blocked: (m) => m === 'codex:gpt-5.6-sol' }).model, 'codex:gpt-6-astra');
  // 위험도 4 미만은 설정과 무관하게 같다
  for (const difficulty of [2, 8]) {
    const lowRisk = { role: 'review', risk: 2, difficulty };
    assert.deepEqual(modelCandidates({ ...lowRisk, reviewMinTier: 2 }), modelCandidates(lowRisk));
    assert.equal(selectModel({ ...lowRisk, avoid: 'opus', providers, reviewMinTier: 2 })?.model, selectModel({ ...lowRisk, avoid: 'opus', providers })?.model);
  }
  // 교차검증 불변 — 구현이 sol 이면 sol 검토 금지
  const codexDev = { enabled: true, maxRisk: 10, models: ['codex:gpt-5.6-sol'] };
  assert.equal(selectModel({ ...base, avoid: 'codex:gpt-5.6-sol', codexDev, reviewMinTier: 2, preferred: 'codex:gpt-5.6-sol' }).model, 'codex:gpt-6-astra');
  // 러너(StageRouter)·배정기(정책 경로)도 같은 설정을 따른다
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-review-tier-'));
  assert.equal(new StageRouter({ stateDir, providers }).choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus' }).model, 'codex:gpt-6-astra');
  assert.equal(new StageRouter({ stateDir, providers, reviewMinTier: 2 }).choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus' }).model, 'codex:gpt-5.6-sol');
  const [a] = assignWorkers({ stories: [{ key: 'x' }], providers, config: { modelPolicy: { enabled: true, reviewMinTier: 2 } } });
  assert.equal(a.review, 'codex:gpt-5.6-sol');
  const [b] = assignWorkers({ stories: [{ key: 'x' }], providers, config: { modelPolicy: { enabled: true } } });
  assert.equal(b.review, 'codex:gpt-6-astra');
});

test('순차 경로(수동 큐)도 배치 models 지정을 라우터 선호로 넘긴다 — 2026-11-12 7-23 (sol 구현 · astra 중지 · review=opus) exit 5 회귀', () => {
  // ① 표식 규칙: 정책이 켜져 있고 배치에 models 지정이 있을 때만 붙는다(지정 없음 = 종전 명령줄 그대로).
  assert.deepEqual(sequentialPolicyFlags({ enabled: true }, { review: 'opus' }), ['--policy-assigned']);
  assert.deepEqual(sequentialPolicyFlags({ enabled: true }, {}), []);
  assert.deepEqual(sequentialPolicyFlags({ enabled: true }, { review: '' }), []);
  assert.deepEqual(sequentialPolicyFlags({ enabled: true }, undefined), []);
  assert.deepEqual(sequentialPolicyFlags({ enabled: false }, { review: 'opus' }), []);
  assert.deepEqual(sequentialPolicyFlags(undefined, { review: 'opus' }), []);
  // ② 배선: 순차 builder 가 그 표식을 붙이고, 파이프라인은 표식이 있을 때 지정 모델을 선호로 쓴다.
  const runner = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8');
  assert.match(runner, /args\.push\(\.\.\.routingFlags\(\), \.\.\.sequentialPolicyFlags\(CFG\.modelPolicy, batch\.models\)\)/);
  assert.match(runner, /a\.push\(\.\.\.routingFlags\(\), \.\.\.\(CFG\.modelPolicy\?\.enabled \? \['--policy-assigned'\] : \[\]\)\)/, '병렬 경로 불변');
  const pipe = readFileSync(new URL('./runtime/auto-story-pipeline.mjs', import.meta.url), 'utf8');
  assert.match(pipe, /let preferred = flag\('policy-assigned'\) \? models\[stage\] :/);
  // ③ 실사고 재현: sol 이 구현 · astra 소진(👤 11-09 중지) · codexDev 꺼짐 — 선호가 비면 검토자 0, opus 를 넘기면 opus.
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-seq-policy-'));
  const router = new StageRouter({ stateDir, providers, exhausted: ['codex:gpt-6-astra'], reviewMinTier: 2 });
  for (const risk of [2, 6]) {
    const base = { role: 'review', risk, difficulty: 5, avoid: 'codex:gpt-5.6-sol', preferProvider: 'claude' };
    assert.equal(router.choose({ ...base, preferred: '' }), null, `위험도 ${risk}: 지정이 빠지면 고를 모델 없음(종전 증상)`);
    assert.equal(router.choose({ ...base, preferred: 'opus' })?.model, 'opus', `위험도 ${risk}: 지정 opus 가 교차 검토자로 골라진다`);
  }
});

// ── modelPolicy.claudeCross (👤 2026-11-18 「코덱스 주간 한도 소진 · 코덱스 사용은 중단하고 fable 로 대체」) ──
const CC = { enabled: true, review: 'fable', dev: ['opus', 'sonnet'] };
const codexOff = { claude: { enabled: true, max: 2 }, codex: { enabled: false, max: 1, roles: ['review'] } };
const ccManifest = ({ dev = 'opus', rev = 'fable', policy = CC, review = {} } = {}) => ({
  story: 'x', workers: { dev: { provider: 'claude', model: dev } },
  ...(policy ? { reviewPolicy: { claudeCross: claudeCrossPolicy(policy) } } : {}),
  review: { provider: 'claude', model: rev, result: 'clean', counts: { patch: 0, decision: 0, high: 0 }, readEvidence: ['story.md', 'diff.txt', 'a.py'], ...review },
});

test('claudeCross 정책 정규화 — 켜진 때만 · 검토 모델은 Claude · dev 목록은 검토 모델보다 낮은 등급의 Claude 모델만', () => {
  assert.deepEqual(claudeCrossPolicy(CC), { enabled: true, review: 'fable', dev: ['opus', 'sonnet'] });
  assert.equal(claudeCrossPolicy(null).enabled, false);
  assert.equal(claudeCrossPolicy({ ...CC, enabled: 'yes' }).enabled, false);
  assert.equal(claudeCrossPolicy({ ...CC, enabled: false }).enabled, false);
  assert.equal(claudeCrossPolicy({ enabled: true, review: 'codex:gpt-6-astra', dev: ['opus'] }).enabled, false, '검토 모델은 Claude 만');
  assert.equal(claudeCrossPolicy({ enabled: true, review: 'fable', dev: [] }).enabled, false, 'dev 목록이 비면 꺼짐');
  assert.deepEqual(claudeCrossPolicy({ enabled: true, review: 'fable', dev: ['fable', 'opus', 'codex:gpt-5.6-sol', 'nope'] }).dev, ['opus'], '같은 모델·codex·모르는 모델은 걸러진다');
  assert.equal(claudeCrossPolicy({ enabled: true, review: 'opus', dev: ['fable', 'opus'] }).enabled, false, '더 낮은 모델이 높은 모델을 검토하는 짝은 만들 수 없다');
  // 짝 판정
  assert.equal(claudePairCross(CC, 'opus', 'fable'), true);
  assert.equal(claudePairCross(CC, 'sonnet', 'fable'), true);
  assert.equal(claudePairCross(CC, 'opus', 'opus'), false, '같은 모델');
  assert.equal(claudePairCross(CC, 'fable', 'fable'), false);
  assert.equal(claudePairCross(CC, 'fable', 'opus'), false, '거꾸로 짝(fable 구현 → opus 검토)은 예외가 아니다');
  assert.equal(claudePairCross(CC, 'opus', 'sonnet'), false, '검토 모델이 지정 모델이 아니다');
  assert.equal(claudePairCross(CC, '', 'fable'), false, '구현 모델 기록 누락');
  assert.equal(claudePairCross(CC, 'opus', ''), false, '검토 모델 기록 누락');
  assert.equal(claudePairCross(CC, 'cli-default', 'fable'), false);
  assert.equal(claudePairCross(null, 'opus', 'fable'), false, '설정 없음');
  assert.equal(claudePairCross({ ...CC, enabled: false }, 'opus', 'fable'), false, '설정 꺼짐');
});

test('claudeCross 정상: opus·sonnet 구현 → fable 검토가 골라진다(고위험 tier 3 하한을 내리지 않고 만족) · fable 은 구현하지 않는다', () => {
  assert.equal(MODEL_CATALOG.fable.tier, 3, 'fable = 최상위 Claude — 고위험 검토 하한(tier 3)을 그대로 만족');
  for (const [risk, difficulty] of [[8, 8], [4, 8], [2, 6], [0, 2]]) {
    for (const dev of ['opus', 'sonnet']) {
      const r = selectModel({ role: 'review', risk, difficulty, providers: codexOff, avoid: dev, claudeCross: CC });
      assert.equal(r?.model, 'fable', `위험 ${risk}: ${dev} 구현 → fable 검토`);
    }
  }
  assert.deepEqual(modelCandidates({ role: 'review', risk: 8, avoid: 'opus', claudeCross: CC }), ['fable', 'codex:gpt-6-astra']);
  // 구현: fable 선호(고위험 기본)여도 dev 목록 안에서만 — 검토할 눈을 남긴다
  assert.equal(selectModel({ role: 'dev', risk: 8, difficulty: 8, providers: codexOff, preferred: 'fable', claudeCross: CC }).model, 'opus');
  assert.deepEqual(modelCandidates({ role: 'dev', risk: 8, claudeCross: CC }), ['opus']);
  assert.equal(selectModel({ role: 'dev', risk: 0, difficulty: 2, providers: codexOff, claudeCross: CC }).model, 'sonnet');
  assert.equal(selectModel({ role: 'dev', risk: 8, difficulty: 8, providers: codexOff, claudeCross: CC, blocked: (m) => m === 'opus' }), null, 'opus 불가 시 fable 로 구현하지 않는다(보류)');
  // 계획 단계(create·replan·mockup)는 건드리지 않는다
  assert.equal(selectModel({ role: 'replan', risk: 4, difficulty: 8, providers: codexOff, preferred: 'fable', claudeCross: CC }).model, 'fable');
  // 배정기(정책 경로)도 같은 짝
  const [a] = assignWorkers({ stories: [{ key: 'x' }], providers: codexOff, config: { modelPolicy: { enabled: true, claudeCross: CC } } });
  assert.equal(a.dev, 'opus'); assert.equal(a.review, 'fable');
});

test('claudeCross 실패: 같은 모델끼리는 미달 · 설정이 없거나 꺼져 있으면 종전과 같다 · fable 불가면 다른 Claude 로 내려가지 않고 대기', () => {
  const ask = { role: 'review', risk: 8, difficulty: 8, providers: codexOff, avoid: 'opus' };
  // opus → opus 는 지정해도 고르지 않는다
  assert.equal(selectModel({ ...ask, preferred: 'opus', claudeCross: CC }).model, 'fable');
  assert.equal(selectModel({ ...ask, preferred: 'opus', claudeCross: CC, blocked: (m) => m === 'fable' }), null, 'fable 불가 → opus 자기 검토 금지(대기)');
  assert.equal(selectModel({ ...ask, preferred: 'sonnet', claudeCross: CC, blocked: (m) => m === 'fable' }), null, 'fable 불가 → sonnet 으로도 내려가지 않는다');
  assert.equal(selectModel({ ...ask, claudeCross: CC, exclude: ['fable'] }), null, 'exhaustedModels 에 fable → 대기');
  // 설정 없음·꺼짐 = 종전(claude 끼리 금지)
  assert.equal(selectModel({ ...ask }), null);
  assert.equal(selectModel({ ...ask, preferred: 'fable' }), null);
  assert.equal(selectModel({ ...ask, preferred: 'fable', claudeCross: { ...CC, enabled: false } }), null);
  for (const role of ['dev', 'review', 'create']) for (const risk of [0, 4, 8]) for (const difficulty of [2, 8]) for (const avoid of ['', 'opus', 'fable', 'codex:gpt-5.6-sol']) {
    const q = { role, risk, difficulty, avoid };
    assert.deepEqual(modelCandidates({ ...q, claudeCross: null }), modelCandidates(q));
    assert.deepEqual(modelCandidates({ ...q, claudeCross: { ...CC, enabled: false } }), modelCandidates(q));
    assert.deepEqual(selectModel({ ...q, providers, claudeCross: { ...CC, enabled: false } }), selectModel({ ...q, providers }));
  }
  // codex 가 켜져 있는 종전 구성은 설정이 없으면 그대로 codex 검토
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers, avoid: 'opus' }).model, 'codex:gpt-6-astra');
  // 라우터: fable 한도 기록 → 다른 러너도 검토자를 고르지 못한다(리뷰 대기)
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-claude-cross-'));
  const router = new StageRouter({ stateDir, providers: codexOff, claudeCross: CC, now: () => 1000 });
  assert.equal(router.choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus' }).model, 'fable');
  router.record('fable', 'limit', { retryAt: 9000 });
  assert.equal(new StageRouter({ stateDir, providers: codexOff, claudeCross: CC, now: () => 1000 }).choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus', preferred: 'opus' }), null);
  assert.equal(new StageRouter({ stateDir: mkdtempSync(join(tmpdir(), 'routing-claude-cross-')), providers: codexOff, claudeCross: CC, exhausted: ['fable'] }).choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus' }), null);
  assert.equal(limitDowngradeMode({ stage: 'review', batchKind: 'new' }), 'block', '검토 한도 = 강등 없이 대기(불변)');
});

test('claudeCross 경계: dev 목록 밖 구현 모델(fable·codex·미상)은 예외가 아니다 · 검토 하한은 내려가지 않는다', () => {
  const base = { role: 'review', risk: 8, difficulty: 8, providers: codexOff, claudeCross: CC };
  assert.equal(selectModel({ ...base, avoid: 'fable' }), null, 'fable 구현분은 Claude 가 검토하지 못한다');
  assert.equal(selectModel({ ...base, avoid: 'fable', preferred: 'opus' }), null);
  assert.deepEqual(modelCandidates({ role: 'review', risk: 8, avoid: 'fable', claudeCross: CC }), ['codex:gpt-6-astra']);
  assert.equal(selectModel({ ...base, avoid: 'opus', claudeCross: { enabled: true, review: 'fable', dev: ['sonnet'] } }), null, 'opus 가 목록에 없으면 opus 구현분은 대기');
  assert.equal(selectModel({ ...base, avoid: 'codex:gpt-5.6-sol' }), null, 'codex 구현분은 이 예외와 무관(codex 꺼짐 → 대기)');
  // 검토 모델을 opus 로 적어도 고위험(tier 3) 하한은 그대로 — 저위험만 opus 검토
  const low = { enabled: true, review: 'opus', dev: ['sonnet'] };
  assert.equal(selectModel({ role: 'review', risk: 8, difficulty: 8, providers: codexOff, avoid: 'sonnet', claudeCross: low }), null);
  assert.equal(selectModel({ role: 'review', risk: 2, difficulty: 2, providers: codexOff, avoid: 'sonnet', claudeCross: low }).model, 'opus');
});

test('claudeCross + 환경값 사다리(AUTO_MODEL_LADDER=opus,sonnet): 지정 검토 모델만 review 역할에서 사다리 예외 — 구현·계획은 사다리 그대로', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routing-claude-cross-ladder-'));
  const ladder = ['opus', 'sonnet'];
  const on = new StageRouter({ stateDir, providers: codexOff, claudeLadder: ladder, claudeCross: CC });
  assert.equal(on.choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus' }).model, 'fable');
  assert.equal(on.choose({ role: 'dev', risk: 8, difficulty: 8, preferred: 'fable' }).model, 'opus');
  assert.equal(on.choose({ role: 'replan', risk: 4, difficulty: 8, preferred: 'fable' }).model, 'opus', '계획 단계의 fable 은 사다리가 계속 막는다');
  assert.equal(on.choose({ role: 'create', risk: 4, difficulty: 8, preferred: 'fable' }).model, 'opus');
  // 설정이 없으면 종전: 사다리가 fable 을 막아 검토자 0
  assert.equal(new StageRouter({ stateDir, providers: codexOff, claudeLadder: ladder }).choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus', preferred: 'fable' }), null);
  assert.equal(new StageRouter({ stateDir, providers: codexOff, claudeLadder: ladder, claudeCross: { ...CC, enabled: false } }).choose({ role: 'review', risk: 8, difficulty: 8, avoid: 'opus', preferred: 'fable' }), null);
});

test('claudeCross 완료 판정(T6): opus→fable + 열람 증거면 통과 · 같은 모델·설정 기록 없음·목록 밖·증거 미달은 미달(completion-rules 와 readiness 가 같은 잣대)', () => {
  const t6 = (m) => taskReadiness({ manifest: m }).criteria.find((c) => c.id === 'T6').result;
  const both = (m, want, why) => { assert.equal(crossReviewResult(m)[0], want, why); assert.equal(t6(m), want, `readiness: ${why}`); };
  both(ccManifest(), 'pass', 'opus 구현 → fable 검토');
  both(ccManifest({ dev: 'sonnet' }), 'pass', 'sonnet 구현 → fable 검토');
  both(ccManifest({ dev: 'opus', rev: 'opus' }), 'fail', '같은 모델');
  both(ccManifest({ dev: 'fable', rev: 'fable' }), 'fail', '같은 모델(fable)');
  both(ccManifest({ dev: 'fable', rev: 'opus' }), 'fail', '거꾸로 짝');
  both(ccManifest({ policy: null }), 'fail', '매니페스트에 설정 기록이 없으면 종전대로 미달');
  both(ccManifest({ policy: { ...CC, enabled: false } }), 'fail', '설정 꺼짐');
  both(ccManifest({ dev: '' }), 'fail', '구현 모델 기록 누락');
  both(ccManifest({ dev: 'cli-default' }), 'fail', '구현 모델 미상');
  both(ccManifest({ rev: 'cli-default' }), 'fail', '검토 모델 미상');
  both(ccManifest({ policy: { enabled: true, review: 'fable', dev: ['sonnet'] } }), 'fail', 'dev 목록 밖(opus)');
  // 열람 증거 요건은 그대로다
  both(ccManifest({ review: { result: 'not-run(missing read evidence)', readEvidence: ['story.md'] } }), 'not-verified', '열람 근거 미달 = 검토를 안 돌린 것');
  both(ccManifest({ review: { readEvidence: [] } }), 'fail', '열람 증거 0건');
  both(ccManifest({ review: { counts: { patch: 1, decision: 0, high: 1 } } }), 'fail', '높음 지적 잔존');
  // 종전 짝은 불변
  const codexRev = { story: 'x', workers: { dev: { provider: 'claude', model: 'opus' } }, review: { provider: 'codex', model: 'gpt-6-astra', result: 'clean', counts: { high: 0 }, readEvidence: ['a'] } };
  both(codexRev, 'pass', 'claude 구현 → codex 검토(종전)');
});

test('claudeCross 배선: 파이프라인 REVIEW STOP · 라우터 · 매니페스트 표식 · 편성기 기본 짝 · Claude 검토의 열람 증거 판정 불변', () => {
  const pipe = readFileSync(new URL('./runtime/auto-story-pipeline.mjs', import.meta.url), 'utf8');
  assert.match(pipe, /claudePairCross\(routingConfig\.modelPolicy\?\.claudeCross, devSpecForCross\.model, spec\.model\)/);
  assert.match(pipe, /spec\.provider === devSpecForCross\.provider && !codexCrossOk && !claudeCrossOk\)/);
  assert.match(pipe, /claudeCross: routingConfig\.modelPolicy\?\.claudeCross \?\? null/);
  assert.match(pipe, /if \(cc\.enabled\) m\.reviewPolicy = \{ claudeCross: cc \}/);
  // 증거 요건: Claude 검토는 stream-json 으로 돌고, 필수 입력을 전부 Read 해야만 verified
  assert.match(pipe, /stream: role === "review"/);
  assert.match(pipe, /const verified = required\.length > 1 && readEvidence\.length === required\.length;/);
  assert.match(pipe, /verified \? counts\.patch \+ counts\.decision \? 'findings' : 'clean' : 'not-run\(missing read evidence\)'/);
  const planner = readFileSync(new URL('./plan-queue.mjs', import.meta.url), 'utf8');
  assert.match(planner, /cc\.enabled \? \(kind === 'closeout' \? \{ review: cc\.review \} : \{ dev: cc\.dev\[0\], review: cc\.review \}\)/);
});
