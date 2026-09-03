// readiness.mjs — 완료·배포 가능 판정표 (요구 SPEC §7 · 설계 §1-4 · §6)
//
// 이 모듈의 유일한 주장: **미확인을 통과로 적지 않는다.**
//   · 스크립트가 없어서 못 돌린 게이트는 `n/a` 이고, `n/a` 는 GREEN 이 아니라 `not-verified` 다.
//   · fail 이 하나라도 있으면 `not-ready`, fail 0 이어도 not-verified 가 하나라도 있으면 `not-verified`.
//     **`ready` 는 전부 pass 일 때만** 나온다(코드로 강제 · propagate()).
//   · 진단이 「확인 못 한 것」을 하나라도 들고 있으면(`diagnosis.notVerified`) 어떤 경우에도 ready 가 아니다.
//
// 순수 모듈 — 파일·프로세스에 손대지 않는다. 판정 재료는 전부 인자로 받는다.
//   taskReadiness   : 작업(스토리) 1건 — 매니페스트(auto-story-finish/verification/1) + 스냅숏 스토리 + 진단
//   projectReadiness: 프로젝트 전체 — 진단 + 매니페스트 목록 + 백로그 + 계측
//
// 산출 JSON 스키마 = `night-batch-ops/readiness/1` (현황판 ⑦ 블록이 읽는다).

// ── 상수 ─────────────────────────────────────────────────────────────────────
export const READINESS_SCHEMA = 'night-batch-ops/readiness/1'

export const PASS = 'pass'
export const FAIL = 'fail'
/** 「확인하지 못했다」 — pass 도 fail 도 아니다. ready 를 막는다. */
export const NOT_VERIFIED = 'not-verified'

export const READY = 'ready'
export const NOT_READY = 'not-ready'

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const NA_RE = /^(n\/a|required-missing|not-run|unknown)/i
const REPAIR_INTRODUCED_RE = /repair-introduced/
/** 수리 라운드가 남기면 차단으로 올리는 흔적(F5) — `baseline:true` 로 표시된 선재 흔적은 제외한다. */
const REPAIR_SENSITIVE_RE = /^(test-skip|test-only|empty-test|trivial-assertion|assertion-weakened|ts-ignore|eslint-disable|coverage-exclude|gate-config-changed)/

const isTestPath = (p) => TEST_PATH_RE.test(String(p ?? '').replace(/\\/g, '/'))

/** 완료 매니페스트의 `checks.unitKinds`(정상·실패·경계 건수) → T2 판정.
 *  규칙·문구는 엔진 `completion-rules.mjs:testKindsVerdict` 와 같다 — 이 모듈은 의존성 0 이라 옮겨 적는다
 *  (러너·자율 마무리가 대상 저장소로 복사돼 돌기 때문에 엔진 경로를 import 할 수 없다).
 *  세 유형이 다 있어야 PASS · 하나라도 비면 `not-verified`(없는 유형을 통과로 세지 않는다 — M2). */
const UNIT_KIND_KO = Object.freeze({ normal: '정상', failure: '실패', boundary: '경계' })
export function unitKindsVerdict(kinds) {
  const k = kinds ?? {}
  const names = ['normal', 'failure', 'boundary']
  const n = (x) => (Number.isFinite(Number(k[x])) ? Number(k[x]) : 0)
  const total = names.reduce((a, x) => a + n(x), 0)
  if (total === 0) return [FAIL, '이번 변경에 새 테스트가 하나도 없다']
  const have = names.filter((x) => n(x) > 0).map((x) => `${UNIT_KIND_KO[x]} ${n(x)}`).join(' · ')
  const missing = names.filter((x) => !n(x))
  if (missing.length) return [NOT_VERIFIED, `테스트 ${total}건(${have})은 있으나 ${missing.map((x) => UNIT_KIND_KO[x]).join('·')} 유형을 확인하지 못했다 — 없는 유형을 통과로 세지 않는다`]
  return [PASS, `이번 변경에 테스트 ${total}건(${have})`]
}
const arr = (x) => (Array.isArray(x) ? x : [])
const str = (x) => String(x ?? '')

// ── 판정 기준표 ──────────────────────────────────────────────────────────────
/** 작업 8조건 (SPEC §7 앞단 · 설계 §6 T1~T8). `evidence` = 어느 파일의 어느 값을 근거로 삼았나. */
export const TASK_CRITERIA = Object.freeze([
  { id: 'T1', label: '기본 검사(타입·문법·자동테스트)가 통과했다', evidence: [{ file: '<story>-verification.json', field: 'checks.qa' }], required: true },
  { id: 'T2', label: '정상·실패·경계를 확인하는 테스트가 최소 1개 붙었다', evidence: [{ file: '<story>-verification.json', field: 'completion.criteria.T2' }, { file: '<story>-verification.json', field: 'checks.unitKinds' }, { file: '<story>.md', field: 'File List' }], required: true },
  { id: 'T3', label: '검사 사슬이 중간에 끊기지 않고 끝까지 통과했다', evidence: [{ file: '<story>-verification.json', field: 'checks.typecheck·lint·unit' }], required: true },
  { id: 'T4', label: '보안·성능·통합 게이트에 실제 판정이 있다', evidence: [{ file: '<story>-verification.json', field: 'checks.security·performance·integration' }], required: true },
  { id: 'T5', label: '테스트를 지우거나 끄거나 우회한 흔적이 없다', evidence: [{ file: '<story>-verification.json', field: 'integrity' }], required: true },
  { id: 'T6', label: '만든 쪽과 다른 쪽이 실제로 읽고 교차 검토했고 높음 지적이 0이다', evidence: [{ file: '<story>-verification.json', field: 'review' }, { file: '<story>-verification.json', field: 'workers.dev' }], required: true },
  { id: 'T7', label: '문서에 적힌 상태와 실제 코드 상태가 같다', evidence: [{ file: 'diagnosis.json', field: 'stories[].verdict' }, { file: 'sprint-status.yaml', field: '<story>' }, { file: '<story>.md', field: 'Status' }], required: true },
  { id: 'T8', label: '완료 기록이 실측 수치를 인용하고 확인 못 한 것을 적었다', evidence: [{ file: '<story>.md', field: 'Completion Notes List' }], required: true },
])

/** 프로젝트 8조건 (SPEC §7 뒷단 · 설계 §6 P1~P8). */
export const PROJECT_CRITERIA = Object.freeze([
  { id: 'P1', label: '필수 기능이 전부 「실제로 된다」로 확인됐다', evidence: [{ file: 'diagnosis.json', field: 'stories[].verdict' }, { file: 'diagnosis.json', field: 'counts.epicOnly' }], required: true },
  { id: 'P2', label: '높음·중간 차단이 0이고 상위 3단계 지적이 없다', evidence: [{ file: 'diagnosis.json', field: 'findings[].severity' }, { file: 'diagnosis.json', field: 'counts.findings' }], required: true },
  { id: 'P3', label: '검사·빌드·통합이 전부 초록불이다', evidence: [{ file: 'diagnosis.json', field: 'gates.qa' }, { file: 'diagnosis.json', field: 'gates.build' }], required: true },
  { id: 'P4', label: '문서와 실제 구현이 어긋난 곳이 없다', evidence: [{ file: 'diagnosis.json', field: 'findings[kind=plan-only-story·sprint-only-story·orphan-doc·status-drift]' }], required: true },
  { id: 'P5', label: '남은 일이 0이거나, 남긴 것을 사람이 확정해 미뤘다', evidence: [{ file: 'diagnosis.json', field: 'findings[kind=unfinished-task·open-patch·open-decision]' }, { file: 'backlog.json', field: 'items[].state' }], required: true },
  { id: 'P6', label: '변경 기록 누락·운영 반영 대기·상위 임시 코드가 0이다', evidence: [{ file: 'diagnosis.json', field: 'findings[kind=file-list-missing·db-drift-pending·temp-code-in-secret-path]' }], required: true },
  { id: 'P7', label: '마지막으로 다른 쪽이 교차 검토한 기록이 있다', evidence: [{ file: '<story>-verification.json', field: 'review' }], required: true },
  { id: 'P8', label: '확인하지 못한 항목이 하나도 남아 있지 않다', evidence: [{ file: 'diagnosis.json', field: 'notVerified' }], required: true },
])

// ── 전파 규칙 (코드 강제) ────────────────────────────────────────────────────
/**
 * fail ≥1 → not-ready / fail 0 & not-verified ≥1 → not-verified / 전부 pass → ready.
 * **어떤 인자로도 이 순서를 뒤집을 수 없다** — 「미확인을 통과로 표시 금지」(SPEC §7)의 집행부다.
 */
export function propagate(criteria = []) {
  const results = criteria.map((c) => c.result)
  const fail = results.filter((r) => r === FAIL).length
  const nv = results.filter((r) => r === NOT_VERIFIED).length
  const pass = results.filter((r) => r === PASS).length
  const verdict = fail > 0 ? NOT_READY : nv > 0 ? NOT_VERIFIED : READY
  return { verdict, counts: { pass, fail, notVerified: nv, total: results.length } }
}

const mk = (spec, result, why, extraEvidence = []) => ({
  id: spec.id, label: spec.label, required: spec.required !== false,
  result, why: str(why),
  evidence: [...spec.evidence, ...extraEvidence],
})

const byId = (list, id) => list.find((c) => c.id === id)

/** 매니페스트가 이미 T 판정을 들고 있으면(파이프라인 훅 배선됨) 그 판정을 쓴다. */
function fromCompletion(manifest, id) {
  const c = arr(manifest?.completion?.criteria).find((x) => x?.id === id)
  if (!c || !c.result) return null
  return { result: c.result, why: str(c.why) }
}

/** 게이트 값 하나 → pass/fail/not-verified. `n/a(…)`·`required-missing`·`not-run`·`unknown…` 은 전부 미확인. */
export function gateValueResult(v) {
  const s = str(v)
  if (s === 'pass') return PASS
  if (s === 'fail' || s === 'rollback') return FAIL
  if (s === 'not-required') return PASS
  // `n/a(…)`·`required-missing`·`not-run`·`unknown…` 은 물론, 예상 밖 값도 전부 미확인으로 본다
  // (모르는 값을 통과로 읽는 순간 이 표는 거짓말을 시작한다).
  return NOT_VERIFIED
}
/** 값이 「없어서 못 돌렸다」 계열인지 — 문구를 고를 때만 쓴다. */
export const isNaGateValue = (v) => NA_RE.test(str(v))

/** 교차 리뷰의 열람 증거 개수 — 명시 필드가 없으면 findings 수로 갈음한다(0 이면 0). */
export function reviewEvidenceCount(review) {
  if (!review) return 0
  if (Array.isArray(review.readEvidence)) return review.readEvidence.length
  if (Number.isFinite(review.readEvidence)) return Number(review.readEvidence)
  if (review.validation && typeof review.validation === 'object') {
    if (Number.isFinite(review.validation.readEvidence)) return Number(review.validation.readEvidence)
    if (review.validation.ok === true && arr(review.validation.warnings).length === 0) return 1
  }
  const c = review.counts ?? {}
  const found = Number(c.patch ?? 0) + Number(c.decision ?? 0) + Number(c.defer ?? 0) + Number(c.optional ?? 0)
  return found > 0 ? found : 0
}

/** 차단으로 세는 무결성 흔적 — level block · 수리가 만든 것 · 수리 라운드가 남긴 skip/only 류. */
export function blockingIntegrity(integrity = [], repair = {}) {
  const attempts = Number(repair?.attempts ?? 0) || 0
  return arr(integrity).filter((f) => {
    if (!f) return false
    if (f.level === 'block') return true
    if (REPAIR_INTRODUCED_RE.test(str(f.rule))) return true
    if (attempts > 0 && f.baseline !== true && REPAIR_SENSITIVE_RE.test(str(f.rule))) return true
    return false
  })
}

// ── 작업(스토리) 판정 ────────────────────────────────────────────────────────
/**
 * @param {{item?:object, manifest?:object|null, story?:object|null, diagnosis?:object|null}} o
 *   item     — 백로그 WorkItem(선택 · 제목·스토리 키 표시용)
 *   manifest — auto-story-finish/verification/1
 *   story    — 스냅숏 stories[] 항목(statusInFile·statusInSprint·fileList)
 *   diagnosis— night-batch-ops/diagnosis/1 (그 스토리의 verdict + 전체 notVerified)
 */
export function taskReadiness({ item = null, manifest = null, story = null, diagnosis = null } = {}) {
  const key = str(manifest?.story || story?.key || item?.story || item?.id || '(스토리 미상)')
  const checks = manifest?.checks ?? null
  const criteria = []
  const C = (id) => byId(TASK_CRITERIA, id)

  // T1 — 기본 검사
  if (!manifest) criteria.push(mk(C('T1'), NOT_VERIFIED, '검증 기록이 없다 — 검사를 돌렸다는 증거가 없다'))
  else {
    const r = gateValueResult(checks?.qa)
    criteria.push(mk(C('T1'), r, r === PASS ? '기본 검사 통과' : r === FAIL ? '기본 검사가 빨간불이다' : '기본 검사를 돌린 기록이 없다'))
  }

  // T2 — 새 테스트 (훅이 배선돼 있으면 그 판정 · 다음은 매니페스트의 유형 집계 · 마지막이 변경 목록 갈음)
  {
    const c = fromCompletion(manifest, 'T2')
    const kinds = checks?.unitKinds ?? null
    if (c) criteria.push(mk(C('T2'), c.result, c.why || '검증 기록의 완료 판정을 그대로 인용'))
    else if (kinds) criteria.push(mk(C('T2'), ...unitKindsVerdict(kinds)))
    else if (!story?.fileList?.sectionPresent) criteria.push(mk(C('T2'), NOT_VERIFIED, '변경 파일 목록이 없어 테스트가 붙었는지 확인하지 못했다'))
    else {
      // 마지막 갈음은 **PASS 를 주지 않는다**(M2) — 「테스트 파일이 목록에 있다」는 정상·실패·경계를
      // 확인했다는 뜻이 아니다. 파일조차 없으면 종전대로 FAIL, 있으면 「유형을 확인하지 못했다」로 남긴다.
      const tests = arr(story.fileList.declared).filter(isTestPath)
      criteria.push(mk(C('T2'), tests.length ? NOT_VERIFIED : FAIL,
        tests.length ? `변경 목록에 테스트 파일 ${tests.length}건은 있으나 정상·실패·경계 유형을 확인하지 못했다` : '변경 목록에 테스트 파일이 하나도 없다'))
    }
  }

  // T3 — 검사 사슬
  {
    const chain = [['타입', checks?.typecheck], ['문법', checks?.lint], ['자동테스트', checks?.unit]]
    const rs = chain.map(([, v]) => gateValueResult(v))
    const bad = chain.filter((_, i) => rs[i] === FAIL).map(([n]) => n)
    const unk = chain.filter((_, i) => rs[i] === NOT_VERIFIED).map(([n]) => n)
    const r = !manifest ? NOT_VERIFIED : bad.length ? FAIL : unk.length ? NOT_VERIFIED : PASS
    criteria.push(mk(C('T3'), r, !manifest ? '검증 기록이 없다' : bad.length ? `${bad.join('·')} 검사가 실패했다` : unk.length ? `${unk.join('·')} 결과를 확인하지 못했다` : '사슬 전체 통과'))
  }

  // T4 — 보안·성능·통합
  {
    const parts = [['보안', checks?.security], ['성능', checks?.performance], ['통합', checks?.integration]]
    const rs = parts.map(([, v]) => gateValueResult(v))
    const bad = parts.filter((_, i) => rs[i] === FAIL).map(([n]) => n)
    const unk = parts.filter((_, i) => rs[i] === NOT_VERIFIED).map(([n]) => n)
    const r = !manifest ? NOT_VERIFIED : bad.length ? FAIL : unk.length ? NOT_VERIFIED : PASS
    criteria.push(mk(C('T4'), r, !manifest ? '검증 기록이 없다' : bad.length ? `${bad.join('·')} 게이트가 실패했다` : unk.length ? `${unk.join('·')} 게이트 판정이 없다 — 없는 것은 통과가 아니다` : '세 게이트 모두 판정 있음'))
  }

  // T5 — 테스트 무결성
  {
    const c = fromCompletion(manifest, 'T5')
    if (c) criteria.push(mk(C('T5'), c.result, c.why))
    else if (!manifest) criteria.push(mk(C('T5'), NOT_VERIFIED, '검증 기록이 없다'))
    else {
      const blocks = blockingIntegrity(manifest.integrity, manifest.repair)
      criteria.push(mk(C('T5'), blocks.length ? FAIL : PASS, blocks.length ? `검사를 끄거나 우회한 흔적 ${blocks.length}건` : '우회 흔적 없음'))
    }
  }

  // T6 — 교차 리뷰
  {
    const c = fromCompletion(manifest, 'T6')
    if (c) criteria.push(mk(C('T6'), c.result, c.why))
    else criteria.push(mk(C('T6'), ...crossReviewVerdict(manifest)))
  }

  // T7 — 문서 상태 = 코드 상태
  {
    const v = arr(diagnosis?.stories).find((s) => s.key === key)
    if (!v) criteria.push(mk(C('T7'), NOT_VERIFIED, '이 스토리에 대한 진단 결과가 없다'))
    else if (v.verdict === 'not-verified') criteria.push(mk(C('T7'), NOT_VERIFIED, '검사 증거가 없어 완료를 확인하지 못했다'))
    else if (v.verdict !== 'verified-done') criteria.push(mk(C('T7'), FAIL, `실제 판정이 「${verdictKo(v.verdict)}」다 — 문서의 완료 표시와 다르다`))
    else {
      const a = str(story?.statusInFile), b = str(story?.statusInSprint)
      const same = !a || !b || a === b
      criteria.push(mk(C('T7'), same ? PASS : FAIL, same ? '문서·원장·코드 세 곳이 같다' : `문서 상태(${a})와 원장 상태(${b})가 다르다`))
    }
  }

  // T8 — 완료 기록
  {
    const c = fromCompletion(manifest, 'T8')
    criteria.push(c ? mk(C('T8'), c.result, c.why) : mk(C('T8'), NOT_VERIFIED, '완료 기록을 검사한 판정이 없다 — 실측 인용 여부를 확인하지 못했다'))
  }

  return finish({ kind: 'task', subject: key, title: str(item?.title || key), criteria, diagnosis })
}

function crossReviewVerdict(manifest) {
  const review = manifest?.review ?? null
  if (!review) return [NOT_VERIFIED, '교차 검토 기록이 없다']
  if (/^not-run/.test(str(review.result))) return [NOT_VERIFIED, '교차 검토를 돌리지 않았다']
  const devP = str(manifest?.workers?.dev?.provider)
  const revP = str(review.provider)
  // (codex-review-r3 M1) 한쪽 provider 기록이 없으면 「다른 쪽이 봤다」를 확인할 방법이 없다 —
  // 종전에는 `devP && revP` 라 **누락 = 통과**였고, 구형·부분 손상 매니페스트가 프로젝트를 ready 로 올렸다.
  // 규칙은 `completion-rules.mjs:crossReviewResult` 와 같다: 누락은 PASS 도 FAIL 도 아닌 not-verified.
  if (!devP || !revP) return [NOT_VERIFIED, `교차 검토 제공자 기록이 빠졌다(만든 쪽 ${devP || '미상'} · 검토한 쪽 ${revP || '미상'}) — 다른 쪽이 봤는지 확인할 수 없다`]
  if (devP === revP) return [FAIL, '만든 쪽과 검토한 쪽이 같다 — 교차 검토가 아니다']
  const high = Number(review.counts?.high ?? 0) || 0
  if (high > 0) return [FAIL, `검토에서 높음 지적 ${high}건이 남아 있다`]
  const ev = reviewEvidenceCount(review)
  if (ev < 1) return [FAIL, '검토자가 파일을 실제로 읽은 증거가 없다 — 「아무 문제 없음」을 인정하지 않는다']
  return [PASS, `다른 쪽이 검토했고 높음 지적 0 · 열람 증거 ${ev}건`]
}

const VERDICT_KO = Object.freeze({
  'verified-done': '실제로 된다',
  partial: '반쯤 됐다',
  missing: '아직 안 만들었다',
  defect: '지금 고장 나 있다',
  blocked: '사람 결정 대기',
  'not-verified': '확인하지 못했다',
})
export const verdictKo = (v) => VERDICT_KO[str(v)] ?? str(v)

// ── 프로젝트 판정 ────────────────────────────────────────────────────────────
const DOC_MISMATCH_KINDS = ['plan-only-story', 'sprint-only-story', 'orphan-doc', 'status-drift', 'file-list-file-missing']
const OPEN_WORK_KINDS = ['unfinished-task', 'open-patch', 'open-decision']
const P6_KINDS = ['file-list-missing', 'db-drift-pending', 'temp-code-in-secret-path']

/**
 * @param {{diagnosis?:object|null, manifests?:object[], backlog?:object|null, metrics?:object|null}} o
 */
export function projectReadiness({ diagnosis = null, manifests = [], backlog = null, metrics = null } = {}) {
  const criteria = []
  const C = (id) => byId(PROJECT_CRITERIA, id)
  const findings = arr(diagnosis?.findings)
  const stories = arr(diagnosis?.stories)
  const counts = diagnosis?.counts ?? {}
  const nOf = (kinds) => findings.filter((f) => kinds.includes(f.kind)).length

  // P1 — 필수 기능이 전부 verified-done
  if (!diagnosis) criteria.push(mk(C('P1'), NOT_VERIFIED, '진단 결과가 없다'))
  else {
    const bad = stories.filter((s) => ['partial', 'missing', 'defect', 'blocked'].includes(s.verdict))
    const unk = stories.filter((s) => s.verdict === 'not-verified')
    const epicOnly = Number(counts.epicOnly ?? 0) || 0
    if (bad.length || epicOnly) criteria.push(mk(C('P1'), FAIL, `아직 「실제로 된다」가 아닌 기능 ${bad.length + epicOnly}건`))
    else if (unk.length) criteria.push(mk(C('P1'), NOT_VERIFIED, `완료를 확인하지 못한 기능 ${unk.length}건`))
    else if (!stories.length) criteria.push(mk(C('P1'), NOT_VERIFIED, '판정할 기능 목록이 비어 있다'))
    else criteria.push(mk(C('P1'), PASS, `기능 ${stories.length}건 전부 「실제로 된다」`))
  }

  // P2 — high/medium 0 + 상위 3단계 0
  if (!diagnosis) criteria.push(mk(C('P2'), NOT_VERIFIED, '진단 결과가 없다'))
  else {
    const sev = findings.filter((f) => f.severity === 'high' || f.severity === 'medium').length
    const top = [1, 2, 3].reduce((a, t) => a + (Number(counts.findings?.[t] ?? 0) || 0), 0)
    criteria.push(mk(C('P2'), sev || top ? FAIL : PASS, sev || top ? `높음·중간 지적 ${sev}건 · 상위 3단계 ${top}건` : '높음·중간 0 · 상위 3단계 0'))
  }

  // P3 — 검사·빌드·통합
  if (!diagnosis) criteria.push(mk(C('P3'), NOT_VERIFIED, '진단 결과가 없다'))
  else {
    const g = diagnosis.gates ?? {}
    const red = Object.entries(g).filter(([, v]) => v && v.available !== false && Number.isFinite(v.exit) && v.exit !== 0).map(([k]) => k)
    const notRun = ['qa', 'build'].filter((k) => !g[k] || g[k].available === false || !Number.isFinite(g[k].exit))
    const integ = integrationOf(manifests)
    if (red.length || integ.fail > 0) criteria.push(mk(C('P3'), FAIL, red.length ? `검사 ${red.join('·')} 가 빨간불이다` : `통합 게이트 실패 ${integ.fail}건`))
    else if (notRun.length || integ.unknown > 0 || arr(diagnosis.notVerified).some((n) => /게이트/.test(str(n.what)))) {
      criteria.push(mk(C('P3'), NOT_VERIFIED, notRun.length ? `${notRun.join('·')} 를 돌리지 않았다` : '보안·성능·통합 중 판정이 없는 게이트가 있다 — 없는 것은 통과가 아니다'))
    } else criteria.push(mk(C('P3'), PASS, '검사·빌드·통합 전부 초록불'))
  }

  // P4 — 문서-구현 일치
  if (!diagnosis) criteria.push(mk(C('P4'), NOT_VERIFIED, '진단 결과가 없다'))
  else {
    const n = nOf(DOC_MISMATCH_KINDS)
    criteria.push(mk(C('P4'), n ? FAIL : PASS, n ? `문서와 실제가 어긋난 곳 ${n}건` : '문서와 실제가 일치'))
  }

  // P5 — 남은 일 0 또는 사람이 확정해 미룸
  if (!diagnosis) criteria.push(mk(C('P5'), NOT_VERIFIED, '진단 결과가 없다'))
  else {
    const open = findings.filter((f) => OPEN_WORK_KINDS.includes(f.kind))
    const deferred = arr(backlog?.items).filter((i) => i.state === 'deferred-approved').length
    if (!open.length) criteria.push(mk(C('P5'), PASS, '남은 일 0'))
    else if (deferred >= open.length) criteria.push(mk(C('P5'), PASS, `남은 일 ${open.length}건 — 전부 사람이 확정해 미룬 것`))
    else criteria.push(mk(C('P5'), FAIL, `아직 처리 안 된 남은 일 ${open.length}건`))
  }

  // P6 — 기록 누락·운영 반영 대기·상위 임시 코드
  if (!diagnosis) criteria.push(mk(C('P6'), NOT_VERIFIED, '진단 결과가 없다'))
  else {
    const n = nOf(P6_KINDS)
    criteria.push(mk(C('P6'), n ? FAIL : PASS, n ? `변경 기록 누락·운영 반영 대기·보안 경로 임시 코드 ${n}건` : '해당 없음'))
  }

  // P7 — 최종 교차 리뷰
  {
    const ms = arr(manifests)
    if (!ms.length) criteria.push(mk(C('P7'), NOT_VERIFIED, '교차 검토 기록이 하나도 없다'))
    else {
      const rs = ms.map((m) => crossReviewVerdict(m)[0])
      const fail = rs.filter((r) => r === FAIL).length
      const nv = rs.filter((r) => r === NOT_VERIFIED).length
      criteria.push(mk(C('P7'), fail ? FAIL : nv ? NOT_VERIFIED : PASS, fail ? `교차 검토가 성립하지 않은 작업 ${fail}건` : nv ? `교차 검토 기록이 비어 있는 작업 ${nv}건` : `작업 ${ms.length}건 전부 교차 검토 통과`))
    }
  }

  // P8 — 확인 못 한 것 0 (ready 금지 열쇠)
  {
    const nv = arr(diagnosis?.notVerified)
    criteria.push(mk(C('P8'), nv.length ? NOT_VERIFIED : PASS, nv.length ? `확인하지 못한 항목 ${nv.length}건 — 남아 있는 한 「배포 가능」이라 적지 않는다` : '확인 못 한 항목 없음'))
  }

  return finish({ kind: 'project', subject: str(diagnosis?.root || '(프로젝트)'), title: '배포 가능 여부', criteria, diagnosis, metrics })
}

/** 매니페스트들의 통합 게이트 집계. */
function integrationOf(manifests = []) {
  let pass = 0, fail = 0, unknown = 0
  for (const m of arr(manifests)) {
    const r = gateValueResult(m?.checks?.integration)
    if (r === PASS) pass++
    else if (r === FAIL) fail++
    else unknown++
  }
  return { pass, fail, unknown, total: pass + fail + unknown }
}

// ── 마무리(전파 + notVerified 수집) ──────────────────────────────────────────
function finish({ kind, subject, title, criteria, diagnosis = null, metrics = null }) {
  const p = propagate(criteria)
  const notVerified = criteria.filter((c) => c.result === NOT_VERIFIED).map((c) => ({ what: c.label, why: c.why, criterion: c.id }))

  // 진단이 「확인 못 한 것」을 들고 있으면 ready 를 금지한다(SPEC §7 마지막 줄의 집행부).
  let verdict = p.verdict
  const diagNv = arr(diagnosis?.notVerified)
  if (verdict === READY && diagNv.length) {
    verdict = NOT_VERIFIED
    notVerified.push({ what: '진단이 남긴 확인 못 한 항목', why: `${diagNv.length}건 — 하나라도 남아 있으면 「배포 가능」이 아니다`, criterion: 'propagate' })
  }

  return {
    schema: READINESS_SCHEMA,
    at: str(diagnosis?.at) || null,
    kind, subject, title,
    verdict,
    criteria,
    counts: p.counts,
    blockers: criteria.filter((c) => c.result === FAIL).map((c) => ({ id: c.id, label: c.label, why: c.why })),
    notVerified,
    metrics: metrics ? { wallMs: metrics.wallMs ?? null, qualityGate: metrics.qualityGate ?? null } : null,
  }
}

// ── 표 ───────────────────────────────────────────────────────────────────────
const MARK = Object.freeze({ [PASS]: '✅ 통과', [FAIL]: '❌ 미달', [NOT_VERIFIED]: '⚠ 확인 못 함' })
const VERDICT_LABEL = Object.freeze({
  [READY]: '✅ 배포 가능',
  [NOT_READY]: '❌ 배포 불가',
  [NOT_VERIFIED]: '⚠ 확인 못 함 — 배포 가능이라고 적을 수 없다',
})

/** 판정표(마크다운). 사람이 읽는 문장만 쓴다 — 근거 경로는 JSON 쪽에 있다. */
export function renderReadinessTable(r, { lang = 'ko' } = {}) {
  if (!r) return ''
  if (lang !== 'ko') throw new Error(`지원하지 않는 언어: ${lang}`)
  const head = `**판정**: ${VERDICT_LABEL[r.verdict] ?? r.verdict} — 통과 ${r.counts.pass} · 미달 ${r.counts.fail} · 확인 못 함 ${r.counts.notVerified}`
  const rows = r.criteria.map((c) => `| ${c.id} | ${c.label} | ${MARK[c.result] ?? c.result} | ${c.why} |`)
  return [
    head, '',
    '| 번호 | 조건 | 판정 | 근거 |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
