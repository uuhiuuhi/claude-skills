// report.mjs — 비개발자 보고서 (요구 SPEC §10 · 설계 §1-6 · §8)
//
// 이 보고서가 지켜야 하는 세 가지:
//   1) **항목 순서 고정** — SPEC §10 의 열 가지가 언제나 같은 번호·같은 순서로 나온다(REPORT_SECTIONS).
//      매번 자리가 바뀌는 보고서는 읽는 사람이 매번 처음부터 읽어야 한다.
//   2) **확인 못 한 것을 「완료」로 적지 않는다** — verified-done 만 ②에 들어가고,
//      not-verified 는 ⑧「확인하지 못한 것」에만 들어간다.
//   3) **첫 화면에 결론** — 배포 가능 여부와 모자란 것이 제목 바로 아래에 온다.
//
// 그리고 렌더 직전에 **한 번 더 마스킹**한다(진단·백로그가 이미 지웠어도, 보고서는 사람에게
// 나가는 마지막 관문이라 여기서 한 번 더 지운다 — 안전 경계 7).
//
// 순수 모듈 — 파일·프로세스에 손대지 않는다.

import { maskSecrets, deepRedact } from './diagnose.mjs'
import { compareRuns } from './metrics.mjs'

export const REPORT_SCHEMA = 'night-batch-ops/report/1'

/** SPEC §10 의 열 항목 — **순서·번호를 바꾸지 않는다**(테스트가 문다). */
export const REPORT_SECTIONS = Object.freeze([
  { n: 1, id: 'capabilities', title: '지금 이 프로젝트가 할 수 있는 것' },
  { n: 2, id: 'completed', title: '이번에 끝낸 기능과 해결한 문제' },
  { n: 3, id: 'gates', title: '검사·보안·성능·통합 결과' },
  { n: 4, id: 'flows', title: '실제로 확인한 사용자 흐름' },
  { n: 5, id: 'autofix', title: '자동으로 고친 것과 교차 검토 결과' },
  { n: 6, id: 'time', title: '걸린 시간과 동시 진행 효과' },
  { n: 7, id: 'risks', title: '남은 문제와 위험' },
  { n: 8, id: 'notVerified', title: '확인하지 못한 것' },
  { n: 9, id: 'deployable', title: '지금 배포해도 되는가' },
  { n: 10, id: 'decisions', title: '박사장님이 결정해 주실 것' },
])

const arr = (x) => (Array.isArray(x) ? x : [])
const str = (x) => String(x ?? '')
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)
const uniq = (a) => [...new Set(a)]
const baseName = (p) => str(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop()

// ── 비개발자 언어 ────────────────────────────────────────────────────────────
// 파일 경로·모듈 이름·함수 호출 표기는 본문에서 뺀다(근거는 JSON 쪽에 남는다).
const PATHY_RE = /(?:[A-Za-z0-9_.\-]+[\\/])+[A-Za-z0-9_.\-]*\.[A-Za-z0-9]{1,6}\b|(?:[A-Za-z0-9_.\-]+\/){2,}[A-Za-z0-9_.\-]+|\b[A-Za-z0-9_.\-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonc|ya?ml|md|sql|sh|env)\b/g
const GLOSSARY = Object.freeze([
  [/n\/a\([^)]*scripts 에 ([A-Za-z0-9_\-]+) 없음\)/g, '이 프로젝트에 $1 검사 명령이 없음'],
  [/n\/a\([^)]*\)/g, '해당 검사 명령 없음'],
  [/required-missing\([^)]*\)/g, '검사가 필요한데 명령이 없음'],
  [/unknown\([^)]*\)/g, '판정 없음'],
])

/** 본문용 문장 다듬기 — 경로·확장자·함수 표기를 지우고 기술 약어를 쉬운 말로 바꾼다. */
export function plain(text) {
  let t = str(text)
  for (const [re, to] of GLOSSARY) t = t.replace(re, to)
  t = t.replace(/`/g, '')
  t = t.replace(PATHY_RE, '해당 파일')
  t = t.replace(/\b\w+\(\)/g, '해당 기능')
  t = t.replace(/\(\s*\)/g, '')
  return t.replace(/[ \t]{2,}/g, ' ').trim()
}

const dur = (ms) => {
  // `Number(null) === 0` 이라 null 을 그대로 흘리면 「0초」라는 거짓 수치가 나온다 — 먼저 막는다.
  if (ms === null || ms === undefined || ms === '') return '기록 없음'
  const n = num(ms)
  if (n === null) return '기록 없음'
  const s = Math.round(n / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 ${s % 60}초`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}
const pct = (x) => (x === null || x === undefined || x === '' || num(x) === null ? '기록 없음' : `${Math.round(num(x) * 1000) / 10}%`)

// ── 게이트 조건 비교 ─────────────────────────────────────────────────────────
/** 이 실행이 실제로 돌린 게이트 이름들 — 조건이 다르면 수치를 나란히 놓을 수 없다. */
export function gateSignature(gates) {
  return Object.entries(gates ?? {})
    .filter(([, v]) => v && v.available !== false && (v.exit === 0 || Number.isFinite(v.exit) || v.ran === true))
    .map(([k]) => k)
    .sort()
    .join(',')
}
export function compareGateConditions(baselineGates, currentGates) {
  const a = gateSignature(baselineGates)
  const b = gateSignature(currentGates)
  if (a === b) return { same: true, why: '' }
  return { same: false, why: `이전 실행은 ${a || '검사 없음'} 을, 이번 실행은 ${b || '검사 없음'} 을 돌렸습니다 — 조건이 달라 나란히 놓을 수 없습니다` }
}

// ── 지표 7종 (설계 §8) ──────────────────────────────────────────────────────
/**
 * 계측 모듈이 아직 `firstPass`·`repeatedFailures`·`saving` 을 주지 않으므로,
 * 없으면 **여기서 직접 센다**(근사일 때는 근사라고 적는다 — 근사를 실측처럼 적으면 그게 거짓말이다).
 */
export function computeIndicators({ metrics = null, manifests = [], run = null } = {}) {
  const s = metrics ?? {}
  const ms = arr(manifests)
  const stories = arr(s.stories)

  // ③ 첫 시도 통과율
  let firstPass = s.firstPass ?? null
  let firstPassApprox = false
  if (!firstPass) {
    firstPassApprox = true
    if (ms.length) {
      const ok = ms.filter((m) => (num(m?.repair?.attempts) ?? 0) === 0 && str(m?.checks?.qa) === 'pass').length
      firstPass = { value: ms.length ? ok / ms.length : null, ok, total: ms.length }
    } else if (stories.length) {
      const noRepair = (num(s.retries?.repairRounds) ?? 0) === 0
      const ok = stories.filter((x) => x.exit === 0).length
      firstPass = { value: noRepair ? ok / stories.length : null, ok, total: stories.length }
    } else firstPass = { value: null, ok: 0, total: 0 }
  }

  // ④ 리뷰 결함 수
  const rc = ms.reduce((a, m) => {
    const c = m?.review?.counts ?? {}
    a.high += num(c.high) ?? 0; a.patch += num(c.patch) ?? 0; a.decision += num(c.decision) ?? 0; a.defer += num(c.defer) ?? 0
    return a
  }, { high: 0, patch: 0, decision: 0, defer: 0 })
  const reviewApprox = ms.length === 0
  if (reviewApprox && num(s.quality?.highFindings) !== null) rc.high = num(s.quality.highFindings)

  // ⑤ 자동 수정 · 반복 실패(같은 원인 3회 이상)
  let repeated = s.repeatedFailures ?? null
  let repeatedApprox = false
  if (repeated === null || repeated === undefined) {
    repeatedApprox = true
    const tally = new Map()
    for (const m of ms) for (const sig of arr(m?.repair?.signatures)) tally.set(sig, (tally.get(sig) ?? 0) + 1)
    for (const sig of arr(run?.signatures)) tally.set(sig, (tally.get(sig) ?? 0) + 1)
    repeated = [...tally.values()].filter((n) => n >= 3).length
  }

  // ⑥ 통합 실패율
  const integ = ms.reduce((a, m) => {
    const v = str(m?.checks?.integration)
    if (v === 'pass') a.pass++
    else if (v === 'fail' || v === 'rollback') a.fail++
    else a.unknown++
    return a
  }, { pass: 0, fail: 0, unknown: 0 })
  const integRuns = integ.pass + integ.fail

  // ⑦ 순차 대비 절약
  const saving = s.saving ?? (num(s.serialMs) !== null && num(s.wallMs) !== null ? { ms: s.serialMs - s.wallMs, approx: true } : null)

  return {
    time: { wallMs: num(s.wallMs), p50Ms: num(s.p50Ms), p95Ms: num(s.p95Ms), stories: stories.map((x) => ({ story: x.story, ms: x.ms, exit: x.exit })) },
    parallel: { workers: num(s.workers), efficiency: num(s.parallelEfficiency), idleMs: num(s.idleMs), idleRatio: num(s.idleRatio) },
    firstPass: { ...firstPass, approx: firstPassApprox },
    review: { ...rc, approx: reviewApprox },
    autoFix: { repairRounds: num(s.retries?.repairRounds) ?? 0, providerSwitches: num(s.retries?.providerSwitches) ?? 0, repeatedFailures: repeated, approx: repeatedApprox },
    integration: { ...integ, runs: integRuns, failRate: integRuns > 0 ? integ.fail / integRuns : null },
    saving: saving ? { ms: num(saving.ms), approx: saving.approx !== false } : null,
  }
}

/** 지표 7종 표(마크다운). 값이 없으면 「확인 못 함」이라고 적고 수치를 지어내지 않는다. */
export function renderIndicatorsTable(ind) {
  const na = '확인 못 함'
  const fp = ind.firstPass.value === null || ind.firstPass.value === undefined ? na : `${pct(ind.firstPass.value)} (${ind.firstPass.ok}/${ind.firstPass.total})${ind.firstPass.approx ? ' · 근사' : ''}`
  const ir = ind.integration.failRate === null ? na : `${pct(ind.integration.failRate)} (${ind.integration.fail}/${ind.integration.runs})`
  return [
    '| 무엇 | 값 |',
    '| --- | --- |',
    `| 전체 걸린 시간 | ${dur(ind.time.wallMs)} · 작업 하나 보통 ${dur(ind.time.p50Ms)} · 가장 오래 걸린 축 ${dur(ind.time.p95Ms)} |`,
    `| 동시 진행 정도 | ${ind.parallel.workers === null ? na : `동시 ${ind.parallel.workers}갈래`} · 효율 ${pct(ind.parallel.efficiency)} · 노는 시간 ${dur(ind.parallel.idleMs)} |`,
    `| 한 번에 통과한 비율 | ${fp} |`,
    `| 검토에서 나온 지적 | 높음 ${ind.review.high} · 고칠 것 ${ind.review.patch} · 사람 결정 ${ind.review.decision} · 미룸 ${ind.review.defer}${ind.review.approx ? ' · 근사' : ''} |`,
    `| 자동으로 고친 횟수 | ${ind.autoFix.repairRounds}회 · 담당 바꿔 다시 ${ind.autoFix.providerSwitches}회 · 같은 원인 반복 ${ind.autoFix.repeatedFailures}건${ind.autoFix.approx ? ' · 근사' : ''} |`,
    `| 합치기 실패율 | ${ir} |`,
    `| 순서대로 했을 때보다 아낀 시간 | ${ind.saving ? `${dur(ind.saving.ms)}${ind.saving.approx ? ' · 추정' : ''}` : na} |`,
  ].join('\n')
}

// ── 본체 ─────────────────────────────────────────────────────────────────────
const VERDICT_KO = Object.freeze({
  'verified-done': '실제로 된다',
  partial: '반쯤 됐다',
  missing: '아직 안 만들었다',
  defect: '지금 고장 나 있다',
  blocked: '사람 결정 대기',
  'not-verified': '확인하지 못했다',
})
const HEAD = Object.freeze({
  ready: '✅ 배포해도 됩니다',
  'not-ready': '❌ 아직 배포하면 안 됩니다',
  'not-verified': '⚠ 배포해도 되는지 확인하지 못했습니다',
})

/**
 * @param {{run?:object, diagnoses?:object[], backlog?:object|null, readiness?:object|null,
 *          metrics?:object|null, questions?:object[], bmadApplied?:object|null, manifests?:object[]}} o
 *  metrics 는 `summarizeTimeline` 결과 그대로이거나 `{summary, baseline, gates, baselineGates}` 형태.
 */
export function buildReport({ run = {}, diagnoses = [], backlog = null, readiness = null, metrics = null, questions = [], bmadApplied = null, manifests = [] } = {}) {
  const ds = arr(diagnoses)
  const cur = ds.length ? ds[ds.length - 1] : null
  const first = ds.length ? ds[0] : null
  const project = readiness?.kind === 'project' ? readiness : (readiness?.project ?? null)
  const taskReadiness = arr(readiness?.tasks)
  const ms = arr(manifests)

  const summary = metrics && metrics.summary ? metrics.summary : metrics
  const baseline = metrics?.baseline ?? null
  const ind = computeIndicators({ metrics: summary, manifests: ms, run })

  // 게이트 조건이 다른 두 실행은 수치를 나란히 놓지 않는다.
  let comparison = null
  if (baseline && summary) {
    const g = compareGateConditions(metrics?.baselineGates ?? baseline?.gates ?? run?.baselineGates, metrics?.gates ?? summary?.gates ?? run?.gates)
    if (!g.same) comparison = { comparable: false, why: `비교 불가 — ${g.why}`, rows: [] }
    else {
      const c = compareRuns(baseline, summary)
      comparison = { comparable: c.comparable, why: c.comparable ? c.why : `비교 불가 — ${c.why}`, rows: c.rows }
    }
  }

  const stories = arr(cur?.stories)
  const done = stories.filter((s) => s.verdict === 'verified-done')
  const unverified = stories.filter((s) => s.verdict === 'not-verified')
  const broken = stories.filter((s) => ['partial', 'missing', 'defect', 'blocked'].includes(s.verdict))

  const notVerified = uniq([
    // 예산이 다해서 **건너뛴 단계**(게이트·러너·라운드)는 통과가 아니라 「모른다」다 — 실행부가 넘긴다.
    ...arr(run?.notVerified).map((n) => `${plain(n.what)}|${plain(n.why)}`),
    ...arr(cur?.notVerified).map((n) => `${plain(n.what)}|${plain(n.why)}`),
    ...arr(project?.notVerified).map((n) => `${plain(n.what)}|${plain(n.why)}`),
    ...(arr(run?.flows).length ? [] : ['실제 화면을 열어 따라가 본 사용자 흐름|이번 실행에서는 화면을 직접 열어 확인하지 않았습니다']),
  ]).map((s) => ({ what: s.split('|')[0], why: s.split('|').slice(1).join('|') }))

  const missing = arr(project?.blockers).map((b) => plain(b.why || b.label))
  const verdict = str(project?.verdict || (cur ? 'not-verified' : 'not-verified'))
  const headline = `${HEAD[verdict] ?? verdict}${missing.length ? ` — 모자란 것: ${missing.slice(0, 3).join(' · ')}${missing.length > 3 ? ` 외 ${missing.length - 3}건` : ''}` : notVerified.length ? ` — 확인 못 한 것 ${notVerified.length}건` : ''}`

  const sections = REPORT_SECTIONS.map((sec) => ({ ...sec, lines: [] }))
  const S = (id) => sections.find((x) => x.id === id).lines

  // ① 지금 할 수 있는 것
  if (!cur) S('capabilities').push('진단 결과가 없어 무엇이 되는지 말할 수 없습니다.')
  else {
    S('capabilities').push(`확인한 기능 ${stories.length}개 가운데 **실제로 되는 것 ${done.length}개**, 아직 아닌 것 ${broken.length}개, 확인 못 한 것 ${unverified.length}개입니다.`)
    if (done.length) S('capabilities').push('', '지금 쓸 수 있는 것:', ...done.slice(0, 20).map((s) => `- ${plain(s.key)}`))
    else S('capabilities').push('', '검사를 근거로 「된다」고 말할 수 있는 기능이 아직 없습니다 — 문서에 완료라고 적힌 것만으로는 되는 것으로 세지 않습니다.')
    if (broken.length) S('capabilities').push('', '아직 쓸 수 없는 것:', ...broken.slice(0, 15).map((s) => `- ${plain(s.key)} — ${VERDICT_KO[s.verdict] ?? s.verdict}`))
  }

  // ② 이번에 끝낸 것 — **verified-done 만** 들어간다
  {
    const closed = arr(backlog?.closed)
    if (!done.length && !closed.length) S('completed').push('이번 실행에서 「끝났다」고 적을 수 있는 것이 없습니다.')
    if (done.length) S('completed').push('완료를 검사로 확인한 기능:', ...done.slice(0, 20).map((s) => `- ${plain(s.key)}`))
    if (closed.length) S('completed').push('', '이번에 사라진 문제:', ...closed.slice(0, 20).map((i) => `- ${plain(i.title)}`))
    if (first && cur && first !== cur) {
      const d = (first.counts?.findingsTotal ?? 0) - (cur.counts?.findingsTotal ?? 0)
      S('completed').push('', d > 0 ? `처음보다 문제 ${d}건이 줄었습니다.` : d < 0 ? `처음보다 문제 ${-d}건이 늘었습니다.` : '처음과 견줘 문제 수는 그대로입니다.')
    }
  }

  // ③ 검사 결과
  {
    const g = cur?.gates ?? {}
    // 「명령이 없다」와 「이번에 안 돌렸다」는 다른 말이다 — 둘 다 통과가 아니지만, 사람이 할 일이 다르다.
    const line = (name, ko) => {
      const v = g[name]
      if (!v) return `- ${ko}: 이번에 돌리지 않았습니다 — 돌리지 않은 것은 통과가 아닙니다`
      if (v.available === false) return `- ${ko}: 이 프로젝트에 해당 검사 명령이 없습니다 — 없는 것은 통과가 아닙니다`
      if (!Number.isFinite(v.exit)) return `- ${ko}: 이번에 돌리지 않았습니다`
      return `- ${ko}: ${v.exit === 0 ? '통과' : '실패'}${v.ms ? ` (${dur(v.ms)})` : ''}`
    }
    S('gates').push(line('qa', '기본 검사(타입·문법·자동테스트)'), line('build', '빌드'))
    S('gates').push(`- 보안·성능 검사: ${arr(cur?.notVerified).some((n) => /security|보안/.test(str(n.what))) ? '해당 명령이 없어 돌리지 못했습니다' : '판정 있음'}`)
    S('gates').push(`- 합치기(통합) 검사: ${ind.integration.runs ? `${ind.integration.pass}건 통과 · ${ind.integration.fail}건 실패` : '기록이 없습니다'}`)
  }

  // ④ 실제 확인한 사용자 흐름
  {
    const flows = arr(run?.flows)
    if (flows.length) S('flows').push(...flows.map((f) => `- ${plain(f.name ?? f)}${f.result ? ` — ${plain(f.result)}` : ''}`))
    else S('flows').push('이번 실행에서는 화면을 직접 열어 처음부터 끝까지 따라가 본 흐름이 없습니다. 아래 「확인하지 못한 것」에 그대로 남겼습니다.')
  }

  // ⑤ 자동 수정·교차 검토
  {
    S('autofix').push(`자동으로 고치기를 ${ind.autoFix.repairRounds}회 시도했고, 담당을 바꿔 다시 맡긴 것이 ${ind.autoFix.providerSwitches}회입니다.`)
    if (ind.autoFix.repeatedFailures > 0) S('autofix').push(`같은 원인으로 세 번 넘게 막힌 것이 ${ind.autoFix.repeatedFailures}건 있어 사람을 불러야 합니다.`)
    if (ms.length) {
      const cross = ms.filter((m) => str(m?.review?.provider) && str(m.review.provider) !== str(m?.workers?.dev?.provider)).length
      S('autofix').push(`만든 쪽과 다른 쪽이 검토한 작업 ${cross}건 / 전체 ${ms.length}건 · 높음 지적 ${ind.review.high}건이 남아 있습니다.`)
    } else S('autofix').push('교차 검토 기록이 없어 검토가 실제로 있었는지 확인하지 못했습니다.')
    if (bmadApplied) S('autofix').push(`계획 문서 반영: 적용 ${arr(bmadApplied.applied).length}건 · 건너뜀 ${arr(bmadApplied.skipped).length}건${arr(bmadApplied.conflicts).length ? ` · 사람이 고친 곳과 부딪혀 전부 되돌림` : ''}`)
  }

  // ⑥ 시간·동시 진행
  {
    S('time').push(renderIndicatorsTable(ind))
    if (comparison) S('time').push('', comparison.comparable ? `이전 실행과 비교: ${plain(comparison.why)}` : `이전 실행과 **비교 불가** — ${plain(comparison.why.replace(/^비교 불가 — /, ''))}`)
  }

  // ⑦ 남은 문제·위험
  {
    const items = arr(backlog?.items).filter((i) => i.state !== 'closed').slice(0, 15)
    if (!items.length) S('risks').push('남은 문제로 잡힌 것이 없습니다.')
    else {
      S('risks').push('급한 것부터입니다.')
      for (const i of items) S('risks').push(`- **${plain(i.title)}** — ${plain(i.userImpact || i.purpose)}${i.autoFixAllowed === false ? ' (사람이 봐야 하는 갈래라 자동으로 고치지 않습니다)' : ''}`)
    }
    const blocked = arr(backlog?.blocked)
    if (blocked.length) S('risks').push('', `사람 결정을 기다리며 멈춘 것 ${blocked.length}건 — 나머지는 계속 돌았습니다.`)
  }

  // ⑧ 확인하지 못한 것
  {
    if (!notVerified.length) S('notVerified').push('확인하지 못한 항목은 없습니다.')
    else {
      S('notVerified').push('아래는 **통과가 아니라 「모른다」** 입니다. 통과로 세지 않았습니다.')
      for (const n of notVerified.slice(0, 30)) S('notVerified').push(`- ${n.what} — ${n.why}`)
      if (unverified.length) S('notVerified').push('', `문서에는 끝났다고 적혀 있지만 검사 증거가 없어 완료로 세지 않은 기능 ${unverified.length}건: ${unverified.slice(0, 15).map((s) => plain(s.key)).join(' · ')}`)
    }
  }

  // ⑨ 배포 가능 여부
  {
    S('deployable').push(`**${HEAD[verdict] ?? verdict}**`)
    if (project) {
      S('deployable').push('', renderVerdictList(project))
    } else S('deployable').push('', '판정에 필요한 재료가 없어 배포 가능 여부를 정하지 못했습니다.')
    S('deployable').push('', '「배포 가능한 상태」와 「실제로 배포하는 것」은 다릅니다 — 실제 반영은 승인을 받은 뒤에만 합니다.')
  }

  // ⑩ 결정할 것
  {
    const qs = arr(questions)
    if (qs.length) for (const q of qs) S('decisions').push(renderDecision(q))
    else S('decisions').push('- 지금 결정해 주셔야 넘어가는 항목은 없습니다.')
    S('decisions').push(`- 커밋·푸시·합치기·배포는 승인이 필요합니다 — ${verdict === 'ready' ? '준비는 끝났고 실행 승인만 남았습니다.' : '아직 요청드리지 않습니다.'}`)
  }

  return {
    schema: REPORT_SCHEMA,
    at: str(cur?.at) || str(run?.endedAt) || null,
    // 프로젝트 표시 이름은 **폴더 이름만** 쓴다 — 본문에 전체 경로를 싣지 않기 위해서다.
    run: { id: str(run?.id) || null, project: str(run?.project) || baseName(str(run?.root)) || null, startedAt: run?.startedAt ?? null, endedAt: run?.endedAt ?? null, rounds: num(run?.rounds) ?? ds.length, mode: str(run?.mode) || 'autofinish' },
    verdict, headline, missing,
    counts: { stories: stories.length, verifiedDone: done.length, notVerified: unverified.length, open: arr(backlog?.items).filter((i) => i.state !== 'closed').length },
    indicators: ind,
    comparison,
    readiness: project ? { verdict: project.verdict, counts: project.counts, blockers: project.blockers } : null,
    tasks: taskReadiness.map((t) => ({ subject: t.subject, verdict: t.verdict, counts: t.counts })),
    sections,
    notVerified,
    decisions: arr(questions).map((q) => ({ title: str(q.title), why: str(q.why), options: arr(q.options), recommended: str(q.recommended), safeDefault: str(q.safeDefault) })),
  }
}

function renderVerdictList(project) {
  const bad = arr(project.blockers)
  const nv = arr(project.notVerified)
  const out = []
  if (bad.length) out.push('막고 있는 것:', ...bad.map((b) => `- ${plain(b.label)} — ${plain(b.why)}`))
  if (nv.length) out.push(...(bad.length ? [''] : []), '확인 못 해서 통과로 적을 수 없는 것:', ...nv.map((b) => `- ${plain(b.what)} — ${plain(b.why)}`))
  if (!out.length) out.push('여덟 가지 조건을 모두 통과했습니다.')
  return out.join('\n')
}

function renderDecision(q) {
  const opts = arr(q.options).map((o, i) => `  ${'ⓐⓑⓒⓓ'[i] ?? `(${i + 1})`} ${plain(o.label ?? o)}${o.why ? ` — ${plain(o.why)}` : ''}`)
  return [
    `- **${plain(q.title)}**`,
    q.why ? `  지금 무슨 일: ${plain(q.why)}` : '',
    ...opts,
    q.recommended ? `  추천: ${plain(q.recommended)}` : '',
    q.safeDefault ? `  아무 말씀 없으시면: ${plain(q.safeDefault)}` : '',
  ].filter(Boolean).join('\n')
}

// ── 렌더 ─────────────────────────────────────────────────────────────────────
/** 보고서 본문(마크다운). **렌더 직전에 한 번 더 마스킹**한다. */
export function renderReportMd(model) {
  if (!model) return ''
  const head = [
    `# 자율 마무리 결과 — ${model.run.project ?? '프로젝트'}`,
    '',
    `## ${model.headline}`,
    '',
    `- 기능 ${model.counts.stories}개 가운데 확인된 완료 ${model.counts.verifiedDone}개 · 확인 못 함 ${model.counts.notVerified}개 · 남은 일 ${model.counts.open}건`,
    `- 라운드 ${model.run.rounds}회 · 걸린 시간 ${dur(model.indicators.time.wallMs)}`,
    '',
  ]
  const body = model.sections.map((s) => [`## ${s.n}. ${s.title}`, '', ...(s.lines.length ? s.lines : ['(적을 것이 없습니다)']), ''].join('\n'))
  return maskSecrets([...head, ...body].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
}

/** 보고서 JSON — 문자열은 전부 다시 마스킹해서 내보낸다.
 *  마스커는 **공용 단일 소스**다(codex-review-r3 H1) — 여기서 따로 정의하지 않는다. */
export function renderReportJson(model) {
  return deepRedact(model)
}

export { VERDICT_KO }
