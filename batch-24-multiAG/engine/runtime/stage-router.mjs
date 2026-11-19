import { canonicalModel, claudeCrossPolicy, modelCandidates, providerOf, selectModel } from './model-policy.mjs';
import { readModelHealth, recordModelEvent } from './model-health.mjs';

export class StageRouter {
  constructor({ stateDir, providers, exhausted = [], claudeLadder = null, codexDev = null, reviewMinTier = 3, claudeCross = null, now = () => Date.now() }) {
    this.stateDir = stateDir;
    this.providers = providers;
    this.exhaustedProviders = exhausted.filter((value) => ['claude', 'codex'].includes(String(value)));
    this.exhausted = exhausted.filter((value) => !this.exhaustedProviders.includes(String(value))).map(canonicalModel);
    this.claudeLadder = claudeLadder;
    this.codexDev = codexDev; // 👤 2026-09-26 (나) modelPolicy.codexDev — Codex 구현 허용 정책(없으면 종전 경계)
    this.reviewMinTier = reviewMinTier; // 👤 2026-10-21 reviewMinTier — 위험도 4 이상 검토 하한(없으면 3)
    this.claudeCross = claudeCross; // 👤 2026-11-18 modelPolicy.claudeCross — Claude 구현분을 다른 Claude 모델(fable)이 검토하는 좁은 예외(없으면 종전)
    this.now = now;
  }
  choose({ role, risk, difficulty, preferred = '', avoid = '', attempted = [], preferProvider = 'claude', limitRelief = false }) {
    const health = readModelHealth(this.stateDir, this.now());
    // BMad planning and mockups currently require the Claude skill adapter.
    // claudeCross.review 로 **명시 지정한 검토 모델**은 환경값 사다리(AUTO_MODEL_LADDER · PC 공용)에 없어도 review 역할에 한해 쓴다 —
    // 사다리가 그 모델을 막으면 검토 가용 모델이 0 이 된다(exit 5 반복). 구현·계획 단계와 그 밖의 모델은 종전대로 사다리를 따른다.
    const cc = claudeCrossPolicy(this.claudeCross);
    const ladderExempt = (model) => role === 'review' && cc.enabled && model === cc.review;
    const candidates = modelCandidates({ role, risk, difficulty, preferProvider, limitRelief, codexDev: this.codexDev, avoid, reviewMinTier: this.reviewMinTier, claudeCross: this.claudeCross })
      .filter((m) => ['dev', 'review'].includes(role) || providerOf(m) === 'claude');
    return selectModel({ role, risk, difficulty, preferred, avoid, providers: this.providers,
      blocked: (model) => this.exhaustedProviders.includes(providerOf(model)) || health.blocked(model) ||
        (providerOf(model) === 'claude' && this.claudeLadder && !this.claudeLadder.includes(model) && !ladderExempt(model)),
      exclude: [...this.exhausted, ...attempted], candidates, limitRelief, codexDev: this.codexDev, reviewMinTier: this.reviewMinTier, claudeCross: this.claudeCross,
      crossProvider: true });
  }
  record(model, kind, extra = {}) {
    return recordModelEvent(this.stateDir, { ...extra, model, kind, now: this.now() });
  }
}

/** Stable across queue regrouping; never uses the position of a story in a batch. */
export function preferredDevProvider(story) {
  return [...String(story)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2 ? 'codex' : 'claude';
}
