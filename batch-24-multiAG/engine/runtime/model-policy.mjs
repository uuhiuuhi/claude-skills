// Shared by the planner and workers. Model IDs are explicit; CLI defaults are never a policy.
export const MODEL_CATALOG = Object.freeze({
  fable: { provider: 'claude', tier: 3 },
  opus: { provider: 'claude', tier: 2 },
  sonnet: { provider: 'claude', tier: 1 },
  'codex:gpt-6-astra': { provider: 'codex', tier: 3, effort: 'high' },
  'codex:gpt-5.6-sol': { provider: 'codex', tier: 2, effort: 'high' },
  'codex:gpt-5.6-terra': { provider: 'codex', tier: 1, effort: 'medium' },
});
export const providerOf = (model) => MODEL_CATALOG[model]?.provider ?? (/^codex(:|$)/.test(model) ? 'codex' : 'claude');
export const canonicalModel = (model) => model === 'codex' ? 'codex:gpt-6-astra' : String(model ?? '').replace(/^claude:/, '');

export function modelCandidates({ role = 'dev', risk = 0, difficulty = 5, preferProvider = 'claude', limitRelief = false } = {}) {
  if (['orchestrate', 'create', 'replan', 'mockup'].includes(role)) return ['fable', 'opus', 'codex:gpt-6-astra', 'codex:gpt-5.6-sol'];
  const low = risk < 4 && difficulty <= 3;
  const claude = risk >= 4 ? ['fable', 'opus'] : low ? ['sonnet', 'opus', 'fable'] : ['opus', 'fable'];
  const codex = risk >= 4 && role === 'review' ? ['codex:gpt-6-astra'] : low ? ['codex:gpt-5.6-terra', 'codex:gpt-5.6-sol', 'codex:gpt-6-astra'] : ['codex:gpt-5.6-sol', 'codex:gpt-6-astra'];
  // The verifiable pairing is Claude implementation + Codex review. Claude's
  // print adapter does not expose tool-read evidence, so Codex implementation
  // followed by a clean Claude review cannot satisfy the completion manifest.
  // 👤 2026-09-07 「1 추천대로」: 사용량 한도(exit 5) 때 **회수 dev 만** sonnet 까지 강등을 허용한다(limitRelief).
  if (role === 'dev') return limitRelief && !claude.includes('sonnet') ? [...claude, 'sonnet'] : claude;
  if (role === 'review') return codex;
  return preferProvider === 'codex' ? [...codex, ...claude] : [...claude, ...codex];
}

export function selectModel({ role = 'dev', risk = 0, difficulty = 5, preferred = '', avoid = '', providers = {}, blocked = () => false, preferProvider = 'claude', crossProvider = true, exclude = [], candidates = null, limitRelief = false } = {}) {
  const initial = canonicalModel(preferred);
  const previous = canonicalModel(avoid);
  const pool = [...new Set([initial, ...(candidates ?? modelCandidates({ role, risk, difficulty, preferProvider, limitRelief }))].filter(Boolean))];
  // limitRelief 는 dev 에서만 하한을 1(sonnet)로 내린다 — review 하한(3/2)은 어떤 사유로도 내려가지 않는다.
  const minimumTier = limitRelief && role === 'dev' ? 1 : risk >= 4 && role === 'review' ? 3 : ['orchestrate', 'create', 'replan', 'mockup'].includes(role) || difficulty > 3 || risk >= 4 ? 2 : 1;
  for (const model of pool) {
    const meta = MODEL_CATALOG[model];
    if (!meta || meta.tier < minimumTier || exclude.includes(model) || blocked(model)) continue;
    const provider = providers[meta.provider];
    if (provider?.enabled === false || provider?.available === false || provider?.max === 0) continue;
    if (meta.provider === 'codex' && !provider?.enabled) continue;
    if (Array.isArray(provider?.roles) && !provider.roles.includes(role)) continue;
    // Keep the existing project boundary: high-risk implementation stays on Claude.
    if (role === 'dev' && risk >= 4 && meta.provider === 'codex') continue;
    if (role === 'review' && previous && (model === previous || (crossProvider && meta.provider === providerOf(previous)))) continue;
    return { model, ...meta, reason: model === initial ? 'requested-and-eligible' : 'policy-selection' };
  }
  return null; // Never silently lower the required quality or invent an available model.
}

export function failureKind(text = '') {
  const value = String(text);
  if (/401|unauthori[sz]ed|authentication|token.{0,12}expired|not logged in/i.test(value)) return 'auth';
  if (/spend(ing)?.?limit/i.test(value)) return 'spend';
  if (/usage.?limit|rate.?limit|\b429\b|quota exceeded|limit (reached|exceeded|will reset)|reached your [^.\n]{0,40}limit|switch to another model|too many requests/i.test(value)) return 'limit';
  if (/model.{0,60}(not found|not available|unsupported)|unsupported.{0,30}model/i.test(value)) return 'unavailable';
  if (/\b(404|500|502|503|504|529)\b|overload|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|timed? ?out/i.test(value)) return 'transient';
  return 'other';
}

/** 사용량 한도(limit) 때의 강등 정책 — 👤 2026-09-07 「1 추천대로」: 마감 재검수(review)는 강등 금지, 회수 dev 만 허용.
 *  설정 `modelPolicy.limitDowngrade = { review: false, dev: { recovery: true, new: false } }` 가 기본이다.
 *  반환: 'block' = 한도면 다른 모델을 고르지 않고 리셋 대기(exit 5) · 'relax' = 품질 하한을 sonnet 까지 내려 계속 ·
 *  'floor' = 종전대로 역할 하한 안에서만 다음 모델(fable→opus). create/replan/mockup 은 정책 대상이 아니다(floor). */
export const LIMIT_DOWNGRADE_DEFAULT = Object.freeze({ review: false, dev: Object.freeze({ recovery: true, new: false }) });
export function limitDowngradeMode({ stage, batchKind = 'new', policy = null } = {}) {
  const p = { ...LIMIT_DOWNGRADE_DEFAULT, ...(policy && typeof policy === 'object' ? policy : {}) };
  if (stage === 'review') return p.review === true ? 'floor' : 'block';
  if (stage === 'dev') {
    const dev = p.dev && typeof p.dev === 'object' ? { ...LIMIT_DOWNGRADE_DEFAULT.dev, ...p.dev } : LIMIT_DOWNGRADE_DEFAULT.dev;
    const kind = batchKind === 'closeout' ? 'new' : batchKind; // 마감 재검수 배치의 dev(리뷰 상한 뒤 replan→dev)는 신규와 같은 잣대
    return dev[kind] === true ? 'relax' : 'floor';
  }
  return 'floor';
}
