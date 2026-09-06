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

export function modelCandidates({ role = 'dev', risk = 0, difficulty = 5, preferProvider = 'claude' } = {}) {
  if (['orchestrate', 'create', 'replan', 'mockup'].includes(role)) return ['fable', 'opus', 'codex:gpt-6-astra', 'codex:gpt-5.6-sol'];
  const low = risk < 4 && difficulty <= 3;
  const claude = risk >= 4 ? ['fable', 'opus'] : low ? ['sonnet', 'opus', 'fable'] : ['opus', 'fable'];
  const codex = risk >= 4 && role === 'review' ? ['codex:gpt-6-astra'] : low ? ['codex:gpt-5.6-terra', 'codex:gpt-5.6-sol', 'codex:gpt-6-astra'] : ['codex:gpt-5.6-sol', 'codex:gpt-6-astra'];
  // The verifiable pairing is Claude implementation + Codex review. Claude's
  // print adapter does not expose tool-read evidence, so Codex implementation
  // followed by a clean Claude review cannot satisfy the completion manifest.
  if (role === 'dev') return claude;
  if (role === 'review') return codex;
  return preferProvider === 'codex' ? [...codex, ...claude] : [...claude, ...codex];
}

export function selectModel({ role = 'dev', risk = 0, difficulty = 5, preferred = '', avoid = '', providers = {}, blocked = () => false, preferProvider = 'claude', crossProvider = true, exclude = [], candidates = null } = {}) {
  const initial = canonicalModel(preferred);
  const previous = canonicalModel(avoid);
  const pool = [...new Set([initial, ...(candidates ?? modelCandidates({ role, risk, difficulty, preferProvider }))].filter(Boolean))];
  const minimumTier = risk >= 4 && role === 'review' ? 3 : ['orchestrate', 'create', 'replan', 'mockup'].includes(role) || difficulty > 3 || risk >= 4 ? 2 : 1;
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
