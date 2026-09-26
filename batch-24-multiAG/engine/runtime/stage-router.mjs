import { canonicalModel, modelCandidates, providerOf, selectModel } from './model-policy.mjs';
import { readModelHealth, recordModelEvent } from './model-health.mjs';

export class StageRouter {
  constructor({ stateDir, providers, exhausted = [], claudeLadder = null, codexDev = null, now = () => Date.now() }) {
    this.stateDir = stateDir;
    this.providers = providers;
    this.exhaustedProviders = exhausted.filter((value) => ['claude', 'codex'].includes(String(value)));
    this.exhausted = exhausted.filter((value) => !this.exhaustedProviders.includes(String(value))).map(canonicalModel);
    this.claudeLadder = claudeLadder;
    this.codexDev = codexDev; // 👤 2026-09-26 (나) modelPolicy.codexDev — Codex 구현 허용 정책(없으면 종전 경계)
    this.now = now;
  }
  choose({ role, risk, difficulty, preferred = '', avoid = '', attempted = [], preferProvider = 'claude', limitRelief = false }) {
    const health = readModelHealth(this.stateDir, this.now());
    // BMad planning and mockups currently require the Claude skill adapter.
    const candidates = modelCandidates({ role, risk, difficulty, preferProvider, limitRelief, codexDev: this.codexDev, avoid })
      .filter((m) => ['dev', 'review'].includes(role) || providerOf(m) === 'claude');
    return selectModel({ role, risk, difficulty, preferred, avoid, providers: this.providers,
      blocked: (model) => this.exhaustedProviders.includes(providerOf(model)) || health.blocked(model) ||
        (providerOf(model) === 'claude' && this.claudeLadder && !this.claudeLadder.includes(model)),
      exclude: [...this.exhausted, ...attempted], candidates, limitRelief, codexDev: this.codexDev,
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
