// dev-status 렌더 스냅숏 — 풍족 / 빈손 / 손상 3벌 (설계 §7.3)
// 「핵심 문자열이 있다·없다」로 단언한다. 빈손 벌은 **예외 0 · 「없음」 문구 · 「GREEN」 부재**가 핵심이다.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_CSS, esc, renderDiagnosis, renderError, renderHero, renderInbox,
  renderMetrics, renderNight, renderQueue, renderVerdictTick, storyExtras,
} from './render-batch.mjs'
import { dailyMetrics } from './daily-metrics.mjs'
import { deployVerdict } from './verdict.mjs'

const miss = (file) => ({ value: null, error: { file, why: '파일이 없습니다', kind: 'missing' } })
const broken = (file) => ({ value: null, error: { file, why: 'JSON 을 읽지 못했습니다 — Unexpected end', kind: 'broken' } })
const val = (v) => ({ value: v, error: null })
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString()
const NOW = new Date(2026, 8, 3, 7, 0)

// ── 풍족 ────────────────────────────────────────────────────────────────────
const RICH_MANIFESTS = [
  {
    batchId: 'AUTO-1', label: 'AUTO-1: 2-16 · 2-18 (회수)', at: at(2026, 9, 2, 22, 12),
    stories: ['2-16', '2-18'], stages: ['dev', 'review'], workers: 2,
    landing: [{ order: 1, story: '2-16' }, { order: 2, story: '2-18' }], failed: [],
    integration: { result: 'pass', qaExit: 0, landingBase: 'base1111', ran: true }, pushed: true, worst: 0,
  },
  {
    batchId: 'AUTO-2', label: 'AUTO-2: 4-2 · 4-3 (회수)', at: at(2026, 9, 3, 4, 58),
    stories: ['4-2', '4-3'], stages: ['dev', 'review'], workers: 2,
    landing: [{ order: 1, story: '4-2' }, { order: 2, story: '4-3' }],
    failed: [{ story: '4-3', exit: 1, evidence: 'C:/state/archive/x-evidence/4-3' }],
    integration: { result: 'rollback', qaExit: 1, landingBase: '1e83363abc', ran: true }, pushed: false, worst: 1,
  },
]
const RICH_VERIF = [
  {
    story: '2-16', generatedAt: at(2026, 9, 2, 23, 0), checks: { qa: 'pass' }, checkFails: [],
    workers: { dev: { provider: 'claude', model: 'opus' }, review: { provider: 'claude', model: 'sonnet' } },
    review: { provider: 'claude', model: 'sonnet', high: 0, medium: 1 }, completion: null,
  },
  {
    story: '2-18', generatedAt: at(2026, 9, 3, 0, 30), checks: { qa: 'pass' }, checkFails: [],
    workers: { dev: { provider: 'claude', model: 'opus' }, review: { provider: 'codex', model: 'gpt-5.6-sol' } },
    review: { provider: 'codex', model: 'gpt-5.6-sol', high: 1, medium: 2 }, completion: null,
  },
]
const RICH_METRICS = [{
  batchId: 'AUTO-1', wallMs: 96 * 60000, p50Ms: 42 * 60000, p95Ms: 61 * 60000,
  retries: { repairRounds: 1, providerSwitches: 0 },
  modelCalls: [{ provider: 'claude', model: 'opus', calls: 4, tokens: 0 }, { provider: 'codex', model: 'gpt-5.6-sol', calls: 1, tokens: 38400 }],
  qualityGate: { passed: true, why: 'ok' },
}]
const RICH_QUEUE = val({
  planned: 'auto', updated: '2026-09-03 자동 편성(plan-queue · 상한 6)', defaults: { parallel: 2 },
  batches: [
    { label: 'AUTO-1: 4-2 (회수)', enabled: true, stories: ['4-2'], stages: ['dev', 'review'], models: { dev: 'opus', review: 'codex:gpt-5.6-sol' } },
    { label: 'AUTO-2: 11-4 · 11-5 (회수)', enabled: true, stories: ['11-4', '11-5'], stages: ['dev', 'review'], models: { dev: 'opus', review: 'sonnet' } },
  ],
  validation: { ok: false, errors: [{ code: 'unresolved-dep', key: '4-7', msg: '선행 4-2 이 done 이 아닌데 편성됐다' }], warnings: [] },
  plan: { date: '2026-09-03', picked: [{ key: '4-2', why: '회수(review)' }, { key: '11-4', why: '회수(in-progress)' }, { key: '11-5', why: '신규(backlog)' }], excluded: [{ key: '4-7', why: '선행 미해소' }], notes: [], cap: 6, capBonus: 0, chainAgeDays: 1, alreadyPlannedToday: 0 },
})
const RICH_DIAG = val({ counts: { verifiedDone: 72, partial: 9, missing: 5, defect: 4, notVerified: 11, findings: { 1: 0, 2: 0, 3: 2, 4: 3, 5: 11, 6: 4, 7: 7 } } })
const RICH_BACKLOG = val({ byTier: { 1: 0, 2: 0, 3: 2, 4: 3, 5: 11, 6: 4, 7: 7 } })
const RICH_READY = val({
  verdict: 'not-ready', counts: { pass: 3, fail: 2, notVerified: 3, total: 8 },
  blockers: [{ id: 'P2', label: '높음·중간 차단이 0이 아니다', why: '높음 지적 2건' }],
  notVerified: [{ what: '2-27 qa 증거', why: '실행 기록이 없다', criterion: 'P3' }],
})
const RICH_REPORT = val({ headline: '❌ 아직 배포하면 안 됩니다 — 모자란 것: 통합 되돌림 1건' })
const RICH_INBOX = val({
  pending: [
    { title: '2.16 장비 재발 알림 기준일', summary: '재발로 묶는 기간입니다.', ageDays: 5, old: true, kind: 'pending', listed: '2026-08-29' },
    { title: '4-2 오늘 밤 재시도', summary: '', ageDays: 0, old: false, kind: 'pending', listed: '2026-09-03' },
  ],
  gates: [{ title: '4.2 G-7 자산별 프로파일', summary: '', ageDays: 2, old: false, kind: 'gate' }],
  ack: [{ title: '11.3 착수 가드' }],
  closed: 55,
})

const richTable = dailyMetrics({
  history: [
    { at: at(2026, 9, 2, 22, 0), workers: 2, wallMs: 60 * 60000, serialMs: 100 * 60000, idleRatio: 0.19, retries: { repairRounds: 0, providerSwitches: 0 }, modelCalls: [{ provider: 'claude', model: 'opus', calls: 6, tokens: 0 }], qualityGate: { passed: true } },
    { at: at(2026, 9, 1, 22, 0), workers: 2, wallMs: 50 * 60000, serialMs: 90 * 60000, idleRatio: 0.15, retries: { repairRounds: 1, providerSwitches: 0 }, modelCalls: [], qualityGate: { passed: true } },
  ],
  manifests: RICH_MANIFESTS, verifications: RICH_VERIF, now: NOW,
})

const RICH_VERDICT = deployVerdict({
  manifests: RICH_MANIFESTS, lastNight: RICH_MANIFESTS, metrics: RICH_METRICS,
  queue: RICH_QUEUE.value, verifications: RICH_VERIF, inbox: RICH_INBOX.value,
  diagnosis: RICH_DIAG.value, backlog: RICH_BACKLOG.value, readiness: RICH_READY.value, chainAgeDays: 1,
})

describe('풍족 — 목업의 핵심 문자열이 실제로 나온다', () => {
  test('① 히어로 — 판정·심박·숫자·이유 한 줄', () => {
    const h = renderHero({
      verdict: RICH_VERDICT, heartbeat: { state: 'ok', label: '슬롯 심박 정상 · 8분 전', why: '' },
      lastNight: RICH_MANIFESTS, inbox: RICH_INBOX.value, queue: RICH_QUEUE.value, blockers: 1,
    })
    assert.equal(RICH_VERDICT.level, 'red')
    assert.match(h, /b-verdict red/)
    assert.match(h, /배포 불가/)
    assert.match(h, /슬롯 심박 정상/)
    assert.match(h, /지난밤 배치 <b>2건/)
    assert.match(h, /결정 대기 <b>2건/)
    assert.match(h, /오늘 예정 <b>2배치/)
    assert.match(h, /배포 차단 <b>1건/)
    assert.match(h, /b-why/)
  })
  test('② 인박스 — 3일 이상이 맨 위 · 사후 확인은 접힘', () => {
    const h = renderInbox(RICH_INBOX)
    assert.match(h, /② 오늘 정하실 것/)
    assert.match(h, /5일 대기/)
    assert.match(h, /b-age old/)
    assert.ok(h.indexOf('2.16 장비 재발') < h.indexOf('4-2 오늘 밤'), '오래된 것이 위에 온다')
    assert.match(h, /사람 게이트/)
    assert.match(h, /사후 확인 1건/)
  })
  test('④ 지난밤 배치 — 워커/모델·병렬·통합·되돌림 설명·증거', () => {
    const h = renderNight({ manifests: RICH_MANIFESTS, verifications: RICH_VERIF, metrics: RICH_METRICS, evidence: [{ story: '4-3', dir: 'C:/state/archive/x-evidence/4-3' }] })
    assert.match(h, /④ 지난밤 배치/)
    assert.match(h, /병렬 2폭 · 워크트리 분리/)
    assert.match(h, /통합 게이트 통과/)
    assert.match(h, /통합 게이트 되돌림/)
    assert.match(h, /Claude \/ opus/)
    assert.match(h, /Codex \/ gpt-5\.6-sol/)
    assert.match(h, /qa GREEN/)
    assert.match(h, /리뷰 high 1/)
    assert.match(h, /따로는 통과했는데 합치니 실패했습니다/)
    assert.match(h, /1e83363/)
    assert.match(h, /푸시 안 함/)
    assert.match(h, /수리 라운드 1/)
    assert.match(h, /38,400tok/)
    assert.match(h, /1시간 36분/) // 96분
    assert.match(h, /x-evidence/)
  })
  test('⑤ 오늘 예정 — 편성 방식·검증 경고·배정 이유·LLM·병렬 짝', () => {
    const h = renderQueue(RICH_QUEUE, { assign: new Map([['11-5', { avoid: [{ provider: 'codex', role: 'dev', failStreak: 2 }] }]]) })
    assert.match(h, /⑤ 오늘 밤 예정/)
    assert.match(h, /2배치 · 3스토리/)
    assert.match(h, /편성 방식 · 자동 편성/)
    assert.match(h, /검증 경고 1건/)
    assert.match(h, /선행 4-2 이 done 이 아닌데/)
    assert.match(h, /빠진 스토리 1건/)
    assert.match(h, /병렬 짝 · 파일 겹침 없음/)
    assert.match(h, /Codex \/ gpt-5\.6-sol/)
    assert.match(h, /회수\(review\)/)
    assert.match(h, /Codex dev 연속 실패 2회/)
  })
  test('⑥ 계측 — 지표 6 + 모델 호출량 · 3열 · 추세', () => {
    const h = renderMetrics(richTable, { historyMissing: false, badLines: 0 })
    assert.match(h, /⑥ 얼마나 잘 돌았나 \(지난 3일 · 하루 단위\)/)
    for (const label of ['순차 대비 절약 추정', '병렬 효율', '유휴', '첫 시도 통과율', '리뷰 결함 high', '통합 실패율', '모델 호출량']) {
      assert.match(h, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    assert.match(h, /지난 1일/)
    assert.match(h, /지난 3일/)
    assert.match(h, /배치 없음/) // 3일째는 비었다
    assert.match(h, /50\.0%/) // 통합 실패율 2 중 1
    assert.match(h, /2 중 1/)
  })
  test('⑦ 자율 진단 — 5분류 · 7단계 · 배포 차단 · 확인 못 함', () => {
    const h = renderDiagnosis({ diagnosis: RICH_DIAG, backlog: RICH_BACKLOG, readiness: RICH_READY, report: RICH_REPORT })
    assert.match(h, /⑦ 자율 마무리 진단/)
    assert.match(h, /배포 차단 1건/)
    assert.match(h, /부분 완료/)
    assert.match(h, /테스트 부족|회귀·테스트 누락/)
    assert.match(h, /비밀정보 노출·데이터 손실·인증/)
    assert.match(h, /아직 배포하면 안 됩니다/)
    assert.match(h, /확인 못 한 것 1건/)
  })
  test('⑧ 3열 재료 — 값이 있으면 on=true', () => {
    const x = storyExtras({ verifications: RICH_VERIF, assignByStory: new Map([['2-16', { rounds: 2 }]]) })
    assert.equal(x.hasAny, true)
    assert.equal(x.map['2-18'].worker, 'Claude / opus')
    assert.equal(x.map['2-18'].reviewer, 'Codex')
    assert.equal(x.map['2-16'].rounds, '2')
  })
  test('티커 1칸', () => {
    assert.match(renderVerdictTick(RICH_VERDICT), /배포 판정 <b style="color:var\(--orange\)">RED/)
  })
})

// ── 빈손 ────────────────────────────────────────────────────────────────────
describe('빈손 — 예외 0 · 「없음」 · 「GREEN」 부재', () => {
  const verdict = deployVerdict({})
  const emptyTable = dailyMetrics({ history: [], now: NOW })
  const blocks = () => [
    renderHero({ verdict, heartbeat: { state: 'none', label: '러너 로그 없음', why: 'slots.log 가 없습니다' }, lastNight: [], inbox: null, queue: null, blockers: 0 }),
    renderInbox(miss('/x/DECISIONS-INBOX.md')),
    renderNight({ manifests: [], verifications: [], metrics: [], evidence: [] }),
    renderQueue(miss('/x/auto-queue-*.json')),
    renderMetrics(emptyTable, { historyMissing: true }),
    renderDiagnosis({ diagnosis: miss('/x/diagnosis.json'), backlog: miss('/x/backlog.json'), readiness: miss('/x/readiness.json'), report: miss('/x/report.json') }),
  ]

  test('예외 없이 6블록이 다 나온다', () => {
    const html = blocks().join('')
    assert.ok(html.length > 500)
  })
  test('판정은 「판정 불가」이고 어디에도 GREEN 이 없다', () => {
    const html = blocks().join('')
    assert.equal(verdict.level, 'unknown')
    assert.match(html, /판정 불가/)
    assert.ok(!/GREEN/.test(html), 'GREEN 이라는 낱말이 나오면 안 된다')
    assert.ok(!/b-verdict green/.test(html))
    assert.match(html, /b-verdict unknown/)
  })
  test('블록마다 「없음」 계열 문구가 있다', () => {
    const [hero, inbox, night, queue, metrics, diag] = blocks()
    assert.match(hero, /러너 로그 없음/)
    assert.match(inbox, /아직 없습니다/)
    assert.match(night, /지난밤 배치 기록이 없습니다/)
    assert.match(queue, /18:00 편성 전입니다/)
    assert.match(metrics, /계측 이력.*아직 없습니다/)
    assert.match(diag, /자율 마무리 진단을 아직 돌리지 않았습니다/)
    assert.match(diag, /상한은 「조건부」/)
  })
  test('계측 표는 전 칸 —(배치 없음)', () => {
    const h = renderMetrics(emptyTable, { historyMissing: false })
    assert.match(h, /배치 없음/)
    assert.ok(!/\d+\.\d%/.test(h), '값이 없는데 퍼센트를 그리면 안 된다')
  })
  test('⑧ 3열 재료가 없으면 on=false — 열을 안 그린다', () => {
    assert.equal(storyExtras({ verifications: [], assignByStory: new Map() }).hasAny, false)
    assert.equal(storyExtras({ verifications: [{ story: 'x', workers: {}, review: null }], assignByStory: new Map() }).hasAny, false)
  })
})

// ── 손상 ────────────────────────────────────────────────────────────────────
describe('손상 — 「읽지 못했습니다」 + 원문 경로 · 추측 렌더 없음', () => {
  test('renderError 3종', () => {
    assert.match(renderError({ file: '/a/b.json', why: '파일이 없습니다', kind: 'missing' }), /아직 없습니다/)
    assert.match(renderError({ file: '/a/b.json', why: 'x', kind: 'broken' }), /읽지 못했습니다/)
    assert.match(renderError({ file: '/a/b.json', why: 'x', kind: 'schema' }), /알 수 없는 형식입니다/)
    assert.match(renderError({ file: '/a/b.json', why: 'x', kind: 'broken' }), /\/a\/b\.json/)
    assert.equal(renderError(null), '')
  })
  test('인박스·큐가 손상이면 그 블록만 사유를 적고 나머지는 정상', () => {
    const inbox = renderInbox(broken('/x/DECISIONS-INBOX.md'))
    const queue = renderQueue(broken('/x/auto-queue-2026-09-03.json'))
    const night = renderNight({ manifests: RICH_MANIFESTS, verifications: RICH_VERIF, metrics: RICH_METRICS })
    assert.match(inbox, /읽지 못했습니다/)
    assert.match(inbox, /DECISIONS-INBOX\.md/)
    assert.match(queue, /읽지 못했습니다/)
    assert.match(queue, /auto-queue-2026-09-03\.json/)
    assert.match(night, /AUTO-1/) // 옆 블록은 멀쩡하다
  })
  test('깨진 이력 줄이 있으면 몇 줄을 건너뛰었는지 적는다', () => {
    const h = renderMetrics(dailyMetrics({ history: [], now: NOW }), { historyMissing: false, badLines: 3 })
    assert.match(h, /읽지 못한 줄 3개는 건너뛰었습니다/)
  })
  test('진단 파일만 손상이면 회색 안내 + 상한 문구', () => {
    const h = renderDiagnosis({ diagnosis: broken('/x/diagnosis.json'), backlog: miss('/x/b.json'), readiness: miss('/x/r.json'), report: miss('/x/rep.json') })
    assert.match(h, /자율 마무리 진단을 아직 돌리지 않았습니다/)
    assert.match(h, /diagnosis\.json/)
  })
})

describe('안전', () => {
  test('HTML 이스케이프 — 원장 문자열이 태그로 새지 않는다', () => {
    const h = renderInbox(val({
      pending: [{ title: '<img src=x onerror=alert(1)>', summary: '"a" & <b>', ageDays: 1, old: false }],
      gates: [], ack: [], closed: 0,
    }))
    assert.ok(!/<img src=x/.test(h))
    assert.match(h, /&lt;img src=x/)
    assert.equal(esc('<&">'), '&lt;&amp;&quot;&gt;')
  })
  test('CSS 는 목업 토큰만 쓰고 빨강을 새로 만들지 않는다', () => {
    assert.match(BATCH_CSS, /var\(--orange\)/)
    assert.match(BATCH_CSS, /var\(--green\)/)
    assert.ok(!/#(ef4444|dc2626|ff0000|f00\b)/i.test(BATCH_CSS), '빨강 신설 금지 — RED 는 주황 채움')
    // 기존 build.mjs 클래스(.chip · .it · .row · .sec3)와 이름이 겹치지 않는다
    for (const cls of ['\\.chip\\{', '\\.it\\{', '\\.row\\{', '\\.sec3\\{', '\\.tag\\{']) {
      assert.ok(!new RegExp(cls).test(BATCH_CSS.replace(/\s/g, '')), '클래스 충돌: ' + cls)
    }
  })
})
