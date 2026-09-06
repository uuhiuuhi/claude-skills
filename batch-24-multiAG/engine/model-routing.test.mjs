import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageRouter } from './runtime/stage-router.mjs';
import { failureKind, limitDowngradeMode, selectModel, MODEL_CATALOG } from './runtime/model-policy.mjs';
import { recordModelEvent, readModelHealth } from './runtime/model-health.mjs';
import { assignWorkers } from './assign.mjs';
import { requestPlan } from './orchestrate.mjs';
import { asfCandidates } from './asf-resolve.mjs';
import { buildCodexCommand } from './runtime/providers/codex.mjs';
import { buildDag, validatePlan } from './plan-dag.mjs';
import { parseSprint } from './story-ledger.mjs';

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
