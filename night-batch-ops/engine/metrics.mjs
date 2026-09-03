// 배치 계측 — 2026-09-02 「9점대 하네스」 (워커 F2)
//
// 무엇을 재나: 하네스가 「빨라졌다」고 말하려면 **무엇이 빨라졌는지**를 숫자로 대야 한다.
// 여기서 재는 것은 5가지다 — ① 전체 시간 ② 스토리별 소요(p50/p95) ③ 워커 유휴시간
// ④ 병렬 효율 ⑤ 재시도(수리 라운드·프로바이더 전환)와 모델 호출량(프로바이더·모델별 · 토큰).
//
// **품질 기준이 먼저다**: 비교는 「같은 품질 게이트를 통과한 실행」끼리만 한다(qa GREEN ·
// 리뷰 high 0 · 통합 게이트 pass · 워커 STOP 0). 미통과 실행은 표에 남기되 「품질 미달 ·
// 비교 제외」로 찍는다 — 품질을 깎아서 얻은 속도는 개선이 아니기 때문이다.
//
// 이 파일은 **순수 함수 + 파일 기록기 2개**뿐이다. 프로세스를 띄우지 않고 LLM 을 부르지 않는다.
// 입력은 엔진이 이미 남기는 로그(`run-summary.log`)와 러너가 아는 워커 시각뿐이다 —
// 계측을 위해 엔진 로그 형식을 바꾸지 않는다(현황판이 같은 줄을 읽는다).

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const METRICS_SCHEMA = 'night-batch-ops/metrics/1'
export const METRICS_HISTORY_FILE = 'metrics-history.jsonl'
export const metricsHistoryPath = (stateDir) => join(String(stateDir ?? '.'), METRICS_HISTORY_FILE)

const iso = (v) => (typeof v === 'string' && v ? v : null)
const ms = (a, b) => {
  const s = Date.parse(a ?? ''), e = Date.parse(b ?? '')
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : 0
}

// ── 엔진 로그 파서 ───────────────────────────────────────────────────────────
// 엔진(auto-story-pipeline)이 남기는 줄 3종만 읽는다. 형식은 현황판(dev-status)도 읽는
// **고정 형식**이라 바뀌지 않는다:
//   [<ISO>] → [<story>] <stageLabel> (model=<m>, perm=<p>)     ← 단계 시작
//   [<ISO>] [<story>][<PROVIDER>][<ROLE>] start model=… cwd=…  ← 프로바이더·역할
//   [<ISO>]    exit=<n> …                                       ← 단계 종료
//   [<ISO>] → [<story>] qa-gate: <cmd>   /   [<ISO>]    qa exit=<n> …
const LINE_RE = /^\[([^\]]+)\]\s?(.*)$/
const START_RE = /^→ \[([^\]]+)\] ([^(]+?) \(model=([^,)]*)/
const QA_START_RE = /^→ \[([^\]]+)\] qa-gate:/
const WHO_RE = /^\[([^\]]+)\]\[([A-Z]+)\]\[([A-Z]+)\] start model=(\S+)/
const EXIT_RE = /^exit=(-?\d+)/
const QA_EXIT_RE = /^qa exit=(-?\d+)/

/**
 * `run-summary.log` 텍스트 → 단계 이벤트 배열(순수 · 입력 순서 보존).
 * 반환 [{ kind:'stage', story, stage, role, provider, model, start, end, ms, exit }]
 * 닫히지 않은 단계(로그가 잘렸거나 프로세스가 죽음)는 `end=null · exit=null` 로 남긴다 —
 * 없는 것처럼 지우면 유휴시간이 부풀고 「멀쩡한 실행」으로 보인다.
 */
export function parseEngineLog(text, { story: onlyStory = '', provider: defProvider = 'claude' } = {}) {
  const events = []
  let open = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trim())
    if (!m) continue
    const at = m[1], body = m[2].trim()
    const st = START_RE.exec(body)
    if (st) {
      if (open) events.push(open)
      open = { kind: 'stage', story: st[1], stage: st[2].trim(), role: st[2].trim(), provider: defProvider, model: st[3].trim(), start: at, end: null, ms: 0, exit: null }
      continue
    }
    const qs = QA_START_RE.exec(body)
    if (qs) {
      if (open) events.push(open)
      open = { kind: 'stage', story: qs[1], stage: 'qa', role: 'qa', provider: 'local', model: '', start: at, end: null, ms: 0, exit: null }
      continue
    }
    const who = WHO_RE.exec(body)
    if (who && open && open.story === who[1]) {
      open.provider = who[2].toLowerCase()
      open.role = who[3].toLowerCase()
      open.model = who[4]
      continue
    }
    const ex = EXIT_RE.exec(body) || QA_EXIT_RE.exec(body)
    if (ex && open) {
      open.end = at
      open.ms = ms(open.start, at)
      open.exit = Number(ex[1])
      events.push(open)
      open = null
    }
  }
  if (open) events.push(open)
  return onlyStory ? events.filter((e) => e.story === onlyStory) : events
}

/** Codex JSONL(`turn.completed{usage}`) 토큰 합산 — 로그 본문 어디에 섞여 있어도 줄 단위로 줍는다. */
export function parseCodexUsage(text) {
  const out = { input: 0, output: 0, total: 0, turns: 0 }
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{') || !line.includes('turn.completed')) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev?.type !== 'turn.completed' || !ev.usage) continue
    const u = ev.usage
    const i = Number(u.input_tokens ?? u.inputTokens ?? 0) || 0
    const o = Number(u.output_tokens ?? u.outputTokens ?? 0) || 0
    out.input += i
    out.output += o
    out.total += Number(u.total_tokens ?? u.totalTokens ?? i + o) || 0
    out.turns++
  }
  return out
}

// ── 집계 ─────────────────────────────────────────────────────────────────────
/** 최근값 우선(nearest-rank) 백분위 — 표본이 적어도 결정적이다. */
export function percentile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return 0
  const rank = Math.max(1, Math.ceil((q / 100) * v.length))
  return v[Math.min(v.length - 1, rank - 1)]
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 타임라인 → 요약(순수 · 결정적).
 * events = parseEngineLog 결과 + 러너가 만든 `{kind:'story', story, provider, model, start, end, exit}`
 *          (워커 슬롯 점유 구간) · `{kind:'batch', start, end}`(벽시계).
 * opts   = { workers, quality:{ highFindings, integration, qaExit }, tokens:{provider:{model:{…}}} }
 */
export function summarizeTimeline(events = [], opts = {}) {
  const workers = Math.max(1, Number(opts.workers) || 1)
  const evs = (events ?? []).filter((e) => e && typeof e === 'object')
  const stages = evs.filter((e) => e.kind === 'stage')
  const storyEvs = evs.filter((e) => e.kind === 'story')
  const batchEvs = evs.filter((e) => e.kind === 'batch')

  const starts = evs.map((e) => Date.parse(e.start ?? '')).filter(Number.isFinite)
  const ends = evs.map((e) => Date.parse(e.end ?? e.start ?? '')).filter(Number.isFinite)
  const wallMs = batchEvs.length
    ? batchEvs.reduce((a, b) => a + ms(b.start, b.end), 0)
    : (starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0)

  // 점유 = 워커 슬롯이 실제로 물려 있던 시간. story 이벤트가 있으면 그것이 슬롯 단위다
  // (단계 사이 간격도 슬롯은 잡고 있다) — 없으면 단계 합으로 근사한다.
  const occupancyMs = storyEvs.length
    ? storyEvs.reduce((a, e) => a + (Number(e.ms) || ms(e.start, e.end)), 0)
    : stages.reduce((a, e) => a + (Number(e.ms) || ms(e.start, e.end)), 0)
  const serialMs = stages.reduce((a, e) => a + (Number(e.ms) || ms(e.start, e.end)), 0)

  const capacityMs = workers * wallMs
  const idleMs = Math.max(0, capacityMs - occupancyMs)
  const idleRatio = capacityMs > 0 ? Number((idleMs / capacityMs).toFixed(4)) : 0
  const parallelEfficiency = capacityMs > 0 ? Number((serialMs / capacityMs).toFixed(4)) : 0

  // 스토리별
  const keys = [...new Set([...storyEvs, ...stages].map((e) => String(e.story ?? '')).filter(Boolean))].sort(cmpStr)
  const stories = keys.map((k) => {
    const own = storyEvs.filter((e) => e.story === k)
    const st = stages.filter((e) => e.story === k)
    const dur = own.length ? own.reduce((a, e) => a + (Number(e.ms) || ms(e.start, e.end)), 0)
      : st.reduce((a, e) => a + (Number(e.ms) || ms(e.start, e.end)), 0)
    // exit 은 **마지막** 것이 결론이다 — 중간 qa RED 를 수리가 고쳤으면 그 스토리는 실패가 아니다.
    // 최댓값을 쓰면 「수리에 성공한 실행」이 영원히 품질 미달로 찍힌다.
    const last = own.length ? own[own.length - 1] : st[st.length - 1]
    return { story: k, ms: dur, stages: st.length, exit: Number.isFinite(last?.exit) ? last.exit : null }
  })
  const durations = stories.map((s) => s.ms)

  // 재시도 — 수리 라운드(stage/role 에 repair)와 같은 스토리·역할의 프로바이더 전환
  const repairRounds = stages.filter((e) => /repair/i.test(String(e.stage)) || /repair/i.test(String(e.role))).length
  let providerSwitches = 0
  for (const k of keys) {
    const seq = stages.filter((e) => e.story === k && e.provider && e.provider !== 'local')
    for (let i = 1; i < seq.length; i++) if (seq[i].provider !== seq[i - 1].provider) providerSwitches++
  }

  // 모델 호출량
  const callMap = new Map()
  for (const e of stages) {
    if (e.provider === 'local') continue
    const key = `${e.provider ?? ''}|${e.model ?? ''}`
    const cur = callMap.get(key) ?? { provider: e.provider ?? '', model: e.model ?? '', calls: 0, tokens: 0 }
    cur.calls++
    callMap.set(key, cur)
  }
  for (const [provider, models] of Object.entries(opts.tokens ?? {})) {
    for (const [model, t] of Object.entries(models ?? {})) {
      const key = `${provider}|${model}`
      const cur = callMap.get(key) ?? { provider, model, calls: 0, tokens: 0 }
      cur.tokens += Number(t?.total ?? t ?? 0) || 0
      callMap.set(key, cur)
    }
  }
  const modelCalls = [...callMap.values()].sort((a, b) => cmpStr(a.provider, b.provider) || cmpStr(a.model, b.model))
  const tokensTotal = modelCalls.reduce((a, m) => a + m.tokens, 0)

  // 품질 게이트 — 통과한 실행끼리만 비교한다
  const q = opts.quality ?? {}
  // qa 도 **스토리별 마지막 판정**이 결론이다(수리 뒤 GREEN 이면 GREEN). 여러 스토리면 그중 최악.
  const qaLast = keys
    .map((k) => stages.filter((e) => e.stage === 'qa' && e.story === k).pop())
    .filter(Boolean)
    .map((e) => Number(e.exit ?? 1))
  const qaExit = q.qaExit !== undefined && q.qaExit !== null ? Number(q.qaExit)
    : qaLast.length ? Math.max(...qaLast) : null
  const highFindings = Number(q.highFindings ?? 0) || 0
  const integration = String(q.integration ?? 'pass')
  const badStories = stories.filter((s) => Number.isFinite(s.exit) && s.exit !== 0).map((s) => s.story)
  const why = []
  if (qaExit === null) why.push('qa 결과 없음(게이트 미실행)')
  else if (qaExit !== 0) why.push(`qa RED(exit ${qaExit})`)
  if (highFindings > 0) why.push(`리뷰 high ${highFindings}건`)
  if (integration !== 'pass') why.push(`통합 게이트 ${integration}`)
  if (badStories.length) why.push(`워커 STOP ${badStories.join(',')}`)

  return {
    schema: METRICS_SCHEMA,
    workers,
    wallMs,
    serialMs,
    occupancyMs,
    idleMs,
    idleRatio,
    parallelEfficiency,
    stories,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    retries: { repairRounds, providerSwitches },
    modelCalls,
    tokens: tokensTotal,
    qualityGate: { passed: why.length === 0, why: why.join(' · ') || 'qa GREEN · 리뷰 high 0 · 통합 pass' },
  }
}

// ── 표 ───────────────────────────────────────────────────────────────────────
const sec = (n) => `${(Number(n) || 0) / 1000}s`
const pct = (n) => `${Math.round((Number(n) || 0) * 1000) / 10}%`

/** night-last-run.md 에 붙일 요약 표 1개(마크다운). */
export function renderMetricsTable(s, { title = '## 계측' } = {}) {
  if (!s) return ''
  const calls = s.modelCalls.map((m) => `${m.provider}/${m.model || '기본'}×${m.calls}${m.tokens ? `(${m.tokens}tok)` : ''}`).join(' · ') || '없음'
  return [
    title,
    '',
    '| 항목 | 값 |',
    '| --- | --- |',
    `| 전체(벽시계) | ${sec(s.wallMs)} |`,
    `| 워커 | ${s.workers} |`,
    `| 직렬 합 | ${sec(s.serialMs)} |`,
    `| 병렬 효율 | ${pct(s.parallelEfficiency)} |`,
    `| 워커 유휴 | ${sec(s.idleMs)} (${pct(s.idleRatio)}) |`,
    `| 스토리 p50 / p95 | ${sec(s.p50Ms)} / ${sec(s.p95Ms)} |`,
    `| 재시도 | 수리 ${s.retries.repairRounds}회 · 프로바이더 전환 ${s.retries.providerSwitches}회 |`,
    `| 모델 호출 | ${calls} |`,
    `| 품질 게이트 | ${s.qualityGate.passed ? 'PASS' : 'FAIL'} — ${s.qualityGate.why} |`,
  ].join('\n')
}

// ── 비교(벤치) ────────────────────────────────────────────────────────────────
const METRIC_ROWS = Object.freeze([
  { key: 'wallMs', label: '전체(벽시계)', fmt: sec, better: 'lower' },
  { key: 'serialMs', label: '직렬 합', fmt: sec, better: 'lower' },
  { key: 'parallelEfficiency', label: '병렬 효율', fmt: pct, better: 'higher' },
  { key: 'idleRatio', label: '워커 유휴 비율', fmt: pct, better: 'lower' },
  { key: 'p50Ms', label: '스토리 p50', fmt: sec, better: 'lower' },
  { key: 'p95Ms', label: '스토리 p95', fmt: sec, better: 'lower' },
])

/**
 * 두 실행 비교 — **둘 다 품질 게이트를 통과했을 때만** 비교값을 낸다.
 * 반환 { comparable, why, rows[], calls:{baseline,candidate}, retries:{…} }
 */
export function compareRuns(baseline, candidate) {
  const bad = []
  if (!baseline?.qualityGate?.passed) bad.push(`기준선 품질 미달 — ${baseline?.qualityGate?.why ?? '요약 없음'}`)
  if (!candidate?.qualityGate?.passed) bad.push(`후보 품질 미달 — ${candidate?.qualityGate?.why ?? '요약 없음'}`)
  const comparable = bad.length === 0
  const rows = METRIC_ROWS.map((r) => {
    const b = Number(baseline?.[r.key] ?? 0), c = Number(candidate?.[r.key] ?? 0)
    const delta = c - b
    const dir = delta === 0 ? '=' : (r.better === 'lower' ? (delta < 0 ? '개선' : '악화') : (delta > 0 ? '개선' : '악화'))
    return { key: r.key, label: r.label, baseline: r.fmt(b), candidate: r.fmt(c), delta: r.fmt(Math.abs(delta)), direction: dir }
  })
  const callSum = (s) => (s?.modelCalls ?? []).reduce((a, m) => a + m.calls, 0)
  return {
    comparable,
    why: comparable ? '두 실행 모두 품질 게이트 통과 — 비교 유효' : `품질 미달 · 비교 제외 — ${bad.join(' / ')}`,
    rows,
    calls: { baseline: callSum(baseline), candidate: callSum(candidate) },
    retries: {
      baseline: baseline?.retries ?? { repairRounds: 0, providerSwitches: 0 },
      candidate: candidate?.retries ?? { repairRounds: 0, providerSwitches: 0 },
    },
  }
}

/** 비교표(마크다운) — 품질 미달이면 수치 대신 「비교 제외」를 크게 적는다. */
export function renderComparison(cmp, { baselineLabel = '기준선(Claude-only)', candidateLabel = '새 하네스' } = {}) {
  const head = [`**판정**: ${cmp.comparable ? '비교 유효' : '⚠ 품질 미달 · 비교 제외'} — ${cmp.why}`, '']
  const table = [
    `| 지표 | ${baselineLabel} | ${candidateLabel} | 차이 |`,
    '| --- | --- | --- | --- |',
    ...cmp.rows.map((r) => `| ${r.label} | ${r.baseline} | ${r.candidate} | ${r.direction === '=' ? '=' : `${r.delta} ${r.direction}`} |`),
    `| 모델 호출 수 | ${cmp.calls.baseline} | ${cmp.calls.candidate} | ${cmp.calls.candidate - cmp.calls.baseline} |`,
    `| 수리 라운드 | ${cmp.retries.baseline.repairRounds} | ${cmp.retries.candidate.repairRounds} | ${cmp.retries.candidate.repairRounds - cmp.retries.baseline.repairRounds} |`,
    `| 프로바이더 전환 | ${cmp.retries.baseline.providerSwitches} | ${cmp.retries.candidate.providerSwitches} | ${cmp.retries.candidate.providerSwitches - cmp.retries.baseline.providerSwitches} |`,
  ]
  return [...head, ...table].join('\n')
}

// ── 기록기 ───────────────────────────────────────────────────────────────────
/** 한 줄 = 한 번의 write. 여러 프로세스가 동시에 불러도 줄이 섞이지 않는다(append 모드 단일 호출). */
export function appendJsonl(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const line = JSON.stringify(obj) + '\n'
  appendFileSync(file, line, 'utf8')
  return line
}

/** tmp → rename 원자 쓰기 — 읽는 쪽이 반쪽 JSON 을 보지 않는다. */
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return file
}
