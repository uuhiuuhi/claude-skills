// 사용량 API 직접 읽기 (👤 2026-09-09 「2 a」 — 엔진 동결 예외)
//
// 왜: CLI 의 실패 문구는 한도의 **종류**를 말해 주지 않는다. 2026-09-09 실측 — Fable 주간 모델별 한도 100% 인데
// `claude -p --model fable` 은 「You've hit your monthly spend limit」(크레딧 지갑 문구)를 냈고, 엔진은 그것을
// spend(프로바이더 전체 30분 차단)로 기록해 **살아 있는 opus 까지** 「가용 모델 없음」으로 세웠다(밤 신규 dev 0건).
// 같은 계정·같은 시각에 헤드리스 opus·sonnet 은 정상이었다. 사용량 화면(claude.ai/settings/usage)이 읽는 것과 같은
// 응답(`api/oauth/usage`)을 엔진이 직접 읽으면 세션(5시간)·주간(전체)·주간 모델별·크레딧을 **각각** 알 수 있다.
//
// 규율: ① 토큰은 어떤 로그·오류·스냅샷에도 쓰지 않는다 ② 실패는 usage null + 사유 코드(프로브 실패가 배치를 세우지 않는다 · 2026-11-14 사유 분리·만료 토큰 갱신)
//       ③ 판정은 「모델별 한도 → 그 모델만 · 세션/주간 전체 → Claude 전 모델 · 크레딧 → 무시(플랜 몫으로 계속)」
//       ④ 기록은 model-health 의 `limit`(모델 스코프 · retryAt = 리셋 시각) — spend(프로바이더 스코프)를 쓰지 않는다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readModelHealth, recordModelEvent } from './model-health.mjs';
import { canonicalModel } from './model-policy.mjs';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_MODELS = Object.freeze(['fable', 'opus', 'sonnet']);
export const SNAPSHOT_FILE = 'usage-snapshot.json';
const SNAPSHOT_MAX_AGE_MS = 45 * 60_000; // 30분 슬롯 + 여유 — 이보다 낡은 스냅샷은 판정에 쓰지 않는다

const defaultCredentialsPath = () => join(homedir(), '.claude', '.credentials.json');

/** 자격 파일의 { token, expiresAt }. 토큰이 없거나 형식 불량이면 token null. 값은 호출자에게만 돌아간다. */
export function readOauth(credentialsPath = defaultCredentialsPath()) {
  try {
    const o = JSON.parse(readFileSync(credentialsPath, 'utf8'))?.claudeAiOauth;
    const token = typeof o?.accessToken === 'string' && o.accessToken.length > 20 ? o.accessToken : null;
    const exp = Number(o?.expiresAt);
    return { token, expiresAt: o?.expiresAt != null && Number.isFinite(exp) ? exp : null };
  } catch { return { token: null, expiresAt: null }; }
}

/** `~/.claude/.credentials.json` 의 claude.ai OAuth 액세스 토큰. 없으면 null. 값은 호출자에게만 돌아간다. */
export function readOauthToken(credentialsPath = defaultCredentialsPath()) { return readOauth(credentialsPath).token; }

/** 만료 토큰 갱신 = 가벼운 CLI 호출 한 번(CLI 가 갱신 토큰으로 새 액세스 토큰을 받아 자격 파일에 쓴다 — 계정 풀의
 *  「전환 뒤 첫 claude -p 가 갱신 → saveBack 이 풀에 저장」과 같은 길). 직접 refresh 엔드포인트를 부르면 갱신 토큰이
 *  회전해 풀 사본과 어긋나므로 쓰지 않는다. 출력은 버린다(토큰이 로그에 실릴 길이 없다). 성공 여부만 돌려준다. */
export function refreshViaCli({ claudeBin = process.env.CLAUDE_BIN || 'claude', run = spawnSync, timeoutMs = 90_000 } = {}) {
  try {
    const r = run(claudeBin, ['-p', 'ok', '--model', 'haiku'], { timeout: timeoutMs, stdio: ['ignore', 'ignore', 'ignore'] });
    return r?.status === 0;
  } catch { return false; }
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const when = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null; };
const modelOfScope = (scope) => {
  const name = String(scope?.model?.display_name ?? scope?.model?.id ?? '').toLowerCase();
  return CLAUDE_MODELS.find((m) => name.includes(m)) ?? (name || null);
};

/** 응답 → 엔진이 쓰는 형태. 알 수 없는 필드는 무시하고, 없는 값은 null 이다(0 으로 꾸미지 않는다). */
export function normalizeUsage(json, now = Date.now()) {
  if (!json || typeof json !== 'object') return null;
  const limits = Array.isArray(json.limits) ? json.limits : [];
  // none = 응답이 그 칸을 null 로 **명시**했고 limits 에도 항목이 없다 = 그 한도가 없는 계정(2026-11-14 실측 five_hour: null).
  // 칸이 아예 없거나(빈 응답) 항목이 있는데 값이 비면 측정 실패다 — none 이 아니다.
  const pick = (kind, key) => {
    const l = limits.find((x) => x?.kind === kind);
    const fallback = json[key];
    const src = l ?? fallback ?? null;
    const out = { pct: num(l?.percent ?? fallback?.utilization), resetsAt: when(src?.resets_at) };
    if (!l && key in json && json[key] === null) out.none = true;
    return out;
  };
  const scoped = limits.filter((x) => x?.kind === 'weekly_scoped').map((x) => ({
    model: modelOfScope(x.scope), pct: num(x.percent), resetsAt: when(x.resets_at), active: x.is_active === true,
  })).filter((x) => x.model);
  const eu = json.extra_usage ?? json.spend ?? null;
  const euPct = eu ? num(eu.utilization ?? eu.percent) : null;
  return {
    schema: 'batch-24-multiag/usage-snapshot/1', at: now,
    fiveHour: pick('session', 'five_hour'), sevenDay: pick('weekly_all', 'seven_day'), scoped,
    extraUsage: eu ? { enabled: eu.is_enabled === true || eu.enabled === true, reached: eu.spend_limit_reached === true || (euPct !== null && euPct >= 100), pct: euPct } : null,
  };
}

/** 실패 사유 코드 → 사람이 읽는 말. 토큰·URL 없음. */
export const FAIL_REASONS = Object.freeze({ 'no-token': '토큰 없음', expired: '토큰 만료(갱신 실패)', timeout: '시간 초과', network: '네트워크 오류', 'bad-json': '응답 형식 불량' });
export const failText = (reason) => FAIL_REASONS[reason] ?? (/^http-\d+$/.test(String(reason)) ? `HTTP ${String(reason).slice(5)}` : '원인 미상');

/** 실제 조회 → { usage, reason, refreshed }. reason = null(성공) | 'no-token' | 'expired' | 'http-<코드>' | 'timeout' | 'network' | 'bad-json'.
 *  토큰을 넘기지 않으면 자격 파일에서 읽고, expiresAt 이 지났으면 조회 전에 refresh() 로 한 번 갱신해 다시 읽는다.
 *  명시 토큰(계정 풀의 다른 계정)은 갱신하지 않는다. 오류 문구·사유에 토큰이 실릴 수 없다(헤더로만 보낸다). */
export async function fetchClaudeUsageResult(opts = {}) {
  let { token } = opts;
  const { credentialsPath = defaultCredentialsPath(), refresh = refreshViaCli, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now(), url = USAGE_URL } = opts;
  let refreshed = false;
  // `token` 키를 넘긴 호출(계정 풀 — 값이 비었어도)은 자격 파일을 읽지도 갱신하지도 않는다.
  if (!Object.hasOwn(opts, 'token')) {
    let cred = readOauth(credentialsPath);
    if (cred.token && cred.expiresAt !== null && cred.expiresAt <= now) {
      try { refreshed = refresh() === true; } catch { refreshed = false; }
      if (refreshed) cred = readOauth(credentialsPath);
      if (!cred.token) return { usage: null, reason: 'no-token', refreshed };
      if (cred.expiresAt !== null && cred.expiresAt <= now) return { usage: null, reason: 'expired', refreshed };
    }
    token = cred.token;
  }
  if (!token) return { usage: null, reason: 'no-token', refreshed };
  if (typeof fetchImpl !== 'function') return { usage: null, reason: 'network', refreshed };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: ac.signal });
    if (!res || res.status !== 200) return { usage: null, reason: `http-${Number(res?.status) || 0}`, refreshed };
    const usage = normalizeUsage(await res.json().catch(() => null), now);
    return { usage, reason: usage ? null : 'bad-json', refreshed };
  } catch (e) {
    return { usage: null, reason: ac.signal.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'timeout' : 'network', refreshed };
  } finally { clearTimeout(timer); }
}

/** 종전 호출자(계정 풀)용 — 사용량 또는 null. */
export async function fetchClaudeUsage(opts = {}) { return (await fetchClaudeUsageResult(opts)).usage; }

/** 한도 판정 → 모델별 차단 목록. 모델별 한도는 그 모델만, 세션/주간 전체는 전 모델. 크레딧은 차단 사유가 아니다. */
export function usageBlocks(usage, { now = Date.now(), models = CLAUDE_MODELS } = {}) {
  if (!usage) return [];
  const out = new Map();
  const add = (model, retryAt, reason) => {
    if (!models.includes(model) || !Number.isFinite(retryAt) || retryAt <= now) return;
    const prev = out.get(model);
    if (!prev || retryAt > prev.retryAt) out.set(model, { model, retryAt, reason: prev ? `${prev.reason} · ${reason}` : reason });
    else prev.reason = `${prev.reason} · ${reason}`;
  };
  if (usage.fiveHour?.pct >= 100) for (const m of models) add(m, usage.fiveHour.resetsAt, `세션 ${usage.fiveHour.pct}%`);
  if (usage.sevenDay?.pct >= 100) for (const m of models) add(m, usage.sevenDay.resetsAt, `주간 전체 ${usage.sevenDay.pct}%`);
  // is_active 는 「이 모델별 한도가 표시 대상인가」이지 소진이 아니다 — 2026-09-27 05:06 fable 12%(is_active) 를 09-30 까지 막아 지휘 opus 대체·마감 재검수 exit 5.
  for (const s of usage.scoped ?? []) if (s.pct >= 100) add(s.model, s.resetsAt, `${s.model} 주간 모델별 ${s.pct}%`);
  return [...out.values()];
}

export const kst = (t) => (Number.isFinite(t) ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(5, 16) : '-');

/** 차단 목록을 model-health 에 `limit`(모델 스코프 · retryAt = 리셋)으로 기록한다. 기록한 이벤트를 돌려준다. */
export function applyUsageToHealth(stateDir, usage, { now = Date.now(), models = CLAUDE_MODELS } = {}) {
  return usageBlocks(usage, { now, models }).map((b) =>
    recordModelEvent(stateDir, { model: b.model, kind: 'limit', now, retryAt: b.retryAt, role: 'usage-probe', detail: `usage API: ${b.reason} · 리셋 ${kst(b.retryAt)}` }));
}

/** usageBlocks 의 **반대 조건** — 세션·주간 전체가 둘 다 실측돼 100% 아래이고, 그 모델의 모델별 한도(있으면)도 전부
 *  실측돼 100% 아래인 모델 목록. 값이 하나라도 없으면(null) 측정 실패로 보고 넣지 않는다. */
export function usageClears(usage, { models = CLAUDE_MODELS } = {}) {
  if (!usage) return [];
  const under = (x) => Number.isFinite(x?.pct) && x.pct < 100;
  // 세션 한도가 없는 계정(none)은 세션 조건을 통과한다 — 주간은 늘 실측이 있어야 한다.
  if (!(under(usage.fiveHour) || usage.fiveHour?.none === true) || !under(usage.sevenDay)) return [];
  return models.filter((m) => (usage.scoped ?? []).filter((s) => s.model === m).every(under));
}

/** 계정 교체 등으로 한도가 기준 아래로 내려왔는데 model-health 에 아직 유효한 `limit`(retryAt > now)이 최신이면
 *  그 모델 scope 에 `clear` 를 적는다(2026-10-11 실사고 — 예전 limit 이 retryAt 까지 모델을 막아 success 가 영영 안 적힘).
 *  기존 사건은 고치지 않고 추가만 한다 · 최신이 이미 clear/success(또는 limit 이 아님)면 적지 않는다(반복 측정에 쌓이지 않게).
 *  provider 전체 auth·spend·transient 는 건드리지 않는다(실제 호출 성공이 아니므로). 기록한 clear 사건을 돌려준다. */
export function applyUsageClears(stateDir, usage, { now = Date.now(), models = CLAUDE_MODELS } = {}) {
  const clears = usageClears(usage, { models });
  if (!stateDir || !clears.length) return [];
  const latest = new Map(readModelHealth(stateDir, now).events.map((e) => [e.scope, e]));
  const pct = (x) => `${x.pct}%`;
  const session = usage.fiveHour?.none === true ? '세션 한도 없음' : `세션 ${pct(usage.fiveHour)}`;
  return clears.flatMap((model) => {
    const prev = latest.get(canonicalModel(model));
    if (!prev || prev.kind !== 'limit' || !(prev.retryAt > now)) return [];
    const scoped = (usage.scoped ?? []).filter((s) => s.model === model).map((s) => ` · ${model} 주간 모델별 ${pct(s)}`).join('');
    return [recordModelEvent(stateDir, { model, kind: 'clear', now, role: 'usage-probe',
      detail: `usage API: ${session} · 주간 전체 ${pct(usage.sevenDay)}${scoped} — 기준(100%) 아래 · 직전 limit(리셋 ${kst(prev.retryAt)}) 해제` })];
  }).filter(Boolean);
}

export function writeUsageSnapshot(stateDir, usage) {
  if (!stateDir || !usage) return null;
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, SNAPSHOT_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(usage, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  return file;
}

/** 워커(동기 코드)가 읽는 최근 스냅샷. 낡았거나 없으면 null — 낡은 값으로 판정하지 않는다. */
export function readUsageSnapshot(stateDir, { now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  try {
    if (!stateDir) return null;
    const file = join(stateDir, SNAPSHOT_FILE);
    if (!existsSync(file)) return null;
    const u = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(u?.at) || now - u.at > maxAgeMs) return null;
    return u;
  } catch { return null; }
}

/** 「spend limit」 문구를 받은 모델에 대해 스냅샷이 **플랜 한도**를 증언하면 limit(모델 스코프)로 바꿔 읽는다.
 *  증언이 없으면 null — 그때는 진짜 크레딧 지갑 문제로 두고 종전대로 spend 다. */
export function reclassifySpend(usage, model, now = Date.now()) {
  const b = usageBlocks(usage, { now }).find((x) => x.model === String(model));
  return b ? { kind: 'limit', retryAt: b.retryAt, reason: b.reason } : null;
}

/** 사람이 읽는 한 줄 — 브리핑·텔레그램용. 토큰·URL 없음. */
export function usageLine(usage, reason = null) {
  if (!usage) return `[USAGE] 조회 실패(${reason ? failText(reason) : '원인 미상'}) — CLI 문구로만 판정`;
  const pct = (x) => (x?.pct === null || x?.pct === undefined ? '—' : `${x.pct}%`);
  const seg = [usage.fiveHour?.none === true ? '세션 한도 없음' : `세션 ${pct(usage.fiveHour)}(리셋 ${kst(usage.fiveHour?.resetsAt)})`, `주간 ${pct(usage.sevenDay)}(${kst(usage.sevenDay?.resetsAt)})`];
  for (const s of usage.scoped ?? []) seg.push(`${s.model} ${pct(s)}${s.pct >= 100 ? '🔴' : ''}(${kst(s.resetsAt)})`);
  if (usage.extraUsage) seg.push(`크레딧 ${usage.extraUsage.reached ? '소진' : usage.extraUsage.enabled ? '사용 중' : '꺼짐'}`);
  return `[USAGE] ${seg.join(' · ')}`;
}

/** 슬롯 시작용 — 조회 → 스냅샷 → model-health. 실패는 { usage: null, blocks: [], reason }. */
export async function probeUsage({ stateDir, enabled = true, now = Date.now(), ...opts } = {}) {
  if (!enabled) return { usage: null, blocks: [], skipped: true };
  const { usage, reason } = await fetchClaudeUsageResult({ now, ...opts });
  if (!usage) return { usage: null, blocks: [], reason };
  writeUsageSnapshot(stateDir, usage);
  const events = applyUsageToHealth(stateDir, usage, { now });
  const cleared = applyUsageClears(stateDir, usage, { now });
  return { usage, blocks: events.map((e) => ({ model: e.model, retryAt: e.retryAt })), clears: cleared.map((e) => e.model) };
}
