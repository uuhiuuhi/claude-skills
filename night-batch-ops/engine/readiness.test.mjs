// readiness.test.mjs — 완료·배포 가능 판정표 (설계 §9-1 readiness)
//
// 이 테스트가 지키는 한 문장: **모르는 것은 통과가 아니다.**
// 그래서 「n/a 면 ready 가 못 된다」·「진단이 확인 못 한 것을 들고 있으면 ready 가 못 된다」를
// 스텁이 아니라 **실제 픽스처 프로젝트를 읽어 만든 진단**으로도 한 번 더 확인한다.

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { diagnose, readProject } from './diagnose.mjs'
import { buildBacklog } from './backlog.mjs'
import { createFakeProject } from './fixtures/fake-bmad-project.mjs'
import {
  FAIL, NOT_READY, NOT_VERIFIED, PASS, PROJECT_CRITERIA, READY, TASK_CRITERIA,
  blockingIntegrity, gateValueResult, projectReadiness, propagate,
  renderReadinessTable, reviewEvidenceCount, taskReadiness,
} from './readiness.mjs'

// ── 재료 ─────────────────────────────────────────────────────────────────────
const okManifest = (over = {}) => ({
  schema: 'auto-story-finish/verification/1',
  story: '1-1-정상-스토리',
  workers: { dev: { provider: 'claude', model: 'opus' }, review: { provider: 'codex', model: 'gpt-5' } },
  checks: {
    qa: 'pass', typecheck: 'pass', lint: 'pass', unit: 'pass', build: 'pass',
    security: 'not-required', performance: 'not-required', integration: 'pass',
  },
  integrity: [],
  repair: { attempts: 0, signatures: [], exhausted: false },
  review: { provider: 'codex', model: 'gpt-5', result: 'clean', counts: { high: 0, patch: 0, decision: 0, defer: 0 }, readEvidence: 2 },
  completion: {
    criteria: [{ id: 'T2', result: PASS, why: '이번 변경에 테스트 3건' }, { id: 'T8', result: PASS, why: '실측 인용 + 확인 못 한 것 기재' }],
    verdict: READY, counts: { pass: 8, fail: 0, notVerified: 0, total: 8 }, notVerified: [],
  },
  ...over,
})

const okStory = () => ({
  key: '1-1-정상-스토리', id: '1-1', epic: 1, exists: true,
  statusInFile: 'done', statusInSprint: 'done',
  fileList: { sectionPresent: true, declared: ['src/a.ts', 'tests/a.test.ts'], missing: [], untested: [] },
})

const okDiagnosis = (over = {}) => ({
  schema: 'night-batch-ops/diagnosis/1', at: '2026-09-03T00:00:00.000Z',
  stories: [{ key: '1-1-정상-스토리', verdict: 'verified-done' }],
  findings: [], counts: { findings: { 1: 0, 2: 0, 3: 0 } }, notVerified: [],
  ...over,
})

const task = (o = {}) => taskReadiness({ manifest: okManifest(o.manifest ?? {}), story: o.story ?? okStory(), diagnosis: o.diagnosis ?? okDiagnosis(), item: o.item ?? null })
const idOf = (r, id) => r.criteria.find((c) => c.id === id)

// ── 기준표 ───────────────────────────────────────────────────────────────────
describe('readiness — 기준표 형태', () => {
  it('작업 8조건·프로젝트 8조건이 T1~T8 / P1~P8 로 빠짐없이 있고, 각 조건이 근거 출처를 들고 있다', () => {
    assert.deepEqual(TASK_CRITERIA.map((c) => c.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'])
    assert.deepEqual(PROJECT_CRITERIA.map((c) => c.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'])
    for (const c of [...TASK_CRITERIA, ...PROJECT_CRITERIA]) {
      assert.ok(c.label.length > 5, `${c.id} 라벨이 비었다`)
      assert.ok(c.evidence.length >= 1, `${c.id} 근거 출처가 없다`)
      for (const e of c.evidence) { assert.ok(e.file, `${c.id} evidence.file 없음`); assert.ok(e.field, `${c.id} evidence.field 없음`) }
      assert.equal(c.required, true)
    }
  })

  it('전파 규칙: fail≥1 → not-ready / fail 0 & not-verified≥1 → not-verified / 전부 pass → ready', () => {
    assert.equal(propagate([{ result: PASS }, { result: FAIL }, { result: NOT_VERIFIED }]).verdict, NOT_READY)
    assert.equal(propagate([{ result: PASS }, { result: NOT_VERIFIED }]).verdict, NOT_VERIFIED)
    assert.equal(propagate([{ result: PASS }, { result: PASS }]).verdict, READY)
  })
})

// ── 작업 판정 ────────────────────────────────────────────────────────────────
describe('readiness — 작업(스토리) 8조건', () => {
  it('여덟 조건이 전부 통과하면 ready 다(기준선)', () => {
    const r = task()
    assert.equal(r.verdict, READY, JSON.stringify(r.criteria.filter((c) => c.result !== PASS), null, 1))
    assert.equal(r.counts.pass, 8)
    assert.equal(r.schema, 'night-batch-ops/readiness/1')
  })

  it('스크립트가 없어 n/a 인 게이트는 not-verified 이고, ready 는 절대 나오지 않는다', () => {
    const r = task({ manifest: { checks: { ...okManifest().checks, security: 'n/a(package.json scripts 에 security 없음)' } } })
    assert.equal(idOf(r, 'T4').result, NOT_VERIFIED)
    assert.notEqual(r.verdict, READY)
    assert.equal(r.verdict, NOT_VERIFIED)
    assert.match(idOf(r, 'T4').why, /없는 것은 통과가 아니다/)
    // n/a 는 fail 도 아니다 — 「실패했다」고 적으면 그것도 거짓말이다
    assert.equal(r.counts.fail, 0)
  })

  it('required-missing·not-run·unknown 도 전부 not-verified 다(모르는 값은 통과가 아니다)', () => {
    for (const v of ['required-missing(트리거됐으나 스크립트 없음)', 'not-run', 'unknown(mock 통과는 통합 성공이 아니다)', '', 'ホゲ']) {
      assert.equal(gateValueResult(v), NOT_VERIFIED, `${v} 를 통과로 읽었다`)
    }
    assert.equal(gateValueResult('pass'), PASS)
    assert.equal(gateValueResult('not-required'), PASS)
    assert.equal(gateValueResult('fail'), FAIL)
    assert.equal(gateValueResult('rollback'), FAIL)
  })

  it('fail 1건 + not-verified 2건이면 not-verified 가 아니라 not-ready 다(더 나쁜 쪽이 이긴다)', () => {
    const m = okManifest({
      checks: { ...okManifest().checks, qa: 'fail', security: 'n/a(스크립트 없음)' },
      completion: undefined,
    })
    delete m.completion
    const r = taskReadiness({ manifest: m, story: okStory(), diagnosis: okDiagnosis() })
    assert.equal(idOf(r, 'T1').result, FAIL)
    assert.equal(idOf(r, 'T4').result, NOT_VERIFIED)
    assert.equal(idOf(r, 'T8').result, NOT_VERIFIED) // 훅 미배선 = 완료 기록을 검사하지 못했다
    // T2 도 미확인이다 — 완료 판정도 `checks.unitKinds` 도 없으면 「목록에 테스트 파일이 있다」만으로는
    // 정상·실패·경계를 확인했다고 말할 수 없다(M2). 종전에는 여기서 PASS 가 나와 notVerified 가 2였다.
    assert.equal(idOf(r, 'T2').result, NOT_VERIFIED)
    assert.equal(r.counts.fail, 1)
    assert.equal(r.counts.notVerified, 3)
    assert.equal(r.verdict, NOT_READY)
    assert.deepEqual(r.blockers.map((b) => b.id), ['T1'])
  })

  // codex-review-r3 M2 — 엔진이 완료 판정을 안 붙였을 때의 갈음 경로. `checks.unitKinds` 가 있으면
  // 세 유형을 다 요구하고, 없으면 PASS 를 주지 않는다(happy-path 한 건으로 ready 가 되던 자리).
  it('T2: 완료 판정이 없어도 checks.unitKinds 가 있으면 정상·실패·경계 3유형을 요구한다', () => {
    const base = () => { const m = okManifest(); delete m.completion; return m }
    const withKinds = (kinds) => { const m = base(); m.checks = { ...m.checks, unitKinds: kinds }; return m }

    const all = taskReadiness({ manifest: withKinds({ normal: 2, failure: 1, boundary: 1 }), story: okStory(), diagnosis: okDiagnosis() })
    assert.equal(idOf(all, 'T2').result, PASS)

    const partial = taskReadiness({ manifest: withKinds({ normal: 3, failure: 0, boundary: 0 }), story: okStory(), diagnosis: okDiagnosis() })
    assert.equal(idOf(partial, 'T2').result, NOT_VERIFIED)
    assert.match(idOf(partial, 'T2').why, /실패·경계/)

    const none = taskReadiness({ manifest: withKinds({ normal: 0, failure: 0, boundary: 0 }), story: okStory(), diagnosis: okDiagnosis() })
    assert.equal(idOf(none, 'T2').result, FAIL)

    // `checks.unit` 은 문자열 그대로여야 한다 — T3 사슬이 그것을 읽는다(경로 혼선 방지).
    assert.equal(typeof withKinds({ normal: 1, failure: 1, boundary: 1 }).checks.unit, 'string')
    assert.equal(idOf(all, 'T3').result, PASS)
  })

  it('T6: 구현한 쪽과 검토한 쪽의 제공자가 같으면 교차 리뷰가 아니다 — fail', () => {
    const r = task({ manifest: { review: { provider: 'claude', model: 'fable', result: 'clean', counts: { high: 0 }, readEvidence: 3 }, completion: { criteria: [], verdict: READY, notVerified: [], counts: {} } } })
    assert.equal(idOf(r, 'T6').result, FAIL)
    assert.match(idOf(r, 'T6').why, /같다/)
    assert.equal(r.verdict, NOT_READY)
  })

  it('T6: 파일을 읽은 증거 없이 「아무 문제 없음」을 낸 리뷰는 fail(명령 개수만으로 통과시키지 않는다)', () => {
    const r = task({ manifest: { review: { provider: 'codex', model: 'gpt-5', result: 'clean', counts: { high: 0, patch: 0, decision: 0, defer: 0 } }, completion: { criteria: [], verdict: READY, notVerified: [], counts: {} } } })
    assert.equal(reviewEvidenceCount({ counts: { high: 0, patch: 0 } }), 0)
    assert.equal(idOf(r, 'T6').result, FAIL)
    assert.match(idOf(r, 'T6').why, /읽은 증거가 없다/)
  })

  it('T6: 높음 지적이 남아 있으면 fail · 교차 리뷰 기록 자체가 없으면 not-verified', () => {
    const high = task({ manifest: { review: { provider: 'codex', result: 'findings', counts: { high: 2, patch: 3 }, readEvidence: 4 }, completion: { criteria: [], verdict: READY, notVerified: [], counts: {} } } })
    assert.equal(idOf(high, 'T6').result, FAIL)
    const none = task({ manifest: { review: null, completion: { criteria: [], verdict: READY, notVerified: [], counts: {} } } })
    assert.equal(idOf(none, 'T6').result, NOT_VERIFIED)
  })

  // codex-review-r3 M1 — 종전 조건은 `devP && revP && devP === revP` 라 **한쪽 기록이 없으면 통과**였다.
  // 구형·부분 손상 매니페스트가 프로젝트를 ready 로 올리던 경로다. 누락 = not-verified(PASS 금지).
  it('T6: dev·review 제공자 중 하나라도 기록이 없으면 PASS 가 아니라 not-verified 다', () => {
    const clean = { model: 'gpt-5', result: 'clean', counts: { high: 0, patch: 0, decision: 0, defer: 0 }, readEvidence: 3 }
    const completion = { criteria: [], verdict: READY, notVerified: [], counts: {} }

    // ① review.provider 누락
    const noRev = task({ manifest: { review: { ...clean }, completion } })
    assert.equal(idOf(noRev, 'T6').result, NOT_VERIFIED)
    assert.match(idOf(noRev, 'T6').why, /제공자 기록이 빠졌다/)

    // ② workers.dev.provider 누락
    const noDev = task({ manifest: { workers: { dev: { model: 'opus' }, review: { provider: 'codex' } }, review: { ...clean, provider: 'codex' }, completion } })
    assert.equal(idOf(noDev, 'T6').result, NOT_VERIFIED)

    // ③ 둘 다 있고 서로 다르면 그때만 PASS
    const ok = task({ manifest: { review: { ...clean, provider: 'codex' }, completion } })
    assert.equal(idOf(ok, 'T6').result, PASS)
  })

  it('T5: 수리 라운드가 남긴 skip/only 는 경고가 아니라 차단이다', () => {
    const warn = [{ level: 'warn', rule: 'test-skip', file: 'tests/a.test.ts', line: 3, detail: 'skip 추가' }]
    assert.equal(blockingIntegrity(warn, { attempts: 0 }).length, 0) // 수리 전이면 경고 그대로
    assert.equal(blockingIntegrity(warn, { attempts: 1 }).length, 1) // 수리 라운드가 돌았으면 차단
    assert.equal(blockingIntegrity([{ level: 'warn', rule: 'test-skip', baseline: true }], { attempts: 2 }).length, 0) // 선재 흔적은 제외
    const r = task({ manifest: { integrity: warn, repair: { attempts: 1, signatures: ['x'] }, completion: { criteria: [], verdict: READY, notVerified: [], counts: {} } } })
    assert.equal(idOf(r, 'T5').result, FAIL)
  })

  it('T7: 실제 판정이 verified-done 이 아니면 문서의 done 을 믿지 않는다', () => {
    const r = taskReadiness({ manifest: okManifest(), story: okStory(), diagnosis: okDiagnosis({ stories: [{ key: '1-1-정상-스토리', verdict: 'partial' }] }) })
    assert.equal(idOf(r, 'T7').result, FAIL)
    assert.match(idOf(r, 'T7').why, /반쯤 됐다/)
  })

  it('T2: 변경 파일 목록이 없으면 not-verified · 목록에 테스트가 없으면 fail', () => {
    const noList = taskReadiness({ manifest: okManifest({ completion: undefined }), story: { ...okStory(), fileList: { sectionPresent: false, declared: [], missing: [], untested: [] } }, diagnosis: okDiagnosis() })
    assert.equal(idOf(noList, 'T2').result, NOT_VERIFIED)
    const noTest = taskReadiness({ manifest: okManifest({ completion: undefined }), story: { ...okStory(), fileList: { sectionPresent: true, declared: ['src/a.ts'], missing: [], untested: [] } }, diagnosis: okDiagnosis() })
    assert.equal(idOf(noTest, 'T2').result, FAIL)
  })

  it('진단이 「확인 못 한 것」을 하나라도 들고 있으면 여덟 조건이 전부 통과여도 ready 가 아니다', () => {
    const r = taskReadiness({ manifest: okManifest(), story: okStory(), diagnosis: okDiagnosis({ notVerified: [{ what: '보안 게이트', why: '이 프로젝트에 명령이 없다' }] }) })
    assert.equal(r.counts.pass, 8)
    assert.equal(r.counts.fail, 0)
    assert.equal(r.verdict, NOT_VERIFIED)
    assert.ok(r.notVerified.some((n) => n.criterion === 'propagate'))
  })

  it('검증 기록 자체가 없으면(훅 미배선) 조건 다수가 not-verified 로 떨어지고 ready 는 못 된다', () => {
    const r = taskReadiness({ manifest: null, story: okStory(), diagnosis: okDiagnosis() })
    assert.equal(r.verdict, NOT_VERIFIED)
    assert.ok(r.counts.notVerified >= 5)
    assert.equal(r.counts.fail, 0)
  })
})

// ── 표 ───────────────────────────────────────────────────────────────────────
describe('readiness — 판정표 렌더', () => {
  it('여덟 줄 + 판정 + 근거가 나오고, 확인 못 한 것을 「통과」로 적지 않는다', () => {
    const r = task({ manifest: { checks: { ...okManifest().checks, integration: 'unknown(mock 통과는 통합 성공이 아니다)' } } })
    const md = renderReadinessTable(r, { lang: 'ko' })
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']) assert.ok(md.includes(`| ${id} |`), `${id} 줄 없음`)
    assert.match(md, /확인 못 함/)
    assert.ok(!/T4 \|[^|]*\|\s*✅/.test(md), 'not-verified 를 통과로 적었다')
    assert.throws(() => renderReadinessTable(r, { lang: 'en' }), /지원하지 않는 언어/)
  })
})

// ── 프로젝트 판정(실제 픽스처) ───────────────────────────────────────────────
describe('readiness — 프로젝트 8조건(실제 픽스처 진단)', () => {
  const fx = createFakeProject()
  after(() => fx.cleanup())

  it('워커 A 픽스처를 실제로 읽어 진단하면 P2·P4·P5 가 근거와 함께 미달로 잡히고 판정은 not-ready 다', () => {
    const snap = readProject(fx.root)
    const diagnosis = diagnose(snap, { gates: {} })
    const backlog = buildBacklog({ diagnosis, snapshot: snap })
    const r = projectReadiness({ diagnosis, manifests: [], backlog })

    assert.equal(r.verdict, NOT_READY)
    const get = (id) => r.criteria.find((c) => c.id === id)
    for (const id of ['P2', 'P4', 'P5']) {
      assert.equal(get(id).result, FAIL, `${id} 가 미달이 아니다 — ${get(id).why}`)
      assert.ok(get(id).why.length > 5, `${id} 근거가 비었다`)
    }
    // 근거가 실제 수치를 인용한다(문장만 있고 숫자가 없으면 판정을 검증할 수 없다)
    assert.match(get('P2').why, /\d/)
    assert.match(get('P4').why, /\d/)
    assert.match(get('P5').why, /\d/)
    // 게이트를 안 돌렸으니 P3 는 fail 이 아니라 not-verified 다
    assert.equal(get('P3').result, NOT_VERIFIED)
    // 교차 리뷰 기록이 없으면 P7 은 통과가 아니다
    assert.equal(get('P7').result, NOT_VERIFIED)
    // P8 = 진단의 「확인 못 한 것」
    assert.equal(get('P8').result, NOT_VERIFIED)
    assert.ok(r.blockers.length >= 3)
  })

  it('진단을 읽는 동안 대상 저장소에 아무것도 쓰지 않는다', () => {
    const before = fx.porcelain()
    const snap = readProject(fx.root)
    projectReadiness({ diagnosis: diagnose(snap, { gates: {} }), manifests: [], backlog: null })
    assert.equal(fx.porcelain(), before)
  })

  it('전부 깨끗하면(지적 0 · 게이트 GREEN · 교차 리뷰 있음) ready 가 나온다', () => {
    const clean = {
      schema: 'night-batch-ops/diagnosis/1', at: '2026-09-03T00:00:00.000Z', root: '가짜',
      stories: [{ key: '1-1', verdict: 'verified-done' }],
      findings: [], counts: { epicOnly: 0, findings: { 1: 0, 2: 0, 3: 0 } },
      gates: { qa: { exit: 0, available: true }, build: { exit: 0, available: true } },
      notVerified: [],
    }
    const r = projectReadiness({ diagnosis: clean, manifests: [okManifest()], backlog: { items: [] } })
    assert.equal(r.verdict, READY, JSON.stringify(r.criteria.filter((c) => c.result !== PASS), null, 1))
  })

  it('같은 재료라도 진단에 확인 못 한 것이 하나 있으면 ready 가 not-verified 로 내려간다', () => {
    const clean = {
      schema: 'night-batch-ops/diagnosis/1', at: '2026-09-03T00:00:00.000Z',
      stories: [{ key: '1-1', verdict: 'verified-done' }],
      findings: [], counts: { epicOnly: 0, findings: { 1: 0, 2: 0, 3: 0 } },
      gates: { qa: { exit: 0, available: true }, build: { exit: 0, available: true } },
      notVerified: [{ what: '성능 게이트', why: '이 프로젝트에 명령이 없다' }],
    }
    const r = projectReadiness({ diagnosis: clean, manifests: [okManifest()], backlog: { items: [] } })
    assert.equal(r.verdict, NOT_VERIFIED)
    assert.equal(r.criteria.find((c) => c.id === 'P8').result, NOT_VERIFIED)
  })
})
