// dev-status 배포 판정 — RED 5경로 · AMBER 8경로 · GREEN 1 · 재료 0 → 판정 불가 (설계 §7.2)
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AMBER, GREEN, RED, UNKNOWN, batchWarnings, deployVerdict, tierRemaining } from './verdict.mjs'

const pass = (over = {}) => ({
  batchId: 'A', label: 'AUTO-1', at: '2026-09-03T01:00:00.000Z',
  stories: ['2-16'], stages: ['dev'], workers: 1, landing: [{ order: 1, story: '2-16' }],
  failed: [], integration: { result: 'pass', qaExit: 0, landingBase: 'b', at: null, ran: true },
  pushed: true, worst: 0, ...over,
})
const goodMetrics = { batchId: 'A', qualityGate: { passed: true, why: 'ok' } }
const goodDiag = { schema: 'night-batch-ops/diagnosis/1', counts: { findings: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } } }

/** 전부 초록인 최소 입력 — 각 테스트는 여기서 한 가지만 뒤집는다. */
const GREEN_INPUT = () => ({
  manifests: [pass()], lastNight: [pass()], metrics: [goodMetrics],
  queue: { validation: { ok: true, errors: [] }, batches: [], plan: { chainAgeDays: 0 } },
  verifications: [{ story: '2-16', checkFails: [], checks: { qa: 'pass' } }],
  inbox: { pending: [], gates: [], ack: [] },
  diagnosis: goodDiag, backlog: null, readiness: { verdict: 'ready', counts: {} },
  chainAgeDays: 0,
})

describe('GREEN', () => {
  test('전부 통과하면 GREEN — 이유 문장이 붙는다', () => {
    const v = deployVerdict(GREEN_INPUT())
    assert.equal(v.level, GREEN)
    assert.equal(v.label, '배포 가능')
    assert.ok(v.why.length > 0)
    assert.deepEqual(v.reasons, [])
  })
})

describe('RED — 5경로', () => {
  test('① 통합 게이트 fail', () => {
    const i = GREEN_INPUT()
    i.manifests = [pass({ integration: { result: 'fail', ran: true, landingBase: 'b' } })]
    i.lastNight = i.manifests
    const v = deployVerdict(i)
    assert.equal(v.level, RED)
    assert.match(v.why, /실패/)
  })
  test('② 통합 게이트 rollback', () => {
    const i = GREEN_INPUT()
    i.manifests = [pass({ integration: { result: 'rollback', ran: true, landingBase: 'b' } })]
    i.lastNight = i.manifests
    assert.equal(deployVerdict(i).level, RED)
  })
  test('③ worst ≥ 7', () => {
    const i = GREEN_INPUT()
    i.manifests = [pass({ worst: 7 })]
    i.lastNight = i.manifests
    assert.equal(deployVerdict(i).level, RED)
  })
  test('④ 진단 우선순위 ①②③ 잔여 > 0', () => {
    const i = GREEN_INPUT()
    i.diagnosis = { counts: { findings: { 1: 0, 2: 0, 3: 2, 4: 0, 5: 0 } } }
    const v = deployVerdict(i)
    assert.equal(v.level, RED)
    assert.match(v.why, /①②③/)
  })
  test('⑤ readiness 가 not-ready', () => {
    const i = GREEN_INPUT()
    i.readiness = { verdict: 'not-ready', counts: { fail: 2 } }
    assert.equal(deployVerdict(i).level, RED)
  })
  test('RED + GREEN 동시 → RED', () => {
    const i = GREEN_INPUT() // 나머지는 전부 GREEN 조건
    i.manifests = [pass({ integration: { result: 'rollback', ran: true, landingBase: 'b' } }), pass()]
    i.lastNight = i.manifests
    const v = deployVerdict(i)
    assert.equal(v.level, RED)
  })
})

describe('AMBER — 8경로', () => {
  const amber = (mut) => { const i = GREEN_INPUT(); mut(i); return deployVerdict(i) }
  test('① 품질 게이트 미통과', () => {
    const v = amber((i) => { i.metrics = [{ batchId: 'A', qualityGate: { passed: false, why: 'qa RED(exit 1)' } }] })
    assert.equal(v.level, AMBER)
    assert.match(v.why, /품질 게이트/)
  })
  test('② 큐 자기 검증 실패', () => {
    const v = amber((i) => { i.queue.validation = { ok: false, errors: [{ code: 'x', key: '4-7', msg: 'y' }] } })
    assert.equal(v.level, AMBER)
  })
  test('③ 검증 매니페스트 checks 에 fail/required-missing', () => {
    const v = amber((i) => { i.verifications = [{ story: '2-16', checkFails: [{ check: 'security', value: 'required-missing' }] }] })
    assert.equal(v.level, AMBER)
    assert.match(v.why, /검사 실패/)
  })
  test('④ 결정 대기 > 0', () => {
    const v = amber((i) => { i.inbox = { pending: [{ title: 'a' }], gates: [], ack: [] } })
    assert.equal(v.level, AMBER)
    assert.match(v.why, /결정 대기 1건/)
  })
  test('⑤ 사람 게이트 > 0', () => {
    const v = amber((i) => { i.inbox = { pending: [], gates: [{ title: 'g' }], ack: [] } })
    assert.equal(v.level, AMBER)
  })
  test('⑥ 미머지 auto/* ≥ 1일', () => {
    const v = amber((i) => { i.chainAgeDays = 1 })
    assert.equal(v.level, AMBER)
    assert.match(v.why, /1일째/)
  })
  test('⑦ 진단 ④⑤ 잔여 > 0', () => {
    const v = amber((i) => { i.diagnosis = { counts: { findings: { 1: 0, 2: 0, 3: 0, 4: 3, 5: 11 } } } })
    assert.equal(v.level, AMBER)
    assert.match(v.why, /④⑤/)
  })
  test('⑧ readiness 가 not-verified', () => {
    const v = amber((i) => { i.readiness = { verdict: 'not-verified', counts: { notVerified: 3 } } })
    assert.equal(v.level, AMBER)
  })
})

describe('상한 · 판정 불가', () => {
  test('자율 진단 산출물이 없으면 GREEN 이 못 되고 상한 AMBER', () => {
    const i = GREEN_INPUT()
    i.diagnosis = null; i.backlog = null; i.readiness = null
    const v = deployVerdict(i)
    assert.equal(v.level, AMBER)
    assert.equal(v.capped, true)
    assert.match(v.why, /자율 마무리 진단을 아직 돌리지 않았습니다/)
  })
  test('재료 0 → 판정 불가 · GREEN 이 아니다', () => {
    const v = deployVerdict({})
    assert.equal(v.level, UNKNOWN)
    assert.notEqual(v.level, GREEN)
    assert.equal(v.label, '판정 불가')
    assert.match(v.why, /아직 모른다/)
  })
  test('재료는 있는데 지난밤 배치가 0건 → GREEN 이 아니라 판정 불가', () => {
    const i = GREEN_INPUT()
    i.lastNight = []
    const v = deployVerdict(i)
    assert.equal(v.level, UNKNOWN)
    assert.match(v.why, /지난밤 배치 기록이 없습니다/)
  })
  test('빈 입력의 이유 문장에 「GREEN」 이라는 낱말이 없다', () => {
    const v = deployVerdict({})
    assert.ok(!/GREEN/.test(v.why))
    assert.ok(!/배포 가능/.test(v.label))
  })
})

// ── H2(2026-09-02 교차리뷰) — 증거 부재를 통과로 바꾸지 않는다 ─────────────────
describe('H2 · 증거 없는 GREEN 차단', () => {
  test('시나리오 1 — 통합 pass 뿐이고 계측·검증 0건 + 빈 진단이면 GREEN 이 아니다', () => {
    const v = deployVerdict({
      manifests: [pass()], lastNight: [pass()],
      metrics: [], verifications: [],
      diagnosis: {}, backlog: null, readiness: null,
    })
    assert.notEqual(v.level, GREEN)
    assert.equal(v.level, UNKNOWN)
    // 이유 문장이 증거 없이 「통과」를 주장하지 않는다
    assert.ok(!/품질 게이트 통과/.test(v.why), '증거 없이 통과를 적었다: ' + v.why)
    assert.ok(v.reasons.some((r) => /계측 기록이 0건/.test(r)))
    assert.ok(v.reasons.some((r) => /검증 기록이 0건/.test(r)))
    assert.ok(v.reasons.some((r) => /readiness/.test(r)))
  })

  test('시나리오 2 — 진단 없음 + backlog 있음 + 계측 1건이면 상한 AMBER(backlog 가 상한을 뚫지 못한다)', () => {
    const v = deployVerdict({
      manifests: [pass()], lastNight: [pass()], metrics: [goodMetrics],
      verifications: [{ story: '2-16', checkFails: [] }],
      diagnosis: null, backlog: { byTier: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
      readiness: { verdict: 'ready', counts: {} },
    })
    assert.equal(v.level, AMBER)
    assert.equal(v.capped, true)
    assert.notEqual(v.level, GREEN)
  })

  test('진짜 GREEN 1경로 — 이유 문장에 실제로 센 건수가 들어간다', () => {
    const v = deployVerdict(GREEN_INPUT())
    assert.equal(v.level, GREEN)
    assert.match(v.why, /지난밤 배치 1건 전부 통합 게이트 pass/)
    assert.match(v.why, /계측 1건 전부 품질 게이트 통과/)
    assert.match(v.why, /검증 1건 검사 실패 0/)
    assert.match(v.why, /마무리 판정 ready/)
  })

  // 뮤테이션 6종 — GREEN 조건을 하나씩 없애면 전부 GREEN 에서 탈락해야 한다.
  const MUTATIONS = [
    ['① 계측을 없앤다', (i) => { i.metrics = [] }],
    ['② 계측의 qualityGate.passed 를 지운다', (i) => { i.metrics = [{ batchId: 'A' }] }],
    ['③ 검증 기록을 없앤다', (i) => { i.verifications = [] }],
    ['④ 지난밤 배치가 돌린 스토리의 검증만 빠진다', (i) => { i.verifications = [{ story: '9-9', checkFails: [] }] }],
    ['⑤ 진단을 없앤다', (i) => { i.diagnosis = null }],
    ['⑥ readiness 를 없앤다', (i) => { i.readiness = null }],
  ]
  for (const [name, mut] of MUTATIONS) {
    test('뮤테이션 ' + name + ' → GREEN 탈락', () => {
      const i = GREEN_INPUT()
      mut(i)
      const v = deployVerdict(i)
      assert.notEqual(v.level, GREEN, name + ' 인데 GREEN 이 나왔다: ' + JSON.stringify(v))
      assert.ok(v.level === AMBER || v.level === UNKNOWN)
    })
  }

  test('뮤테이션 ⑦ readiness.verdict 가 ready 가 아니면 GREEN 탈락', () => {
    const i = GREEN_INPUT()
    i.readiness = { verdict: 'unknown', counts: {} } // not-ready/not-verified 가 아닌 낯선 값
    const v = deployVerdict(i)
    assert.notEqual(v.level, GREEN)
    assert.ok(v.reasons.some((r) => /ready 가 아닙니다/.test(r)))
  })

  test('뮤테이션 ⑧ 지난밤 배치의 통합 결과가 미실행(undefined)이면 GREEN 탈락', () => {
    const i = GREEN_INPUT()
    const m = pass({ integration: { result: undefined, ran: false } })
    i.manifests = [m]; i.lastNight = [m]
    const v = deployVerdict(i)
    assert.notEqual(v.level, GREEN)
  })
})

describe('tierRemaining', () => {
  test('backlog.byTier 가 우선 · 없으면 diagnosis · 둘 다 없으면 known=false', () => {
    assert.deepEqual(tierRemaining({ counts: { findings: { 1: 9 } } }, { byTier: { 1: 2, 2: 1 } }, [1, 2]),
      { known: true, count: 3, from: 'backlog.byTier' })
    assert.equal(tierRemaining({ counts: { findings: { 1: 4, 3: 1 } } }, null, [1, 3]).count, 5)
    assert.equal(tierRemaining(null, null, [1]).known, false)
  })
})

describe('⑨ 하네스 경고 3종', () => {
  test('unknown-story · integration=fail · 완료로 보이는데 통합 unknown', () => {
    const w = batchWarnings({
      manifests: [
        pass({ stories: ['2-16', '9-9'], integration: { result: 'rollback', ran: true, landingBase: 'b' } }),
      ],
      verifications: [{ story: '2-16', checks: { integration: 'unknown(mock 통과는…)' } }],
      stories: [{ slug: '2-16', status: 'done' }],
    })
    assert.equal(w.length, 3)
    assert.ok(w.some((x) => /unknown-story/.test(x.msg)))
    assert.ok(w.some((x) => /통합 게이트 되돌림/.test(x.msg)))
    assert.ok(w.some((x) => /확인 안 됨/.test(x.msg)))
  })
  test('스토리 목록을 모르면 unknown-story 를 만들지 않는다(오경보 금지)', () => {
    const w = batchWarnings({ manifests: [pass({ stories: ['9-9'] })], verifications: [], stories: [] })
    assert.equal(w.length, 0)
  })
  test('재료 0 → 경고 0', () => {
    assert.deepEqual(batchWarnings({}), [])
  })
})
