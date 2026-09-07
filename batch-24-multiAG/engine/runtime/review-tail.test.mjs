// 리뷰 꼬리 정책(review-tail.mjs) — 👤 2026-09-07 「리뷰 횟수 최적화」
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyReviewTail, applyReviewTailBlock } from './review-tail.mjs'

const md = (block, nl = '\n') => [
  '# 스토리', 'Status: review', '', '## Tasks / Subtasks', '- [x] **Task 1** 끝', '', '### Review Findings', '',
  '## Review Findings — 2차 (2026-09-05)', '- [ ] [Review][Patch][low] 지난 라운드 열린 것 [src/old.ts:1]', '',
  block, '', '### File List', '- `src/a.ts`', '', '## Dev Notes', '- [ ] [Review][Patch] Dev Notes 안의 줄은 대상 아님', '',
].join(nl)
const round3 = [
  '## Review Findings — 3차 (2026-09-07 · 비대화형 배치)',
  '- [ ] [Review][Decision] 문구 A — ⭐추천 (a)',
  '- [ ] **[Review][Patch]** 심각도 없는 지적 [src/a.ts:10] — 상세',
  '- [ ] [Review][Patch][medium] 정렬 흔들림 [src/b.ts:20] — 상세',
  '- [ ] [Review][Patch][low] 변수명 [src/c.ts:30]',
  '- [ ] [Review][Patch][high] 저장 실패 문구 없음 [src/d.ts:40]',
  '- [ ] [Review][Patch][low] RLS 정책이 회사 경계를 안 본다 [supabase/x.sql:5]',
  '- [x] [Review][Defer] 기존 문제 [src/e.ts:1] — ⏭️ deferred, pre-existing',
  '```',
  '- [ ] [Review][Patch][low] 펜스 안 예시',
  '```',
].join('\n')

describe('applyReviewTail — N차부터 high 외 열린 Patch 를 ⏭️ Defer 로 닫는다', () => {
  it('3차(기본 fromRound 3): 미표기=medium·medium·low 이월 · high·5범주(RLS) 유지 · Decision·펜스·이전 라운드·Dev Notes 는 손대지 않는다', () => {
    const r = applyReviewTail(md(round3), { round: 3, date: '2026-09-07', story: '2-1-a' })
    assert.equal(r.applied, true)
    assert.equal(r.deferred.length, 3)
    assert.deepEqual(r.kept.map((k) => k.why), ['high', '이월 금지 5범주'])
    assert.match(r.text, /^- \[x\] ~~\*\*\[Review\]\[Patch\]\*\* 심각도 없는 지적 \[src\/a\.ts:10\] — 상세~~ — ⏭️ Defer\(리뷰 꼬리 정책 · 3차 · 2026-09-07 · deferred-work 이관\)$/m)
    assert.match(r.text, /^- \[x\] ~~\[Review\]\[Patch\]\[medium\] 정렬 흔들림.*⏭️ Defer/m)
    assert.match(r.text, /^- \[x\] ~~\[Review\]\[Patch\]\[low\] 변수명.*⏭️ Defer/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[high\] 저장 실패 문구 없음/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] RLS 정책이/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Decision\] 문구 A/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 지난 라운드 열린 것/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 펜스 안 예시/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\] Dev Notes 안의 줄은 대상 아님/m)
    assert.match(r.deferred[0], /심각도 미표기=medium/)
    assert.match(r.deferred[1], /· medium\)$/)
    assert.match(r.why, /3차 · ⏭️ 이월 3건 · high\/5범주 유지 2건/)
  })
  it('2차는 전 심각도 회수(무변경) · fromRound 0 = 끔 · 리뷰 헤딩 없으면 무변경', () => {
    const two = applyReviewTail(md(round3), { round: 2, date: '2026-09-07' })
    assert.equal(two.applied, false); assert.equal(two.text, md(round3)); assert.match(two.why, /2차 < 시작 라운드 3/)
    const off = applyReviewTail(md(round3), { round: 9, fromRound: 0 })
    assert.equal(off.applied, false); assert.match(off.why, /꺼짐/)
    const none = applyReviewTail('# s\nStatus: review\n## Tasks\n- [ ] [Review][Patch][low] x\n', { round: 5 })
    assert.equal(none.applied, false); assert.match(none.why, /헤딩 없음/)
  })
  it('이월 대상 0건(high 만)이면 applied=false · CRLF 원문은 CRLF 로 돌려준다', () => {
    const onlyHigh = md('## Review Findings — 4차 (x)\n- [ ] [Review][Patch][high] 막아야 함 [a:1]')
    const r = applyReviewTail(onlyHigh, { round: 4 })
    assert.equal(r.applied, false); assert.equal(r.kept.length, 1); assert.match(r.why, /이월 대상 0건/)
    const crlf = applyReviewTail(md(round3, '\r\n'), { round: 3, date: 'd' })
    assert.equal(crlf.applied, true)
    assert.ok(crlf.text.includes('\r\n'))
    assert.equal(crlf.text.split('\r\n').length, crlf.text.split('\n').length, 'lone LF 없음')
  })
})

const B3 = String.fromCharCode(96).repeat(3), B4 = String.fromCharCode(96).repeat(4)
describe('applyReviewTail — Codex 교차리뷰 1차 회수(H2 · M4 · M6) + 블록 모드(M3)', () => {
  it('H2: 강조 기호·공백 뒤의 심각도도 읽는다 — **[Review][Patch]**[high] 는 유지 · **[Review][Patch]** [low] 는 이월', () => {
    const md = ['# s', 'Status: review', '## Tasks', '## Review Findings — 3차 (x)',
      '- [ ] **[Review][Patch]**[high] AC 결과가 틀리다 [a:1]',
      '- [ ] **[Review][Patch]** [low] 사소 [b:2]',
      '- [ ] __[Review][Patch]__[medium] 중간 [c:3]', ''].join('\n')
    const r = applyReviewTail(md, { round: 3, date: 'd' })
    assert.deepEqual(r.kept.map((k) => k.why), ['high'])
    assert.equal(r.deferred.length, 2)
    assert.match(r.deferred[0], /· low\)$/); assert.match(r.deferred[1], /· medium\)$/)
    assert.match(r.text, /^- \[ \] \*\*\[Review\]\[Patch\]\*\*\[high\] AC 결과가 틀리다/m)
  })
  it('M4: 블록 끝 = 같거나 얕은 깊이의 다음 헤딩 — ### Review 뒤의 ### Replan/회수 라운드 줄은 손대지 않는다 · ## Review 안의 ### 소절은 포함', () => {
    const md = ['# s', '## Tasks', '### Review Findings — Codex 교차리뷰 (3차)', '- [ ] [Review][Patch][low] 리뷰 지적 [a:1]',
      '### Replan 2026-09-07', '- [ ] [Review][Patch][low] replan 이 연 회수 일감 [b:2]', '## Dev Notes', ''].join('\n')
    const r = applyReviewTail(md, { round: 3, date: 'd' })
    assert.equal(r.deferred.length, 1)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] replan 이 연 회수 일감/m)
    const h2 = ['# s', '## Tasks', '## Review Findings — 3차', '### 독립 검증', '- [ ] [Review][Patch][low] 소절 안 [a:1]', '## Dev Notes', '- [ ] [Review][Patch][low] 밖 [b:2]', ''].join('\n')
    const r2 = applyReviewTail(h2, { round: 3, date: 'd' })
    assert.equal(r2.deferred.length, 1); assert.match(r2.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 밖/m)
  })
  it('M6: 4백틱 펜스 안의 3백틱 예시는 펜스를 닫지 않는다 · ~~~ 펜스도 같다', () => {
    const md = ['# s', '## Tasks', '## Review Findings — 3차', B4 + 'md', '예시:', B3, '- [ ] [Review][Patch][low] 펜스 안 예시 [a:1]', B3, B4,
      '- [ ] [Review][Patch][low] 진짜 지적 [b:2]', '~~~', '- [ ] [Review][Patch][low] 물결 펜스 안 [c:3]', '~~~', ''].join('\n')
    const r = applyReviewTail(md, { round: 3, date: 'd' })
    assert.equal(r.deferred.length, 1); assert.match(r.deferred[0], /진짜 지적/)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 펜스 안 예시/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 물결 펜스 안/m)
  })
  it('M3: applyReviewTailBlock — 삽입 전 렌더 블록 전체에 적용(파일 순서 무관) · 2차는 무변경', () => {
    const block = ['### Review Findings — Codex 교차리뷰 (2026-09-07 · 3차 · codex exec · gpt-6-astra)', '', '> 출처 = …', '',
      '- [ ] [Review][Patch][medium] 정렬 [a:1] — 상세', '- [ ] [Review][Patch][high] 저장 실패 [b:2] — 상세', '- [x] [Review][Defer] 기존 [c:3] — ⏭️ deferred, pre-existing'].join('\n')
    const r = applyReviewTailBlock(block, { round: 3, date: 'd', story: 's' })
    assert.equal(r.applied, true); assert.equal(r.deferred.length, 1); assert.deepEqual(r.kept.map((k) => k.why), ['high'])
    assert.match(r.text, /^- \[x\] ~~\[Review\]\[Patch\]\[medium\] 정렬 \[a:1\] — 상세~~ — ⏭️ Defer\(리뷰 꼬리 정책 · 3차 · d · deferred-work 이관\)$/m)
    assert.equal(applyReviewTailBlock(block, { round: 2 }).applied, false)
  })
})

describe('applyReviewTail — Codex 2차 검증 회수(H1 continuation · M3 before 대조 · M5 헤딩 관용)', () => {
  it('H1: 들여쓴 이어지는 줄까지 지적 전문으로 5범주를 판정하고 이월 원장에도 전문을 싣는다', () => {
    const md = ['# s', '## Tasks', '## Review Findings — 3차', '- [ ] [Review][Patch][medium] 필터가 틀리다 [a:1]', '  → 결과적으로 다른 회사 개인정보가 노출된다',
      '- [ ] [Review][Patch][medium] 정렬 [b:2]', '  세부: 날짜 내림차순이어야 한다', '- [ ] [Review][Patch][low] 다음 항목 [c:3]', ''].join('\n')
    const r = applyReviewTail(md, { round: 3, date: 'd', story: 's' })
    assert.deepEqual(r.kept.map((k) => k.why), ['이월 금지 5범주'])
    assert.equal(r.deferred.length, 2)
    assert.match(r.deferred[0], /정렬 \[b:2\] 세부: 날짜 내림차순이어야 한다 — ⏭️/)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[medium\] 필터가 틀리다/m)
  })
  it('M3: before 를 주면 새로 생긴 헤딩(파일 순서상 앞쪽)을 이번 블록으로 고른다 · 없으면 마지막 헤딩', () => {
    const before = ['# s', '## Tasks', '### Review Findings', '## Dev Notes', '## Review Findings — 2차', '- [ ] [Review][Patch][low] 옛 지적 [a:1]', ''].join('\n')
    const after = ['# s', '## Tasks', '### Review Findings', '### Review Findings — 3차 (bmad-code-review)', '- [ ] [Review][Patch][low] 새 지적 [b:2]', '## Dev Notes', '## Review Findings — 2차', '- [ ] [Review][Patch][low] 옛 지적 [a:1]', ''].join('\n')
    const r = applyReviewTail(after, { round: 3, date: 'd', before })
    assert.equal(r.deferred.length, 1); assert.match(r.deferred[0], /새 지적/)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 옛 지적/m)
    const noBefore = applyReviewTail(after, { round: 3, date: 'd' })
    assert.match(noBefore.deferred[0], /옛 지적/)
  })
  it('M5: 앞 공백·탭 구분 헤딩(  ### Replan · ###<탭>Replan)도 블록 경계다 · 닫는 # 붙은 골격 앵커는 라운드가 아니다', () => {
    const md = ['# s', '## Tasks', '### Review Findings — 3차', '- [ ] [Review][Patch][low] 리뷰 지적 [a:1]', '  ### Replan 2026-09-07', '- [ ] [Review][Patch][low] 회수 일감 A [b:2]', ''].join('\n')
    const r = applyReviewTail(md, { round: 3, date: 'd' })
    assert.equal(r.deferred.length, 1); assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 회수 일감 A/m)
    const tab = md.replace('  ### Replan', '###\tReplan')
    const r2 = applyReviewTail(tab, { round: 3, date: 'd' })
    assert.equal(r2.deferred.length, 1); assert.match(r2.text, /^- \[ \] \[Review\]\[Patch\]\[low\] 회수 일감 A/m)
    const anchorOnly = ['# s', '## Tasks', '### Review Findings ###', '- [ ] [Review][Patch][low] x [a:1]', ''].join('\n')
    assert.match(applyReviewTail(anchorOnly, { round: 3 }).why, /헤딩 없음/)
  })
})

describe('applyReviewTail — Codex 3차 H1: 중첩 불릿·빈 줄 뒤 들여쓴 문단도 지적 전문이다', () => {
  it('중첩 불릿의 「개인정보」·빈 줄 뒤 문단의 「보안」이 5범주를 살린다 · 단순 medium 은 이월되고 원장에 전문이 실린다', () => {
    const md = ['# s', '## Tasks', '## Review Findings — 3차',
      '- [ ] [Review][Patch][medium] 필터가 틀리다 [a:1]', '  - 결과: 다른 회사 개인정보 노출',
      '- [ ] [Review][Patch][medium] 헤더 누락 [b:2]', '', '  이 헤더가 없으면 보안 검사가 통과되지 않는다',
      '- [ ] [Review][Patch][medium] 정렬 [c:3]', '  - 세부: 날짜 내림차순', '', '  근거: AC 4', '',
      '- [ ] [Review][Patch][low] 마지막 [d:4]', ''].join('\n')
    const r = applyReviewTail(md, { round: 3, date: 'd', story: 's' })
    assert.deepEqual(r.kept.map((k) => k.why), ['이월 금지 5범주', '이월 금지 5범주'])
    assert.equal(r.deferred.length, 2)
    assert.match(r.deferred[0], /정렬 \[c:3\] - 세부: 날짜 내림차순 근거: AC 4 — ⏭️/)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[medium\] 필터가 틀리다/m)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[medium\] 헤더 누락/m)
    assert.match(r.text, /^- \[x\] ~~\[Review\]\[Patch\]\[low\] 마지막/m)
  })
})
