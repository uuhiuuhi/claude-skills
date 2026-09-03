// completion-rules.mjs — 스토리 「완료」의 기준을 매니페스트 위에서 강제한다 (요구 SPEC §7 앞단 · 설계 §6 T1~T8)
//
// 왜 있나: 지금까지 완료의 근거는 「엔진이 exit 0 을 봤다」였다. 그건 T1 하나다.
// SPEC §7 은 여덟 가지를 요구한다 — 검사 통과 · 새 테스트 · 사슬 완주 · 조건부 게이트 판정 ·
// 우회 흔적 0 · 다른 쪽의 교차 검토 · 문서=코드 · 실측 인용 완료 기록.
// 이 모듈은 그 여덟 개를 **매니페스트에 이미 있는 값으로만** 판정한다.
//
// 두 가지 금지가 이 파일의 전부다:
//   1) **없는 수치를 지어내지 않는다** — 매니페스트에 없으면 `NOT VERIFIED` 라고 적는다.
//   2) **모르는 것을 통과로 적지 않는다** — 판정은 pass / fail / not-verified 세 값뿐이고,
//      not-verified 가 하나라도 있으면 verdict 는 `not-verified` 다(ready 아님).
//
// 순수 모듈 — 파일·프로세스에 손대지 않는다. 파이프라인은 `finalizeManifest()` 끝에서 3줄로 부른다.

import { TEST_FILE_RE, splitDiffByFile } from './quality-rules.mjs'
import { countOpenFindings } from './story-writes.mjs'

export const COMPLETION_SCHEMA = 'auto-story-finish/completion/1'

export const PASS = 'pass'
export const FAIL = 'fail'
export const NOT_VERIFIED = 'not-verified'
export const READY = 'ready'
export const NOT_READY = 'not-ready'

/** 매니페스트에 값이 없을 때 본문에 적는 표시 — 이 문자열 말고 다른 말로 얼버무리지 않는다. */
export const NV = 'NOT VERIFIED'

const NA_RE = /^(n\/a|required-missing|not-run|unknown)/i
const REPAIR_INTRODUCED_RE = /repair-introduced/
const REPAIR_SENSITIVE_RE = /^(test-skip|test-only|empty-test|trivial-assertion|assertion-weakened|ts-ignore|eslint-disable|coverage-exclude|gate-config-changed)/
const TEST_CASE_RE = /\b(it|test)\s*\(|\bdescribe\s*\(/

const arr = (x) => (Array.isArray(x) ? x : [])
const str = (x) => String(x ?? '')
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)

/** T1~T8 — id·순서는 `night-batch-ops/engine/readiness.mjs` 의 TASK_CRITERIA 와 같아야 한다(테스트가 문다). */
export const COMPLETION_CRITERIA = Object.freeze([
  { id: 'T1', label: '기본 검사(타입·문법·자동테스트)가 통과했다' },
  { id: 'T2', label: '정상·실패·경계를 확인하는 테스트가 최소 1개 붙었다' },
  { id: 'T3', label: '검사 사슬이 중간에 끊기지 않고 끝까지 통과했다' },
  { id: 'T4', label: '보안·성능·통합 게이트에 실제 판정이 있다' },
  { id: 'T5', label: '테스트를 지우거나 끄거나 우회한 흔적이 없다' },
  { id: 'T6', label: '만든 쪽과 다른 쪽이 실제로 읽고 교차 검토했고 높음 지적이 0이다' },
  { id: 'T7', label: '문서에 적힌 상태와 실제 코드 상태가 같다' },
  { id: 'T8', label: '완료 기록이 실측 수치를 인용하고 확인 못 한 것을 적었다' },
])

const LABEL = Object.fromEntries(COMPLETION_CRITERIA.map((c) => [c.id, c.label]))
const crit = (id, result, why) => ({ id, label: LABEL[id], result, why: str(why) })

/** 게이트 값 하나 → pass/fail/not-verified. 모르는 값은 전부 미확인이다. */
export function gateResult(v) {
  const s = str(v)
  if (s === 'pass' || s === 'not-required') return PASS
  if (s === 'fail' || s === 'rollback') return FAIL
  return NOT_VERIFIED
}
export const isNaGate = (v) => NA_RE.test(str(v))

/** 차단으로 세는 무결성 흔적 — level block · 수리가 만든 것 · **수리 라운드가 남긴 skip/only 류**. */
export function blockingIntegrity(integrity = [], repair = {}) {
  const attempts = num(repair?.attempts) ?? 0
  return arr(integrity).filter((f) => {
    if (!f) return false
    if (f.level === 'block') return true
    if (REPAIR_INTRODUCED_RE.test(str(f.rule))) return true
    // 수리 라운드가 돈 뒤에도 남아 있는 skip/only/단언 약화는 「고치는 대신 끈 것」으로 본다.
    // 첫 검사부터 있던 선재 흔적은 호출부가 `baseline:true` 로 표시해 빼 준다.
    if (attempts > 0 && f.baseline !== true && REPAIR_SENSITIVE_RE.test(str(f.rule))) return true
    return false
  })
}

/** 교차 검토의 열람 증거 개수 — 명시 필드가 없으면 findings 수로 갈음(0 이면 0). */
export function reviewEvidenceCount(review) {
  if (!review) return 0
  if (Array.isArray(review.readEvidence)) return review.readEvidence.length
  if (Number.isFinite(review.readEvidence)) return Number(review.readEvidence)
  const c = review.counts ?? {}
  const found = (num(c.patch) ?? 0) + (num(c.decision) ?? 0) + (num(c.defer) ?? 0) + (num(c.optional) ?? 0)
  return found > 0 ? found : 0
}

/** 교차 검토 판정(T6) — 같은 제공자 · 높음 잔존 · 열람 증거 0 은 전부 미달이다.
 *  (M1 · 2026-09-02 3차 리뷰) 두 provider 중 **하나라도 없으면** PASS 가 아니라 `not-verified` 다 —
 *  「다른 쪽인지」를 확인할 수 없는데 통과로 세면 구형·부분 손상 매니페스트가 프로젝트를 ready 로 올린다.
 *  ⚠️ 라벨·id 는 `night-batch-ops/engine/readiness.mjs` 의 T6 와 같아야 한다(테스트가 문다). */
export function crossReviewResult(manifest) {
  const review = manifest?.review ?? null
  if (!review) return [NOT_VERIFIED, '교차 검토 기록이 없다']
  if (/^not-run/.test(str(review.result))) return [NOT_VERIFIED, '교차 검토를 돌리지 않았다']
  const devP = str(manifest?.workers?.dev?.provider)
  const revP = str(review.provider)
  if (devP && revP && devP === revP) return [FAIL, `만든 쪽과 검토한 쪽이 같다(${revP}) — 교차 검토가 아니다`]
  if (!devP || !revP) {
    const miss = [!devP ? '구현자(workers.dev.provider)' : '', !revP ? '검토자(review.provider)' : ''].filter(Boolean).join('·')
    return [NOT_VERIFIED, `${miss} 기록이 없어 「만든 쪽과 다른 쪽인지」를 확인하지 못했다`]
  }
  const high = num(review.counts?.high) ?? 0
  if (high > 0) return [FAIL, `검토에서 높음 지적 ${high}건이 남아 있다`]
  const ev = reviewEvidenceCount(review)
  if (ev < 1) return [FAIL, '검토자가 파일을 실제로 읽은 증거가 없다 — 「아무 문제 없음」을 인정하지 않는다']
  return [PASS, `다른 쪽(${revP})이 검토 · 높음 0 · 열람 증거 ${ev}건`]
}

/**
 * BMAD 상태 = 코드 상태 일치 판정(T7 헬퍼).
 * 코드가 말하는 상태 = 검사 결과 + 스토리에 열려 있는 지적. 문서가 말하는 상태 = `Status:` 줄 + 원장.
 * @param {{storyText?:string, sprintStatus?:string|null, manifest?:object|null}} o
 */
export function bmadStateAgreesWithCode({ storyText = '', sprintStatus = null, manifest = null } = {}) {
  const text = str(storyText)
  const m = /^\s*(?:\*\*)?Status(?:\*\*)?\s*:\s*([A-Za-z가-힣\- ]+?)\s*$/m.exec(text)
  const statusInFile = m ? m[1].trim() : null
  const inSprint = sprintStatus == null ? null : str(sprintStatus).trim()
  const openPatch = countOpenFindings(text, 'Patch')
  const openDecision = countOpenFindings(text, 'Decision')
  const qa = gateResult(manifest?.checks?.qa)
  const [rev] = crossReviewResult(manifest)

  if (!text) return { ok: null, why: '스토리 본문이 없어 상태를 비교하지 못했다', statusInFile, statusInSprint: inSprint, expected: null, openPatch, openDecision }
  if (!statusInFile) return { ok: null, why: '스토리에 Status 줄이 없다', statusInFile, statusInSprint: inSprint, expected: null, openPatch, openDecision }
  if (inSprint && statusInFile !== inSprint) {
    return { ok: false, why: `문서 상태(${statusInFile})와 원장 상태(${inSprint})가 다르다`, statusInFile, statusInSprint: inSprint, expected: null, openPatch, openDecision }
  }
  const canBeDone = qa === PASS && rev === PASS && openPatch === 0 && openDecision === 0
  const expected = canBeDone ? 'done' : 'in-progress'
  if (statusInFile === 'done' && !canBeDone) {
    const why = [
      qa !== PASS ? '검사가 통과로 확인되지 않았다' : '',
      rev !== PASS ? '교차 검토가 성립하지 않았다' : '',
      openPatch ? `열린 지적 ${openPatch}건` : '',
      openDecision ? `사람 결정 대기 ${openDecision}건` : '',
    ].filter(Boolean).join(' · ')
    return { ok: false, why: `문서는 완료라고 적었는데 코드 상태가 아니다 — ${why}`, statusInFile, statusInSprint: inSprint, expected, openPatch, openDecision }
  }
  if (statusInFile !== 'done' && canBeDone) {
    return { ok: null, why: '코드는 완료 조건을 채웠는데 문서는 아직 완료가 아니다 — 상태 전이가 남았다', statusInFile, statusInSprint: inSprint, expected, openPatch, openDecision }
  }
  return { ok: true, why: statusInFile === 'done' ? '문서·원장·코드가 모두 완료로 일치' : `문서·원장·코드가 모두 「${statusInFile}」로 일치`, statusInFile, statusInSprint: inSprint, expected, openPatch, openDecision }
}

// ── 본체 ─────────────────────────────────────────────────────────────────────
/**
 * 완료 기준 8조건 판정. **순수** — 매니페스트를 고치지 않고 completion 객체를 돌려준다.
 * 파이프라인은 `manifest.completion = strengthenCompletion({ manifest, storyText, diff })` 로 붙인다.
 *
 * @param {{manifest:object, storyText?:string, diff?:string, sprintStatus?:string|null}} o
 * @returns {{schema:string, criteria:object[], verdict:'ready'|'not-ready'|'not-verified', notVerified:object[], counts:object, evidence:object}}
 */
export function strengthenCompletion({ manifest, storyText = '', diff = '', sprintStatus = null } = {}) {
  const m = manifest ?? {}
  const checks = m.checks ?? {}
  const criteria = []

  // T1 — 기본 검사
  {
    const r = gateResult(checks.qa)
    criteria.push(crit('T1', r, r === PASS ? '기본 검사 통과' : r === FAIL ? '기본 검사가 빨간불이다' : '기본 검사를 돌린 기록이 없다'))
  }

  // T2 — 새 테스트 (이번 변경분에서 센다 · 정상·실패·경계 3유형을 요구한다 — M2)
  const tests = newTestsFromDiff(diff)
  criteria.push(crit('T2', ...testKindsVerdict(tests)))

  // T3 — 검사 사슬
  {
    const chain = [['타입', checks.typecheck], ['문법', checks.lint], ['자동테스트', checks.unit]]
    const rs = chain.map(([, v]) => gateResult(v))
    const bad = chain.filter((_, i) => rs[i] === FAIL).map(([n]) => n)
    const unk = chain.filter((_, i) => rs[i] === NOT_VERIFIED).map(([n]) => n)
    criteria.push(crit('T3', bad.length ? FAIL : unk.length ? NOT_VERIFIED : PASS,
      bad.length ? `${bad.join('·')} 검사가 실패했다` : unk.length ? `${unk.join('·')} 결과를 확인하지 못했다` : '사슬 전체 통과'))
  }

  // T4 — 보안·성능·통합
  {
    const parts = [['보안', checks.security], ['성능', checks.performance], ['통합', checks.integration]]
    const rs = parts.map(([, v]) => gateResult(v))
    const bad = parts.filter((_, i) => rs[i] === FAIL).map(([n]) => n)
    const unk = parts.filter((_, i) => rs[i] === NOT_VERIFIED).map(([n]) => n)
    criteria.push(crit('T4', bad.length ? FAIL : unk.length ? NOT_VERIFIED : PASS,
      bad.length ? `${bad.join('·')} 게이트가 실패했다` : unk.length ? `${unk.join('·')} 게이트 판정이 없다 — 없는 것은 통과가 아니다` : '세 게이트 모두 판정 있음'))
  }

  // T5 — 무결성
  const blocks = blockingIntegrity(m.integrity, m.repair)
  criteria.push(crit('T5', blocks.length ? FAIL : PASS,
    blocks.length ? `검사를 끄거나 우회한 흔적 ${blocks.length}건(${[...new Set(blocks.map((b) => str(b.rule)))].slice(0, 4).join(', ')})` : '우회 흔적 없음'))

  // T6 — 교차 검토
  criteria.push(crit('T6', ...crossReviewResult(m)))

  // T7 — 문서 = 코드
  const state = bmadStateAgreesWithCode({ storyText, sprintStatus, manifest: m })
  criteria.push(crit('T7', state.ok === true ? PASS : state.ok === false ? FAIL : NOT_VERIFIED, state.why))

  // T8 — 완료 기록
  const notes = completionNotesAudit({ manifest: m, storyText })
  criteria.push(crit('T8', notes.result, notes.why))

  const counts = {
    pass: criteria.filter((c) => c.result === PASS).length,
    fail: criteria.filter((c) => c.result === FAIL).length,
    notVerified: criteria.filter((c) => c.result === NOT_VERIFIED).length,
    total: criteria.length,
  }
  const verdict = counts.fail > 0 ? NOT_READY : counts.notVerified > 0 ? NOT_VERIFIED : READY

  return {
    schema: COMPLETION_SCHEMA,
    criteria,
    verdict,
    counts,
    notVerified: criteria.filter((c) => c.result === NOT_VERIFIED).map((c) => ({ what: c.label, why: c.why, criterion: c.id })),
    evidence: {
      newTests: tests.measurable ? { files: tests.files, cases: tests.cases, kinds: tests.kinds } : null,
      integrityBlocking: blocks.length,
      review: m.review ? { provider: str(m.review.provider), high: num(m.review.counts?.high) ?? 0, readEvidence: reviewEvidenceCount(m.review) } : null,
      state: { statusInFile: state.statusInFile, statusInSprint: state.statusInSprint, openPatch: state.openPatch, openDecision: state.openDecision },
    },
  }
}

// ── T2 테스트 유형 판별 (M2 · 2026-09-02 3차 리뷰) ─────────────────────────────────────
// 왜: T2 의 기준 문구는 「정상·실패·경계」를 요구하는데 판정은 `cases > 0` 하나였다 — happy-path 한 건으로
// 완료가 `ready` 가 됐다. 이제 **diff 의 신규 테스트 케이스 이름·본문**에서 유형을 읽는다.
// 판정 규율: 3유형 다 있으면 PASS · 일부만이면 `not-verified`(fail 아님 — 빠진 유형을 사유에 적는다) ·
// 테스트가 하나도 없으면 종전대로 FAIL · 유형을 판별할 증거(diff)가 없으면 `not-verified`.
export const TEST_KIND_FAILURE_RE = /throws|rejects?|error|fail|invalid|denied|\b401\b|\b403\b/i
export const TEST_KIND_BOUNDARY_RE = /empty|zero|max|min|boundary|edge|limit|overflow|null|undefined|빈|경계|최대|최소/i
export const TEST_KINDS = Object.freeze(['normal', 'failure', 'boundary'])
const KIND_KO = { normal: '정상', failure: '실패', boundary: '경계' }

/** 케이스 한 건(이름 + 본문)의 유형 — 실패 > 경계 > 정상 우선순위(한 건은 한 유형으로만 센다). */
export function classifyTestCase(blockText) {
  const s = str(blockText)
  if (TEST_KIND_FAILURE_RE.test(s)) return 'failure'
  if (TEST_KIND_BOUNDARY_RE.test(s)) return 'boundary'
  return 'normal'
}

/** 추가된 줄들을 테스트 케이스 단위 블록으로 자른다 — 케이스 선언 줄부터 다음 선언 줄 직전까지가 본문. */
function testCaseBlocks(added = []) {
  const blocks = []
  for (const a of added) {
    const t = str(a?.text)
    if (TEST_CASE_RE.test(t)) blocks.push([t])
    else if (blocks.length) blocks[blocks.length - 1].push(t)
  }
  return blocks.map((b) => b.join('\n'))
}

/** 이번 diff 가 더한 테스트 — 파일 수 · 케이스 수 · **유형별 건수**. diff 가 없으면 「셀 수 없음」이다(0 이 아니다). */
export function newTestsFromDiff(diff) {
  const text = str(diff)
  const zero = () => ({ normal: 0, failure: 0, boundary: 0 })
  if (!text.trim()) return { measurable: false, files: [], cases: 0, kinds: zero() }
  const byFile = splitDiffByFile(text)
  const files = []
  const kinds = zero()
  let cases = 0
  for (const [path, f] of Object.entries(byFile)) {
    if (!TEST_FILE_RE.test(path)) continue
    const blocks = testCaseBlocks(f.added ?? [])
    if (!blocks.length) continue
    files.push(path)
    cases += blocks.length
    for (const b of blocks) kinds[classifyTestCase(b)] += 1
  }
  return { measurable: true, files, cases, kinds }
}

/** 유형 충족 판정(순수) — 셋 다 1건 이상이어야 PASS. */
export function testKindsVerdict(tests) {
  if (!tests?.measurable) return [NOT_VERIFIED, '변경 내용을 받지 못해 새 테스트가 붙었는지 확인하지 못했다']
  if (!tests.cases) return [FAIL, '이번 변경에 새 테스트가 하나도 없다']
  const k = tests.kinds ?? { normal: 0, failure: 0, boundary: 0 }
  const missing = TEST_KINDS.filter((n) => !k[n])
  const have = TEST_KINDS.filter((n) => k[n]).map((n) => `${KIND_KO[n]} ${k[n]}`).join(' · ')
  if (missing.length) {
    return [NOT_VERIFIED, `테스트 ${tests.cases}건(${have})은 있으나 ${missing.map((n) => KIND_KO[n]).join('·')} 유형을 확인하지 못했다 — 없는 유형을 통과로 세지 않는다`]
  }
  return [PASS, `이번 변경에 테스트 ${tests.cases}건(파일 ${tests.files.length}개 · ${have})`]
}

/** 스토리의 완료 기록 절을 감사한다 — 실측 인용과 「확인 못 한 것」이 둘 다 있어야 통과다. */
export function completionNotesAudit({ manifest, storyText = '' } = {}) {
  const text = str(storyText)
  if (!text) return { result: NOT_VERIFIED, why: '스토리 본문을 받지 못해 완료 기록을 확인하지 못했다', section: '' }
  const section = sectionOf(text, '### Completion Notes List')
  if (section === null) return { result: FAIL, why: '완료 기록 절이 없다 — 무엇을 근거로 끝냈는지 남지 않았다', section: '' }
  if (!section.trim()) return { result: FAIL, why: '완료 기록 절이 비어 있다', section: '' }
  const hasNv = /NOT VERIFIED|미검증|확인하지 못/.test(section)
  const hasCite = citedFacts(manifest).some((f) => section.includes(f))
  if (!hasCite) return { result: FAIL, why: '완료 기록에 검증 기록의 실측 수치가 인용돼 있지 않다', section }
  if (!hasNv) return { result: FAIL, why: '완료 기록에 「확인하지 못한 것」 항목이 없다 — 미검증 0건이면 그렇게 적어야 한다', section }
  return { result: PASS, why: '실측 인용 + 확인 못 한 것 기재 확인', section }
}

/** 완료 기록이 인용했는지 볼 「매니페스트에 실제로 있는 값」들. */
function citedFacts(manifest) {
  const m = manifest ?? {}
  const out = []
  const qa = str(m.checks?.qa)
  if (qa) out.push(`검사(qa): ${qa}`, `검사 ${qa}`, `qa ${qa}`)
  const a = num(m.repair?.attempts)
  if (a !== null) out.push(`자동 수리: ${a}회`, `자동 수리 ${a}회`)
  const high = num(m.review?.counts?.high)
  if (high !== null) out.push(`높음 ${high}`)
  out.push(`차단 ${blockingIntegrity(m.integrity, m.repair).length}건`)
  if (m.commit) out.push(str(m.commit))
  return out
}

/** `heading` 절의 본문(다음 같은/상위 수준 헤더 전까지). 절이 없으면 null. */
function sectionOf(text, heading) {
  const lines = str(text).split(/\r?\n/)
  const level = (heading.match(/^#+/) ?? ['###'])[0].length
  const i = lines.findIndex((l) => l.trim() === heading)
  if (i < 0) return null
  const out = []
  for (let j = i + 1; j < lines.length; j++) {
    const h = /^(#{1,6})\s/.exec(lines[j])
    if (h && h[1].length <= level) break
    out.push(lines[j])
  }
  return out.join('\n')
}

// ── 완료 기록 렌더 (설계 §3-5 형식) ──────────────────────────────────────────
/**
 * 스토리 `### Completion Notes List` 에 붙일 블록.
 * **매니페스트에 없는 수치는 창작하지 않는다** — 없으면 `NOT VERIFIED` 라고 적는다.
 * @param {object} manifest
 * @param {{round?:number, date?:string, applied?:string[]}} o
 */
export function renderCompletionNotes(manifest, { round = 1, date = null, applied = [] } = {}) {
  const m = manifest ?? {}
  const c = m.completion ?? null
  const day = date ?? (str(m.generatedAt).slice(0, 10) || NV)
  const v = (x) => (x === null || x === undefined || x === '' ? NV : String(x))

  const chain = ['typecheck', 'lint', 'unit'].map((k) => `${k}=${v(m.checks?.[k])}`).join(' · ')
  const rev = m.review
    ? `${v(m.review.provider)}/${v(m.review.model)} — 결과 ${v(m.review.result)} · 높음 ${v(num(m.review.counts?.high))} · 지적 ${v(num(m.review.counts?.patch))} · 결정 ${v(num(m.review.counts?.decision))} · 열람 증거 ${reviewEvidenceCount(m.review) || NV}`
    : NV
  const blocks = blockingIntegrity(m.integrity, m.repair).length
  const warns = arr(m.integrity).filter((f) => f?.level === 'warn').length
  const nv = [
    ...(c ? c.notVerified.map((x) => x.what) : []),
    ...(m.checks?.integration && isNaGate(m.checks.integration) ? ['통합 게이트'] : []),
  ]
  const uniqNv = [...new Set(nv)]

  const lines = [
    `**✅ ${day} 자율 마무리 라운드 ${round} 완주** — ${v(m.story)}`,
    '',
    `- 검사(qa): ${v(m.checks?.qa)} · 사슬 ${chain}`,
    `- 조건부 게이트: 보안 ${v(m.checks?.security)} · 성능 ${v(m.checks?.performance)} · 통합 ${v(m.checks?.integration)}`,
    `- 테스트 무결성: 차단 ${blocks}건 · 경고 ${warns}건`,
    `- 자동 수리: ${v(num(m.repair?.attempts))}회${arr(m.repair?.signatures).length ? ` (원인 ${[...new Set(arr(m.repair.signatures))].length}종)` : ''}`,
    `- 교차 검토: ${rev}`,
    `- 새 테스트: ${c?.evidence?.newTests ? `${c.evidence.newTests.cases}건 / 파일 ${c.evidence.newTests.files.length}개 · 유형 ${TEST_KINDS.map((n) => `${KIND_KO[n]} ${c.evidence.newTests.kinds?.[n] ?? 0}`).join(' · ')}` : NV}`,
    `- 완료 판정: ${c ? `${c.verdict} (통과 ${c.counts.pass} · 미달 ${c.counts.fail} · 확인 못 함 ${c.counts.notVerified})` : NV}`,
    `- 커밋: ${v(m.commit)} · 브랜치: ${v(m.branch)}`,
    ...(applied.length ? [`- 반영: ${applied.join(' · ')}`] : []),
    '',
    `- **${NV}**: ${uniqNv.length ? uniqNv.join(' · ') : '없음'}`,
  ]
  return lines.join('\n')
}
