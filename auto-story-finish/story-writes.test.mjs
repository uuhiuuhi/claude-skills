// 원장 쓰기 순수 변환 테스트 — CRLF 보존 · Tasks 절 안 삽입 · 상태 줄 치환.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendDecisionsInbox, appendDeferredWork, countOpenFindings, insertReviewFindings, setSprintStatus, setStoryStatus } from './story-writes.mjs'
import { openFindings, readStorySignals } from '../night-batch-ops/engine/story-ledger.mjs'

const MD = '---\nbaseline_commit: abc\n---\n\n# Story 2.3: 제목\n\nStatus: review <!-- 주석 -->\n\n## Tasks / Subtasks\n\n- [x] Task 1\n- [ ] Task 2\n\n### Review Findings\n\n- [x] [Review][Patch] 옛것 — ✅ 해소\n\n## Dev Notes\n\n내용\n\n## Dev Agent Record\n'

describe('[story-writes] Review Findings 삽입 — Tasks 절 끝(다음 ## 앞) · 편성기가 일감으로 센다', () => {
  it('블록이 Dev Notes 앞에 들어가고 미완 일감이 늘어난다', () => {
    const out = insertReviewFindings(MD, '### Review Findings — Codex\n\n- [ ] [Review][Patch][high] 새것 [a.ts:1] — d')
    const tasksEnd = out.indexOf('## Dev Notes')
    const at = out.indexOf('### Review Findings — Codex')
    assert.ok(at > 0 && at < tasksEnd, '블록이 Tasks 절 안이어야 한다')
    assert.ok(out.indexOf('- [x] [Review][Patch] 옛것') < at, '기존 라운드 뒤에 append')
    assert.equal(readStorySignals(MD).unfinishedTasks, 1)
    assert.equal(readStorySignals(out).unfinishedTasks, 2)
    assert.equal(readStorySignals(out).openPatches, 1)
    assert.ok(/새것 \[a\.ts:1\] — d\n\n## Dev Notes/.test(out), '절 사이 빈 줄 유지')
  })
  it('Tasks 절이 없으면 파일 끝에 ### Review Findings 를 연다', () => {
    const out = insertReviewFindings('# S\n\n## Dev Notes\n\nx\n', 'BLOCK')
    assert.ok(out.endsWith('## Dev Notes\n\nx\n\n### Review Findings\n\nBLOCK\n'))
  })
  it('CRLF 파일이면 삽입 블록도 CRLF(Windows 파일 교훈)', () => {
    const crlf = MD.replace(/\n/g, '\r\n')
    const out = insertReviewFindings(crlf, 'L1\nL2')
    assert.ok(out.includes('L1\r\nL2\r\n\r\n## Dev Notes'))
    assert.ok(!/[^\r]\n/.test(out), 'LF 단독 개행이 섞이면 안 된다')
  })
})

describe('[story-writes] 상태 줄 — 주석·다른 줄 보존', () => {
  it('스토리 Status: 첫 줄만 · 뒤 주석 보존 · 없으면 changed=false', () => {
    const r = setStoryStatus(MD, 'in-progress')
    assert.equal(r.changed, true)
    assert.ok(r.text.includes('Status: in-progress <!-- 주석 -->'))
    assert.equal(setStoryStatus('# no status\n', 'done').changed, false)
  })
  it('sprint-status: 해당 키 한 줄 + last_updated 값만 · STATUS DEFINITIONS 등 주석 불변 · 없는 키는 changed=false', () => {
    const yaml = '# STATUS DEFINITIONS\n#   review: 리뷰 대기\nlast_updated: 2026-09-01  # 어제 메모\ndevelopment_status:\n  epic-2: in-progress\n  2-3-시각-타임라인: review  # 12차 리뷰\n  2-30-x: backlog\n'
    const r = setSprintStatus(yaml, '2-3-시각-타임라인', 'done', '2026-09-02')
    assert.equal(r.changed, true)
    assert.ok(r.text.includes('  2-3-시각-타임라인: done  # 12차 리뷰'))
    assert.ok(r.text.includes('last_updated: 2026-09-02  # 어제 메모'))
    assert.ok(r.text.includes('#   review: 리뷰 대기'), '정의 주석 불변')
    assert.ok(r.text.includes('  2-30-x: backlog'))
    assert.equal(setSprintStatus(yaml, '2-3', 'done').changed, false, '접두사 일치는 키 일치가 아니다')
    assert.equal(setSprintStatus(yaml, '9-9-없음', 'done').changed, false)
  })
})

describe('[story-writes] 열린 findings 사본 — story-ledger.openFindings 와 결과가 같아야 한다(단일 소스 사본 동기)', () => {
  it('굵게·들여쓰기·[x] 제외 픽스처 전부 동일', () => {
    const fx = [
      '- [ ] [Review][Patch] a\n- [ ] **[Review][Patch][high]** b\n  - [ ] _[Review][Decision]_ c\n- [x] [Review][Patch] d ✅\n',
      '- [ ] [Review][Defer] e\n',
      '',
      '- [ ] [Review][Patch]x\n- [ ]  [Review][Patch] y\n',
    ]
    for (const t of fx) for (const tag of ['Patch', 'Decision']) assert.equal(countOpenFindings(t, tag), openFindings(t, tag), `${tag}: ${JSON.stringify(t)}`)
    assert.equal(countOpenFindings(fx[0], 'Patch'), 2)
    assert.equal(countOpenFindings(fx[0], 'Decision'), 1)
  })
})

describe('[story-writes] 결정 인박스 등재 — H1 아래 맨 위 · 스토리 번호(2.3) 포함(편성기 규칙 2 인박스 검사)', () => {
  it('appendDecisionsInbox', () => {
    const inbox = '# 결정 인박스\n\n## ✅ 확정 — 옛것 (등재 2026-09-01)\n\n- x\n'
    const out = appendDecisionsInbox(inbox, { storyKey: '2-3-시각-타임라인', date: '2026-09-02', decisions: ['A 를 택할까 — 상세 [a.ts:1]', 'B'] })
    const lines = out.split('\n')
    assert.equal(lines[0], '# 결정 인박스')
    assert.ok(lines[2].startsWith('## 🟠 결정 대기 — Story 2.3 Codex 교차리뷰(무인 배치) Decision 2건 (등재 2026-09-02'))
    assert.ok(out.includes('- A 를 택할까 — 상세 [a.ts:1]\n- B\n'))
    assert.ok(out.indexOf('## 🟠 결정 대기') < out.indexOf('## ✅ 확정 — 옛것'))
    assert.ok(out.includes('2.3'))
    assert.equal(appendDecisionsInbox(inbox, { storyKey: '2-3', date: 'd', decisions: [] }), inbox)
    const noH1 = appendDecisionsInbox('- 첫 줄\n', { storyKey: '1-1-x', date: 'd', decisions: ['q'] })
    assert.ok(noH1.startsWith('## 🟠 결정 대기 — Story 1.1'))
  })
})

describe('[story-writes] deferred-work 추가 — step-04 제목 형식', () => {
  it('절 하나 append · 빈 목록이면 무변경', () => {
    const out = appendDeferredWork('# Deferred\n\n## 옛 절\n\n- a\n', 'Deferred from: Codex code review of 2-3 (2026-09-02)', ['x [a.ts:1] — d'])
    assert.ok(out.endsWith('## 옛 절\n\n- a\n\n## Deferred from: Codex code review of 2-3 (2026-09-02)\n\n- x [a.ts:1] — d\n'))
    assert.equal(appendDeferredWork('T\n', 'h', []), 'T\n')
  })
})
