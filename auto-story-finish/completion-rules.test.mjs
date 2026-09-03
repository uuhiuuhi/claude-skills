// completion-rules.test.mjs — 스토리 완료 기준 8조건 (설계 §9-1 completion-rules)
//
// 핵심 두 가지를 실물로 문다:
//   · 수리 라운드가 **새로 남긴** skip/only 는 경고가 아니라 차단이다(고치는 대신 끈 것).
//   · 완료 기록은 **매니페스트에 있는 수치만** 인용한다 — 없으면 지어내지 않고 `NOT VERIFIED` 라고 적는다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TASK_CRITERIA } from '../night-batch-ops/engine/readiness.mjs'
import {
  COMPLETION_CRITERIA, FAIL, NOT_READY, NOT_VERIFIED, NV, PASS, READY,
  blockingIntegrity, bmadStateAgreesWithCode, classifyTestCase, completionNotesAudit, crossReviewResult,
  newTestsFromDiff, renderCompletionNotes, reviewEvidenceCount, strengthenCompletion, testKindsVerdict,
} from './completion-rules.mjs'

// ── 재료 ─────────────────────────────────────────────────────────────────────
const manifest = (over = {}) => ({
  schema: 'auto-story-finish/verification/1',
  story: '2-1-패치-열림', generatedAt: '2026-09-03T01:02:03.000Z', branch: 'auto/2026-09-03', commit: 'abc123def456',
  workers: { dev: { provider: 'claude', model: 'opus' }, review: { provider: 'codex', model: 'gpt-5' } },
  checks: { qa: 'pass', typecheck: 'pass', lint: 'pass', unit: 'pass', build: 'pass', security: 'not-required', performance: 'not-required', integration: 'pass' },
  integrity: [], repair: { attempts: 0, signatures: [], exhausted: false },
  review: { provider: 'codex', model: 'gpt-5', result: 'clean', counts: { high: 0, patch: 0, decision: 0, defer: 0 }, readEvidence: 3 },
  ...over,
})

const DIFF_WITH_TEST = [
  'diff --git a/src/feature/c.ts b/src/feature/c.ts',
  '--- a/src/feature/c.ts',
  '+++ b/src/feature/c.ts',
  '@@ -10,2 +10,3 @@',
  '+  if (!ok) return toast("저장하지 못했습니다")',
  'diff --git a/tests/feature/c.test.ts b/tests/feature/c.test.ts',
  '--- a/tests/feature/c.test.ts',
  '+++ b/tests/feature/c.test.ts',
  '@@ -0,0 +1,6 @@',
  "+it('저장 실패 문구가 뜬다', () => {",
  '+  expect(render()).toContain("저장하지 못했습니다")',
  '+})',
  "+it('빈 입력이면 저장 버튼이 꺼진다', () => {",
  '+  expect(disabled()).toBe(true)',
  '+})',
  // (M2 · 2026-09-02 3차 리뷰) T2 는 이제 **정상·실패·경계 3유형**을 요구한다 — 기준선 픽스처를 강화한다.
  // 종전 두 건(정상 1 · 경계 1)만으로 ready 가 나던 것이 M2 가 고친 결함이다(완화가 아니라 강화).
  "+it('저장이 실패하면 rejects 로 error 를 던진다', async () => {",
  '+  await expect(save()).rejects.toThrow()',
  '+})',
].join('\n')

/** 유형이 모자란 diff — 정상 1건뿐(happy-path 한 건으로 ready 가 나던 M2 결함의 재현) */
const DIFF_HAPPY_ONLY = [
  'diff --git a/tests/feature/c.test.ts b/tests/feature/c.test.ts',
  '--- a/tests/feature/c.test.ts',
  '+++ b/tests/feature/c.test.ts',
  '@@ -0,0 +1,3 @@',
  "+it('저장하면 목록에 나타난다', () => {",
  '+  expect(list()).toHaveLength(1)',
  '+})',
].join('\n')

const DIFF_NO_TEST = [
  'diff --git a/src/feature/c.ts b/src/feature/c.ts',
  '--- a/src/feature/c.ts',
  '+++ b/src/feature/c.ts',
  '@@ -10,1 +10,2 @@',
  '+  const x = 1',
].join('\n')

const storyMd = ({ status = 'done', findings = '', notes = '' } = {}) => [
  '# Story 2.1: 패치 열림',
  '',
  `Status: ${status}`,
  '',
  '## Acceptance Criteria',
  '',
  '**AC-1 저장 실패 문구**',
  '',
  '### Review Findings',
  '',
  findings || '- [x] [Review][Patch] ~~정렬 불안정~~ — ✅ 해소(2026-09-03 · Task 2)',
  '',
  '## Dev Agent Record',
  '',
  '### Completion Notes List',
  '',
  notes,
  '',
  '### File List',
  '',
  '**수정 (1)**',
  '',
  '- `src/feature/c.ts`',
].join('\n')

const idOf = (c, id) => c.criteria.find((x) => x.id === id)

// ── 기준표 ───────────────────────────────────────────────────────────────────
describe('completion-rules — 기준표', () => {
  it('T1~T8 의 번호와 순서가 판정표(readiness) 와 정확히 같다 — 두 곳이 갈리면 같은 스토리를 다르게 읽는다', () => {
    assert.deepEqual(COMPLETION_CRITERIA.map((c) => c.id), TASK_CRITERIA.map((c) => c.id))
    for (const c of COMPLETION_CRITERIA) {
      const t = TASK_CRITERIA.find((x) => x.id === c.id)
      assert.equal(c.label, t.label, `${c.id} 라벨이 두 모듈에서 다르다`)
    }
  })

  it('전부 통과하는 매니페스트 + 테스트 붙은 변경 + 완료 기록이면 verdict 가 ready 다', () => {
    const m = manifest()
    const notes = renderCompletionNotes({ ...m, completion: { notVerified: [], counts: { pass: 8, fail: 0, notVerified: 0 }, verdict: READY, evidence: { newTests: { cases: 2, files: ['tests/feature/c.test.ts'] } } } })
    const c = strengthenCompletion({ manifest: m, storyText: storyMd({ notes }), diff: DIFF_WITH_TEST, sprintStatus: 'done' })
    assert.equal(c.verdict, READY, JSON.stringify(c.criteria.filter((x) => x.result !== PASS), null, 1))
    assert.equal(c.counts.pass, 8)
    assert.equal(c.schema, 'auto-story-finish/completion/1')
  })

  it('원본 매니페스트를 건드리지 않는다(순수) — completion 은 호출부가 붙인다', () => {
    const m = manifest()
    const before = JSON.stringify(m)
    strengthenCompletion({ manifest: m, storyText: storyMd(), diff: DIFF_WITH_TEST })
    assert.equal(JSON.stringify(m), before)
    assert.equal(m.completion, undefined)
  })
})

// ── T2 새 테스트 ─────────────────────────────────────────────────────────────
describe('completion-rules — T2 새 테스트', () => {
  it('실제 diff 에서 테스트 파일의 새 테스트를 세고 정상·실패·경계 유형을 판별한다', () => {
    const t = newTestsFromDiff(DIFF_WITH_TEST)
    assert.equal(t.measurable, true)
    assert.equal(t.cases, 3)
    assert.deepEqual(t.files, ['tests/feature/c.test.ts'])
    assert.deepEqual(t.kinds, { normal: 1, failure: 1, boundary: 1 })
  })

  it('테스트 없는 변경은 fail · diff 를 못 받았으면 fail 이 아니라 not-verified 다', () => {
    const noTest = strengthenCompletion({ manifest: manifest(), storyText: storyMd(), diff: DIFF_NO_TEST })
    assert.equal(idOf(noTest, 'T2').result, FAIL)
    const noDiff = strengthenCompletion({ manifest: manifest(), storyText: storyMd(), diff: '' })
    assert.equal(idOf(noDiff, 'T2').result, NOT_VERIFIED)
    assert.equal(newTestsFromDiff('').measurable, false)
    assert.deepEqual(newTestsFromDiff('').kinds, { normal: 0, failure: 0, boundary: 0 })
  })

  // (M2 · 2026-09-02 3차 리뷰) 종전 판정은 `cases > 0` 하나였다 — happy-path 한 건으로 ready 가 났다.
  it('happy-path 한 건뿐이면 PASS 가 아니라 not-verified 다 — 빠진 유형을 사유에 적는다', () => {
    const c = strengthenCompletion({ manifest: manifest(), storyText: storyMd(), diff: DIFF_HAPPY_ONLY })
    const t2 = idOf(c, 'T2')
    assert.equal(t2.result, NOT_VERIFIED, `T2 가 ${t2.result} 였다: ${t2.why}`)
    assert.match(t2.why, /실패/)
    assert.match(t2.why, /경계/)
    assert.notEqual(c.verdict, READY, '유형을 확인 못 했는데 ready 가 나왔다')
    // 같은 매니페스트에 3유형 diff 를 주면 T2 는 통과한다 = 위 not-verified 가 유형 판정 때문임을 증명(자기 RED)
    assert.equal(idOf(strengthenCompletion({ manifest: manifest(), storyText: storyMd(), diff: DIFF_WITH_TEST }), 'T2').result, PASS)
  })

  it('유형 판별은 이름과 본문을 함께 본다 — 실패 > 경계 > 정상 우선순위로 한 건은 한 유형', () => {
    assert.equal(classifyTestCase("it('저장한다', () => { expect(x).toBe(1) })"), 'normal')
    assert.equal(classifyTestCase("it('권한 없으면 denied', () => {})"), 'failure')
    assert.equal(classifyTestCase("it('빈 목록이어도 렌더된다', () => {})"), 'boundary')
    assert.equal(classifyTestCase("it('빈 입력이면 error 를 던진다', () => {})"), 'failure', '실패가 경계보다 우선')
    // 이름은 평범해도 본문의 단언에서 유형이 드러나는 경우
    assert.equal(classifyTestCase("it('저장', () => {})\n  await expect(save()).rejects.toThrow()"), 'failure')
  })

  it('3유형이 다 있으면 PASS 이고 사유에 유형별 건수를 적는다', () => {
    const [r, why] = testKindsVerdict(newTestsFromDiff(DIFF_WITH_TEST))
    assert.equal(r, PASS)
    assert.match(why, /정상 1/)
    assert.match(why, /실패 1/)
    assert.match(why, /경계 1/)
  })
})

// ── T5 무결성 ────────────────────────────────────────────────────────────────
describe('completion-rules — T5 수리 라운드가 만든 흔적', () => {
  it('수리 라운드가 새로 만든 skip 은 blocking 이다(수리 전 같은 경고는 아니다)', () => {
    const integrity = [{ level: 'warn', rule: 'test-skip', file: 'tests/feature/c.test.ts', line: 12, detail: 'skip 추가' }]
    const before = strengthenCompletion({ manifest: manifest({ integrity, repair: { attempts: 0, signatures: [] } }), storyText: storyMd(), diff: DIFF_WITH_TEST })
    assert.equal(idOf(before, 'T5').result, PASS)

    const after = strengthenCompletion({ manifest: manifest({ integrity, repair: { attempts: 2, signatures: ['vitest:c.test.ts', 'vitest:c.test.ts'] } }), storyText: storyMd(), diff: DIFF_WITH_TEST })
    assert.equal(idOf(after, 'T5').result, FAIL)
    assert.match(idOf(after, 'T5').why, /test-skip/)
    assert.equal(after.verdict, NOT_READY)
  })

  it('`(repair-introduced)` 로 이미 승격된 흔적은 수리 횟수와 무관하게 차단이고, 선재 흔적은 제외한다', () => {
    assert.equal(blockingIntegrity([{ level: 'warn', rule: 'test-only(repair-introduced)' }], { attempts: 0 }).length, 1)
    assert.equal(blockingIntegrity([{ level: 'warn', rule: 'test-skip', baseline: true }], { attempts: 3 }).length, 0)
    assert.equal(blockingIntegrity([{ level: 'block', rule: 'deleted-test' }], {}).length, 1)
    // 수리와 무관한 경고(삭제 사유 기재)는 차단이 아니다
    assert.equal(blockingIntegrity([{ level: 'warn', rule: 'deleted-test-justified' }], { attempts: 2 }).length, 0)
  })
})

// ── T6 교차 검토 ─────────────────────────────────────────────────────────────
describe('completion-rules — T6 교차 검토 제공자', () => {
  it('구현자와 검토자의 제공자가 같으면 미달이다', () => {
    const [r, why] = crossReviewResult(manifest({ review: { provider: 'claude', model: 'fable', result: 'clean', counts: { high: 0 }, readEvidence: 2 } }))
    assert.equal(r, FAIL)
    assert.match(why, /교차 검토가 아니다/)
  })

  it('제공자가 다르고 높음 0 이며 열람 증거가 있으면 통과 · 증거 0 이면 미달', () => {
    assert.equal(crossReviewResult(manifest())[0], PASS)
    assert.equal(crossReviewResult(manifest({ review: { provider: 'codex', result: 'clean', counts: { high: 0, patch: 0, decision: 0, defer: 0 } } }))[0], FAIL)
    assert.equal(reviewEvidenceCount({ counts: { patch: 2 } }), 2)
    assert.equal(reviewEvidenceCount(null), 0)
  })

  it('높음이 남아 있으면 미달 · 리뷰를 안 돌렸으면 미달이 아니라 not-verified', () => {
    assert.equal(crossReviewResult(manifest({ review: { provider: 'codex', result: 'findings', counts: { high: 1 }, readEvidence: 5 } }))[0], FAIL)
    assert.equal(crossReviewResult(manifest({ review: { provider: 'codex', result: 'not-run' } }))[0], NOT_VERIFIED)
    assert.equal(crossReviewResult(manifest({ review: null }))[0], NOT_VERIFIED)
  })

  // (M1 · 2026-09-02 3차 리뷰) 종전에는 `devP && revP` 가 false 면 그냥 흘러 열람 증거만으로 PASS 가 났다 —
  // 구형·부분 손상 매니페스트가 프로젝트를 ready 로 올렸다. 확인 못 한 것은 통과가 아니다.
  it('두 provider 중 하나라도 없으면 열람 증거가 있어도 PASS 가 아니라 not-verified 다', () => {
    const noRev = manifest({ review: { model: 'gpt-5', result: 'clean', counts: { high: 0 }, readEvidence: 4 } })
    const [r1, w1] = crossReviewResult(noRev)
    assert.equal(r1, NOT_VERIFIED, `검토자 provider 누락인데 ${r1} 이 나왔다`)
    assert.match(w1, /검토자\(review\.provider\)/)

    const noDev = manifest({ workers: { dev: { model: 'opus' }, review: { provider: 'codex' } } })
    const [r2, w2] = crossReviewResult(noDev)
    assert.equal(r2, NOT_VERIFIED, `구현자 provider 누락인데 ${r2} 이 나왔다`)
    assert.match(w2, /구현자\(workers\.dev\.provider\)/)

    const both = manifest({ workers: {}, review: { result: 'clean', counts: { high: 0 }, readEvidence: 2 } })
    assert.equal(crossReviewResult(both)[0], NOT_VERIFIED)

    // 전체 판정으로도 ready 가 아니다(완료 라인이 실제로 막힌다)
    const c = strengthenCompletion({ manifest: noRev, storyText: storyMd(), diff: DIFF_WITH_TEST })
    assert.equal(idOf(c, 'T6').result, NOT_VERIFIED)
    assert.notEqual(c.verdict, READY, '교차 검토를 확인 못 했는데 ready 가 나왔다')
  })
})

// ── T7 문서 = 코드 ───────────────────────────────────────────────────────────
describe('completion-rules — T7 BMAD 상태 = 코드 상태', () => {
  it('세 곳이 같으면 일치 · 원장과 문서가 다르면 불일치', () => {
    const ok = bmadStateAgreesWithCode({ storyText: storyMd({ status: 'done' }), sprintStatus: 'done', manifest: manifest() })
    assert.equal(ok.ok, true)
    const drift = bmadStateAgreesWithCode({ storyText: storyMd({ status: 'review' }), sprintStatus: 'done', manifest: manifest() })
    assert.equal(drift.ok, false)
    assert.match(drift.why, /다르다/)
  })

  it('열린 지적이 남았는데 done 이라고 적혀 있으면 불일치다(문서의 done 을 믿지 않는다)', () => {
    const text = storyMd({ status: 'done', findings: '- [ ] **[Review][Patch][high] 저장 실패 문구가 안 뜬다**' })
    const r = bmadStateAgreesWithCode({ storyText: text, sprintStatus: 'done', manifest: manifest() })
    assert.equal(r.ok, false)
    assert.equal(r.openPatch, 1)
    assert.match(r.why, /열린 지적 1건/)
    const c = strengthenCompletion({ manifest: manifest(), storyText: text, diff: DIFF_WITH_TEST, sprintStatus: 'done' })
    assert.equal(idOf(c, 'T7').result, FAIL)
  })

  it('Status 줄이 없거나 본문이 없으면 미달이 아니라 not-verified 다', () => {
    assert.equal(bmadStateAgreesWithCode({ storyText: '' }).ok, null)
    assert.equal(bmadStateAgreesWithCode({ storyText: '# Story 2.1\n\n내용만 있다' }).ok, null)
    const c = strengthenCompletion({ manifest: manifest(), storyText: '', diff: DIFF_WITH_TEST })
    assert.equal(idOf(c, 'T7').result, NOT_VERIFIED)
  })
})

// ── T8 완료 기록 ─────────────────────────────────────────────────────────────
describe('completion-rules — T8 완료 기록', () => {
  it('완료 기록이 매니페스트의 qa 수치를 인용값 그대로 적는다', () => {
    const md = renderCompletionNotes(manifest())
    assert.match(md, /검사\(qa\): pass/)
    assert.match(md, /typecheck=pass · lint=pass · unit=pass/)
    assert.match(md, /자동 수리: 0회/)
    assert.match(md, /abc123def456/)
    assert.ok(!md.includes('exit 0'), '매니페스트에 없는 수치를 지어냈다')
  })

  it('매니페스트에 값이 없으면 지어내지 않고 NOT VERIFIED 라고 적는다', () => {
    const m = manifest({ checks: { qa: null, typecheck: null, lint: null, unit: null, security: null, performance: null, integration: 'n/a(스크립트 없음)' }, repair: {}, review: null, commit: '' })
    const md = renderCompletionNotes(m)
    assert.match(md, new RegExp(`검사\\(qa\\): ${NV}`))
    assert.match(md, new RegExp(`교차 검토: ${NV}`))
    assert.match(md, new RegExp(`커밋: ${NV}`))
    assert.ok(!/: pass/.test(md), '없는 값을 통과로 적었다')
    assert.ok(md.includes(`**${NV}**`), '미검증 절이 없다')
  })

  it('렌더한 완료 기록을 그대로 스토리에 넣으면 T8 이 통과한다(왕복)', () => {
    const m = manifest()
    const notes = renderCompletionNotes(m)
    const audit = completionNotesAudit({ manifest: m, storyText: storyMd({ notes }) })
    assert.equal(audit.result, PASS, audit.why)
  })

  it('완료 기록 절이 없으면 미달 · 실측 인용이나 미검증 절이 빠져도 미달 · 본문이 없으면 not-verified', () => {
    const noSection = completionNotesAudit({ manifest: manifest(), storyText: '# Story 2.1\n\nStatus: done\n' })
    assert.equal(noSection.result, FAIL)
    assert.match(noSection.why, /완료 기록 절이 없다/)

    const noCite = completionNotesAudit({ manifest: manifest(), storyText: storyMd({ notes: '- 다 잘 됐습니다. NOT VERIFIED: 없음' }) })
    assert.equal(noCite.result, FAIL)
    assert.match(noCite.why, /실측 수치가 인용/)

    const noNv = completionNotesAudit({ manifest: manifest(), storyText: storyMd({ notes: '- 검사(qa): pass · 자동 수리: 0회' }) })
    assert.equal(noNv.result, FAIL)
    assert.match(noNv.why, /확인하지 못한 것/)

    assert.equal(completionNotesAudit({ manifest: manifest(), storyText: '' }).result, NOT_VERIFIED)
  })
})

// ── 게이트 ───────────────────────────────────────────────────────────────────
describe('completion-rules — 게이트 판정', () => {
  it('n/a·required-missing·unknown 은 전부 not-verified 이고 verdict 는 ready 가 못 된다', () => {
    const c = strengthenCompletion({
      manifest: manifest({ checks: { ...manifest().checks, security: 'required-missing(트리거됐으나 스크립트 없음)', integration: 'unknown(mock 통과는 통합 성공이 아니다)' } }),
      storyText: storyMd({ notes: renderCompletionNotes(manifest()) }), diff: DIFF_WITH_TEST, sprintStatus: 'done',
    })
    assert.equal(idOf(c, 'T4').result, NOT_VERIFIED)
    assert.equal(c.verdict, NOT_VERIFIED)
    assert.equal(c.counts.fail, 0)
    assert.ok(c.notVerified.some((n) => n.criterion === 'T4'))
  })

  it('사슬 중간이 실패면 T3 가 fail 이고 어느 단계인지 적는다', () => {
    const c = strengthenCompletion({ manifest: manifest({ checks: { ...manifest().checks, qa: 'fail', lint: 'fail', unit: 'not-run' } }), storyText: storyMd(), diff: DIFF_WITH_TEST })
    assert.equal(idOf(c, 'T3').result, FAIL)
    assert.match(idOf(c, 'T3').why, /문법/)
    assert.equal(idOf(c, 'T1').result, FAIL)
    assert.equal(c.verdict, NOT_READY)
  })
})
