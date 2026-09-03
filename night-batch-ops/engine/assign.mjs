// 워커 배정 규칙 — 2026-09-02 「9점대 하네스」
//
// 무엇을 대체하나: `runner-rules.assignProviders` 는 codex dev 를 **홀짝 인덱스**로 나눴다
// (i % 2 === 1). 스토리의 난이도·위험도·과거 성적과 무관한 분할이라, 마이그레이션·인증
// 같은 고위험 스토리가 우연히 짝수 자리에 오면 그대로 외부 벤더 dev 로 갔다.
// 여기서는 **점수로** 나눈다 — 난이도(작업량) · 위험도(보안/개인정보/청구/마이그레이션) ·
// 역할 · 프로바이더 가용성·슬롯 상한 · 최근 실패 기록.
//
// 불변식 3개(깨지면 배정이 아니라 사고다):
//   ① 고위험 스토리의 dev 는 Codex 에 주지 않는다(외부 벤더 · 실데이터 인접 · 롤백 비용).
//   ② review 는 dev 와 **다른 눈**이어야 한다 — 다른 프로바이더가 있으면 프로바이더를,
//      없으면 최소한 다른 모델을 쓴다(교차검증 · 자기 검증 금지).
//   ③ 같은 프로바이더가 그 스토리에서 **연속 2회 실패**했으면 회피한다(핑퐁 방지).
// 가용 프로바이더가 claude 하나뿐이면 전부 claude 로 돌아간다 — 배정이 배치를 세우지 않는다.
//
// 모든 함수는 순수·결정적이다(같은 입력 → 같은 출력).

import { isValidModelSpec } from './plan-dag.mjs'

/** 모델 스펙의 프로바이더 — "codex"·"codex:m" 만 codex(엔진 parseModelSpec 과 같은 규칙) */
export const specProvider = (s) => (/^codex(:|$)/i.test(String(s ?? '').trim()) ? 'codex' : 'claude')
/** claude 대체 사다리 — dev 와 겹치지 않는 모델을 고를 때만 쓴다(엔진 사다리와 같은 순서) */
export const CLAUDE_LADDER = Object.freeze(['opus', 'fable', 'sonnet'])
/** 이 점수 이상이면 고위험 — Codex dev 배제 */
export const HIGH_RISK_MIN = 4
/** 같은 프로바이더 연속 실패 상한 */
export const FAIL_STREAK_MAX = 2

const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/')

/** 위험 키워드 — 이월 금지 5범주(보안·권한 / 개인정보 / 데이터 손실 / 결제·청구 / 외부 발송)와 같은 축 */
export const RISK_KEYWORDS = Object.freeze([
  ['보안', 'security'], ['권한', 'permission'], ['RLS', 'rls'], ['auth', 'auth'],
  ['개인정보', 'privacy'], ['마스킹', 'masking'],
  ['결제', 'billing'], ['청구', 'billing'], ['payment', 'billing'],
  ['시크릿', 'secret'], ['자격증명', 'secret'], ['credential', 'secret'], ['token', 'secret'],
  ['외부 발송', 'egress'], ['배포', 'deploy'],
])

/** 위험도 0~10 — 파일 경로 + 스토리 본문 키워드. flags 에 근거를 남긴다. */
export function storyRisk({ files = [], text = '' } = {}) {
  const flags = []
  const add = (f, n) => { if (!flags.some((x) => x.flag === f)) flags.push({ flag: f, weight: n }) }
  for (const raw of files) {
    const p = norm(raw)
    if (/(^|\/)supabase\/migrations\//.test(p)) add('migration', 3)
    if (/(^|\/)(src\/)?(auth|security)\//.test(p) || /auth/i.test(p.split('/').pop() ?? '')) add('auth-path', 3)
    if (/\.env/.test(p)) add('env-file', 4)
    if (/(^|\/)supabase\/functions\//.test(p)) add('edge-function', 2)
  }
  const body = String(text ?? '')
  for (const [needle, flag] of RISK_KEYWORDS) if (body.includes(needle)) add(flag, 2)
  const score = Math.min(10, flags.reduce((a, f) => a + f.weight, 0))
  return { score, flags: flags.map((f) => f.flag).sort() }
}

/** 난이도 0~10 — File List 크기 · 마이그레이션 · 테스트 파일 수 · 스토리 md 길이 */
export function storyDifficulty({ files = [], text = '' } = {}) {
  const list = files.map(norm).filter(Boolean)
  const tests = list.filter((p) => /(^|\/)tests?\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p)).length
  const migrations = list.filter((p) => /(^|\/)supabase\/migrations\//.test(p)).length
  const len = String(text ?? '').length
  const parts = {
    files: Math.min(4, Math.ceil(list.length / 3)),
    migrations: migrations > 0 ? 2 : 0,
    tests: Math.min(2, tests),
    size: len > 20000 ? 2 : len > 8000 ? 1 : 0,
  }
  return { score: Math.min(10, parts.files + parts.migrations + parts.tests + parts.size), parts }
}

// ── 기록 저장소(assign-history.json · 상태 폴더) ─────────────────────────────
export const ASSIGN_HISTORY_FILE = 'assign-history.json'
export const emptyHistory = () => ({ version: 1, entries: {} })
const entryKey = (story, provider, role) => `${story}|${provider}|${role}`

/** 파일 내용(문자열·객체·null) → 정규화된 기록. 깨졌으면 빈 기록(편성이 서면 안 된다). */
export function parseHistory(input) {
  let raw = input
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return emptyHistory() } }
  if (!raw || typeof raw !== 'object' || typeof raw.entries !== 'object' || raw.entries === null) return emptyHistory()
  const entries = {}
  for (const [k, v] of Object.entries(raw.entries)) {
    if (!v || typeof v !== 'object') continue
    entries[k] = {
      attempts: Math.max(0, Number(v.attempts) || 0),
      fails: Math.max(0, Number(v.fails) || 0),
      failStreak: Math.max(0, Number(v.failStreak) || 0),
      rounds: Math.max(0, Number(v.rounds) || 0),
      avgRounds: Number.isFinite(Number(v.avgRounds)) ? Number(v.avgRounds) : 0,
    }
  }
  return { version: 1, entries }
}

/** 결과 1건 반영(순수 — 새 객체를 돌려준다). ok=false 면 연속 실패가 쌓이고 ok=true 면 0 으로 리셋. */
export function recordAssignResult(history, { story, provider, role = 'dev', ok = true, rounds = 1 } = {}) {
  const h = parseHistory(history)
  const key = entryKey(story, provider, role)
  const prev = h.entries[key] ?? { attempts: 0, fails: 0, failStreak: 0, rounds: 0, avgRounds: 0 }
  const attempts = prev.attempts + 1
  const totalRounds = prev.rounds + Math.max(0, Number(rounds) || 0)
  return {
    version: 1,
    entries: {
      ...h.entries,
      [key]: {
        attempts,
        fails: prev.fails + (ok ? 0 : 1),
        failStreak: ok ? 0 : prev.failStreak + 1,
        rounds: totalRounds,
        avgRounds: Number((totalRounds / attempts).toFixed(2)),
      },
    },
  }
}

/** 그 스토리·역할에서 프로바이더의 연속 실패 수(기록 없으면 0) */
export function providerFailStreak(history, provider, { story, role = 'dev' } = {}) {
  const h = parseHistory(history)
  return h.entries[entryKey(story, provider, role)]?.failStreak ?? 0
}

export const serializeHistory = (history) => JSON.stringify(parseHistory(history), null, 2) + '\n'
export const assignHistoryPath = (stateDir) => `${String(stateDir ?? '').replace(/[/\\]+$/, '')}/${ASSIGN_HISTORY_FILE}`

// ── 배정 ─────────────────────────────────────────────────────────────────
const usable = (p) => Boolean(p?.enabled ?? true) && (p?.available ?? true) !== false

/**
 * 워커 배정(순수).
 * stories   = [{ key, kind, files[], text }]
 * roles     = ['dev','review'] (repair 는 dev 배정을 따른다 — 같은 트리·같은 계약)
 * providers = { claude:{enabled,available,max}, codex:{enabled,available,max,roles[]} }
 * history   = assign-history.json 내용
 * config    = { models:{dev,review}, split:boolean }
 * 반환 [{ story, dev, review, devProvider, reviewProvider, difficulty, risk, flags, why }]
 */
export function assignWorkers({ stories = [], roles = ['dev', 'review'], providers = {}, history = null, config = {} } = {}) {
  const wantDev = roles.includes('dev') || roles.includes('repair')
  const wantReview = roles.includes('review')
  const claude = providers.claude ?? {}
  const codex = providers.codex ?? {}
  const codexOn = usable(codex) && Boolean(codex.enabled)
  const codexRoles = Array.isArray(codex.roles) ? codex.roles : ['review']
  const codexMax = Math.max(0, Number(codex.max ?? 1) || 0)
  const base = config.models ?? {}
  const baseDev = String(base.dev ?? '')
  const baseReview = String(base.review ?? '')
  // dev 와 겹치지 않는 claude 대체 모델(교차검증 유지). 배치 모델이 이미 claude 면 그것을 쓴다.
  const claudeAlt = (avoid) => {
    for (const m of [baseDev, baseReview, ...CLAUDE_LADDER]) {
      if (!m || specProvider(m) !== 'claude' || !isValidModelSpec(m)) continue
      if (avoid && m === avoid) continue
      return m
    }
    return ''
  }
  let codexBudget = codexOn ? codexMax : 0

  return stories.map((s, i) => {
    const story = String(s.key ?? s.story ?? '')
    const risk = storyRisk(s)
    const diff = storyDifficulty(s)
    const why = []
    let dev = baseDev
    let review = baseReview

    // ── dev ──
    if (wantDev) {
      const devCodexAllowed = codexOn && codexRoles.includes('dev') && codexBudget > 0 &&
        providerFailStreak(history, 'codex', { story, role: 'dev' }) < FAIL_STREAK_MAX
      if (specProvider(dev) === 'codex' && !devCodexAllowed) {
        dev = claudeAlt()
        why.push('codex dev 불가(미가용·역할 밖·연속 실패) → claude 폴백')
      }
      if (specProvider(dev) === 'codex' && risk.score >= HIGH_RISK_MIN) {
        dev = claudeAlt()
        why.push(`고위험(${risk.score}: ${risk.flags.join(',')}) — Codex dev 배제`)
      }
      // 명시 split: 난이도 낮고 위험 낮은 스토리부터 Codex dev 로 나눈다(교차는 review 가 맡는다)
      if (devCodexAllowed && Boolean(config.split) && specProvider(dev) !== 'codex' &&
        risk.score < HIGH_RISK_MIN && diff.score <= (Number(config.splitMaxDifficulty ?? 6)) && i > 0) {
        dev = 'codex'
        why.push(`split — 난이도 ${diff.score}·위험 ${risk.score} 로 Codex dev 배정`)
      }
      if (specProvider(dev) === 'codex') codexBudget--
      const devStreak = providerFailStreak(history, specProvider(dev), { story, role: 'dev' })
      if (devStreak >= FAIL_STREAK_MAX && specProvider(dev) === 'codex') {
        dev = claudeAlt()
        why.push(`codex dev 연속 실패 ${devStreak}회 — 회피`)
      }
    }

    // ── review ──
    if (wantReview) {
      const reviewCodexAllowed = codexOn && codexRoles.includes('review') && codexBudget > 0 &&
        providerFailStreak(history, 'codex', { story, role: 'review' }) < FAIL_STREAK_MAX
      if (specProvider(review) === 'codex' && !reviewCodexAllowed) {
        review = claudeAlt(dev)
        why.push('codex review 불가(미가용·역할 밖·연속 실패) → claude 폴백')
      }
      if (specProvider(review) === 'codex' && specProvider(dev) === 'codex') {
        review = claudeAlt(dev)
        why.push('dev·review 가 같은 프로바이더 — 교차검증 위해 review 를 claude 로')
      }
      if (specProvider(review) === 'codex') codexBudget--
      if (review && dev && review === dev) {
        review = claudeAlt(dev) || review
        why.push('dev 와 같은 모델 — 자기 검증 금지(교차 모델로 교체)')
      }
    }

    // ── 형식·교차 최종 보정 ── (순서 주의: 형식 위반을 먼저 비우고, 그 다음에 교차를 다시 세운다.
    // 형식 교체가 교차 검사보다 뒤에 오면 dev·review 가 같은 모델로 수렴할 수 있다.)
    if (dev && !isValidModelSpec(dev)) { dev = ''; why.push('dev 모델 스펙 형식 위반 — 교체') }
    if (review && !isValidModelSpec(review)) { review = ''; why.push('review 모델 스펙 형식 위반 — 교체') }
    if (wantDev && !dev) dev = claudeAlt(review)
    if (wantReview && !review) review = claudeAlt(dev)
    if (wantDev && wantReview && dev && review && dev === review) review = claudeAlt(dev) || review
    if (!codexOn && why.length === 0) why.push('codex 미가용 — claude 단독 배정')

    return {
      story,
      dev,
      review,
      devProvider: specProvider(dev),
      reviewProvider: specProvider(review),
      difficulty: diff.score,
      risk: risk.score,
      flags: risk.flags,
      why: why.join(' · ') || '기본 배정(설정·기록 변경 없음)',
    }
  })
}

/**
 * 배치 단위 models — 편성기(plan-queue)가 쓰는 얇은 어댑터.
 * **base 에 있는 키만** 돌려준다(마감 재검수의 `{review}` 단독 형태 보존 · 종전 큐 형식 불변).
 */
export function assignBatchModels({ base, stories = [], providers = {}, history = null, config = {} } = {}) {
  if (!base) return base
  const roles = Object.keys(base).filter((k) => ['dev', 'review'].includes(k))
  if (roles.length === 0) return base
  const [first] = assignWorkers({ stories: stories.length ? stories : [{ key: '', files: [] }], roles, providers, history, config: { ...config, models: base } })
  const out = {}
  for (const r of roles) {
    const v = r === 'dev' ? first.dev : first.review
    out[r] = v || base[r]
  }
  return out
}
