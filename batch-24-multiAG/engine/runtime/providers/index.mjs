// providers/index.mjs — 워커 프로바이더 계층 공통부 (2026-09-02 · 다중 프로바이더 하네스)
//
// 왜 있나: 엔진(auto-story-pipeline.mjs)의 runClaude() 가 `claude -p …` 를 직접 박아 두어
// 다른 코딩 에이전트(Codex)를 워커로 쓸 수 없었다. 여기서 「모델 스펙 문자열 → (provider, model)」
// 해석 · 능력 감지 · 한도 사다리(같은 프로바이더 차순위 → 다른 프로바이더) 를 **순수 함수**로 둔다.
//
// 하위 호환 규율: 모델 스펙에 접두사가 없으면 종전과 똑같이 claude 별칭이다("opus" = claude/opus).
// "codex" 또는 "codex:<model>" 만 Codex 워커를 뜻한다. 큐·러너 스키마(`models: {dev, review}`)는 그대로.
//
// 2026-09-02 하드닝(codex-review-r1 #6): 모델 스펙은 **셸 메타문자를 담을 수 없다**(parseModelSpec 이 거부),
// 능력 감지도 셸 문자열이 아니라 실행파일+argv 분리 spawn(spawn-safe)으로 돈다.
import { UnsafeArgumentError, assertSafeModel, spawnSafe } from './spawn-safe.mjs'

export const PROVIDER_NAMES = Object.freeze(['claude', 'codex'])
/** Claude 품질 사다리 기본값 — 엔진의 AUTO_MODEL_LADDER 와 같은 뜻(엔진이 env 로 좁힐 수 있다) */
export const DEFAULT_CLAUDE_LADDER = Object.freeze(['fable', 'opus', 'sonnet'])

/** "opus" → claude/opus · "" → claude/cli-default · "codex" → codex/default · "codex:m" · "claude:m"
 *  스펙은 명령줄 인자로 나가므로 **허용 문자집합 밖(셸 메타문자 포함)이면 여기서 거부**한다 —
 *  큐/설정 파일의 `opus & git push …` 같은 값이 실행 단계까지 가지 못하게 하는 첫 관문(#6). */
export function parseModelSpec(spec) {
  const s = String(spec ?? '').trim()
  if (!s) return { provider: 'claude', model: '' }
  assertSafeModel(s, '모델 스펙')
  const m = /^(claude|codex)(?::(.*))?$/i.exec(s)
  if (m) return { provider: m[1].toLowerCase(), model: (m[2] ?? '').trim() }
  return { provider: 'claude', model: s }
}

/** parseModelSpec 의 역 — claude 는 접두사 없이(종전 표기 그대로), codex 는 "codex[:model]" */
export function formatModelSpec(spec) {
  const p = typeof spec === 'string' ? parseModelSpec(spec) : spec
  if (!p) return ''
  if (p.provider === 'codex') return p.model ? `codex:${p.model}` : 'codex'
  return p.model || ''
}

/** 로그 표기 — 종전 "cli-default" 문구 보존 */
export function shownSpec(spec) {
  const p = typeof spec === 'string' ? parseModelSpec(spec) : (spec ?? parseModelSpec(''))
  if (p.provider === 'codex') return `codex:${p.model || 'default'}`
  return p.model || 'cli-default'
}

export const specEquals = (a, b) => {
  const x = typeof a === 'string' ? parseModelSpec(a) : a
  const y = typeof b === 'string' ? parseModelSpec(b) : b
  return Boolean(x && y) && x.provider === y.provider && (x.model || '') === (y.model || '')
}

const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''

/** 기본 실행기 — **셸 없이** 실행파일+argv 분리 spawn(Windows `.cmd` 심만 spawn-safe 의 cmd.exe 전용 경로).
 *  bin·args 가 허용 문자집합을 벗어나면 spawn 전에 throw 한다(부작용 0). 30초 상한. */
export function defaultExec(bin, args) {
  const r = spawnSafe(bin, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** 거부(UnsafeArgumentError)를 「그 프로바이더 불가」로 바꾼다 — 배치를 죽이지 않고 fail-closed 로 끊는다. */
function guardedExec(exec, bin, args) {
  try { return exec(bin, args) } catch (e) {
    if (e instanceof UnsafeArgumentError || e?.code === 'UNSAFE_ARGUMENT') return { status: 126, stdout: '', stderr: e.message, rejected: true }
    throw e
  }
}

/** 능력 감지 — **요청된 프로바이더만** 찔러 본다(Claude-only 배치는 새 프로세스 0).
 *  codex = `codex --version` + `codex login status`(둘 다 오프라인·수 초). 반환은 프로바이더별
 *  { wanted, available, version, loggedIn?, reason }. reason 은 사람이 읽는 사유(불가 시). */
export function detectProviders({ want = ['claude'], exec = defaultExec, env = process.env } = {}) {
  const out = {}
  for (const p of PROVIDER_NAMES) out[p] = { wanted: want.includes(p), available: false, version: '', reason: '감지 생략(요청 없음)' }
  if (want.includes('claude')) {
    const bin = env.CLAUDE_BIN || 'claude'
    const r = guardedExec(exec, bin, ['--version'])
    out.claude = r.status === 0
      ? { wanted: true, available: true, version: firstLine(r.stdout), reason: '' }
      : { wanted: true, available: false, version: '', reason: `claude --version 실패(exit ${r.status}) ${firstLine(r.stderr)}`.trim() }
  }
  if (want.includes('codex')) {
    const bin = env.CODEX_BIN || 'codex'
    const v = guardedExec(exec, bin, ['--version'])
    if (v.rejected) {
      out.codex = { wanted: true, available: false, version: '', loggedIn: false, reason: `CODEX_BIN 값 거부(셸 메타문자) — ${firstLine(v.stderr)}` }
    } else if (v.status !== 0) {
      out.codex = { wanted: true, available: false, version: '', loggedIn: false, reason: 'codex CLI 미설치(또는 PATH 에 없음) — Claude 전용으로 진행' }
    } else {
      const l = guardedExec(exec, bin, ['login', 'status'])
      const text = `${l.stdout}\n${l.stderr}`
      const loggedIn = l.status === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)
      out.codex = loggedIn
        ? { wanted: true, available: true, version: firstLine(v.stdout), loggedIn: true, reason: '' }
        : { wanted: true, available: false, version: firstLine(v.stdout), loggedIn: false, reason: 'codex 미인증 — 사람이 `codex login` 을 한 번 해야 한다. 그때까지 Claude 전용' }
    }
  }
  return out
}

/** 감지 결과 한 줄 — 로그 `[PROVIDERS] claude=YES(2.1.250) codex=NO(사유)` */
export function providersLine(det) {
  const one = (p) => {
    const d = det?.[p]
    if (!d || !d.wanted) return `${p}=-`
    return d.available ? `${p}=YES(${d.version || '?'})` : `${p}=NO(${d.reason || '?'})`
  }
  return `[PROVIDERS] ${PROVIDER_NAMES.map(one).join(' ')}`
}

/** 요청 스펙을 실제로 쓸 수 있는 스펙으로 확정한다 — codex 불가(미설치·미인증·cwd 프라이버시)면
 *  claude 대체(dev 와 다른 모델)로 **폴백**하고 사유를 돌려준다. 배치는 절대 서지 않는다. */
export function resolveWorkerSpec({ spec, availability, ladder = DEFAULT_CLAUDE_LADDER, avoid = null, codexCwd = { ok: true } }) {
  const want = typeof spec === 'string' ? parseModelSpec(spec) : spec
  if (want.provider !== 'codex') return { spec: want, fallback: false, why: '' }
  const av = availability?.codex
  const blocked = !av?.available ? (av?.reason || 'codex 불가') : (!codexCwd?.ok ? (codexCwd.why || 'cwd 불허') : '')
  if (!blocked) return { spec: want, fallback: false, why: '' }
  const avoidSpec = avoid ? (typeof avoid === 'string' ? parseModelSpec(avoid) : avoid) : null
  const alt = ladder.find((m) => !(avoidSpec && avoidSpec.provider === 'claude' && avoidSpec.model === m)) ?? ''
  return { spec: { provider: 'claude', model: alt }, fallback: true, why: `codex 폴백 → claude/${alt || 'cli-default'} (${blocked})` }
}

/** 한도(limit) 사다리 — ① 같은 프로바이더 차순위(claude 만 사다리가 있다) ② 다른 프로바이더
 *  (허용 역할·가용·**전환 상한** 미소진 · avoid 와 다른 것) ③ null.
 *  전환 상한(기본 1)은 08-29 설계 §5-3 「무한 핑퐁 금지」 — 같은 스토리가 두 벤더를 왕복하지 않는다. */
export function nextWorkerDown({ current, avoid = null, ladder = DEFAULT_CLAUDE_LADDER, availability = {}, allowedProviders = ['claude'], switchesUsed = 0, maxSwitches = 1 }) {
  const cur = typeof current === 'string' ? parseModelSpec(current) : current
  const av = avoid ? (typeof avoid === 'string' ? parseModelSpec(avoid) : avoid) : null
  const clash = (c) => Boolean(av && specEquals(c, av))
  if (cur.provider === 'claude') {
    const i = ladder.indexOf(cur.model)
    for (let j = i + 1; j < ladder.length; j++) {
      const c = { provider: 'claude', model: ladder[j] }
      if (!clash(c)) return { next: c, switched: false }
    }
  }
  const other = cur.provider === 'claude' ? 'codex' : 'claude'
  if (switchesUsed >= maxSwitches) return null
  if (!allowedProviders.includes(other) || !availability?.[other]?.available) return null
  if (other === 'codex') {
    const c = { provider: 'codex', model: '' }
    return clash(c) ? null : { next: c, switched: true }
  }
  for (const m of ladder) {
    const c = { provider: 'claude', model: m }
    if (!clash(c)) return { next: c, switched: true }
  }
  return null
}

/** 교차검증 — dev 와 review 가 **같은 프로바이더·같은 모델**이면 review 를 바꾼다.
 *  claude↔claude 는 종전과 같이 사다리에서 dev 와 다른 첫 모델(자동 벤더 전환 없음 — 한도·비용은
 *  편성기가 정한다). codex↔codex(둘 다 기본 모델)는 claude 최상위로 — Codex 는 사다리가 없다. */
export function enforceCrossSpec({ dev, review, ladder = DEFAULT_CLAUDE_LADDER }) {
  const d = typeof dev === 'string' ? parseModelSpec(dev) : dev
  const r = typeof review === 'string' ? parseModelSpec(review) : review
  if (!d || !r) return { review: r, changed: false }
  if (d.provider === 'claude' && r.provider === 'claude') {
    if (!d.model || !r.model || d.model !== r.model) return { review: r, changed: false }
    const alt = ladder.find((m) => m !== d.model)
    return alt ? { review: { provider: 'claude', model: alt }, changed: true } : { review: r, changed: false }
  }
  if (d.provider === 'codex' && r.provider === 'codex' && (d.model || '') === (r.model || '')) {
    return { review: { provider: 'claude', model: ladder[0] ?? '' }, changed: true }
  }
  return { review: r, changed: false }
}
