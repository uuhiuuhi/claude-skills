// dev-status — 배포 가능 판정 (순수 함수 · 규칙만 · LLM 호출 0)
//
// 설계 §2-① 표 그대로다. 이 파일이 지키는 것 두 가지:
//   ① **재료가 없으면 「판정 불가」다 — GREEN 이 아니다.** 「확인 못 한 것을 통과로 적지 않는다」의 집행부.
//   ② **자율 진단 산출물이 없으면 상한이 AMBER 다.** 진단을 안 돌린 것을 「이상 없음」으로 그리면
//      화면이 사람을 속인다(2026-09-02 설계 「핵심 발견 3」).
// RED 와 GREEN 이 동시에 성립하면 RED 다(나쁜 쪽이 이긴다).

export const RED = 'red'
export const AMBER = 'amber'
export const GREEN = 'green'
export const UNKNOWN = 'unknown'

const LABEL = {
  [RED]: '배포 불가',
  [AMBER]: '조건부 — 확인 필요',
  [GREEN]: '배포 가능',
  [UNKNOWN]: '판정 불가',
}

const arr = (v) => (Array.isArray(v) ? v : [])
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

/**
 * 배포 가능 판정.
 *
 * @param {object} input
 *   manifests      배치 매니페스트 배열(정규화된 parseBatchManifest 값)
 *   lastNight      지난밤(18:00 접기)에 속한 매니페스트 배열
 *   metrics        metrics-<id>.json 배열
 *   queue          parseQueue 결과값(없으면 null)
 *   verifications  <story>-verification.json 배열
 *   inbox          parseInbox 결과값(없으면 null)
 *   diagnosis / backlog / readiness  자율 진단 산출물(없으면 null)
 *   chainAgeDays   미머지 auto/* 체인 나이(큐 `_편성.chainAgeDays` · 모르면 null)
 * @returns {{level,label,why,reasons:string[],capped:boolean}}
 */
export function deployVerdict({
  manifests = [], lastNight = [], metrics = [], queue = null,
  verifications = [], inbox = null,
  diagnosis = null, backlog = null, readiness = null,
  chainAgeDays = null,
} = {}) {
  const red = []
  const amber = []

  // ── RED ──────────────────────────────────────────────────────────────────
  for (const m of arr(manifests)) {
    const r = m?.integration?.result
    if (r === 'fail' || r === 'rollback') {
      red.push('배치 ' + (m.label || m.batchId || '?') + ' 의 통합 게이트가 ' + (r === 'rollback' ? '되돌림' : '실패') + '입니다')
    }
    if (n(m?.worst) >= 7) red.push('배치 ' + (m.label || m.batchId || '?') + ' 이 exit ' + m.worst + ' 로 끝났습니다')
  }
  const topTiers = tierRemaining(diagnosis, backlog, [1, 2, 3])
  if (topTiers.known && topTiers.count > 0) {
    red.push('자율 진단 우선순위 ①②③(비밀정보·빌드 실패·배포 차단) 잔여 ' + topTiers.count + '건')
  }
  if (readiness && readiness.verdict === 'not-ready') {
    red.push('자율 마무리 판정이 「배포 불가」입니다 — 미달 ' + n(readiness.counts?.fail) + '건')
  }

  // ── AMBER ────────────────────────────────────────────────────────────────
  for (const m of arr(metrics)) {
    if (m?.qualityGate && m.qualityGate.passed === false) {
      amber.push('계측 품질 게이트 미통과 — ' + (m.qualityGate.why || '사유 없음'))
    }
  }
  if (queue?.validation && queue.validation.ok === false) {
    amber.push('오늘 예정 큐의 자기 검증이 실패했습니다 — 걸린 항목 ' + arr(queue.validation.errors).length + '건')
  }
  const badChecks = arr(verifications).flatMap((v) => arr(v.checkFails).map((c) => (v.story || '?') + ' 의 ' + c.check))
  if (badChecks.length) amber.push('스토리 검사 실패·미구성 ' + badChecks.length + '건 — ' + badChecks.slice(0, 3).join(' · '))
  const pending = arr(inbox?.pending).length
  if (pending > 0) amber.push('결정 대기 ' + pending + '건')
  const gates = arr(inbox?.gates).length
  if (gates > 0) amber.push('사람 게이트 ' + gates + '건')
  if (n(chainAgeDays) >= 1) amber.push('미머지 auto/* 체인이 ' + n(chainAgeDays) + '일째입니다')
  const midTiers = tierRemaining(diagnosis, backlog, [4, 5])
  if (midTiers.known && midTiers.count > 0) {
    amber.push('자율 진단 우선순위 ④⑤(핵심 흐름 미완·회귀 누락) 잔여 ' + midTiers.count + '건')
  }
  if (readiness && readiness.verdict === 'not-verified') {
    amber.push('자율 마무리 판정이 「확인 못 함」입니다 — 확인 못 한 항목 ' + n(readiness.counts?.notVerified) + '건')
  }

  // ── 재료 유무 ─────────────────────────────────────────────────────────────
  const material = arr(manifests).length + arr(metrics).length + arr(verifications).length
    + (queue ? 1 : 0) + (diagnosis ? 1 : 0) + (readiness ? 1 : 0) + (backlog ? 1 : 0)
  if (material === 0) {
    return {
      level: UNKNOWN, label: LABEL[UNKNOWN], capped: false,
      why: '판정할 재료가 없습니다 — 배치 매니페스트·계측·검증 기록·예정 큐·자율 진단이 모두 없습니다. 「이상 없음」이 아니라 「아직 모른다」입니다.',
      reasons: [],
    }
  }

  if (red.length) return { level: RED, label: LABEL[RED], why: red[0], reasons: red.concat(amber), capped: false }

  // ── GREEN 의 적극 조건 ────────────────────────────────────────────────────
  // 「막는 것이 없다」는 GREEN 의 근거가 아니다. 빈 배열의 `.some()` 은 false 라서
  // 계측 0건·검증 0건이 「전부 통과」로 둔갑한다(2026-09-02 교차리뷰 H2).
  // 그래서 **있어야 할 증거가 실제로 있는지**를 하나씩 센다 — 부재는 통과가 아니다.
  const greenBlocks = []
  const nights = arr(lastNight)
  const ms = arr(metrics)
  const vs = arr(verifications)

  if (nights.length < 1) greenBlocks.push('지난밤 배치 기록이 없습니다')
  else if (nights.some((m) => m?.integration?.result !== 'pass')) greenBlocks.push('지난밤 배치 중 통합 게이트가 pass 가 아닌 것이 있습니다')
  if (arr(manifests).some((m) => m?.integration?.result !== 'pass')) greenBlocks.push('통합 게이트가 pass 가 아닌 배치가 있습니다')

  if (ms.length < 1) greenBlocks.push('계측 기록이 0건입니다 — 품질 게이트를 통과했다는 증거가 없습니다')
  else if (ms.some((m) => !m?.qualityGate || m.qualityGate.passed !== true)) greenBlocks.push('품질 게이트 통과(passed=true)가 기록되지 않은 계측이 있습니다')

  // 지난밤 배치가 돌린 스토리에는 검증 기록이 **있어야** 한다. 배치가 스토리를 안 적었으면
  // 최소한 검증 기록 1건은 있어야 「검사 실패 0」이라고 쓸 수 있다.
  const wantStories = [...new Set(nights.flatMap((m) => arr(m?.stories).map((s) => String(s))).filter(Boolean))]
  const haveStories = new Set(vs.map((v) => String(v?.story || '')).filter(Boolean))
  const missingV = wantStories.filter((s) => !haveStories.has(s))
  if (vs.length < 1) greenBlocks.push('스토리 검증 기록이 0건입니다 — 검사 실패 0 이라고 적을 근거가 없습니다')
  else if (missingV.length) greenBlocks.push('검증 기록이 없는 스토리가 있습니다 — ' + missingV.slice(0, 3).join(' · '))
  if (badChecks.length) greenBlocks.push('검사 실패 기록이 있습니다')

  const DIAG_MISSING = '자율 마무리 진단(diagnosis) 산출물이 없습니다'
  if (!diagnosis) greenBlocks.push(DIAG_MISSING)
  if (!readiness) greenBlocks.push('자율 마무리 판정(readiness) 산출물이 없습니다')
  else if (readiness.verdict !== 'ready') greenBlocks.push('자율 마무리 판정이 「' + (readiness.verdict || '값 없음') + '」이라 ready 가 아닙니다')

  if (amber.length) return { level: AMBER, label: LABEL[AMBER], why: amber[0], reasons: amber, capped: false }

  // 진단이 없으면 상한 AMBER — backlog·readiness 유무와 **무관한 단독 조건**이다.
  // (예전 판정은 `!diagnosis && !readiness && !backlog` 였고, backlog 하나만 있어도 상한을 건너뛰었다.)
  if (!diagnosis) {
    return {
      level: AMBER, label: LABEL[AMBER], capped: true,
      why: '막는 것은 없지만 자율 마무리 진단을 아직 돌리지 않았습니다 — 확인하지 못한 것이 있으므로 「배포 가능」으로는 올리지 않습니다.',
      reasons: ['자율 진단 산출물 없음(상한 AMBER)'].concat(greenBlocks.filter((b) => b !== DIAG_MISSING)),
    }
  }

  if (greenBlocks.length) {
    return {
      level: UNKNOWN, label: LABEL[UNKNOWN], capped: false,
      why: greenBlocks[0] + ' — 「배포 가능」이라고 적을 근거가 모자랍니다.',
      reasons: greenBlocks,
    }
  }

  // 이유 문장은 **센 것만** 적는다. 증거 없이 「품질 게이트 통과」라고 쓰지 않는다.
  return {
    level: GREEN, label: LABEL[GREEN], capped: false,
    why: '지난밤 배치 ' + nights.length + '건 전부 통합 게이트 pass · 계측 ' + ms.length + '건 전부 품질 게이트 통과 · 검증 '
      + vs.length + '건 검사 실패 0 · 자율 진단 있음 · 마무리 판정 ready · 결정 대기 0 입니다.',
    reasons: [],
  }
}

/** 진단·백로그의 우선순위 단계별 잔여 수. 재료가 없으면 known=false(0 으로 세지 않는다). */
export function tierRemaining(diagnosis, backlog, tiers) {
  const want = new Set(tiers)
  if (backlog && backlog.byTier && typeof backlog.byTier === 'object') {
    let c = 0
    for (const [t, v] of Object.entries(backlog.byTier)) if (want.has(Number(t))) c += n(v)
    return { known: true, count: c, from: 'backlog.byTier' }
  }
  const f = diagnosis?.counts?.findings
  if (f && typeof f === 'object') {
    let c = 0
    for (const [t, v] of Object.entries(f)) if (want.has(Number(t))) c += n(v)
    return { known: true, count: c, from: 'diagnosis.counts.findings' }
  }
  return { known: false, count: 0, from: null }
}

/**
 * ⑨ 불일치·경고 — 하네스 산출물이 만드는 3종. 기존 4종(epics ↔ sprint)에 **더한다**.
 * 반환은 기존 drift 와 같은 모양 `{level,where,msg}` 이라 호출부가 그대로 이어 붙이면 된다.
 */
export function batchWarnings({ manifests = [], verifications = [], stories = [] } = {}) {
  const out = []
  const known = new Set(arr(stories).map((s) => String(s.slug || '')).filter(Boolean))
  const statusOf = new Map(arr(stories).map((s) => [String(s.slug || ''), String(s.status || '')]))

  const seen = new Set()
  for (const m of arr(manifests)) {
    for (const s of arr(m.stories)) {
      if (known.size === 0 || known.has(String(s)) || seen.has(String(s))) continue
      seen.add(String(s))
      out.push({ level: 'high', where: '배치 ' + (m.label || m.batchId || '?'), msg: '"' + s + '" — 배치가 돌린 스토리가 sprint-status.yaml 에 없습니다(unknown-story)' })
    }
    const r = m?.integration?.result
    if (r === 'fail' || r === 'rollback') {
      out.push({
        level: 'high', where: '배치 ' + (m.label || m.batchId || '?'),
        msg: '통합 게이트 ' + (r === 'rollback' ? '되돌림' : '실패') + ' — landing ' + arr(m.landing).length + '건, 푸시 ' + (m.pushed ? '됨(확인 필요)' : '차단됨'),
      })
    }
  }

  for (const v of arr(verifications)) {
    const integ = String(v?.checks?.integration ?? '')
    const st = statusOf.get(String(v.story)) ?? ''
    if (/^unknown/.test(integ) && (st === 'done' || st === 'review')) {
      out.push({
        level: 'mid', where: 'Story ' + v.story,
        msg: '상태는 ' + st + ' 인데 검증 기록의 통합 칸이 「확인 안 됨」입니다 — 통합 게이트를 통과한 적이 없습니다',
      })
    }
  }
  return out
}
