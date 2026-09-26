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

/** Codex 구현(dev) 허용 정책 — 👤 2026-09-26 「astra·sol 을 더 써서 opus 사용량을 줄여줘」 → (나) · 같은 날 20:5x 「opus 를 astra 로 대체 · astra 하던 일을 opus 가」.
 *  설정 `modelPolicy.codexDev = { enabled, maxRisk, models, review }` 가 켜져 있을 때만 dev 후보에 Codex 모델이 들어가고
 *  위험도 상한(maxRisk)까지 허용한다. 꺼져 있으면(기본) 종전 경계 그대로 — 고위험(risk ≥ 4) 구현은 Claude 만.
 *  models = dev 를 맡을 Codex 모델 목록(기본 sol) · review = Codex 구현 뒤 리뷰를 맡을 **Claude** 모델(예: opus · 비우면 codex 의 다른 모델이 리뷰).
 *  review 를 적으면 Codex 구현 스토리에 한해 리뷰 품질 하한이 그 모델의 tier 까지 내려간다(👤 20:5x 결정 — opus 리뷰) · Claude 리뷰는 stream-json 열람 증거로 T6 를 채운다. */
export const CODEX_DEV_DEFAULT = Object.freeze({ enabled: false, maxRisk: 3, models: Object.freeze(['codex:gpt-5.6-sol']), review: '' });
export function codexDevPolicy(policy = null) {
  const p = policy && typeof policy === 'object' ? policy : {};
  const models = (Array.isArray(p.models) ? p.models : CODEX_DEV_DEFAULT.models).map(canonicalModel)
    .filter((m) => MODEL_CATALOG[m]?.provider === 'codex');
  const maxRisk = Number.isFinite(Number(p.maxRisk)) ? Math.max(0, Math.min(10, Number(p.maxRisk))) : CODEX_DEV_DEFAULT.maxRisk;
  const review = canonicalModel(p.review ?? '');
  return { enabled: p.enabled === true && models.length > 0, maxRisk, models: models.length ? models : [...CODEX_DEV_DEFAULT.models],
    review: MODEL_CATALOG[review]?.provider === 'claude' ? review : '' };
}
/** 이 위험도의 구현을 Codex 에 줄 수 있는가(정책이 켜져 있고 상한 안). */
export const codexDevAllowed = (risk, policy = null) => { const p = codexDevPolicy(policy); return p.enabled && Number(risk ?? 0) <= p.maxRisk; };
/** codex 끼리의 교차 — 제공자가 같아도 **모델**이 다르면(sol ≠ astra) 다른 눈으로 인정한다. */
export const codexPairCross = (a, b) => providerOf(canonicalModel(a)) === 'codex' && providerOf(canonicalModel(b)) === 'codex' && canonicalModel(a) !== canonicalModel(b);

export function modelCandidates({ role = 'dev', risk = 0, difficulty = 5, preferProvider = 'claude', limitRelief = false, codexDev = null, avoid = '' } = {}) {
  if (['orchestrate', 'create', 'replan', 'mockup'].includes(role)) return ['fable', 'opus', 'codex:gpt-6-astra', 'codex:gpt-5.6-sol'];
  const low = risk < 4 && difficulty <= 3;
  const claude = risk >= 4 ? ['fable', 'opus'] : low ? ['sonnet', 'opus', 'fable'] : ['opus', 'fable'];
  const codex = risk >= 4 && role === 'review' ? ['codex:gpt-6-astra'] : low ? ['codex:gpt-5.6-terra', 'codex:gpt-5.6-sol', 'codex:gpt-6-astra'] : ['codex:gpt-5.6-sol', 'codex:gpt-6-astra'];
  // The verifiable pairing is Claude implementation + Codex review (Claude review carries read evidence only
  // through the stream-json trace — providers/claude.mjs parseClaudeTrace — which the review stage enables).
  // 👤 2026-09-07 「1 추천대로」: 사용량 한도(exit 5) 때 **회수 dev 만** sonnet 까지 강등을 허용한다(limitRelief).
  // 👤 2026-09-26 (나): modelPolicy.codexDev 가 켜져 있으면 dev 후보에 Codex 구현 모델이 든다 — 리뷰는 codexDev.review(Claude · 예 opus) 또는 codex 의 다른 모델.
  const cd = codexDevPolicy(codexDev);
  if (role === 'dev') {
    const base = limitRelief && !claude.includes('sonnet') ? [...claude, 'sonnet'] : claude;
    if (!codexDevAllowed(risk, codexDev)) return base;
    return preferProvider === 'codex' ? [...cd.models, ...base] : [...base, ...cd.models];
  }
  if (role === 'review') {
    if (cd.enabled && cd.review && providerOf(canonicalModel(avoid)) === 'codex') return [cd.review, ...codex];
    return codex;
  }
  return preferProvider === 'codex' ? [...codex, ...claude] : [...claude, ...codex];
}

export function selectModel({ role = 'dev', risk = 0, difficulty = 5, preferred = '', avoid = '', providers = {}, blocked = () => false, preferProvider = 'claude', crossProvider = true, exclude = [], candidates = null, limitRelief = false, codexDev = null } = {}) {
  const initial = canonicalModel(preferred);
  const previous = canonicalModel(avoid);
  const cd = codexDevPolicy(codexDev);
  const pool = [...new Set([initial, ...(candidates ?? modelCandidates({ role, risk, difficulty, preferProvider, limitRelief, codexDev, avoid }))].filter(Boolean))];
  // limitRelief 는 dev 에서만 하한을 1(sonnet)로 내린다 — review 하한(3/2)은 어떤 사유로도 내려가지 않는다.
  // 예외(👤 2026-09-26 20:5x 「astra 하던 일을 opus 가」): Codex 구현 스토리의 리뷰를 codexDev.review(Claude) 가 맡을 때만 그 모델의 tier 까지.
  const minimumTier = limitRelief && role === 'dev' ? 1 : risk >= 4 && role === 'review' ? 3 : ['orchestrate', 'create', 'replan', 'mockup'].includes(role) || difficulty > 3 || risk >= 4 ? 2 : 1;
  const claudeReviewAfterCodex = role === 'review' && cd.enabled && Boolean(cd.review) && previous && providerOf(previous) === 'codex';
  const floorFor = (model) => claudeReviewAfterCodex && model === cd.review ? Math.min(minimumTier, MODEL_CATALOG[model].tier) : minimumTier;
  for (const model of pool) {
    const meta = MODEL_CATALOG[model];
    if (!meta || meta.tier < floorFor(model) || exclude.includes(model) || blocked(model)) continue;
    const provider = providers[meta.provider];
    if (provider?.enabled === false || provider?.available === false || provider?.max === 0) continue;
    if (meta.provider === 'codex' && !provider?.enabled) continue;
    if (Array.isArray(provider?.roles) && !provider.roles.includes(role)) continue;
    // Keep the existing project boundary: high-risk implementation stays on Claude —
    // unless modelPolicy.codexDev opens Codex implementation up to its maxRisk (and only for its listed models).
    if (role === 'dev' && meta.provider === 'codex' && !(cd.enabled ? (risk <= cd.maxRisk && cd.models.includes(model)) : risk < 4)) continue;
    // Review must be a different eye: a different provider, or — when Codex implements (codexDev) — a different Codex model.
    if (role === 'review' && previous && (model === previous || (crossProvider && meta.provider === providerOf(previous) && !(cd.enabled && codexPairCross(model, previous))))) continue;
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
