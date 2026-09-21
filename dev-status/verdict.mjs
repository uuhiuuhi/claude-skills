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

// ── 두 갈래(운영선 · 개발선) 가르기 — **설정이 있을 때만 동작한다** ─────────
// 왜 — 배포 판정은 **운영선(배포되는 갈래)** 이 지금 나가도 되느냐의 물음이다. 별도 갈래에서만
// 도는 개발선 배치의 리뷰 대기·STOP 을 운영 배포의 「막는 것」으로 세면 헤더가 영원히 RED 다
// (원 프로젝트 2026-09-21 실측 296건). 개발선 재료는 버리지 않고 **참고 한 줄**로 접는다.
//
// **이 스킬은 운영선 에픽 목록을 스스로 알아내지 않는다.** 어느 에픽이 운영선인지는 프로젝트
// 고유의 릴리스 규약이라, 프로젝트 루트의 `tools/dev-status/sources.json` 에 `opsLineEpics`
// 가 적혀 있을 때만 이 가르기가 켜진다. 값이 없으면 `opsEpics = []` 이고, 그때는
// **아무것도 접지 않는다**(종전 동작 그대로 전건을 센다 — 가릴 근거가 없으면 가리지 않는다).
// 아래 `lineOfFinding`(진단 항목)·`splitChain`(미머지 갈래)도 같은 규칙을 따른다.

/** 스토리 슬러그·번호의 에픽 번호. '13-2-…' → 13 · '1.29' → 1 · 못 읽으면 null */
export function epicOfStory(slug) {
  const m = /^(\d+)[-.]/.exec(String(slug ?? '').trim())
  if (!m) return null
  const e = Number(m[1])
  return Number.isFinite(e) ? e : null
}

/** 매니페스트·계측의 스토리 슬러그들(매니페스트는 문자열 배열 · 계측은 {story} 객체 배열). */
export function storySlugs(item) {
  return arr(item?.stories)
    .map((s) => (typeof s === 'string' ? s : String(s?.story ?? '')))
    .filter(Boolean)
}

/**
 * 배치 산출물 1건이 어느 갈래인가.
 *   · 호출부가 `fromRunnerClone: true` 로 표시한 것은 전부 개발선(이 스킬은 표시하지 않는다 — 플러그인용 고리).
 *   · 스토리 에픽이 **전부** 개발선 에픽이면 개발선.
 *   · 운영선 에픽이 하나라도 섞였거나 · 스토리를 모르거나 · 운영선 목록이 없으면 'ops'(센다).
 *     — 나쁜 쪽이 이긴다. 가릴 근거가 없으면 가리지 않는다.
 */
export function releaseLineOf(item, opsEpics = []) {
  const set = new Set(arr(opsEpics).map(Number).filter((x) => Number.isFinite(x)))
  if (!set.size) return 'ops'
  if (item?.fromRunnerClone === true) return 'dev'
  const eps = storySlugs(item).map(epicOfStory).filter((e) => e != null)
  if (!eps.length) return 'ops'
  return eps.every((e) => !set.has(e)) ? 'dev' : 'ops'
}

/**
 * 스토리 검사 실패·미구성을 **지금 세는 것**과 **그 검사가 생기기 전 기록**으로 가른다.
 *
 * 왜 — 검증 기록(`<story>-verification.json`)은 그때의 사진이라 나중에 다시 찍히지 않는다.
 * 검사 종류(security·performance·api·authorization)가 프로젝트에 들어오기 **전**에 찍힌 사진은
 * 「스크립트 없음(required-missing)」이 정상이고, 그 스토리들은 「머지해줘」 절차(qa + 운영 배포)로
 * 검증됐다. 그걸 영구히 「막는 것」으로 세면 헤더가 영원히 AMBER 다(2026-09-21 실측 10건 · 전부 09-05 기록).
 *
 * 판정 근거 = 검증 기록이 만들어진 시각(`generatedAt`) vs 그 검사 종류의 도입일.
 * 도입일을 모르는 검사(qa·lint·typecheck 처럼 처음부터 있던 것)나 기록 시각을 모르면 **접지 않는다**
 * — 확인 못 한 것을 통과로 적지 않는다. 원본 기록은 감사 기록이라 손대지 않고 세는 규칙만 고친다.
 *
 * @param {Array} verifications 정규화된 검증 기록(`checkFails`·`generatedAt`)
 * @param {object|null} gatesSince 검사 종류 → 도입일(YYYY-MM-DD) 맵
 * @returns {{counted:string[], folded:number}}
 */
export function splitCheckFails(verifications, gatesSince = null) {
  const since = gatesSince && typeof gatesSince === 'object' ? gatesSince : {}
  const counted = []
  let folded = 0
  for (const v of arr(verifications)) {
    const madeAt = ts(v?.generatedAt)
    for (const c of arr(v?.checkFails)) {
      const gateAt = ts(since[String(c?.check ?? '')])
      if (gateAt !== null && madeAt !== null && madeAt < gateAt) { folded += 1; continue }
      counted.push((v?.story || '?') + ' 의 ' + String(c?.check ?? '?'))
    }
  }
  return { counted, folded }
}

/**
 * 미머지 갈래 목록을 **개발선 날짜 체인**과 **운영선 수리 갈래**로 가른다.
 *
 * 왜 — 두 갈래로 운영하는 프로젝트에서 개발선 체인 `auto/YYYY-MM-DD` 는 **정본 갈래에 머지하지
 * 않는 것이 정상**이고 릴리스 묶음으로만 나간다. 그걸 「미머지 체인 N일」로 세면 릴리스 사이 내내
 * 헤더가 AMBER 로 잠긴다(2026-09-21 실측 7일). 운영선 수리 갈래(`auto/<날짜>-<주제>`)는 종전대로 센다.
 *
 * 주제 갈래는 이름만으로 갈래를 가릴 수 없다(`-fix-` 규약을 안 지킨 것이 섞여 있다). 그래서
 * **개발선으로 확인된 것만** `devLineBranches`(sources.json)에 이름으로 적어 접는다 — 목록에 없으면
 * 종전대로 센다. 가릴 근거가 없으면 가리지 않는다.
 *
 * 날짜를 못 읽는 이름(`auto/tooling` 등)은 어느 쪽으로도 세지 않는다 — 추측하지 않는다.
 * 나이 = 가장 오래된 날짜 → 오늘(엔진 `inheritPlan` 과 같은 셈법).
 *
 * @param {string[]} branches `origin/` 접두는 떼고 같은 이름으로 합친다
 * @param {string} todayYmd 오늘(YYYY-MM-DD)
 * @param {string[]} devLineBranches 개발선으로 확인된 주제 갈래 이름(`origin/` 접두는 무시)
 * @returns {{dev:{days:number|null,branches:string[]}, ops:{days:number|null,branches:string[]}}}
 */
export function splitChain(branches, todayYmd, devLineBranches = []) {
  const day = (ymd) => Math.floor(Date.parse(ymd + 'T00:00:00Z') / 86400000)
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(todayYmd ?? '')) ? day(todayYmd) : null
  const known = new Set(arr(devLineBranches).map((b) => String(b ?? '').trim().replace(/^origin\//, '')).filter(Boolean))
  const dev = []
  const ops = []
  for (const raw of arr(branches)) {
    const name = String(raw ?? '').trim().replace(/^origin\//, '')
    const m = /^auto\/(\d{4}-\d{2}-\d{2})(-.+)?$/.exec(name)
    if (!m) continue
    ;(m[2] && !known.has(name) ? ops : dev).push({ name, date: m[1] })
  }
  const pack = (list) => ({
    days: list.length && today !== null
      ? Math.max(0, today - day(list.reduce((a, b) => (b.date < a.date ? b : a)).date))
      : null,
    branches: [...new Set(list.map((x) => x.name))].sort(),
  })
  return { dev: pack(dev), ops: pack(ops) }
}

/** 매니페스트·계측의 시각(계측에는 at 이 없어 batchId 의 날짜를 그 날 끝으로 읽는다 — 접는 쪽이 아니라 세는 쪽). */
function atOfItem(item) {
  const t = ts(item?.at)
  if (t !== null) return t
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(item?.batchId ?? ''))
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59) - 9 * 3600000
}

/**
 * 배치 재료를 셋으로 가른다.
 *   active     = 지금 운영 배포 판정에 쓰는 것(운영선 · 마지막 릴리스 이후)
 *   dev        = 개발선(릴리스 열차 별도)
 *   preRelease = 마지막 운영 릴리스 이전에 끝난 운영선 배치(이미 반영되고 끝난 것)
 * 시각을 모르면 접지 않는다.
 */
export function splitBatchMaterial(items, { opsEpics = [], lastReleaseAt = null } = {}) {
  const relAt = ts(lastReleaseAt)
  const active = []
  const dev = []
  const preRelease = []
  for (const it of arr(items)) {
    if (releaseLineOf(it, opsEpics) === 'dev') { dev.push(it); continue }
    const at = atOfItem(it)
    if (relAt !== null && at !== null && at <= relAt) { preRelease.push(it); continue }
    active.push(it)
  }
  return { active, dev, preRelease }
}

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
 *   chainBranches  미머지 갈래 이름 목록(chain-info.json `branches` · 비면 위 숫자 하나로 센다)
 *   devLineBranches 개발선으로 확인된 주제 갈래 이름(sources.json 의 devLineBranches · 비면 전건을 센다)
 *   qualityGatesSince 검사 종류별 도입일 맵({security:'2026-09-10',…} · 없으면 아무것도 접지 않는다)
 *   opsEpics       운영선 에픽 번호(sources.json 의 opsLineEpics · 비면 아무것도 접지 않는다)
 *   lastReleaseAt  마지막 운영 릴리스 시각(ISO · lastRelease() 산출 · 모르면 null)
 *   lastReleaseLabel 화면에 적을 릴리스 절 머리 문구
 *   now            오늘 기준 시각(체인 나이 계산 · 테스트가 고정한다)
 * @returns {{level,label,why,reasons:string[],capped:boolean,notes:string[],lines:object}}
 */
export function deployVerdict({
  manifests = [], lastNight = [], metrics = [], queue = null,
  verifications = [], inbox = null,
  diagnosis = null, backlog = null, readiness = null,
  chainAgeDays = null, chainBranches = null, devLineBranches = null, qualityGatesSince = null,
  opsEpics = [], lastReleaseAt = null, lastReleaseLabel = '', now = new Date(),
} = {}) {
  const red = []
  const amber = []

  // 판정에 쓰는 재료는 **운영선 · 마지막 릴리스 이후** 배치뿐이다(위 「두 갈래 가르기」 참고).
  const M = splitBatchMaterial(manifests, { opsEpics, lastReleaseAt })
  const G = splitBatchMaterial(metrics, { opsEpics, lastReleaseAt })
  const isRollback = (m) => m?.integration?.result === 'fail' || m?.integration?.result === 'rollback'
  const lines = {
    ops: { manifests: M.active.length, metrics: G.active.length },
    dev: {
      manifests: M.dev.length,
      metrics: G.dev.length,
      reviewPending: M.dev.filter((m) => n(m?.worst) === 8).length,
      recovery: G.dev.filter((m) => m?.qualityGate && m.qualityGate.passed === false).length,
      stop: M.dev.filter((m) => (n(m?.worst) >= 7 && n(m?.worst) !== 8) || isRollback(m)).length,
    },
    preRelease: {
      manifests: M.preRelease.length,
      metrics: G.preRelease.length,
      rollback: M.preRelease.filter(isRollback).length,
    },
    opsEpics: arr(opsEpics).slice(),
    lastReleaseAt: lastReleaseAt || null,
  }
  const notes = []
  if (lines.dev.manifests || lines.dev.metrics) {
    notes.push('개발선(릴리스 열차 별도) — 리뷰 대기 ' + lines.dev.reviewPending
      + ' · 회수 대기 ' + lines.dev.recovery + ' · STOP ' + lines.dev.stop
      + ' (배치 ' + lines.dev.manifests + '건 · main 에 머지하지 않으므로 운영 배포 판정에 넣지 않습니다)')
  }
  if (lines.preRelease.rollback) {
    notes.push('참고 — 마지막 릴리스 이전 되돌림 ' + lines.preRelease.rollback + '건'
      + (lastReleaseLabel ? '(' + lastReleaseLabel + ' 이전)' : '') + ' — 이미 운영에 반영되고 끝난 배치라 판정에 넣지 않습니다')
  }
  const done = (o) => ({ ...o, notes, lines })

  // ── RED ──────────────────────────────────────────────────────────────────
  for (const m of M.active) {
    const r = m?.integration?.result
    if (r === 'fail' || r === 'rollback') {
      red.push('배치 ' + (m.label || m.batchId || '?') + ' 의 통합 게이트가 ' + (r === 'rollback' ? '되돌림' : '실패') + '입니다')
    }
    // exit 8 = 「리뷰 대기」(2026-09-07 👤 T6 규칙 · 회수 dev 배치가 qa GREEN 인데 review 단계가 없어 교차 검토만 미충족) — 고장이 아니다.
    // 러너 차단기도 세지 않는다(runner-rules isReviewPendingExit). RED 로 그리면 정상인 밤이 통째로 「배포 불가」가 된다(2026-09-09 실측: 15배치 중 exit 8 여럿 → RED 28건).
    if (n(m?.worst) === 8) amber.push('배치 ' + (m.label || m.batchId || '?') + ' 이 리뷰 대기(exit 8)로 끝났습니다 — 교차 검토만 미충족 · 다음 라운드가 review 를 잇습니다')
    else if (n(m?.worst) >= 7) red.push('배치 ' + (m.label || m.batchId || '?') + ' 이 exit ' + m.worst + ' 로 끝났습니다')
  }
  const topTiers = tierRemaining(diagnosis, backlog, [1, 2, 3], opsEpics)
  const midTiers = tierRemaining(diagnosis, backlog, [4, 5], opsEpics)
  if (topTiers.known && topTiers.count > 0) {
    red.push('자율 진단 우선순위 ①②③(비밀정보·빌드 실패·배포 차단) 잔여 ' + topTiers.count + '건')
  }
  // 자율 마무리 판정은 **프로젝트 전체** 기준이라 개발선까지 합산돼 있다. 그 판정을 그대로 쓰지 않고
  // 운영선 잔여로 다시 본다 — 운영선에 남은 것이 하나도 없으면 그 미달은 개발선 몫이라 참고 줄로 접는다.
  // 원본 판정·미달 수는 버리지 않고 참고 줄에 그대로 남긴다(원본 파일은 손대지 않는다).
  // 접는 조건은 **보이는 것으로 증명될 때만**이다:
  //   ⓐ 항목 목록이 실제로 있고(집계 숫자만 있으면 갈래를 가릴 근거가 없다)
  //   ⓑ 운영선 잔여가 0 이고 ⓒ 개발선 잔여가 실제로 있다.
  // 「확인 못 함(not-verified)」은 **절대 접지 않는다** — 그건 「검사를 안 돌렸다」는 뜻이고,
  // 접으면 화면이 안 돌린 검사를 통과로 그린다(이 파일 머리말 ①).
  const opsLeft = (topTiers.known ? topTiers.count : 0) + (midTiers.known ? midTiers.count : 0)
  const devLeft = (topTiers.dev ?? 0) + (midTiers.dev ?? 0)
  const hasItems = arr(backlog?.items).length > 0 || arr(diagnosis?.findings).length > 0
  const readyFolded = Boolean(readiness) && readiness.verdict === 'not-ready'
    && hasItems && opsLeft === 0 && devLeft > 0
  if (readiness && readiness.verdict === 'not-ready' && !readyFolded) {
    red.push('자율 마무리 판정이 「배포 불가」입니다 — 운영선 잔여 ' + opsLeft
      + '건(프로젝트 전체 미달 ' + n(readiness.counts?.fail) + '건)')
  }

  // ── AMBER ────────────────────────────────────────────────────────────────
  for (const m of G.active) {
    if (m?.qualityGate && m.qualityGate.passed === false) {
      amber.push('계측 품질 게이트 미통과 — ' + (m.qualityGate.why || '사유 없음'))
    }
  }
  if (queue?.validation && queue.validation.ok === false) {
    amber.push('오늘 예정 큐의 자기 검증이 실패했습니다 — 걸린 항목 ' + arr(queue.validation.errors).length + '건')
  }
  const CF = splitCheckFails(verifications, qualityGatesSince)
  const badChecks = CF.counted
  if (badChecks.length) amber.push('스토리 검사 실패·미구성 ' + badChecks.length + '건 — ' + badChecks.slice(0, 3).join(' · '))
  if (CF.folded) {
    notes.push('참고 — 검사 도입 전 기록 ' + CF.folded + '건(그 검사가 프로젝트에 들어오기 전 만들어진 검증 기록)'
      + ' — 「머지해줘」 절차(qa + 운영 배포)로 검증된 기록이라 막는 것으로 세지 않습니다')
  }
  const pending = arr(inbox?.pending).length
  if (pending > 0) amber.push('결정 대기 ' + pending + '건')
  const gates = arr(inbox?.gates).length
  if (gates > 0) amber.push('사람 게이트 ' + gates + '건')
  // 미머지 체인 — 갈래 목록이 있으면 두 갈래로 가른다(개발선 날짜 체인은 릴리스 열차 대기 = 정상).
  // 목록이 없으면 종전대로 숫자 하나로 센다 — 모르는 것을 접지 않는다.
  const chain = arr(chainBranches).length ? splitChain(chainBranches, kstYmd(now), devLineBranches) : null
  if (chain) {
    if (n(chain.ops.days) >= 1) {
      amber.push('미머지 운영선 수리 갈래가 ' + n(chain.ops.days) + '일째입니다 — ' + chain.ops.branches.join(' · '))
    }
    if (chain.dev.days != null) {
      notes.push('개발선 체인 ' + chain.dev.days + '일(릴리스 열차 대기 · 정상) — '
        + chain.dev.branches.join(' · ') + ' 는 main 에 머지하지 않으므로 막는 것으로 세지 않습니다')
    }
  } else if (n(chainAgeDays) >= 1) amber.push('미머지 auto/* 체인이 ' + n(chainAgeDays) + '일째입니다')
  if (midTiers.known && midTiers.count > 0) {
    amber.push('자율 진단 우선순위 ④⑤(핵심 흐름 미완·회귀 누락) 잔여 ' + midTiers.count + '건')
  }
  if (readiness && readiness.verdict === 'not-verified') {
    amber.push('자율 마무리 판정이 「확인 못 함」입니다 — 확인 못 한 항목 ' + n(readiness.counts?.notVerified) + '건')
  }
  if (devLeft > 0) {
    notes.push('개발선 진단 잔여 ' + devLeft + '건(릴리스 묶음 열 때 정리) — 개발선 에픽 몫이라 운영 배포 판정에 넣지 않습니다')
  }
  if (readyFolded) {
    notes.push('참고 — 자율 마무리 판정 원본은 「' + (readiness.verdict || '값 없음') + '」(프로젝트 전체 미달 '
      + n(readiness.counts?.fail) + '건 · 확인 못 함 ' + n(readiness.counts?.notVerified)
      + '건)입니다 — 운영선 잔여가 0 이라 개발선 몫으로 보고 막는 것으로 세지 않습니다')
  }

  // ── 재료 유무 ─────────────────────────────────────────────────────────────
  const material = arr(manifests).length + arr(metrics).length + arr(verifications).length
    + (queue ? 1 : 0) + (diagnosis ? 1 : 0) + (readiness ? 1 : 0) + (backlog ? 1 : 0)
  if (material === 0) {
    return done({
      level: UNKNOWN, label: LABEL[UNKNOWN], capped: false,
      why: '판정할 재료가 없습니다 — 배치 매니페스트·계측·검증 기록·예정 큐·자율 진단이 모두 없습니다. 「이상 없음」이 아니라 「아직 모른다」입니다.',
      reasons: [],
    })
  }

  if (red.length) return done({ level: RED, label: LABEL[RED], why: red[0], reasons: red.concat(amber), capped: false })

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
  // readyFolded = 미달이 전부 개발선 몫이라고 판정한 경우(위) — 운영선 기준으로는 막는 것이 없다.
  if (!readiness) greenBlocks.push('자율 마무리 판정(readiness) 산출물이 없습니다')
  else if (readiness.verdict !== 'ready' && !readyFolded) greenBlocks.push('자율 마무리 판정이 「' + (readiness.verdict || '값 없음') + '」이라 ready 가 아닙니다')

  if (amber.length) return done({ level: AMBER, label: LABEL[AMBER], why: amber[0], reasons: amber, capped: false })

  // 진단이 없으면 상한 AMBER — backlog·readiness 유무와 **무관한 단독 조건**이다.
  // (예전 판정은 `!diagnosis && !readiness && !backlog` 였고, backlog 하나만 있어도 상한을 건너뛰었다.)
  if (!diagnosis) {
    return done({
      level: AMBER, label: LABEL[AMBER], capped: true,
      why: '막는 것은 없지만 자율 마무리 진단을 아직 돌리지 않았습니다 — 확인하지 못한 것이 있으므로 「배포 가능」으로는 올리지 않습니다.',
      reasons: ['자율 진단 산출물 없음(상한 AMBER)'].concat(greenBlocks.filter((b) => b !== DIAG_MISSING)),
    })
  }

  if (greenBlocks.length) {
    return done({
      level: UNKNOWN, label: LABEL[UNKNOWN], capped: false,
      why: greenBlocks[0] + ' — 「배포 가능」이라고 적을 근거가 모자랍니다.',
      reasons: greenBlocks,
    })
  }

  // 이유 문장은 **센 것만** 적는다. 증거 없이 「품질 게이트 통과」라고 쓰지 않는다.
  return done({
    level: GREEN, label: LABEL[GREEN], capped: false,
    why: '지난밤 배치 ' + nights.length + '건 전부 통합 게이트 pass · 계측 ' + ms.length + '건 전부 품질 게이트 통과 · 검증 '
      + vs.length + '건 검사 실패 0 · 자율 진단 있음 · 마무리 판정 ready · 결정 대기 0 입니다.',
    reasons: [],
  })
}

/**
 * 진단 findings·백로그 항목 1건이 어느 갈래인가. 근거 = 항목의 `epic` 숫자, 없으면 `story` 슬러그의 에픽.
 * **스토리·에픽을 모르는 항목은 운영선으로 센다**(`db-drift-pending` 처럼 프로젝트 전역인 것이 여기다).
 * 운영선 목록이 비면 아무것도 가리지 않는다 — 가릴 근거가 없으면 가리지 않는다.
 */
export function lineOfFinding(item, opsEpics = []) {
  const set = new Set(arr(opsEpics).map(Number).filter((x) => Number.isFinite(x)))
  if (!set.size) return 'ops'
  const raw = item?.epic
  const e = raw == null || raw === '' ? epicOfStory(item?.story) : Number(raw)
  if (e == null || !Number.isFinite(e)) return 'ops'
  return set.has(e) ? 'ops' : 'dev'
}

/**
 * 진단·백로그의 우선순위 단계별 잔여 수 — **운영선만** 센다(`count`), 개발선은 따로 담는다(`dev`).
 *
 * 왜 — 배포 판정은 운영선이 지금 나가도 되느냐의 물음이다. 진단은 프로젝트 전체를
 * 훑어서 개발선 몫까지 한 숫자로 내는데, 그걸 그대로 「막는 것」으로 세면
 * 릴리스 묶음이 열리기 전까지 헤더가 RED 로 잠긴다(원 프로젝트 2026-09-21 실측 — 항목 136건 중 43건이 개발선).
 *
 * 항목 목록(`backlog.items`·`diagnosis.findings`)이 있으면 **항목마다** 갈래를 가른다.
 * 목록 없이 집계값(`byTier`·`counts.findings`)만 있으면 가릴 근거가 없으므로 **전건을 운영선으로** 센다.
 * 재료가 아예 없으면 known=false(0 으로 세지 않는다).
 */
export function tierRemaining(diagnosis, backlog, tiers, opsEpics = []) {
  const want = new Set(tiers)
  const split = (items, from) => {
    let ops = 0
    let dev = 0
    for (const it of arr(items)) {
      if (!want.has(Number(it?.tier))) continue
      if (lineOfFinding(it, opsEpics) === 'dev') dev += 1
      else ops += 1
    }
    return { known: true, count: ops, dev, from }
  }
  if (arr(backlog?.items).length) return split(backlog.items, 'backlog.items')
  if (arr(diagnosis?.findings).length) return split(diagnosis.findings, 'diagnosis.findings')
  const sum = (o) => Object.entries(o).reduce((c, [t, v]) => (want.has(Number(t)) ? c + n(v) : c), 0)
  if (backlog && backlog.byTier && typeof backlog.byTier === 'object') {
    return { known: true, count: sum(backlog.byTier), dev: 0, from: 'backlog.byTier' }
  }
  const f = diagnosis?.counts?.findings
  if (f && typeof f === 'object') {
    return { known: true, count: sum(f), dev: 0, from: 'diagnosis.counts.findings' }
  }
  return { known: false, count: 0, dev: 0, from: null }
}

const ts = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }

/** 오늘(KST) — 체인 이름의 날짜가 KST 하루라서 같은 시간대로 읽는다. */
const kstYmd = (d) => {
  const t = d instanceof Date ? d.getTime() : Date.parse(String(d ?? ''))
  return Number.isFinite(t) ? new Date(t + 9 * 3600000).toISOString().slice(0, 10) : ''
}

/**
 * RELEASE-LOG.md 의 절 머리에서 **가장 최근 릴리스 시각**을 뽑는다.
 *
 * 왜 필요한가 — 이미 운영에 반영되고 끝난 옛 배치의 되돌림이 계속 「현재 불일치」로 잡혀
 * 대표가 매번 같은 7건을 다시 본다(2026-09-21 결정표 C-5 · W20). 기준선은 코드 상수가 아니라
 * **원장(RELEASE-LOG.md)** 에서 읽는다 — 릴리스가 늘면 기준선도 저절로 따라간다.
 *
 * 파싱 규칙(파일 실물을 보고 정했다):
 *   · 절 머리는 `## YYYY-MM-DD [HH:MM] · …` 꼴이고 시각이 없는 줄도 있다(`## 2026-09-16 · …`).
 *   · 분에 x 를 쓴 표기(`16:3x` · `08:xx`)는 **그 시(hour)의 끝**(HH:59:59)으로 읽는다.
 *   · 시각이 아예 없으면 그 날의 끝(23:59:59)으로 읽는다.
 *   · 절 머리는 **파일 순서가 곧 시간 순서가 아니다**(09-08 23:52 절이 09-09 08:03 절 뒤에 온다).
 *     그래서 마지막 줄이 아니라 **파싱한 시각의 최댓값**을 쓴다.
 *   · 시간대는 KST(+09:00)로 읽는다 — 최근 절들이 KST 표기다. 일부 옛 절은 UTC 였는데,
 *     그것을 KST 로 읽으면 기준선이 9시간 **앞당겨질 뿐**이라 접는 쪽이 아니라 세는 쪽으로 기운다(보수적).
 *
 * @returns {{at:string|null, heading:string}} at = ISO 문자열(없으면 null)
 */
export function lastRelease(text) {
  const KST = 9 * 3600000
  let best = null
  for (const m of String(text ?? '').matchAll(/^##[ \t]+(\d{4})-(\d{2})-(\d{2})(?:[ \t]+(\d{1,2}):([0-9x]{2}))?/gm)) {
    const [, y, mo, d, hh, mm] = m
    let h = 23, mi = 59
    if (hh != null) {
      h = Number(hh)
      if (h > 23) continue
      mi = /^\d{2}$/.test(mm) ? Number(mm) : 59 // 「16:3x」 = 그 시의 끝
      if (mi > 59) continue
    }
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), h, mi, 59) - KST
    if (!Number.isFinite(t)) continue
    if (!best || t > best.t) best = { t, heading: m[0].replace(/^##[ \t]+/, '') }
  }
  return best ? { at: new Date(best.t).toISOString(), heading: best.heading } : { at: null, heading: '' }
}

/**
 * ⑨ 불일치·경고 — 하네스 산출물이 만드는 3종. 기존 4종(epics ↔ sprint)에 **더한다**.
 *
 * 반환은 두 갈래다.
 *   · `warnings` = **지금 경고**(기존 drift 와 같은 모양 `{level,where,msg}` · 호출부가 그대로 이어 붙인다)
 *   · `notes`    = **참고로 접는 것**(판정이 끝난 과거 기록 · 건수로 세지 않는다)
 * 원본 매니페스트·검증 기록은 감사 기록이라 손대지 않는다 — 세는 규칙만 고친다.
 *
 * @param {object} input
 *   lastReleaseAt        마지막 운영 릴리스 시각(ISO · lastRelease() 산출 · 모르면 null = 접지 않는다)
 *   lastReleaseLabel     화면에 적을 릴리스 절 머리 문구
 *   integrationGateSince 통합 게이트 도입 시점(YYYY-MM-DD · 모르면 null = 접지 않는다)
 */
export function batchWarnings({
  manifests = [], verifications = [], stories = [],
  lastReleaseAt = null, lastReleaseLabel = '', integrationGateSince = null,
} = {}) {
  const out = []
  const notes = []
  const known = new Set(arr(stories).map((s) => String(s.slug || '')).filter(Boolean))
  const statusOf = new Map(arr(stories).map((s) => [String(s.slug || ''), String(s.status || '')]))
  const relAt = ts(lastReleaseAt)
  const gateAt = ts(integrationGateSince)
  let oldRollback = 0
  let preGate = 0

  const seen = new Set()
  for (const m of arr(manifests)) {
    for (const s of arr(m.stories)) {
      if (known.size === 0 || known.has(String(s)) || seen.has(String(s))) continue
      seen.add(String(s))
      out.push({ level: 'high', where: '배치 ' + (m.label || m.batchId || '?'), msg: '"' + s + '" — 배치가 돌린 스토리가 sprint-status.yaml 에 없습니다(unknown-story)' })
    }
    const r = m?.integration?.result
    if (r === 'fail' || r === 'rollback') {
      // 규칙 1 — 마지막 운영 릴리스 **이후**의 되돌림만 「현재 불일치」다.
      const at = ts(m.at)
      if (relAt !== null && at !== null && at <= relAt) oldRollback += 1
      else {
        out.push({
          level: 'high', where: '배치 ' + (m.label || m.batchId || '?'),
          msg: '통합 게이트 ' + (r === 'rollback' ? '되돌림' : '실패') + ' — landing ' + arr(m.landing).length + '건, 푸시 ' + (m.pushed ? '됨(확인 필요)' : '차단됨'),
        })
      }
    }
  }

  for (const v of arr(verifications)) {
    const integ = String(v?.checks?.integration ?? '')
    const st = statusOf.get(String(v.story)) ?? ''
    if (!(/^unknown/.test(integ) && (st === 'done' || st === 'review'))) continue
    // 규칙 2 — 통합 게이트가 생기기 전에 끝난 스토리는 통합 칸이 비어 있는 것이 정상이다.
    // 판정 근거 = **그 스토리의 검증 기록이 만들어진 시각**(`<story>-verification.json` 의 generatedAt).
    // 통합 칸을 적는 주체가 바로 이 기록이라, 기록 시각이 곧 「그때 게이트가 있었나」의 답이다.
    // 시각을 모르면 접지 않는다(확인 못 한 것을 통과로 적지 않는다).
    const madeAt = ts(v?.generatedAt)
    if (gateAt !== null && madeAt !== null && madeAt < gateAt) preGate += 1
    else {
      out.push({
        level: 'mid', where: 'Story ' + v.story,
        msg: '상태는 ' + st + ' 인데 검증 기록의 통합 칸이 「확인 안 됨」입니다 — 통합 게이트를 통과한 적이 없습니다',
      })
    }
  }

  if (oldRollback) {
    notes.push({
      level: 'info', where: '배치 되돌림',
      msg: '참고 — 과거 배치 되돌림 ' + oldRollback + '건(마지막 릴리스 이전'
        + (lastReleaseLabel ? ' · ' + lastReleaseLabel : '') + ') — 감사 기록으로 보존하며 현재 경고로 세지 않습니다',
    })
  }
  if (preGate) {
    notes.push({
      level: 'info', where: '통합 칸',
      msg: '참고 — 통합 게이트 도입 전 완료 ' + preGate + '건(' + String(integrationGateSince) + ' 이전 검증 기록)'
        + ' — 「머지해줘」 절차(qa + 운영 배포)로 검증된 기록이라 현재 경고로 세지 않습니다',
    })
  }
  return { warnings: out, notes }
}
