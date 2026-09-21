// dev-status 배포 판정 — RED 5경로 · AMBER 8경로 · GREEN 1 · 재료 0 → 판정 불가 (설계 §7.2)
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AMBER, GREEN, RED, UNKNOWN, batchWarnings, deployVerdict, epicOfStory, lastRelease, releaseLineOf, splitBatchMaterial, splitChain, splitCheckFails, tierRemaining } from './verdict.mjs'

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
  test('③-b exit 8(리뷰 대기)은 RED 가 아니다 — AMBER 로 내려가고 사유에 「리뷰 대기」가 적힌다(2026-09-07 T6 규칙)', () => {
    const i = GREEN_INPUT()
    i.manifests = [pass({ worst: 8 })]
    i.lastNight = i.manifests
    const v = deployVerdict(i)
    assert.notEqual(v.level, RED)
    assert.equal(v.level, AMBER)
    assert.ok(v.reasons.some((r) => r.includes('리뷰 대기(exit 8)')), JSON.stringify(v.reasons))
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
    const { warnings: w, notes } = batchWarnings({
      manifests: [
        pass({ stories: ['2-16', '9-9'], integration: { result: 'rollback', ran: true, landingBase: 'b' } }),
      ],
      verifications: [{ story: '2-16', checks: { integration: 'unknown(mock 통과는…)' } }],
      stories: [{ slug: '2-16', status: 'done' }],
    })
    assert.equal(w.length, 3)
    assert.equal(notes.length, 0)
    assert.ok(w.some((x) => /unknown-story/.test(x.msg)))
    assert.ok(w.some((x) => /통합 게이트 되돌림/.test(x.msg)))
    assert.ok(w.some((x) => /확인 안 됨/.test(x.msg)))
  })
  test('스토리 목록을 모르면 unknown-story 를 만들지 않는다(오경보 금지)', () => {
    const w = batchWarnings({ manifests: [pass({ stories: ['9-9'] })], verifications: [], stories: [] })
    assert.equal(w.warnings.length, 0)
  })
  test('재료 0 → 경고 0', () => {
    assert.deepEqual(batchWarnings({}), { warnings: [], notes: [] })
  })
})

// ── 2026-09-21 규칙 1·2 — 판정이 끝난 과거 기록을 「현재 경고」로 세지 않는다 ──────────────
const rollback = (over = {}) => pass({ integration: { result: 'rollback', ran: true, landingBase: 'b' }, ...over })

describe('lastRelease — RELEASE-LOG.md 절 머리 파싱', () => {
  const LOG = [
    '# RELEASE LOG',
    '## 2026-09-19 16:3x · 릴리스 열차 R2 T6 · auto/2026-09-19-release → main',
    '- 범위: …',
    '## 2026-09-16 · auto/2026-09-15-fix-walkthrough-r → main',
    '## 2026-09-08 23:52 · auto/2026-09-09-devstatus-exit8 → main',
  ].join('\n')

  test('파일 순서가 아니라 시각의 최댓값을 고르고 「3x」는 그 시의 끝으로 읽는다', () => {
    const r = lastRelease(LOG)
    assert.equal(r.heading, '2026-09-19 16:3x')
    assert.equal(r.at, '2026-09-19T07:59:59.000Z') // 16:59:59 KST
  })
  test('시각이 없는 절은 그 날의 끝 · 절이 하나도 없으면 null(접지 않는다)', () => {
    assert.equal(lastRelease('## 2026-09-16 · x').at, '2026-09-16T14:59:59.000Z')
    assert.deepEqual(lastRelease('릴리스 기록 없음'), { at: null, heading: '' })
  })
})

describe('규칙 1 — 마지막 릴리스 이전 되돌림은 참고로 접는다', () => {
  const opts = { lastReleaseAt: '2026-09-19T07:59:59.000Z', lastReleaseLabel: '2026-09-19 16:3x' }

  test('릴리스 이전 되돌림 → 경고 0 · 참고 1줄', () => {
    const r = batchWarnings({ manifests: [rollback({ at: '2026-09-18T10:00:00.000Z' })], ...opts })
    assert.equal(r.warnings.length, 0)
    assert.equal(r.notes.length, 1)
    assert.match(r.notes[0].msg, /과거 배치 되돌림 1건/)
    assert.match(r.notes[0].msg, /2026-09-19 16:3x/)
  })
  test('릴리스 이후 되돌림 → 경고 1 · 참고 0', () => {
    const r = batchWarnings({ manifests: [rollback({ at: '2026-09-20T10:00:00.000Z' })], ...opts })
    assert.equal(r.warnings.length, 1)
    assert.equal(r.notes.length, 0)
    assert.match(r.warnings[0].msg, /통합 게이트 되돌림/)
  })
  test('릴리스 시각이나 배치 시각을 모르면 접지 않는다', () => {
    assert.equal(batchWarnings({ manifests: [rollback({ at: '2026-09-18T10:00:00.000Z' })] }).warnings.length, 1)
    assert.equal(batchWarnings({ manifests: [rollback({ at: null })], ...opts }).warnings.length, 1)
  })
})

describe('규칙 2 — 통합 게이트 도입 전 완료는 참고로 접는다', () => {
  const v = (generatedAt) => ({ story: '2-1', generatedAt, checks: { integration: 'unknown(mock…)' } })
  const stories = [{ slug: '2-1', status: 'done' }]

  test('검증 기록이 도입일 전 → 경고 0 · 참고 1줄', () => {
    const r = batchWarnings({ verifications: [v('2026-09-05T01:29:10.879Z')], stories, integrationGateSince: '2026-09-10' })
    assert.equal(r.warnings.length, 0)
    assert.equal(r.notes.length, 1)
    assert.match(r.notes[0].msg, /통합 게이트 도입 전 완료 1건/)
  })
  test('검증 기록이 도입일 이후 → 경고 1 · 참고 0', () => {
    const r = batchWarnings({ verifications: [v('2026-09-12T01:00:00.000Z')], stories, integrationGateSince: '2026-09-10' })
    assert.equal(r.warnings.length, 1)
    assert.equal(r.notes.length, 0)
  })
  test('도입일이나 기록 시각을 모르면 접지 않는다', () => {
    assert.equal(batchWarnings({ verifications: [v('2026-09-05T01:00:00.000Z')], stories }).warnings.length, 1)
    assert.equal(batchWarnings({ verifications: [v(null)], stories, integrationGateSince: '2026-09-10' }).warnings.length, 1)
  })
})

// ── 2026-09-21 두 갈래 — 개발선(릴리스 열차 별도)·지난 릴리스 이전 재료는 배포 판정에 넣지 않는다 ──
const OPS = [1, 2, 3, 11, 4]
const REL = '2026-09-19T07:59:59.000Z' // 마지막 운영 릴리스(R2)

describe('에픽 번호 읽기', () => {
  test('에픽 번호는 슬러그 앞자리에서 읽는다', () => {
    assert.equal(epicOfStory('13-2-서버-마스킹'), 13)
    assert.equal(epicOfStory('1.29'), 1)
    assert.equal(epicOfStory(''), null)
    assert.equal(epicOfStory(null), null)
  })
})

describe('운영선 / 개발선 가르기', () => {
  test('스토리가 전부 개발선 에픽이면 개발선 · 하나라도 운영선이면 운영선', () => {
    assert.equal(releaseLineOf(pass({ stories: ['13-2', '5-1'] }), OPS), 'dev')
    assert.equal(releaseLineOf(pass({ stories: ['13-2', '2-16'] }), OPS), 'ops')
  })
  test('러너 클론에서 읽은 것은 스토리와 무관하게 개발선', () => {
    assert.equal(releaseLineOf({ ...pass({ stories: ['2-16'] }), fromRunnerClone: true }, OPS), 'dev')
  })
  test('스토리를 모르거나 운영선 목록이 없으면 가리지 않는다(나쁜 쪽이 이긴다)', () => {
    assert.equal(releaseLineOf(pass({ stories: [] }), OPS), 'ops')
    assert.equal(releaseLineOf(pass({ stories: ['13-2'] }), []), 'ops')
  })
  test('계측은 stories 가 {story} 객체 배열이어도 같은 규칙', () => {
    const met = { batchId: '2026-09-20-1', stories: [{ story: '13-6-릴스' }], qualityGate: { passed: false, why: 'qa RED' } }
    assert.equal(releaseLineOf(met, OPS), 'dev')
  })
  test('셋으로 가른다 — 운영선·개발선·마지막 릴리스 이전', () => {
    const r = splitBatchMaterial([
      pass({ stories: ['2-16'], at: '2026-09-20T01:00:00.000Z' }),   // 운영선 · 릴리스 이후
      pass({ stories: ['13-2'], at: '2026-09-20T01:00:00.000Z' }),   // 개발선
      pass({ stories: ['2-16'], at: '2026-09-18T01:00:00.000Z' }),   // 운영선 · 릴리스 이전
    ], { opsEpics: OPS, lastReleaseAt: REL })
    assert.equal(r.active.length, 1)
    assert.equal(r.dev.length, 1)
    assert.equal(r.preRelease.length, 1)
  })
  test('계측에 at 이 없으면 batchId 날짜를 그 날 끝으로 읽는다(접는 쪽이 아니라 세는 쪽)', () => {
    const met = (id) => ({ batchId: id, stories: [{ story: '2-16' }], qualityGate: { passed: false, why: 'qa RED' } })
    const r = splitBatchMaterial([met('2026-09-18-111'), met('2026-09-20-222')], { opsEpics: OPS, lastReleaseAt: REL })
    assert.equal(r.preRelease.length, 1)
    assert.equal(r.active.length, 1)
  })
})

describe('배포 판정 — 개발선·옛 기록은 「막는 것」으로 세지 않는다', () => {
  const rb = (over) => pass({ integration: { result: 'rollback', ran: true, landingBase: 'b' }, ...over })

  test('개발선 배치의 되돌림·리뷰 대기는 판정 밖 — 참고 줄로만 적는다', () => {
    const i = GREEN_INPUT()
    i.opsEpics = OPS
    i.lastReleaseAt = REL
    i.manifests = [
      pass(),
      rb({ stories: ['5-5'], at: '2026-09-20T01:00:00.000Z' }),
      pass({ stories: ['13-4'], at: '2026-09-20T02:00:00.000Z', worst: 8 }),
    ]
    const v = deployVerdict(i)
    // 「막는 것」은 0 이다. 다만 개발선이 어지러우면 GREEN 이라고 적지는 않는다 —
    // GREEN 의 적극 조건(증거가 실제로 있나)은 종전 그대로라 UNKNOWN(판정 불가)이 된다.
    assert.notEqual(v.level, RED)
    assert.equal(v.level, UNKNOWN)
    assert.equal(v.reasons.filter((r) => r.startsWith('배치 ')).length, 0)
    assert.equal(v.lines.dev.stop, 1)
    assert.equal(v.lines.dev.reviewPending, 1)
    assert.ok(v.notes.some((t) => t.startsWith('개발선(릴리스 열차 별도) — 리뷰 대기 1 · 회수 대기 0 · STOP 1')))
  })

  test('운영선 배치의 되돌림은 그대로 RED — 가리지 않는다', () => {
    const i = GREEN_INPUT()
    i.opsEpics = OPS
    i.lastReleaseAt = REL
    i.manifests = [pass(), rb({ stories: ['2-16'], at: '2026-09-20T01:00:00.000Z' })]
    const v = deployVerdict(i)
    assert.equal(v.level, RED)
    assert.equal(v.reasons.length, 1)
  })

  test('마지막 릴리스 이전의 운영선 되돌림은 참고로 접는다', () => {
    const i = GREEN_INPUT()
    i.opsEpics = OPS
    i.lastReleaseAt = REL
    i.lastReleaseLabel = '2026-09-19 16:3x'
    i.manifests = [pass(), rb({ stories: ['2-16'], at: '2026-09-18T01:00:00.000Z' })]
    const v = deployVerdict(i)
    assert.notEqual(v.level, RED)
    assert.equal(v.lines.preRelease.rollback, 1)
    assert.ok(v.notes.some((t) => t.includes('마지막 릴리스 이전 되돌림 1건') && t.includes('2026-09-19 16:3x')))
  })

  test('개발선 계측의 품질 게이트 미통과는 「회수 대기」로 접고 운영선 것만 센다', () => {
    const i = GREEN_INPUT()
    i.opsEpics = OPS
    i.lastReleaseAt = REL
    i.metrics = [
      { batchId: '2026-09-20-a', stories: [{ story: '13-6' }], qualityGate: { passed: false, why: 'qa RED(exit 1)' } },
      { batchId: '2026-09-20-b', stories: [{ story: '2-16' }], qualityGate: { passed: false, why: 'qa RED(exit 1)' } },
    ]
    const v = deployVerdict(i)
    assert.equal(v.level, AMBER)
    assert.equal(v.reasons.length, 1)
    assert.equal(v.lines.dev.recovery, 1)
  })

  test('「막는 것 N건」 = 실제 판정에 쓴 이유 수와 같다', () => {
    const i = GREEN_INPUT()
    i.opsEpics = OPS
    i.lastReleaseAt = REL
    i.manifests = [pass()].concat(
      ['13-2', '13-3', '13-4', '5-1', '6-2'].map((sl) => pass({ stories: [sl], at: '2026-09-20T01:00:00.000Z', worst: 8 })),
    )
    i.inbox = { pending: [], gates: [{ title: 'g' }], ack: [] }
    const v = deployVerdict(i)
    assert.equal(v.level, AMBER)
    assert.equal(v.reasons.length, 1) // 사람 게이트 1건뿐 — 개발선 exit 8 다섯 건은 참고 줄
    assert.equal(v.lines.dev.reviewPending, 5)
  })

  test('운영선 목록·릴리스 시각이 없으면 종전대로 전부 센다(뒤로 호환)', () => {
    const i = GREEN_INPUT()
    i.manifests = [pass(), pass({ stories: ['13-4'], at: '2026-09-20T02:00:00.000Z', worst: 8 })]
    const v = deployVerdict(i)
    assert.equal(v.level, AMBER)
    assert.equal(v.reasons.length, 1)
    assert.deepEqual(v.notes, [])
  })
})

// ── 2026-09-21 접기 2종 — 검사 도입 전 기록 · 개발선 날짜 체인 ────────────────
describe('규칙 3 — 검사 도입 전 기록은 참고로 접는다', () => {
  const SINCE = { security: '2026-09-10', performance: '2026-09-10' }
  const v = (generatedAt, check = 'security') => ({
    story: '2-16', generatedAt,
    checkFails: [{ check, value: 'required-missing(스크립트 없음)' }],
  })

  test('기록이 도입일 전 → 세지 않고 참고 1줄', () => {
    const r = splitCheckFails([v('2026-09-05T20:42:20.509Z')], SINCE)
    assert.deepEqual(r.counted, [])
    assert.equal(r.folded, 1)
    const d = deployVerdict({ ...GREEN_INPUT(), verifications: [v('2026-09-05T20:42:20.509Z')], qualityGatesSince: SINCE })
    assert.equal(d.level, GREEN)
    assert.ok(d.notes.some((t) => /검사 도입 전 기록 1건/.test(t)))
  })

  test('기록이 도입일 이후 → 종전대로 센다', () => {
    const r = splitCheckFails([v('2026-09-12T01:00:00.000Z')], SINCE)
    assert.deepEqual(r.counted, ['2-16 의 security'])
    assert.equal(r.folded, 0)
    const d = deployVerdict({ ...GREEN_INPUT(), verifications: [v('2026-09-12T01:00:00.000Z')], qualityGatesSince: SINCE })
    assert.equal(d.level, AMBER)
    assert.match(d.why, /검사 실패·미구성 1건/)
  })

  test('도입일 없는 검사·기록 시각 미상은 접지 않는다', () => {
    assert.equal(splitCheckFails([v('2026-09-05T00:00:00.000Z', 'qa')], SINCE).counted.length, 1)
    assert.equal(splitCheckFails([v(null)], SINCE).counted.length, 1)
    assert.equal(splitCheckFails([v('2026-09-05T00:00:00.000Z')], null).counted.length, 1)
  })
})

describe('규칙 4 — 개발선 날짜 체인은 미머지로 세지 않는다', () => {
  const NOW = new Date('2026-09-21T00:30:00.000Z') // KST 2026-09-21 09:30
  const chain = (branches) => ({ ...GREEN_INPUT(), chainBranches: branches, now: NOW })

  test('가르기 — auto/<날짜> 는 개발선 · auto/<날짜>-<주제> 는 운영선', () => {
    const s = splitChain(['auto/2026-09-19', 'origin/auto/2026-09-19', 'auto/2026-09-21', 'origin/auto/2026-09-14-fix-x'], '2026-09-21')
    assert.deepEqual(s.dev.branches, ['auto/2026-09-19', 'auto/2026-09-21'])
    assert.equal(s.dev.days, 2)
    assert.deepEqual(s.ops.branches, ['auto/2026-09-14-fix-x'])
    assert.equal(s.ops.days, 7)
    assert.equal(splitChain(['auto/tooling'], '2026-09-21').dev.days, null)
  })

  test('개발선 날짜 체인만 밀려 있으면 → 막는 것 0 · 참고 1줄', () => {
    const v = deployVerdict(chain(['auto/2026-09-19', 'origin/auto/2026-09-19', 'auto/2026-09-21']))
    assert.equal(v.level, GREEN)
    assert.deepEqual(v.reasons, [])
    assert.ok(v.notes.some((t) => /개발선 체인 2일\(릴리스 열차 대기 · 정상\)/.test(t)))
  })

  test('운영선 수리 갈래가 남아 있으면 → 종전대로 센다(갈래 이름까지 적는다)', () => {
    const v = deployVerdict(chain(['auto/2026-09-21', 'origin/auto/2026-09-16-fix-billing']))
    assert.equal(v.level, AMBER)
    assert.match(v.why, /미머지 운영선 수리 갈래가 5일째입니다 — auto\/2026-09-16-fix-billing/)
  })

  test('갈래 목록을 모르면 종전 숫자 하나로 센다(뒤로 호환)', () => {
    const v = deployVerdict({ ...GREEN_INPUT(), chainAgeDays: 3, chainBranches: [] })
    assert.equal(v.level, AMBER)
    assert.match(v.why, /미머지 auto\/\* 체인이 3일째입니다/)
  })
})
