// dev-status — 계측을 「지난 1/2/3일」로 접는 순수 함수 (설계 §2-⑥ · 👤 2026-09-03 「하루 단위」)
//
// 하루 = **그날 밤 배치 묶음**이다(18:00 ~ 다음날 아침). 그래서 `at` 의 날짜를 18:00 기준으로
// 접어서 밤 키를 만든다 — 새벽 3시에 끝난 배치는 「어젯밤」이지 「오늘」이 아니다.
//
// 규칙 3가지:
//   ① **품질 게이트를 통과한 실행끼리만** 비교한다. 미통과분은 집계에서 빼고 「제외 N」으로 적는다
//      (품질을 깎아서 얻은 속도는 개선이 아니다 — metrics.mjs 와 같은 잣대).
//   ② 배치가 0건인 날은 전 칸 `—` 이고 「배치 없음」이다. 0 으로 세지 않는다.
//   ③ 추세는 값이 2개 이상일 때만 낸다. 1개면 `—`.

import { nightKey } from './batch-sources.mjs'

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const arr = (v) => (Array.isArray(v) ? v : [])

/** now 기준 지난 1·2·3일의 밤 키(최신이 앞). */
export function nightKeys(now = new Date(), days = 3) {
  const base = nightKey(now)
  if (!base) return []
  const [y, m, d] = base.split('-').map(Number)
  const out = []
  for (let i = 0; i < days; i += 1) {
    const dt = new Date(y, m - 1, d - i)
    const p = (x) => String(x).padStart(2, '0')
    out.push(dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()))
  }
  return out
}

const EMPTY = () => ({
  batches: 0, excluded: 0, counted: 0,
  savingMs: null, parallelEfficiency: null, idleRatio: null,
  firstPass: null, firstPassOk: 0, firstPassTotal: 0,
  reviewHigh: null, reviewMedium: null,
  integrationFailRate: null, integrationFail: 0, integrationRuns: 0,
  modelCalls: [], planSources: {},
})

/**
 * 계측 이력 → 「지난 1/2/3일」 표.
 *
 * @param {object} input
 *   history        metrics-history.jsonl 행 배열(parseMetricsHistory().rows)
 *   manifests      배치 매니페스트 배열(통합 실패율의 원천 — `at`·`integration.result`)
 *   verifications  스토리 검증 매니페스트 배열(리뷰 결함의 원천 — `generatedAt`·`review`)
 *   now / days
 * @returns {{days:[{key,label,…}], rows:[{key,label,unit,better,values,trend,note}]}}
 */
export function dailyMetrics({ history = [], manifests = [], verifications = [], now = new Date(), days = 3 } = {}) {
  const keys = nightKeys(now, days)
  const bucket = new Map(keys.map((k) => [k, EMPTY()]))

  // ── 계측 이력 ─────────────────────────────────────────────────────────────
  for (const row of arr(history)) {
    const k = nightKey(row?.at)
    const b = bucket.get(k)
    if (!b) continue
    b.batches += 1
    if (row?.planSource) b.planSources[row.planSource] = (b.planSources[row.planSource] ?? 0) + 1
    for (const c of arr(row?.modelCalls)) {
      const key = (c?.provider ?? '') + '/' + (c?.model ?? '')
      const cur = b.modelCalls.find((x) => x.key === key)
      if (cur) { cur.calls += num(c?.calls); cur.tokens += num(c?.tokens) }
      else b.modelCalls.push({ key, provider: c?.provider ?? '', model: c?.model ?? '', calls: num(c?.calls), tokens: num(c?.tokens) })
    }
    // 품질 미달 실행은 속도 지표에서 뺀다 — 다만 「있었다」는 사실은 남긴다.
    if (row?.qualityGate && row.qualityGate.passed === false) { b.excluded += 1; continue }
    b.counted += 1
    const workers = Math.max(1, num(row?.workers) || 1)
    const wall = num(row?.wallMs)
    const serial = num(row?.serialMs)
    const capacity = workers * wall
    b.savingMs = num(b.savingMs) + (serial - wall)
    b._serial = num(b._serial) + serial
    b._capacity = num(b._capacity) + capacity
    b._idle = num(b._idle) + num(row?.idleRatio) * capacity
    b.firstPassTotal += 1
    if (num(row?.retries?.repairRounds) === 0 && num(row?.retries?.providerSwitches) === 0) b.firstPassOk += 1
  }

  // ── 통합 실패율 — 그날 배치 매니페스트가 분모다 ────────────────────────────
  for (const m of arr(manifests)) {
    const b = bucket.get(nightKey(m?.at))
    if (!b || !m?.integration) continue
    b.integrationRuns += 1
    if (m.integration.result === 'fail' || m.integration.result === 'rollback') b.integrationFail += 1
  }

  // ── 리뷰 결함 — 스토리 검증 매니페스트가 정본(run-night 은 highFindings 를 늘 0 으로 넘긴다) ──
  for (const v of arr(verifications)) {
    const b = bucket.get(nightKey(v?.generatedAt))
    if (!b || !v?.review) continue
    b.reviewHigh = num(b.reviewHigh) + num(v.review.high)
    b.reviewMedium = num(b.reviewMedium) + num(v.review.medium)
  }

  // ── 마무리 ────────────────────────────────────────────────────────────────
  for (const b of bucket.values()) {
    if (b.counted > 0) {
      b.parallelEfficiency = b._capacity > 0 ? b._serial / b._capacity : null
      b.idleRatio = b._capacity > 0 ? b._idle / b._capacity : null
      b.firstPass = b.firstPassTotal > 0 ? b.firstPassOk / b.firstPassTotal : null
    } else {
      b.savingMs = null
    }
    if (b.integrationRuns > 0) b.integrationFailRate = b.integrationFail / b.integrationRuns
    b.modelCalls.sort((a, c) => a.key.localeCompare(c.key))
    delete b._serial; delete b._capacity; delete b._idle
  }

  const dayCols = keys.map((k, i) => ({
    key: k,
    label: i === 0 ? '지난 1일' : '지난 ' + (i + 1) + '일',
    sub: k.slice(5).replace('-', '/') + ' 밤 · 배치 ' + bucket.get(k).batches,
    empty: bucket.get(k).batches === 0,
    ...bucket.get(k),
  }))

  const ROWS = [
    { key: 'savingMs', label: '순차 대비 절약 추정', hint: '순서대로 했으면 더 걸렸을 시간', unit: 'duration', better: 'higher' },
    { key: 'parallelEfficiency', label: '병렬 효율', hint: '워커 수 대비 실제로 일한 비율', unit: 'pct', better: 'higher' },
    { key: 'idleRatio', label: '유휴', hint: '워커가 놀고 있던 시간 비율', unit: 'pct', better: 'lower' },
    { key: 'firstPass', label: '첫 시도 통과율', hint: '수리 라운드·프로바이더 전환 없이 끝난 비율(근사)', unit: 'pct', better: 'higher' },
    { key: 'reviewHigh', label: '리뷰 결함 high', hint: 'medium 은 괄호', unit: 'count', better: 'lower' },
    { key: 'integrationFailRate', label: '통합 실패율', hint: '그날 배치 중 되돌림·실패 비율', unit: 'pct', better: 'lower' },
  ]

  const rows = ROWS.map((r) => {
    const values = dayCols.map((d) => (d.empty ? null : d[r.key]))
    return { ...r, values, trend: trendOf(values, r.better) }
  })

  return { days: dayCols, rows, modelRow: dayCols.map((d) => ({ calls: d.modelCalls, planSources: d.planSources, empty: d.empty })) }
}

/**
 * 3일 방향. values[0] = 최신. **값이 2개 미만이면 「—」** — 점 하나로 추세를 말하지 않는다.
 * @returns {{dir:'improve'|'worse'|'flat'|'unknown', label:string}}
 */
export function trendOf(values, better = 'higher') {
  const pts = arr(values).map((v, i) => ({ v, i })).filter((p) => typeof p.v === 'number' && Number.isFinite(p.v))
  if (pts.length < 2) return { dir: 'unknown', label: '—' }
  // 가장 오래된 값 → 가장 최신 값
  const newest = pts[0].v
  const oldest = pts[pts.length - 1].v
  if (newest === oldest) return { dir: 'flat', label: '평평' }
  const up = newest > oldest
  const good = better === 'higher' ? up : !up
  return good ? { dir: 'improve', label: '개선 ↑' } : { dir: 'worse', label: '악화 ↓' }
}

// ── 표시 서식 ────────────────────────────────────────────────────────────────
export function formatValue(v, unit) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  if (unit === 'pct') return (Math.round(Number(v) * 1000) / 10).toFixed(1) + '%'
  if (unit === 'duration') return formatDuration(Number(v))
  return String(Math.round(Number(v)))
}

export function formatDuration(ms) {
  const m = Math.round(Math.abs(Number(ms) || 0) / 60000)
  const sign = Number(ms) < 0 ? '-' : ''
  if (m < 60) return sign + m + '분'
  return sign + Math.floor(m / 60) + '시간 ' + (m % 60) + '분'
}
