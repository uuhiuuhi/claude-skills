import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeUsage, usageBlocks, applyUsageToHealth, reclassifySpend, fetchClaudeUsage, usageLine,
  writeUsageSnapshot, readUsageSnapshot, probeUsage, readOauthToken, CLAUDE_MODELS,
} from './runtime/usage-probe.mjs';
import { readModelHealth } from './runtime/model-health.mjs';
import { StageRouter } from './runtime/stage-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-09-08T21:50:00Z'); // 2026-09-09 06:50 KST — 실사고 시각
const SESSION_RESET = '2026-09-08T22:00:00.046291+00:00';
const WEEKLY_RESET = '2026-09-13T17:00:00.046321+00:00';

/** 2026-09-09 06:4x 실측 응답(값만 · 토큰 없음): 세션 51 · 주간 52 · Fable 모델별 100(active) · 크레딧 $206.65/$200 소진. */
const PAYLOAD = () => ({
  five_hour: { utilization: 51.0, resets_at: SESSION_RESET },
  seven_day: { utilization: 52.0, resets_at: WEEKLY_RESET },
  extra_usage: { is_enabled: false, monthly_limit: 20000, used_credits: 20665.0, utilization: 100.0, currency: 'USD', decimal_places: 2, disabled_reason: 'org_level_disabled_until', spend_limit_reached: true, credits_ever_enabled: true },
  limits: [
    { kind: 'session', group: 'session', percent: 51, severity: 'normal', resets_at: SESSION_RESET, scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 52, severity: 'normal', resets_at: WEEKLY_RESET, scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 100, severity: 'critical', resets_at: WEEKLY_RESET, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
  ],
});
const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-FOR-TESTS-0123456789abcdef';

test('normalizeUsage: 세션·주간·모델별(Fable)·크레딧을 각각 읽는다', () => {
  const u = normalizeUsage(PAYLOAD(), NOW);
  assert.equal(u.fiveHour.pct, 51);
  assert.equal(u.fiveHour.resetsAt, Date.parse(SESSION_RESET));
  assert.equal(u.sevenDay.pct, 52);
  assert.deepEqual(u.scoped.map((s) => [s.model, s.pct, s.active]), [['fable', 100, true]]);
  assert.equal(u.extraUsage.reached, true);
  assert.equal(u.extraUsage.enabled, false);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}).fiveHour.pct, null, '없는 값은 null 이다 — 0 으로 꾸미지 않는다');
});

test('usageBlocks: 모델별 한도는 그 모델만 · 크레딧 소진은 차단 사유가 아니다', () => {
  const blocks = usageBlocks(normalizeUsage(PAYLOAD(), NOW), { now: NOW });
  assert.deepEqual(blocks.map((b) => b.model), ['fable']);
  assert.equal(blocks[0].retryAt, Date.parse(WEEKLY_RESET));
  assert.match(blocks[0].reason, /fable 주간 모델별 100%/);
});

test('usageBlocks: 세션 100% 는 Claude 전 모델을 세션 리셋까지 막는다(모델별 한도가 더 늦으면 그 시각)', () => {
  const p = PAYLOAD();
  p.limits[0].percent = 100;
  const blocks = usageBlocks(normalizeUsage(p, NOW), { now: NOW });
  assert.deepEqual(blocks.map((b) => b.model).sort(), [...CLAUDE_MODELS].sort());
  const opus = blocks.find((b) => b.model === 'opus');
  const fable = blocks.find((b) => b.model === 'fable');
  assert.equal(opus.retryAt, Date.parse(SESSION_RESET));
  assert.equal(fable.retryAt, Date.parse(WEEKLY_RESET), '둘 다 풀려야 하므로 더 늦은 리셋');
});

test('usageBlocks: 이미 지난 리셋 시각은 막지 않는다 · 사용량 없음은 빈 목록', () => {
  const p = PAYLOAD();
  p.limits[2].resets_at = '2026-09-08T00:00:00Z';
  assert.deepEqual(usageBlocks(normalizeUsage(p, NOW), { now: NOW }), []);
  assert.deepEqual(usageBlocks(null), []);
});

test('applyUsageToHealth → model-health limit(모델 스코프) → 라우터가 fable 을 건너 opus 를 고른다(review 는 codex 유지)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'usage-probe-'));
  const events = applyUsageToHealth(stateDir, normalizeUsage(PAYLOAD(), NOW), { now: NOW });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'limit');
  assert.equal(events[0].scope, 'fable', 'spend(프로바이더 스코프)가 아니라 모델 스코프');
  assert.equal(events[0].retryAt, Date.parse(WEEKLY_RESET));
  assert.doesNotMatch(events[0].detail, /sk-ant|Bearer/);
  const health = readModelHealth(stateDir, NOW + 60_000);
  assert.equal(health.blocked('fable'), true);
  assert.equal(health.blocked('opus'), false);
  const providers = { claude: { enabled: true, available: true, max: 4 }, codex: { enabled: true, available: true, max: 3, roles: ['review', 'dev'] } };
  const router = new StageRouter({ stateDir, providers, exhausted: [], now: () => NOW + 60_000 });
  assert.equal(router.choose({ role: 'dev', risk: 10, difficulty: 10, preferred: 'fable' }).model, 'opus');
  assert.equal(router.choose({ role: 'review', risk: 10, difficulty: 10, preferred: 'fable', avoid: 'opus' }).model, 'codex:gpt-6-astra');
  // 리셋이 지나면 fable 이 돌아온다
  assert.equal(readModelHealth(stateDir, Date.parse(WEEKLY_RESET) + 1).blocked('fable'), false);
});

test('reclassifySpend: 「spend limit」 문구 + 스냅샷의 모델별 한도 → limit(리셋 시각) · 증언 없으면 null(진짜 spend)', () => {
  const u = normalizeUsage(PAYLOAD(), NOW);
  const r = reclassifySpend(u, 'fable', NOW);
  assert.equal(r.kind, 'limit');
  assert.equal(r.retryAt, Date.parse(WEEKLY_RESET));
  assert.equal(reclassifySpend(u, 'opus', NOW), null, 'opus 는 플랜 한도 증언이 없다 — 종전 spend');
  assert.equal(reclassifySpend(null, 'fable', NOW), null, '스냅샷 없음 → 종전 spend');
});

test('snapshot: 쓰고 읽는다 · 45분 넘게 낡으면 null', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'usage-snap-'));
  const u = normalizeUsage(PAYLOAD(), NOW);
  const file = writeUsageSnapshot(stateDir, u);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /sk-ant|Bearer|accessToken/);
  assert.equal(readUsageSnapshot(stateDir, { now: NOW + 10 * 60_000 }).fiveHour.pct, 51);
  assert.equal(readUsageSnapshot(stateDir, { now: NOW + 46 * 60_000 }), null);
  assert.equal(readUsageSnapshot(null), null);
});

test('fetchClaudeUsage: Bearer 헤더로만 보내고 실패는 전부 null · 토큰이 결과에 실리지 않는다', async () => {
  let seen = null;
  const okFetch = async (url, init) => { seen = { url, auth: init.headers.Authorization, beta: init.headers['anthropic-beta'] }; return { status: 200, json: async () => PAYLOAD() }; };
  const u = await fetchClaudeUsage({ token: FAKE_TOKEN, fetchImpl: okFetch, now: NOW });
  assert.equal(u.scoped[0].model, 'fable');
  assert.equal(seen.auth, `Bearer ${FAKE_TOKEN}`);
  assert.equal(seen.beta, 'oauth-2025-04-20');
  assert.doesNotMatch(JSON.stringify(u), new RegExp(FAKE_TOKEN));
  assert.equal(await fetchClaudeUsage({ token: FAKE_TOKEN, fetchImpl: async () => ({ status: 401, json: async () => ({}) }) }), null);
  assert.equal(await fetchClaudeUsage({ token: FAKE_TOKEN, fetchImpl: async () => { throw new Error('boom'); } }), null);
  assert.equal(await fetchClaudeUsage({ token: null, fetchImpl: okFetch }), null, '토큰 없으면 호출하지 않는다');
});

test('probeUsage: 조회 → 스냅샷 → health 한 번에 · 비활성/실패는 빈 결과', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'usage-probe-all-'));
  const r = await probeUsage({ stateDir, token: FAKE_TOKEN, fetchImpl: async () => ({ status: 200, json: async () => PAYLOAD() }), now: NOW });
  assert.deepEqual(r.blocks.map((b) => b.model), ['fable']);
  assert.equal(readUsageSnapshot(stateDir, { now: NOW }).sevenDay.pct, 52);
  assert.equal(readModelHealth(stateDir, NOW + 1).blocked('fable'), true);
  assert.deepEqual(await probeUsage({ stateDir, enabled: false }), { usage: null, blocks: [], skipped: true });
  assert.deepEqual(await probeUsage({ stateDir, token: FAKE_TOKEN, fetchImpl: async () => { throw new Error('offline'); } }), { usage: null, blocks: [] });
});

test('usageLine: 사람이 읽는 한 줄 — 모델별 🔴 · 크레딧 · 토큰 없음', () => {
  const line = usageLine(normalizeUsage(PAYLOAD(), NOW));
  assert.match(line, /^\[USAGE\] 세션 51%/);
  assert.match(line, /fable 100%🔴/);
  assert.match(line, /크레딧 소진/);
  assert.doesNotMatch(line, /sk-ant|Bearer|api\.anthropic/);
  assert.match(usageLine(null), /조회 실패/);
});

test('readOauthToken: 파일 없음/형식 불량은 null · 정상은 값만 돌려준다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-cred-'));
  assert.equal(readOauthToken(join(dir, 'none.json')), null);
  writeFileSync(join(dir, 'bad.json'), '{"claudeAiOauth":{"accessToken":"short"}}');
  assert.equal(readOauthToken(join(dir, 'bad.json')), null);
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ claudeAiOauth: { accessToken: FAKE_TOKEN } }));
  assert.equal(readOauthToken(join(dir, 'ok.json')), FAKE_TOKEN);
});

test('배선: run-night 는 슬롯 시작에 probeUsage 를 부르고, 파이프라인은 spend 를 스냅샷으로 재분류한다', () => {
  const runNight = readFileSync(join(HERE, 'run-night.mjs'), 'utf8');
  assert.match(runNight, /import \{ probeUsage, usageLine \} from '\.\/runtime\/usage-probe\.mjs'/);
  assert.match(runNight, /await probeUsage\(\{ stateDir: STATE_DIR \}\)/);
  assert.match(runNight, /CFG\.usageProbe !== false/, '설정 usageProbe:false 로 끌 수 있다');
  const pipeline = readFileSync(join(HERE, 'runtime', 'auto-story-pipeline.mjs'), 'utf8');
  assert.match(pipeline, /import \{ readUsageSnapshot, reclassifySpend \} from '\.\/usage-probe\.mjs'/);
  assert.match(pipeline, /result === 'spend' && !dryRun \? reclassifySpend\(readUsageSnapshot\(modelStateDir\), selected\.model\)/);
  assert.match(pipeline, /router\.record\(selected\.model, 'limit', \{ role: stage, story, retryAt: spendAsLimit\.retryAt/);
  assert.match(pipeline, /if \(result === 'limit' \|\| spendAsLimit\) \{/, '재분류된 spend 도 limit 강등 정책을 탄다');
});
