// backlog.test.mjs — 작업항목화·우선순위·보수 범주·실패 6분류 테스트(설계 §9-1 `backlog` 항목).
//
// 실행: node --test night-batch-ops/engine/backlog.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeProject, FIXTURE_STORY_KEYS } from './fixtures/fake-bmad-project.mjs'
import { readProject, diagnose, FINDING_TIER } from './diagnose.mjs'
import { parallelHazardsExtended } from './conflicts.mjs'
import {
  BACKLOG_SCHEMA, TIERS, CONSERVATIVE_RULES, NO_AUTO_FIX_KINDS, FAILURE_KINDS, ENV_EXITS,
  hazardOptsFor, priorityOf, toWorkItems, buildBacklog, mergeBacklog, selectRunnable, classifyFailure, tierLabel,
} from './backlog.mjs'

const K = FIXTURE_STORY_KEYS
const GREEN = { qa: { exit: 0, ms: 10, source: 'gate' } }

// 실제 git 픽스처는 비싸다 — 이 파일은 스냅숏을 **한 번만** 만들어 돌려 쓴다(전부 읽기 전용).
let CACHE = null
function fixture() {
  if (CACHE) return CACHE
  const fx = createFakeProject()
  const snapshot = readProject(fx.root)
  fx.cleanup() // 스냅숏은 순수 데이터라 폴더가 없어도 된다
  CACHE = { snapshot, diagnosis: diagnose(snapshot, { gates: GREEN }) }
  return CACHE
}
const backlog = () => { const { diagnosis, snapshot } = fixture(); return buildBacklog({ diagnosis, snapshot }) }

// ═══════════════════════════════════════════════════════════════════════════
// A. 7단계 우선순위
// ═══════════════════════════════════════════════════════════════════════════

test('TIERS 는 1~7 단계가 빠짐없이·중복 없이 있다', () => {
  assert.deepEqual(TIERS.map((t) => t.tier), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(new Set(TIERS.map((t) => t.id)).size, 7)
  assert.ok(TIERS.every((t) => t.label && t.why))
  assert.equal(tierLabel(1), '비밀정보 노출·데이터 손실·인증/보안')
  assert.equal(tierLabel(99), '분류 밖')
})

test('tier 배정은 배타 — 진단이 내는 모든 kind 가 정확히 한 단계로 간다', () => {
  const { diagnosis } = fixture()
  const seen = new Map()
  for (const f of diagnosis.findings) {
    const { tier } = priorityOf(f, {})
    assert.ok(tier >= 1 && tier <= 7, `${f.kind} 의 tier 가 범위 밖: ${tier}`)
    if (seen.has(f.kind)) assert.equal(seen.get(f.kind), tier, `${f.kind} 가 두 단계로 갈렸다`)
    seen.set(f.kind, tier)
  }
  assert.ok(seen.size >= 8, `표본이 너무 적다(${seen.size}종)`)
  // 표에 등록된 kind 도 전부 1~7 안이다(오탈자로 undefined 가 되면 전부 7 로 밀린다)
  for (const [kind, tier] of Object.entries(FINDING_TIER)) {
    assert.ok(tier >= 1 && tier <= 7, `${kind} → ${tier}`)
  }
})

test('시크릿은 kind 가 무엇이든 항상 tier 1 로 올라간다', () => {
  assert.equal(priorityOf({ kind: 'secret-value', severity: 'high', path: 'src/a.ts' }).tier, 1)
  assert.equal(priorityOf({ kind: 'temp-code', severity: 'low', path: '.env.production' }).tier, 1, '비밀 경로의 tier 7 지적이 안 올라갔다')
  assert.equal(priorityOf({ kind: 'orphan-doc', severity: 'low', path: 'credentials/notes.md' }).tier, 1)
  // 공개 견본은 예외 — 이름만 적는 파일이라 위반이 아니다
  assert.equal(priorityOf({ kind: 'temp-code', severity: 'low', path: '.env.example' }).tier, 7)
  assert.match(priorityOf({ kind: 'temp-code', severity: 'low', path: '.env.production' }).why, /tier 1/)
})

test('score 는 tier 우선 · 같은 tier 면 심각도 · 봉쇄는 뒤로 민다', () => {
  const t1 = priorityOf({ kind: 'secret-value', severity: 'high' }).score
  const t4 = priorityOf({ kind: 'open-patch', severity: 'high' }).score
  assert.ok(t1 > t4, 'tier 1 이 tier 4 보다 앞서야 한다')
  const hi = priorityOf({ kind: 'open-patch', severity: 'high' }).score
  const lo = priorityOf({ kind: 'open-patch', severity: 'low' }).score
  assert.ok(hi > lo)
  const blocked = priorityOf({ kind: 'open-patch', severity: 'high' }, { blocked: true }).score
  assert.ok(blocked < hi, '사람 판단 대기는 뒤로 밀려야 한다')
})

// ═══════════════════════════════════════════════════════════════════════════
// B. 보수 범주(병렬 금지)
// ═══════════════════════════════════════════════════════════════════════════

test('보수 범주 6종은 전부 mode any — 한 스토리만 만져도 병렬 불가', () => {
  assert.equal(CONSERVATIVE_RULES.length, 6)
  assert.ok(CONSERVATIVE_RULES.every((r) => r.mode === 'any'), 'mode 가 any 가 아닌 보수 범주가 있다')
  assert.deepEqual(CONSERVATIVE_RULES.map((r) => r.id), ['secret-external', 'auth-permission', 'billing-payment', 'db-change', 'deploy-config', 'shared-core'])
})

test('결제 경로가 한 건이라도 있으면 parallelOk=false (요구 시나리오)', () => {
  const opts = hazardOptsFor([])
  const r = parallelHazardsExtended([['src/features/contracts/billingApi.ts']], opts)
  assert.equal(r.parallelOk, false)
  assert.ok(r.reasons.some((x) => x.category === 'billing-payment'), `범주가 안 잡혔다: ${JSON.stringify(r.reasons)}`)
  assert.match(r.why, /결제·청구/)
})

test('보수 범주별 대표 경로가 각각 단독으로 병렬을 막는다', () => {
  const opts = hazardOptsFor([])
  const cases = [
    ['secret-external', '.env.production'],
    ['secret-external', 'src/outbox/send.ts'],
    ['auth-permission', 'src/auth/session.ts'],
    ['auth-permission', 'supabase/migrations/20260101_tickets_permissions.sql'],
    ['billing-payment', 'src/features/billing/BillingMonthPage.tsx'],
    ['db-change', 'supabase/migrations/20260201000000_x.sql'],
    ['deploy-config', 'wrangler.jsonc'],
    ['deploy-config', 'tools/deploy/preflight.mjs'],
    ['shared-core', 'src/lib/routes.ts'],
    ['shared-core', 'src/App.tsx'],
  ]
  for (const [expected, path] of cases) {
    const r = parallelHazardsExtended([[path]], opts)
    assert.equal(r.parallelOk, false, `${path} 가 병렬 허용으로 나왔다`)
    assert.ok(r.reasons.some((x) => x.category === expected), `${path} → ${expected} 이어야 하는데 ${r.reasons.map((x) => x.category)}`)
  }
})

test('평범한 화면 파일 한 건은 병렬 가능 · 마이그레이션은 db-change 하나로만 센다(중복 계상 금지)', () => {
  const opts = hazardOptsFor([])
  assert.equal(parallelHazardsExtended([['src/features/tickets/TicketList.tsx']], opts).parallelOk, true)
  const r = parallelHazardsExtended([['supabase/migrations/a.sql'], ['supabase/migrations/b.sql']], opts)
  const cats = r.reasons.map((x) => x.category)
  assert.ok(cats.includes('db-change'))
  assert.ok(!cats.includes('migration'), 'conflicts.migration 과 db-change 가 같은 사유를 두 번 셌다')
})

test('공유 장부(sprint-status·deferred·INBOX)는 겹침에서 뺀다', () => {
  const opts = hazardOptsFor([])
  const shared = '_bmad-output/implementation-artifacts/sprint-status.yaml'
  const r = parallelHazardsExtended([[shared, 'src/features/a/x.tsx'], [shared, 'src/features/b/y.tsx']], opts)
  assert.equal(r.parallelOk, true, `공유 장부로 충돌 판정이 났다: ${r.why}`)
})

// ═══════════════════════════════════════════════════════════════════════════
// C. 작업항목화
// ═══════════════════════════════════════════════════════════════════════════

test('스토리에 매인 지적은 스토리 단위로 묶고, 나머지는 kind 단위로 묶는다', () => {
  const { diagnosis, snapshot } = fixture()
  const items = toWorkItems(diagnosis, snapshot)
  const storyItems = items.filter((i) => i.storyLink === 'existing')
  assert.equal(new Set(storyItems.map((i) => i.story)).size, storyItems.length, '같은 스토리로 항목이 두 개 생겼다')
  for (const key of [K.noFileList, K.openPatch, K.openDecision, '3-1']) {
    assert.ok(items.some((i) => i.story === key), `${key} 항목이 없다`)
  }
  assert.ok(!items.some((i) => i.story === K.ok), 'verified-done 스토리는 항목이 되면 안 된다')
  const kindItems = items.filter((i) => i.story === null)
  assert.ok(kindItems.length > 0)
  assert.ok(kindItems.every((i) => i.storyLink === 'new' || i.storyLink === 'defect'))
})

test('WorkItem 은 SPEC §2 의 12항목을 모두 채운다', () => {
  const items = toWorkItems(fixture().diagnosis, fixture().snapshot)
  const need = ['id', 'fingerprint', 'title', 'purpose', 'userImpact', 'epic', 'story', 'storyLink', 'acceptance', 'tier', 'score', 'risk', 'riskFlags', 'difficulty', 'deps', 'parallelOk', 'conflictReasons', 'gates', 'tests', 'assignee', 'source', 'state']
  for (const i of items) for (const k of need) assert.ok(k in i, `${i.id} 에 ${k} 가 없다`)
  const patch = items.find((i) => i.story === K.openPatch)
  assert.ok(patch.acceptance.some((a) => /Patch/.test(a)))
  assert.ok(patch.acceptance.some((a) => /qa/.test(a)))
  assert.ok(patch.gates.includes('qa'), `게이트 목록이 프로젝트 실물과 다르다: ${patch.gates}`)
  assert.ok(patch.title.startsWith(K.openPatch))
})

test('구현자와 리뷰어는 서로 다른 제공자다(SPEC §4)', () => {
  const { diagnosis, snapshot } = fixture()
  for (const cfg of [null, { providers: { codex: { enabled: true, model: 'gpt-5-codex' } } }]) {
    for (const i of toWorkItems(diagnosis, snapshot, { config: cfg })) {
      assert.ok(i.assignee.dev.provider && i.assignee.review.provider)
      const same = i.assignee.dev.provider === i.assignee.review.provider
      const sameModel = i.assignee.dev.model === i.assignee.review.model
      assert.ok(!(same && sameModel), `${i.id}: 구현자와 리뷰어가 같다(${i.assignee.dev.provider}/${i.assignee.dev.model})`)
    }
  }
})

test('자동 수리 금지 범주(이월 금지 5범주)는 autoFixAllowed=false 로 표시한다', () => {
  const { diagnosis, snapshot } = fixture()
  const items = toWorkItems(diagnosis, snapshot)
  const decision = items.find((i) => i.story === K.openDecision)
  assert.equal(decision.autoFixAllowed, false, '열린 Decision 을 무인 수리 대상으로 뒀다')
  const secret = items.find((i) => i.title.includes('열쇠'))
  assert.equal(secret.autoFixAllowed, false)
  assert.ok(NO_AUTO_FIX_KINDS.includes('open-decision') && NO_AUTO_FIX_KINDS.includes('secret-value'))
})

// ═══════════════════════════════════════════════════════════════════════════
// D. 백로그 조립 · 합치기 · 선택
// ═══════════════════════════════════════════════════════════════════════════

test('buildBacklog — tier 순 정렬 · 봉쇄 목록 · 병렬 판정이 붙는다', () => {
  const b = backlog()
  assert.equal(b.schema, BACKLOG_SCHEMA)
  for (let i = 1; i < b.items.length; i++) assert.ok(b.items[i - 1].tier <= b.items[i].tier, '우선순위 정렬이 깨졌다')
  assert.deepEqual(b.blocked.map((x) => x.key), [K.openDecision])
  assert.equal(b.items.find((i) => i.story === K.openDecision).state, 'blocked')
  assert.equal(b.counts.total, b.items.length)
  const secret = b.items.find((i) => i.tier === 1)
  assert.ok(secret, 'tier 1 항목(코드에 박힌 열쇠)이 없다')
  assert.equal(secret.parallelOk, false, '시크릿·공용 경로 항목이 병렬 허용으로 나왔다')
  assert.ok(secret.conflictReasons.length > 0)
})

test('id·fingerprint 는 같은 진단이면 완전히 같다(라운드 간 추적의 열쇠)', () => {
  const a = backlog()
  const b = backlog()
  assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id))
  assert.deepEqual(a.items.map((i) => i.fingerprint), b.items.map((i) => i.fingerprint))
  assert.equal(a.fingerprint, b.fingerprint)
  assert.ok(a.items.every((i) => /^W-[0-9a-f]{10}$/.test(i.id)))
})

test('mergeBacklog — 사라진 항목은 closed 로 남기고 살아남은 항목은 id 를 승계한다', () => {
  const prev = { ...backlog(), round: 0 }
  const nextItems = prev.items.slice(1)
  const next = { ...backlog(), round: 1, at: '2026-09-03T00:00:00.000Z', items: nextItems }
  const m = mergeBacklog(prev, next)
  assert.equal(m.closed.length, 1)
  assert.equal(m.closed[0].id, prev.items[0].id)
  assert.equal(m.closed[0].state, 'closed')
  assert.match(m.closed[0].closedWhy, /해소/)
  assert.deepEqual(m.items.map((i) => i.id), nextItems.map((i) => i.id), 'id 승계가 깨졌다')
  assert.equal(m.counts.carried, nextItems.length)
  assert.equal(m.counts.closed, 1)
  // prev 가 없으면 그대로 통과
  assert.deepEqual(mergeBacklog(null, next).closed, [])
})

test('selectRunnable — cap · 봉쇄 · 완료를 제외하고 우선순위대로 고른다', () => {
  const b = backlog()
  const two = selectRunnable(b, { cap: 2 })
  assert.equal(two.length, 2)
  assert.equal(two[0].id, b.items[0].id)
  assert.ok(two.every((i) => i.state !== 'blocked'))
  // 봉쇄된 스토리는 그 스토리만 빠지고 나머지는 계속 돈다(무인 결정 규칙 ②)
  const all = selectRunnable(b, { cap: 99 })
  assert.ok(!all.some((i) => i.story === K.openDecision), '봉쇄 스토리가 실행 후보에 남았다')
  assert.ok(all.some((i) => i.story === K.openPatch), '봉쇄 하나가 다른 항목까지 멈췄다')
  // 이미 끝난 스토리 제외
  const minus = selectRunnable(b, { cap: 99, doneKeys: [K.openPatch] })
  assert.ok(!minus.some((i) => i.story === K.openPatch))
  // 바깥에서 넘긴 봉쇄도 먹는다
  assert.ok(!selectRunnable(b, { cap: 99, blocked: [K.noFileList] }).some((i) => i.story === K.noFileList))
  assert.deepEqual(selectRunnable(b, { cap: 0 }), [])
})

// ═══════════════════════════════════════════════════════════════════════════
// E. 실패 6분류
// ═══════════════════════════════════════════════════════════════════════════

test('classifyFailure — 6종 대표 로그를 각각 제 갈래로 보낸다', () => {
  const cases = [
    ['env(종료코드)', { stage: 'dev', exit: 5, qaLog: '무언가 터짐' }, 'env'],
    ['env(한도)', { stage: 'dev', exit: 1, qaLog: 'Error: usage limit reached for opus' }, 'env'],
    ['env(인증)', { stage: 'create', exit: 1, qaLog: 'You are not logged in. Please run `claude login`.' }, 'env'],
    ['code(타입)', { stage: 'qa', exit: 1, qaLog: 'src/a.ts(12,3): error TS2345: 인자 형식이 다르다' }, 'code'],
    ['code(빌드)', { stage: 'qa', exit: 1, qaLog: 'error during build:\nRollup failed to resolve import' }, 'code'],
    ['test', { stage: 'qa', exit: 1, qaLog: ' FAIL  tests/feature/a.test.ts\nAssertionError: expected 1 to be 2' }, 'test'],
    ['security', { stage: 'gate', gate: 'security', exit: 1, qaLog: 'rls policy check failed' }, 'security'],
    ['performance', { stage: 'gate', gate: 'performance', exit: 1, qaLog: 'p95 1200ms > 800ms' }, 'performance'],
    ['integration', { stage: 'integration', exit: 1, qaLog: ' FAIL tests/db/x.test.ts' }, 'integration'],
  ]
  for (const [label, input, expected] of cases) {
    const r = classifyFailure(input)
    assert.equal(r.kind, expected, `${label} → ${r.kind}`)
    assert.ok(FAILURE_KINDS.includes(r.kind))
    assert.ok(r.signature.length > 0)
    assert.ok(typeof r.retry === 'boolean' && r.action)
  }
  assert.deepEqual([...ENV_EXITS], [2, 5, 6])
})

test('classifyFailure — 자동 수리 여부와 처방이 설계 §4-3 대로 붙는다', () => {
  assert.equal(classifyFailure({ exit: 2 }).retry, false)
  assert.match(classifyFailure({ exit: 2 }).action, /재실행 금지/)
  assert.equal(classifyFailure({ gate: 'security', exit: 1 }).retry, false)
  assert.match(classifyFailure({ gate: 'security', exit: 1 }).action, /자동 수리 금지/)
  assert.equal(classifyFailure({ stage: 'integration', exit: 1 }).retry, false)
  assert.match(classifyFailure({ stage: 'integration', exit: 1 }).action, /rollback.*STOP/)
  assert.equal(classifyFailure({ stage: 'qa', exit: 1, qaLog: 'FAIL tests/a.test.ts' }).retry, true)
})

test('classifyFailure — 같은 원인이면 서명이 같고, 다른 파일이면 다르다', () => {
  const a = classifyFailure({ stage: 'qa', exit: 1, qaLog: 'src/a.ts(1,1): error TS2345: x' })
  const b = classifyFailure({ stage: 'qa', exit: 1, qaLog: 'src/a.ts(99,7): error TS2345: y' })
  const c = classifyFailure({ stage: 'qa', exit: 1, qaLog: 'src/b.ts(1,1): error TS2345: x' })
  assert.equal(a.signature, b.signature, '줄·열 번호가 서명을 흔들면 반복 실패를 못 센다')
  assert.notEqual(a.signature, c.signature)
})

test('classifyFailure — scope 는 로그·매니페스트에서 실제 파일 경로를 모은다', () => {
  const r = classifyFailure({
    stage: 'qa', exit: 1,
    qaLog: ' FAIL  tests/feature/a.test.ts\n  at src/feature/a.ts:12',
    manifest: { files: ['src/feature/a.ts'] },
  })
  assert.ok(r.scope.includes('src/feature/a.ts'))
  assert.ok(r.scope.includes('tests/feature/a.test.ts'))
  assert.equal(new Set(r.scope).size, r.scope.length, 'scope 에 중복이 있다')
})
