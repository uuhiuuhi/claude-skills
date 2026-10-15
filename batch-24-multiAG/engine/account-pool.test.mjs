import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  save, saveBack, switchTo, autoSwitch, status, renderStatus, decideSwitch, accountPressure, headroomScore,
  listPool, readCurrent, matchByToken, maskTail, validLabel, resolveStateDir, fetchProfileEmail,
} from './runtime/account-pool.mjs';

const NOW = Date.parse('2026-10-16T05:00:00Z');
const WEEK_RESET = '2026-10-19T17:00:00Z';
const SESSION_RESET = '2026-10-16T08:00:00Z';
const tok = (name, n = 1) => `sk-ant-oat01-FAKE-${name}-ACCESS-${n}-0123456789abcdefXYZ${name}${n}`;
const rtok = (name, n = 1) => `sk-ant-ort01-FAKE-${name}-REFRESH-${n}-0123456789abcdefQRS${name}${n}`;
const oauth = (name, n = 1, extra = {}) => ({
  accessToken: tok(name, n), refreshToken: rtok(name, n), expiresAt: NOW + 4 * 3_600_000, refreshTokenExpiresAt: NOW + 30 * 86_400_000,
  scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', ...extra,
});
const MCP = { 'server-x': { accessToken: 'mcp-token-keep-me-0123456789', expiresAt: 1 } };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'account-pool-'));
  const stateDir = join(root, 'state');
  const credentialsPath = join(root, 'claude', '.credentials.json');
  mkdirSync(join(root, 'claude'), { recursive: true });
  const login = (o) => writeFileSync(credentialsPath, JSON.stringify({ mcpOAuth: MCP, claudeAiOauth: o }));
  const creds = () => JSON.parse(readFileSync(credentialsPath, 'utf8'));
  return { root, stateDir, credentialsPath, login, creds };
}

/** 가짜 계정: 토큰 → 이메일 · 사용량. 프로필·사용량 두 주소를 흉내 낸다. 받은 헤더를 기록한다. */
function fakeApi(accounts) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const token = String(init?.headers?.Authorization ?? '').replace(/^Bearer /, '');
    calls.push(url);
    const acc = Object.values(accounts).find((a) => a.tokens.includes(token));
    if (!acc) return { status: 401, json: async () => ({}) };
    if (url.endsWith('/profile')) return { status: 200, json: async () => ({ account: { email: acc.email } }) };
    if (acc.usage === null) return { status: 401, json: async () => ({}) };
    return { status: 200, json: async () => acc.usage };
  };
  return { fetchImpl, calls };
}
const usagePayload = ({ session = 10, week = 10, fable = null, opus = null } = {}) => ({
  limits: [
    { kind: 'session', percent: session, resets_at: SESSION_RESET },
    { kind: 'weekly_all', percent: week, resets_at: WEEK_RESET },
    ...(fable === null ? [] : [{ kind: 'weekly_scoped', percent: fable, resets_at: WEEK_RESET, scope: { model: { display_name: 'Fable' } } }]),
    ...(opus === null ? [] : [{ kind: 'weekly_scoped', percent: opus, resets_at: WEEK_RESET, scope: { model: { display_name: 'Opus' } } }]),
  ],
});
const quiet = () => { const lines = []; const log = (s) => lines.push(String(s)); return { lines, log }; };
const assertNoTokens = (text) => { assert.doesNotMatch(String(text), /sk-ant-o[ar]t01-FAKE-[A-Z]+-(ACCESS|REFRESH)-\d+-0123456789abcdef/); };

async function twoAccounts({ aUsage = usagePayload(), bUsage = usagePayload() } = {}) {
  const env = setup();
  const accounts = {
    a: { email: 'a@example.com', tokens: [tok('A'), tok('A', 2)], usage: aUsage },
    b: { email: 'b@example.com', tokens: [tok('B'), tok('B', 2), tok('B', 3)], usage: bUsage },
  };
  const api = fakeApi(accounts);
  const { lines, log } = quiet();
  const opts = { stateDir: env.stateDir, credentialsPath: env.credentialsPath, fetchImpl: api.fetchImpl, now: NOW, log, cliEmail: () => null };
  env.login(oauth('A'));
  await save('acctA', opts);
  env.login(oauth('B'));
  await save('acctB', opts);
  return { ...env, accounts, api, lines, opts };
}

test('save: 풀 파일 모양 · current 표식 · 토큰은 로그에 안 남는다', async () => {
  const { stateDir, opts, lines } = await twoAccounts();
  const a = JSON.parse(readFileSync(join(stateDir, 'accounts', 'acctA.json'), 'utf8'));
  assert.deepEqual(Object.keys(a).sort(), ['claudeAiOauth', 'email', 'exhaustedUntil', 'label', 'savedAt']);
  assert.equal(a.email, 'a@example.com');
  assert.equal(a.claudeAiOauth.accessToken, tok('A'));
  assert.equal(a.claudeAiOauth.mcpOAuth, undefined); // mcp 토큰은 풀에 싣지 않는다
  assert.equal(readCurrent(stateDir).label, 'acctB');
  assert.deepEqual(listPool(stateDir).map((x) => x.label), ['acctA', 'acctB']);
  assert.ok(lines.some((l) => l.includes('[ACCOUNT] 저장 acctA') && l.includes('…')));
  assertNoTokens(lines.join('\n'));
  assert.ok(opts);
});

test('save: 같은 이메일을 다른 라벨로 저장하면 거부 · 라벨 형식 검사 · 남의 라벨 덮어쓰기 거부', async () => {
  const { opts, login } = await twoAccounts();
  login(oauth('A', 2));
  await assert.rejects(save('again', opts), /중복 저장 거부/);
  await assert.rejects(save('current', opts), /라벨 형식/);
  await assert.rejects(save('../x', opts), /라벨 형식/);
  await assert.rejects(save('acctB', opts), /다른 계정/);
  await save('acctA', opts); // 같은 계정 같은 라벨은 다시 저장(갱신) 가능
  assert.equal(listPool(opts.stateDir).find((x) => x.label === 'acctA').claudeAiOauth.accessToken, tok('A', 2));
});

test('save: 계정 조회가 실패하면 claude auth status 이메일로, 둘 다 실패하면 거부', async () => {
  const { stateDir, credentialsPath, login } = setup();
  login(oauth('C'));
  const failFetch = async () => ({ status: 500, json: async () => ({}) });
  await assert.rejects(save('c', { stateDir, credentialsPath, fetchImpl: failFetch, cliEmail: () => null, log: () => {} }), /이메일 확인 실패/);
  const r = await save('c', { stateDir, credentialsPath, fetchImpl: failFetch, cliEmail: () => 'c@example.com', log: () => {} });
  assert.equal(r.email, 'c@example.com');
});

test('saveBack: CLI 가 갱신한 토큰을 주인 계정 풀 파일에 반영(갱신 토큰 일치 · 이메일 확인 둘 다)', async () => {
  const { stateDir, login, opts } = await twoAccounts();
  // ① 접근 토큰만 갱신(갱신 토큰 그대로) → 토큰 일치로 판정
  login({ ...oauth('B'), accessToken: tok('B', 2), expiresAt: NOW + 8 * 3_600_000 });
  let r = await saveBack(opts);
  assert.deepEqual([r.ok, r.label, r.updated, r.via], [true, 'acctB', true, '토큰 일치']);
  assert.equal(listPool(stateDir).find((x) => x.label === 'acctB').claudeAiOauth.accessToken, tok('B', 2));
  // ② 둘 다 회전 → 이메일 확인
  login(oauth('B', 3));
  r = await saveBack(opts);
  assert.deepEqual([r.ok, r.label, r.via], [true, 'acctB', '이메일 확인']);
  // ③ 변경 없음
  r = await saveBack(opts);
  assert.equal(r.updated, false);
});

test('saveBack: 사람이 다른 풀 계정으로 로그인했으면 current 를 정정 · 모르는 계정이면 경고만(풀 무변경)', async () => {
  const { stateDir, login, opts, accounts, lines } = await twoAccounts();
  login(oauth('A', 2)); // acctA 로 다시 로그인(토큰 새로) — current 는 acctB
  let r = await saveBack(opts);
  assert.deepEqual([r.ok, r.label], [true, 'acctA']);
  assert.equal(readCurrent(stateDir).label, 'acctA');
  accounts.z = { email: 'z@example.com', tokens: [tok('Z')], usage: usagePayload() };
  const before = JSON.stringify(listPool(stateDir));
  login(oauth('Z'));
  r = await saveBack(opts);
  assert.equal(r.ok, false);
  assert.match(r.reason, /알 수 없는 계정 — save <label> 필요/);
  assert.equal(JSON.stringify(listPool(stateDir)), before);
  assertNoTokens(lines.join('\n'));
});

test('switchTo: mcpOAuth 보존 · 대상 토큰으로 교체 · 백업 1개 · 임시 파일 없음 · current/lastSwitch · 로그 1줄', async () => {
  const { stateDir, credentialsPath, creds, opts, lines, root } = await twoAccounts();
  const r1 = await switchTo('acctA', { ...opts, reason: '시험', now: NOW });
  assert.deepEqual([r1.switched, r1.from, r1.to], [true, 'acctB', 'acctA']);
  assert.deepEqual(creds().mcpOAuth, MCP);
  assert.equal(creds().claudeAiOauth.accessToken, tok('A'));
  const cur = readCurrent(stateDir);
  assert.equal(cur.label, 'acctA');
  assert.deepEqual([cur.lastSwitch.from, cur.lastSwitch.to, cur.lastSwitch.reason], ['acctB', 'acctA', '시험']);
  assert.ok(lines.includes('[ACCOUNT] 전환 acctB → acctA (시험)'));
  await switchTo('acctB', { ...opts, now: NOW + 60_000 });
  const dir = join(root, 'claude');
  const names = readdirSync(dir);
  assert.equal(names.filter((n) => n.startsWith('.credentials.json.bak-')).length, 1, names.join(','));
  assert.equal(names.filter((n) => n.includes('.tmp-')).length, 0);
  assert.equal(readdirSync(join(stateDir, 'accounts')).filter((n) => n.includes('.tmp-')).length, 0);
  assert.equal(JSON.parse(readFileSync(credentialsPath, 'utf8')).claudeAiOauth.accessToken, tok('B'));
  assertNoTokens(lines.join('\n'));
});

test('switchTo: 지금 로그인 정보가 풀에 없으면(되돌려 놓을 곳 없음) 덮어쓰지 않고 거부 · 이미 그 계정이면 무변경', async () => {
  const { credentialsPath, login, opts, accounts } = await twoAccounts();
  assert.equal((await switchTo('acctB', opts)).switched, false);
  accounts.z = { email: 'z@example.com', tokens: [tok('Z')], usage: usagePayload() };
  login(oauth('Z'));
  const before = readFileSync(credentialsPath, 'utf8');
  await assert.rejects(switchTo('acctA', opts), /되돌려 놓지 못했다/);
  assert.equal(readFileSync(credentialsPath, 'utf8'), before);
  await assert.rejects(switchTo('nope', opts), /풀에 「nope」 없음/);
});

test('switchTo: 전환 전에 갱신된 토큰을 먼저 풀에 저장한다(쓴 뒤 저장)', async () => {
  const { stateDir, login, opts } = await twoAccounts();
  login({ ...oauth('B'), accessToken: tok('B', 2) });
  await switchTo('acctA', opts);
  assert.equal(listPool(stateDir).find((x) => x.label === 'acctB').claudeAiOauth.accessToken, tok('B', 2));
});

test('판정표: accountPressure · headroomScore', () => {
  const n = (p) => ({ fiveHour: { pct: p.s ?? 10, resetsAt: Date.parse(SESSION_RESET) }, sevenDay: { pct: p.w ?? 10, resetsAt: Date.parse(WEEK_RESET) },
    scoped: [...(p.f === undefined ? [] : [{ model: 'fable', pct: p.f, resetsAt: Date.parse(WEEK_RESET) }]), ...(p.o === undefined ? [] : [{ model: 'opus', pct: p.o, resetsAt: Date.parse(WEEK_RESET) }])] });
  assert.equal(accountPressure(n({ w: 97 })).triggers.length, 1);
  assert.equal(accountPressure(n({ f: 100 })).triggers.length, 0, 'fable 만 찼으면 opus 가 남아 있다');
  assert.equal(accountPressure(n({ f: 100, o: 96 })).triggers.length, 1);
  assert.equal(accountPressure(n({ s: 99 })).triggers.length, 1);
  assert.equal(accountPressure(n({ s: 99 }), { onSession: false }).triggers.length, 0);
  assert.equal(accountPressure(n({ w: 94 })).triggers.length, 0);
  assert.equal(headroomScore(n({ w: 12 })), 12);
  assert.equal(headroomScore(n({ w: 12, s: 40, f: 30 })), 40);
  assert.equal(headroomScore(n({ w: 96 })), null);
  assert.equal(headroomScore(n({ w: 12, s: 99 })), null, '세션이 찬 계정으로는 옮기지 않는다');
  assert.equal(headroomScore(n({ w: 12, o: 97 })), null);
  assert.equal(headroomScore({ fiveHour: { pct: null }, sevenDay: { pct: null }, scoped: [] }), null, '주간 미측정은 후보 아님');
});

test('decideSwitch: 주간 97% + 다른 계정 12% → 전환 · 둘 다 95↑ → 안 함 · 쿨다운 안 → 안 함 · 조회 실패 제외 · 가장 여유 있는 쪽', () => {
  const u = (w, extra = {}) => ({ fiveHour: { pct: 10, resetsAt: NOW + 3_600_000 }, sevenDay: { pct: w, resetsAt: NOW + 86_400_000 }, scoped: [], ...extra });
  const cur = { label: 'A', usage: u(97) };
  let d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: u(12) }], now: NOW });
  assert.equal(d.to, 'B');
  assert.match(d.reason, /주간 전체 97%/);
  assert.equal(d.exhaustedUntil, NOW + 86_400_000);
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: u(96) }], now: NOW });
  assert.equal(d.to, null);
  assert.match(d.reason, /여유 계정 없음/);
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: u(12) }], now: NOW, lastSwitchAt: new Date(NOW - 10 * 60_000).toISOString() });
  assert.equal(d.to, null);
  assert.match(d.reason, /쿨다운 30분/);
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: u(12) }], now: NOW, lastSwitchAt: NOW - 31 * 60_000 });
  assert.equal(d.to, 'B');
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: null, expired: false, refreshable: true }], now: NOW });
  assert.equal(d.to, null, '조회 실패(토큰 유효) 계정은 후보가 아니다');
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: u(50) }, { label: 'C', usage: u(20) }, { label: 'D', usage: null }], now: NOW });
  assert.equal(d.to, 'C');
  d = decideSwitch({ current: { label: 'A', usage: u(50) }, candidates: [{ label: 'B', usage: u(1) }], now: NOW });
  assert.deepEqual([d.to, d.reason], [null, ''], '현재 계정이 여유면 전환하지 않는다');
  d = decideSwitch({ current: { label: 'A', usage: null }, candidates: [{ label: 'B', usage: u(1) }], now: NOW });
  assert.equal(d.to, null);
  assert.match(d.reason, /조회 실패/);
  // 세션(5시간) 한도만 찼을 때도 다른 계정이 여유면 전환 · onSession false 면 안 함
  const sess = { label: 'A', usage: { ...u(40), fiveHour: { pct: 100, resetsAt: NOW + 3_600_000 } } };
  assert.equal(decideSwitch({ current: sess, candidates: [{ label: 'B', usage: u(30) }], now: NOW }).to, 'B');
  assert.equal(decideSwitch({ current: sess, candidates: [{ label: 'B', usage: u(30) }], now: NOW, cfg: { onSession: false } }).to, null);
});

test('decideSwitch: 상대 토큰이 만료돼 조회 불가면(갱신 토큰 유효 · 최근 찬 기록 없음) 그 계정으로 넘어간다', () => {
  const u = (w) => ({ fiveHour: { pct: 10 }, sevenDay: { pct: w, resetsAt: NOW + 86_400_000 }, scoped: [] });
  const cur = { label: 'A', usage: u(99) };
  let d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: null, expired: true, refreshable: true }], now: NOW });
  assert.deepEqual([d.to, d.blind], ['B', true]);
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: null, expired: true, refreshable: true, exhaustedUntil: NOW + 3_600_000 }], now: NOW });
  assert.equal(d.to, null, '최근 「찼다」로 떠난 계정으로 눈감고 돌아가지 않는다');
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: null, expired: true, refreshable: false }], now: NOW });
  assert.equal(d.to, null, '갱신 토큰까지 만료면 재로그인 몫');
  d = decideSwitch({ current: cur, candidates: [{ label: 'B', usage: null, expired: true, refreshable: true }], now: NOW, cfg: { blindWhenExpired: false } });
  assert.equal(d.to, null);
});

test('autoSwitch: 주간 97% → 다른 계정 12% 로 실제 교체 · 떠난 계정에 찬 기록 · 쿨다운으로 되돌아가지 않음', async () => {
  const { stateDir, creds, opts, accounts, lines } = await twoAccounts({ aUsage: usagePayload({ week: 12 }), bUsage: usagePayload({ week: 97 }) });
  const r = await autoSwitch({ ...opts, cfg: { enabled: true } });
  assert.deepEqual([r.switched, r.from, r.to], [true, 'acctB', 'acctA']);
  assert.equal(creds().claudeAiOauth.accessToken, tok('A'));
  assert.deepEqual(creds().mcpOAuth, MCP);
  assert.equal(listPool(stateDir).find((x) => x.label === 'acctB').exhaustedUntil, Date.parse(WEEK_RESET));
  // 곧바로 A 도 찼다 — 쿨다운 30분 안이라 B 로 되돌아가지 않는다
  accounts.a.usage = usagePayload({ week: 99 });
  accounts.b.usage = usagePayload({ week: 5 });
  const r2 = await autoSwitch({ ...opts, now: NOW + 5 * 60_000, cfg: { enabled: true } });
  assert.equal(r2.switched, false);
  assert.match(r2.reason, /쿨다운/);
  const r3 = await autoSwitch({ ...opts, now: NOW + 40 * 60_000, cfg: { enabled: true } });
  assert.deepEqual([r3.switched, r3.to], [true, 'acctB']);
  assert.ok(lines.some((l) => l.startsWith('[ACCOUNT] 전환 acctB → acctA (acctB 주간 전체 97%')));
  assertNoTokens(lines.join('\n'));
});

test('autoSwitch: 둘 다 95↑ → 안 함 · 현재 여유면 상대 계정 조회 안 함 · 계정 1개면 안 함 · labels 로 후보 제한', async () => {
  let env = await twoAccounts({ aUsage: usagePayload({ week: 96 }), bUsage: usagePayload({ week: 98 }) });
  let r = await autoSwitch({ ...env.opts, cfg: {} });
  assert.equal(r.switched, false);
  assert.match(r.reason, /여유 계정 없음/);
  env = await twoAccounts({ aUsage: usagePayload({ week: 1 }), bUsage: usagePayload({ week: 50 }) });
  const before = env.api.calls.length;
  r = await autoSwitch({ ...env.opts, cfg: {} });
  assert.deepEqual([r.switched, r.reason], [false, '']);
  assert.equal(env.api.calls.length - before, 1, '현재 계정 사용량 1회만 조회');
  env = await twoAccounts({ aUsage: usagePayload({ week: 1 }), bUsage: usagePayload({ week: 99 }) });
  r = await autoSwitch({ ...env.opts, cfg: { labels: ['other'] } });
  assert.equal(r.switched, false, 'labels 에 없는 계정으로는 옮기지 않는다');
  const one = setup();
  one.login(oauth('A'));
  const api = fakeApi({ a: { email: 'a@example.com', tokens: [tok('A')], usage: usagePayload({ week: 99 }) } });
  await save('only', { stateDir: one.stateDir, credentialsPath: one.credentialsPath, fetchImpl: api.fetchImpl, log: () => {} });
  r = await autoSwitch({ stateDir: one.stateDir, credentialsPath: one.credentialsPath, fetchImpl: api.fetchImpl, log: () => {} });
  assert.match(r.reason, /2개 이상/);
});

test('autoSwitch: 조회 실패 계정은 후보에서 빠진다 · 모델별(fable·opus) 전부 찼을 때 전환 · 모르는 계정이면 전환 안 함', async () => {
  let env = await twoAccounts({ aUsage: null, bUsage: usagePayload({ week: 99 }) });
  let r = await autoSwitch({ ...env.opts, cfg: {} });
  assert.equal(r.switched, false, 'acctA 는 토큰 유효 · 조회 실패 → 제외');
  env = await twoAccounts({ aUsage: usagePayload({ week: 30 }), bUsage: usagePayload({ week: 50, fable: 100, opus: 97 }) });
  r = await autoSwitch({ ...env.opts, cfg: {} });
  assert.deepEqual([r.switched, r.to], [true, 'acctA']);
  assert.match(r.reason, /모델별 fable 100% · opus 97%/);
  env = await twoAccounts({ aUsage: usagePayload({ week: 1 }), bUsage: usagePayload({ week: 99 }) });
  env.accounts.z = { email: 'z@example.com', tokens: [tok('Z')], usage: usagePayload({ week: 99 }) };
  env.login(oauth('Z'));
  const before = readFileSync(env.credentialsPath, 'utf8');
  r = await autoSwitch({ ...env.opts, cfg: {} });
  assert.equal(r.switched, false);
  assert.match(r.reason, /알 수 없는 계정/);
  assert.equal(readFileSync(env.credentialsPath, 'utf8'), before);
});

test('status/renderStatus: 계정별 사용량 표 · 조회 실패 표기 · 토큰은 꼬리 6자만', async () => {
  const { opts } = await twoAccounts({ aUsage: null, bUsage: usagePayload({ week: 97, fable: 100 }) });
  const st = await status({ ...opts, cfg: {} });
  assert.equal(st.liveLabel, 'acctB');
  const text = renderStatus(st);
  assert.match(text, /acctA \(a@example.com\) — 조회 실패/);
  assert.match(text, /acctB \(b@example.com\) — 세션 10% · 주간 97% · fable 100%/);
  assert.match(text, /자동 전환 판정: 주간 전체 97% — 옮겨 갈 여유 계정 없음/);
  assert.match(text, new RegExp(`…${tok('B').slice(-6)}`));
  assertNoTokens(text);
});

test('도우미: maskTail · validLabel · matchByToken · resolveStateDir · fetchProfileEmail 실패는 null', async () => {
  assert.equal(maskTail('abcdefghijkl123456'), '…123456');
  assert.equal(maskTail('short'), '—');
  assert.equal(validLabel('max-a_1'), true);
  assert.equal(validLabel('-x'), false);
  const pool = [{ label: 'a', claudeAiOauth: oauth('A') }];
  assert.equal(matchByToken({ accessToken: 'x', refreshToken: rtok('A') }, pool).label, 'a');
  assert.equal(matchByToken({ accessToken: 'x', refreshToken: 'y' }, pool), null);
  const root = mkdtempSync(join(tmpdir(), 'account-pool-cfg-'));
  mkdirSync(join(root, 'tools', 'auto'), { recursive: true });
  writeFileSync(join(root, 'tools', 'auto', 'auto.config.json'), JSON.stringify({ stateDir: join(root, 'st') }));
  assert.equal(resolveStateDir({ argv: [], env: {}, cwd: root }), join(root, 'st'));
  assert.equal(resolveStateDir({ argv: ['--state-dir', join(root, 'x')], env: {}, cwd: root }), join(root, 'x'));
  assert.equal(resolveStateDir({ argv: [], env: { AUTO_BATCH_STATE_DIR: 'E' }, cwd: root }), 'E');
  assert.equal(await fetchProfileEmail({ token: tok('A'), fetchImpl: async () => { throw new Error(`boom ${tok('A')}`); } }), null);
  assert.equal(existsSync(join(root, 'st')), false);
});
