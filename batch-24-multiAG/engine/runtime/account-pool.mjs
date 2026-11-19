// Claude 계정 풀 — 계정별 CLI 로그인 정보를 보관해 두고 사용량 기준으로 바꿔 끼운다(👤 2026-10-16 「만들어줘」).
//
// 왜: 데스크톱 앱과 CLI 는 로그인 저장소가 따로라 앱에서 계정을 바꿔도 러너(`claude -p`)는 그대로다. 브라우저 로그인은
// 무인으로 할 수 없으므로, 사람이 계정마다 한 번 `claude auth login` → `save <라벨>` 해 두면 엔진이 라운드 경계에서
// `~/.claude/.credentials.json` 의 `claudeAiOauth` 만 바꿔 끼운다.
//
// 규율: ① 토큰 값은 어떤 로그·오류·반환 문구에도 싣지 않는다(꼬리 6자 `…abcdef` 만) ② `claudeAiOauth` 밖의 키(mcpOAuth 등)는
//       보존한다 ③ 자격 파일 쓰기 = 임시 파일 → rename(원자적) + 직전 백업 1개 ④ CLI 는 토큰을 스스로 갱신해 파일을 다시
//       쓰므로 **쓴 뒤 저장**(saveBack)한다 — 지금 자격이 어느 풀 계정인지 확인되지 않으면 **전환하지 않는다**(갱신된 토큰을
//       풀에 되돌려 놓지 못한 채 덮으면 그 계정은 다시 로그인해야 한다) ⑤ 조회 실패는 전부 「전환 안 함」 쪽이다.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchClaudeUsage, kst } from './usage-probe.mjs';

export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const ACCOUNT_DEFAULTS = Object.freeze({
  enabled: false, switchAt: 95, models: ['fable', 'opus'], cooldownMin: 30, onSession: true, blindWhenExpired: true,
});
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MIN = 60_000;

export const defaultCredentialsPath = () => join(homedir(), '.claude', '.credentials.json');
/** 토큰 마스킹 — 꼬리 6자만. 짧거나 없으면 「—」. */
export const maskTail = (s) => (typeof s === 'string' && s.length >= 12 ? `…${s.slice(-6)}` : '—');
export const validLabel = (label) => typeof label === 'string' && LABEL_RE.test(label) && label !== 'current';
const iso = (t) => new Date(t).toISOString();
const lower = (s) => String(s ?? '').trim().toLowerCase();
const stripBom = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
const readJson = (file) => { try { return JSON.parse(stripBom(readFileSync(file, 'utf8'))); } catch { return null; } };

const poolDir = (stateDir) => join(stateDir, 'accounts');
const labelFile = (stateDir, label) => join(poolDir(stateDir), `${label}.json`);
const currentFile = (stateDir) => join(poolDir(stateDir), 'current.json');

/** 임시 파일 → rename. Windows 에서 다른 프로세스가 잠깐 잡고 있으면(EPERM·EBUSY) 짧게 몇 번 다시 한다. 오류 문구에 내용 없음. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return file; } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
        try { unlinkSync(tmp); } catch { /* 이미 없음 */ }
        throw new Error(`파일 교체 실패(${e?.code ?? 'unknown'}): ${basename(file)}`, { cause: e });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
    }
  }
}

export function readCredentials(credentialsPath = defaultCredentialsPath()) {
  const raw = readJson(credentialsPath);
  return raw && typeof raw === 'object' ? raw : null;
}
const oauthOf = (creds) => (typeof creds?.claudeAiOauth?.accessToken === 'string' && creds.claudeAiOauth.accessToken ? creds.claudeAiOauth : null);

/** 풀 계정 목록(라벨순). 깨진 파일·토큰 없는 파일은 뺀다. */
export function listPool(stateDir) {
  let names;
  try { names = readdirSync(poolDir(stateDir)); } catch { return []; }
  return names.filter((n) => n.endsWith('.json') && n !== 'current.json')
    .map((n) => readJson(join(poolDir(stateDir), n)))
    .filter((a) => a && validLabel(a.label) && oauthOf(a))
    .sort((a, b) => a.label.localeCompare(b.label));
}
export function readCurrent(stateDir) {
  const c = readJson(currentFile(stateDir));
  return c && validLabel(c.label) ? c : null;
}
const writeCurrent = (stateDir, next) => { writeAtomic(currentFile(stateDir), JSON.stringify(next, null, 2) + '\n'); return next; };
const writeEntry = (stateDir, entry) => { writeAtomic(labelFile(stateDir, entry.label), JSON.stringify(entry, null, 2) + '\n'); return entry; };

/** 토큰이 같은 풀 계정(접근 토큰 → 갱신 토큰 순). 순수 함수. */
export function matchByToken(oauth, pool) {
  if (!oauth) return null;
  return pool.find((a) => a.claudeAiOauth.accessToken === oauth.accessToken)
    ?? (oauth.refreshToken ? pool.find((a) => a.claudeAiOauth.refreshToken === oauth.refreshToken) : null) ?? null;
}

/** 토큰의 실제 주인 이메일(계정 조회 API). `claude auth status` 는 ~/.claude.json 의 캐시를 읽어 전환 직후엔 예전
 *  계정을 말할 수 있으므로, 토큰 자체로 묻는 쪽을 먼저 쓴다. 실패는 null. */
export async function fetchProfileEmail({ token, fetchImpl = globalThis.fetch, timeoutMs = 8000, url = PROFILE_URL } = {}) {
  if (!token || typeof fetchImpl !== 'function') return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: ac.signal });
    if (!res || res.status !== 200) return null;
    const j = await res.json();
    const email = j?.account?.email ?? j?.account?.email_address;
    return typeof email === 'string' && email.includes('@') ? lower(email) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** `claude auth status`(JSON · email 키) — save 의 예비 경로. 실패는 null. */
export function cliAuthEmail({ claudeBin = process.env.CLAUDE_BIN || 'claude', run = spawnSync } = {}) {
  try {
    const r = run(claudeBin, ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 });
    const j = JSON.parse(String(r?.stdout ?? '').trim());
    return typeof j?.email === 'string' && j.email.includes('@') ? lower(j.email) : null;
  } catch { return null; }
}

const whoFn = ({ whoami, fetchImpl }) => whoami ?? ((token) => fetchProfileEmail({ token, fetchImpl }));

/** 지금 CLI 로그인 정보를 라벨로 풀에 저장하고 현재 표식을 그 라벨로. 같은 계정이 다른 라벨에 있으면 거부. */
export async function save(label, { stateDir, credentialsPath = defaultCredentialsPath(), fetchImpl, whoami, cliEmail = cliAuthEmail, now = Date.now(), log = console.log } = {}) {
  if (!stateDir) throw new Error('상태 폴더(stateDir)가 없다');
  if (!validLabel(label)) throw new Error('라벨 형식 오류 — 영문·숫자로 시작, 영문·숫자·_- 1~32자(current 는 쓸 수 없음)');
  const oauth = oauthOf(readCredentials(credentialsPath));
  if (!oauth) throw new Error('CLI 로그인 정보(claudeAiOauth)가 없다 — 먼저 `claude auth login`');
  const email = (await whoFn({ whoami, fetchImpl })(oauth.accessToken)) ?? cliEmail();
  if (!email) throw new Error('이메일 확인 실패(계정 조회 · `claude auth status` 둘 다) — 네트워크·로그인 상태를 확인하고 다시');
  const pool = listPool(stateDir);
  const dup = pool.find((a) => a.label !== label && lower(a.email) === email);
  if (dup) throw new Error(`같은 계정이 이미 「${dup.label}」로 저장돼 있다 — 중복 저장 거부(다른 계정이면 \`claude auth login\` 으로 바꾼 뒤 save)`);
  const prev = pool.find((a) => a.label === label);
  if (prev && lower(prev.email) !== email) throw new Error(`라벨 「${label}」 는 다른 계정이 쓰고 있다 — 다른 라벨을 쓰거나 ${labelFile(stateDir, label)} 을 지운 뒤 다시`);
  writeEntry(stateDir, { label, email, savedAt: iso(now), exhaustedUntil: null, claudeAiOauth: oauth });
  const cur = readCurrent(stateDir);
  writeCurrent(stateDir, { label, since: iso(now), lastSwitch: cur?.lastSwitch ?? null });
  log(`[ACCOUNT] 저장 ${label} (${email} · 토큰 ${maskTail(oauth.accessToken)})`);
  return { label, email };
}

/** 쓴 뒤 저장 — 지금 `.credentials.json` 의 값(CLI 가 갱신했을 수 있다)을 주인 계정의 풀 파일에 되돌려 놓는다.
 *  주인 판정 = 토큰 일치 → 계정 조회 이메일. 모르면 경고만(풀을 건드리지 않는다). */
export async function saveBack({ stateDir, credentialsPath = defaultCredentialsPath(), fetchImpl, whoami, now = Date.now(), log = console.log } = {}) {
  const oauth = oauthOf(readCredentials(credentialsPath));
  if (!oauth) return { ok: false, reason: 'CLI 로그인 정보(claudeAiOauth) 없음' };
  const pool = listPool(stateDir);
  if (!pool.length) return { ok: false, reason: '계정 풀이 비어 있다 — save <label> 필요' };
  let hit = matchByToken(oauth, pool);
  let via = '토큰 일치';
  if (!hit) {
    const email = await whoFn({ whoami, fetchImpl })(oauth.accessToken);
    hit = email ? pool.find((a) => lower(a.email) === email) ?? null : null;
    via = '이메일 확인';
  }
  if (!hit) {
    const reason = '알 수 없는 계정 — save <label> 필요';
    log(`⚠ [ACCOUNT] ${reason} (지금 CLI 토큰 ${maskTail(oauth.accessToken)} · 풀 ${pool.map((a) => a.label).join(',')})`);
    return { ok: false, unknown: true, reason };
  }
  let updated = false;
  if (JSON.stringify(hit.claudeAiOauth) !== JSON.stringify(oauth)) {
    writeEntry(stateDir, { ...hit, savedAt: iso(now), claudeAiOauth: oauth });
    updated = true;
  }
  const cur = readCurrent(stateDir);
  if (cur?.label !== hit.label) {
    writeCurrent(stateDir, { ...(cur ?? {}), label: hit.label, since: iso(now) });
    log(`[ACCOUNT] 현재 계정 표식 정정 ${cur?.label ?? '없음'} → ${hit.label} (${via})`);
  }
  return { ok: true, label: hit.label, updated, via };
}

// ── 판정(순수) ─────────────────────────────────────────────────────────────
const pctOf = (x) => (Number.isFinite(x?.pct) ? x.pct : null);
const modelMax = (usage, model) => {
  const v = (usage?.scoped ?? []).filter((s) => s.model === model).map((s) => s.pct).filter(Number.isFinite);
  return v.length ? Math.max(...v) : null;
};
const cfgOf = (cfg) => {
  const c = { ...ACCOUNT_DEFAULTS, ...(cfg ?? {}) };
  return { ...c, switchAt: Number(c.switchAt) > 0 ? Number(c.switchAt) : 95, cooldownMin: Number(c.cooldownMin) >= 0 ? Number(c.cooldownMin) : 30,
    models: Array.isArray(c.models) ? c.models.map(String) : ACCOUNT_DEFAULTS.models };
};

/** 현재 계정이 바꿀 만큼 찼나 — 주간 전체 ≥ 기준 · `models` 의 모델별이 **전부** ≥ 기준 · (onSession) 세션 ≥ 기준. */
export function accountPressure(usage, cfg) {
  const c = cfgOf(cfg);
  const triggers = [];
  if (!usage) return { triggers, until: null };
  const week = pctOf(usage.sevenDay);
  if (week !== null && week >= c.switchAt) triggers.push({ why: `주간 전체 ${week}%`, resetsAt: usage.sevenDay.resetsAt });
  const per = c.models.map((m) => [m, modelMax(usage, m)]);
  if (per.length && per.every(([, v]) => v !== null && v >= c.switchAt)) {
    const resets = (usage.scoped ?? []).filter((s) => c.models.includes(s.model)).map((s) => s.resetsAt).filter(Number.isFinite);
    triggers.push({ why: `모델별 ${per.map(([m, v]) => `${m} ${v}%`).join(' · ')}`, resetsAt: resets.length ? Math.min(...resets) : null });
  }
  const sess = pctOf(usage.fiveHour);
  if (c.onSession && sess !== null && sess >= c.switchAt) triggers.push({ why: `세션 ${sess}%`, resetsAt: usage.fiveHour.resetsAt });
  const until = triggers.map((t) => t.resetsAt).filter(Number.isFinite);
  return { triggers, until: until.length ? Math.max(...until) : null };
}

/** 옮겨 갈 수 있는 계정인가 — 주간 전체가 실측돼 기준 아래 · `models` 의 모델별(있으면) 기준 아래 · 세션(있으면) 기준 아래.
 *  여유 점수 = 그중 가장 높은 % (낮을수록 여유). 안 되면 null. */
export function headroomScore(usage, cfg) {
  const c = cfgOf(cfg);
  const week = pctOf(usage?.sevenDay);
  if (week === null || week >= c.switchAt) return null;
  const sess = pctOf(usage.fiveHour);
  if (sess !== null && sess >= c.switchAt) return null;
  const per = c.models.map((m) => modelMax(usage, m)).filter((v) => v !== null);
  if (per.some((v) => v >= c.switchAt)) return null;
  return Math.max(week, sess ?? 0, ...per);
}

/** 전환 판정. current = { label, usage } · candidates = [{ label, usage, expired, refreshable, exhaustedUntil }]
 *  → { to: 라벨|null, reason, blind, exhaustedUntil }. */
export function decideSwitch({ current, candidates = [], cfg, now = Date.now(), lastSwitchAt = null }) {
  const c = cfgOf(cfg);
  const none = (reason) => ({ to: null, reason, blind: false, exhaustedUntil: null });
  if (!current?.usage) return none('현재 계정 사용량 조회 실패 — 전환하지 않는다');
  const { triggers, until } = accountPressure(current.usage, c);
  if (!triggers.length) return none('');
  const why = triggers.map((t) => t.why).join(' · ');
  const last = Number.isFinite(lastSwitchAt) ? lastSwitchAt : Date.parse(String(lastSwitchAt ?? ''));
  if (Number.isFinite(last) && now - last < c.cooldownMin * MIN) return none(`${why} — 직전 전환 ${Math.floor((now - last) / MIN)}분 전 · 쿨다운 ${c.cooldownMin}분 안이라 전환하지 않는다`);
  const measured = candidates.map((x) => ({ ...x, score: x.usage ? headroomScore(x.usage, c) : null }))
    .filter((x) => x.score !== null).sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  if (measured.length) return { to: measured[0].label, reason: `${current.label} ${why} → ${measured[0].label} 여유(최고 ${measured[0].score}%)`, blind: false, exhaustedUntil: until };
  // 상대 계정 토큰이 만료돼 사용량을 못 읽는 경우 — 쉬는 계정은 갱신 기회가 없어 거의 늘 만료다. 갱신 토큰이 살아 있고
  // 최근 「찼다」로 떠난 계정(exhaustedUntil)이 아니면 넘어간다: 전환 뒤 첫 `claude -p` 가 갱신하고, 그 값을 saveBack 이 풀에 저장한다.
  if (c.blindWhenExpired) {
    const blind = candidates.filter((x) => !x.usage && x.expired && x.refreshable && !(Number(x.exhaustedUntil) > now))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (blind.length) return { to: blind[0].label, reason: `${current.label} ${why} → ${blind[0].label}(사용량 조회 불가 · 토큰 만료 — 전환 뒤 CLI 가 갱신)`, blind: true, exhaustedUntil: until };
  }
  return none(`${why} — 옮겨 갈 여유 계정 없음(다른 계정도 기준 ${c.switchAt}% 이상이거나 조회 실패)`);
}

// ── 실행 ──────────────────────────────────────────────────────────────────
function backupCredentials(credentialsPath, now) {
  const dir = dirname(credentialsPath);
  const base = basename(credentialsPath);
  const stamp = iso(now).replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const backup = join(dir, `${base}.bak-${stamp}`);
  copyFileSync(credentialsPath, backup);
  try { // 백업은 1개만 — 토큰 사본을 늘려 두지 않는다
    for (const n of readdirSync(dir)) if (n.startsWith(`${base}.bak-`) && join(dir, n) !== backup) unlinkSync(join(dir, n));
  } catch { /* 정리 실패는 무시 */ }
  return backup;
}

/** 계정 전환 — ① saveBack ② 대상 claudeAiOauth 를 자격 파일에 덮어쓰기(다른 키 보존 · 원자적 · 백업 1개) ③ current 갱신 ④ 로그 1줄. */
export async function switchTo(label, { stateDir, credentialsPath = defaultCredentialsPath(), fetchImpl, whoami, now = Date.now(), log = console.log, reason = '수동', exhaustedUntil = null } = {}) {
  if (!validLabel(label)) throw new Error('라벨 형식 오류');
  if (!listPool(stateDir).some((a) => a.label === label)) throw new Error(`풀에 「${label}」 없음 — 그 계정으로 로그인한 뒤 save ${label} 먼저`);
  const back = await saveBack({ stateDir, credentialsPath, fetchImpl, whoami, now, log });
  if (!back.ok) throw new Error(`지금 로그인 정보를 풀에 되돌려 놓지 못했다(${back.reason}) — 이대로 덮으면 그 계정 토큰을 잃는다. 먼저 save <label>`);
  const from = back.label;
  if (from === label) { log(`[ACCOUNT] 이미 ${label} — 전환 없음`); return { switched: false, from, to: label, reason: '이미 그 계정' }; }
  const pool = listPool(stateDir);
  const target = pool.find((a) => a.label === label);
  const creds = readCredentials(credentialsPath);
  backupCredentials(credentialsPath, now);
  writeAtomic(credentialsPath, JSON.stringify({ ...creds, claudeAiOauth: target.claudeAiOauth }));
  const fromEntry = pool.find((a) => a.label === from);
  if (fromEntry && Number.isFinite(exhaustedUntil)) writeEntry(stateDir, { ...fromEntry, exhaustedUntil });
  if (target.exhaustedUntil) writeEntry(stateDir, { ...target, exhaustedUntil: null });
  const prev = readCurrent(stateDir);
  writeCurrent(stateDir, { ...(prev ?? {}), label, since: iso(now), lastSwitch: { at: iso(now), from, to: label, reason } });
  log(`[ACCOUNT] 전환 ${from} → ${label} (${reason})`);
  return { switched: true, from, to: label, reason };
}

/** 풀 계정마다 사용량 실측. 지금 CLI 가 쓰는 계정은 자격 파일의 (더 최신) 토큰으로 읽는다. */
export async function measurePool({ stateDir, credentialsPath = defaultCredentialsPath(), fetchImpl, now = Date.now(), labels = null } = {}) {
  const pool = listPool(stateDir);
  const live = oauthOf(readCredentials(credentialsPath));
  const liveLabel = matchByToken(live, pool)?.label ?? null;
  const rows = [];
  for (const a of pool) {
    if (labels && !labels.includes(a.label) && a.label !== liveLabel) continue;
    const oauth = a.label === liveLabel ? live : a.claudeAiOauth;
    const exp = Number(oauth.expiresAt);
    const rexp = Number(oauth.refreshTokenExpiresAt);
    rows.push({
      label: a.label, email: a.email, live: a.label === liveLabel, tokenTail: maskTail(oauth.accessToken),
      expiresAt: Number.isFinite(exp) ? exp : null, expired: Number.isFinite(exp) && exp <= now,
      refreshable: !Number.isFinite(rexp) || rexp > now, exhaustedUntil: Number(a.exhaustedUntil) || null,
      usage: await fetchClaudeUsage({ token: oauth.accessToken, fetchImpl, now }),
    });
  }
  return { liveLabel, rows };
}

export async function status({ stateDir, credentialsPath = defaultCredentialsPath(), fetchImpl, now = Date.now(), cfg } = {}) {
  const cur = readCurrent(stateDir);
  const { liveLabel, rows } = await measurePool({ stateDir, credentialsPath, fetchImpl, now });
  const current = rows.find((r) => r.live);
  const verdict = current ? decideSwitch({ current, candidates: rows.filter((r) => !r.live), cfg, now, lastSwitchAt: cur?.lastSwitch?.at }) : null;
  return { current: cur?.label ?? null, liveLabel, lastSwitch: cur?.lastSwitch ?? null, rows, verdict };
}

/** 라운드 경계 자동 전환. 결과 { switched, from, to, reason }. 어떤 실패도 「전환 안 함」으로 돌려준다(던지지 않는다). */
export async function autoSwitch({ stateDir, cfg, credentialsPath = defaultCredentialsPath(), fetchImpl, whoami, now = Date.now(), log = console.log } = {}) {
  const c = cfgOf(cfg);
  const no = (reason, from = null) => ({ switched: false, from, to: null, reason });
  try {
    const pool = listPool(stateDir);
    if (pool.length < 2) return no(`계정 풀 ${pool.length}개 — 2개 이상 save 해야 전환한다`);
    const back = await saveBack({ stateDir, credentialsPath, fetchImpl, whoami, now, log });
    if (!back.ok) return no(back.reason);
    const live = oauthOf(readCredentials(credentialsPath));
    const usage = await fetchClaudeUsage({ token: live.accessToken, fetchImpl, now });
    const current = { label: back.label, usage };
    // 현재 계정이 여유면 상대 계정은 부르지 않는다(라운드마다 조회를 늘리지 않는다).
    if (usage && !accountPressure(usage, c).triggers.length) return no('', back.label);
    const labels = Array.isArray(c.labels) && c.labels.length ? c.labels.map(String) : null;
    const { rows } = usage ? await measurePool({ stateDir, credentialsPath, fetchImpl, now, labels }) : { rows: [] };
    const d = decideSwitch({ current, candidates: rows.filter((r) => r.label !== back.label), cfg: c, now, lastSwitchAt: readCurrent(stateDir)?.lastSwitch?.at });
    if (!d.to) return no(d.reason, back.label);
    return await switchTo(d.to, { stateDir, credentialsPath, fetchImpl, whoami, now, log, reason: d.reason, exhaustedUntil: d.exhaustedUntil });
  } catch (e) {
    return no(`자동 전환 오류 — ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// ── 명령줄 ────────────────────────────────────────────────────────────────
/** 상태 폴더 — 러너와 같은 순서: --state-dir → AUTO_BATCH_STATE_DIR → tools/auto/auto.config.json stateDir → ~/.claude-auto/<project>. */
export function resolveStateDir({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const i = argv.indexOf('--state-dir');
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  if (env.AUTO_BATCH_STATE_DIR) return env.AUTO_BATCH_STATE_DIR;
  const cfg = readJson(join(cwd, 'tools', 'auto', 'auto.config.json')) ?? {};
  if (cfg.stateDir) return cfg.stateDir;
  return join(homedir(), '.claude-auto', cfg.project || basename(resolve(cwd)));
}

const fmtPct = (x) => (Number.isFinite(x?.pct) ? `${x.pct}%` : '—');
export function renderStatus(st) {
  const lines = [`[ACCOUNT] 현재 표식 ${st.current ?? '없음'} · 지금 CLI 로그인 = ${st.liveLabel ?? '풀에 없는 계정(save 필요)'}`
    + (st.lastSwitch ? ` · 직전 전환 ${st.lastSwitch.from} → ${st.lastSwitch.to} (${kst(Date.parse(st.lastSwitch.at))})` : '')];
  for (const r of st.rows) {
    const u = r.usage;
    const scoped = u ? (u.scoped ?? []).map((s) => `${s.model} ${fmtPct(s)}`).join(' · ') : '';
    const tok = `토큰 ${r.tokenTail}${r.expired ? ' 만료(다음 사용 때 CLI 갱신)' : ''}${r.refreshable ? '' : ' · 갱신 토큰 만료 → 재로그인 필요'}`;
    lines.push(`  ${r.live ? '▶' : ' '} ${r.label} (${r.email}) — ${u ? `세션 ${fmtPct(u.fiveHour)} · 주간 ${fmtPct(u.sevenDay)}${scoped ? ` · ${scoped}` : ''}` : '조회 실패'} · ${tok}`
      + (r.exhaustedUntil ? ` · 찬 것으로 기록(~${kst(r.exhaustedUntil)})` : ''));
  }
  if (!st.rows.length) lines.push('  (풀이 비어 있다 — `claude auth login` 후 save <라벨>)');
  if (st.verdict) lines.push(`  자동 전환 판정: ${st.verdict.to ? `→ ${st.verdict.to} (${st.verdict.reason})` : st.verdict.reason || '전환 불필요(현재 계정 여유)'}`);
  return lines.join('\n');
}

async function main(argv) {
  const [cmd, label] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--state-dir');
  const stateDir = resolveStateDir({ argv });
  const cfg = (readJson(join(process.cwd(), 'tools', 'auto', 'auto.config.json')) ?? {}).accounts;
  const usage = '사용법: node account-pool.mjs save <라벨> | status | switch <라벨> | save-back  [--state-dir <폴더>]';
  if (cmd === 'save') { if (!label) throw new Error(usage); await save(label, { stateDir }); return; }
  if (cmd === 'status') { console.log(`[ACCOUNT] 상태 폴더 ${stateDir}`); console.log(renderStatus(await status({ stateDir, cfg }))); return; }
  if (cmd === 'switch') { if (!label) throw new Error(usage); await switchTo(label, { stateDir, reason: '수동' }); return; }
  if (cmd === 'save-back') {
    const r = await saveBack({ stateDir });
    console.log(r.ok ? `[ACCOUNT] 쓴 뒤 저장 ${r.label} — ${r.updated ? '갱신된 토큰 반영' : '변경 없음'} (${r.via})` : `⚠ [ACCOUNT] ${r.reason}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  throw new Error(usage);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`✖ [ACCOUNT] ${String(e?.message ?? e)}`); process.exit(1); });
}
