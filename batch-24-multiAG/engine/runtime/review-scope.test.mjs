// 리뷰 diff 범위 좁히기 · 다른 스토리 소관 지적 분리(2026-10-02 5-18·4-18 오귀속 실사고)
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { computeReviewScope, dropFileSections, entryMatches, foreignScopeBrief, parseFileListLoose, pathHasStoryKey, safeReviewScope } from './review-scope.mjs'
import { routeForeignFindings, applyReviewTail } from './review-tail.mjs'
import { appendForeignDeferred, countOpenFindings } from './story-writes.mjs'
import { codexReviewPrompt, renderReviewFindings } from './providers/codex.mjs'
import { openFindings } from '../story-ledger.mjs'

const story = (files, extra = '') => `# Story\n\nStatus: in-progress\n\n## Tasks / Subtasks\n\n- [ ] T1\n\n${extra}### File List\n\n${files.map((f) => `- \`${f}\``).join('\n')}\n\n## Dev Notes\n\n없음\n`
const SPRINT = 'development_status:\n  4-20-contracts: in-progress\n  4-21-schedule: review\n  1-53-tickets: ready-for-dev\n  2-18-old: done\n  3-1-later: backlog\n  3-2-paused: deferred\n'
const STORIES = {
  '4-20-contracts': { text: story(['src/pages/ContractsPage.tsx', 'src/lib/contracts/']), file: '_bmad-output/implementation-artifacts/4-20-contracts.md' },
  '1-53-tickets': { text: story(['src/pages/TicketsPage.tsx']), file: '_bmad-output/implementation-artifacts/1-53-tickets.md' },
  '2-18-old': { text: story(['src/pages/Old.tsx']) },
  '3-1-later': { text: story(['src/pages/Later.tsx']) },
}
const readStory = (key) => (STORIES[key] ? { key, ...STORIES[key] } : null)
const scope = (files, o = {}) => computeReviewScope({ files, story: '4-21', ownKey: '4-21-schedule', ownText: story(['src/pages/SchedulePage.tsx', 'src/lib/schedule/']), sprintText: SPRINT, readStory, ...o })

describe('[review-scope] 정상 — 다른 활성 스토리 소유만 뺀다', () => {
  it('자기 File List 유지 · 다른 활성 스토리 소유 제외(owner 기록) · 미소유 유지', () => {
    const r = scope(['src/pages/SchedulePage.tsx', 'src/pages/ContractsPage.tsx', 'src/pages/TicketsPage.tsx', 'src/util/date.ts'])
    assert.deepEqual(r.kept, ['src/pages/SchedulePage.tsx', 'src/util/date.ts'])
    assert.deepEqual(r.excludedByOwner, [{ file: 'src/pages/ContractsPage.tsx', owner: '4-20-contracts' }, { file: 'src/pages/TicketsPage.tsx', owner: '1-53-tickets' }])
    assert.equal(r.fallback, null)
  })
  it('done·backlog·deferred 스토리의 File List 는 소유로 치지 않는다(남긴다)', () => {
    assert.deepEqual(scope(['src/pages/Old.tsx', 'src/pages/Later.tsx']).kept, ['src/pages/Old.tsx', 'src/pages/Later.tsx'])
  })
  it('자기 File List 와 다른 스토리 File List 가 겹치면 남긴다 · 다른 스토리의 스토리 md 자체는 그 스토리 소유', () => {
    const r = computeReviewScope({ files: ['src/pages/ContractsPage.tsx', '_bmad-output/implementation-artifacts/4-20-contracts.md'], story: '4-21', ownKey: '4-21-schedule', ownText: story(['src/pages/ContractsPage.tsx']), sprintText: SPRINT, readStory })
    assert.deepEqual(r.kept, ['src/pages/ContractsPage.tsx'])
    assert.deepEqual(r.excludedByOwner.map((e) => e.owner), ['4-20-contracts'])
  })
})

describe('[review-scope] 경계', () => {
  it('자기 스토리에 File List 가 없으면 키 경로·미소유만 남고 타 소유는 뺀다', () => {
    const r = scope(['src/pages/ContractsPage.tsx', 'tests/4-21-schedule.test.ts', 'src/x.ts'], { ownText: '# Story\n\nStatus: review\n' })
    assert.deepEqual(r.kept, ['tests/4-21-schedule.test.ts', 'src/x.ts'])
    assert.equal(r.excludedByOwner.length, 1)
  })
  it('sprint-status 가 없으면 좁히지 않는다(전체 범위 · fallback 사유)', () => {
    const r = scope(['src/pages/ContractsPage.tsx'], { sprintText: null })
    assert.deepEqual(r.kept, ['src/pages/ContractsPage.tsx'])
    assert.equal(r.fallback, 'sprint-status 없음')
  })
  it('경로에 스토리 키(4-21 · 4.21)가 든 새 파일은 다른 스토리 디렉터리 안이어도 남긴다 · 14-21·4-210 은 키가 아니다', () => {
    const r = scope(['src/lib/contracts/4.21-hook.ts', 'src/lib/contracts/helper.ts'])
    assert.deepEqual(r.kept, ['src/lib/contracts/4.21-hook.ts'])
    assert.deepEqual(r.excludedByOwner, [{ file: 'src/lib/contracts/helper.ts', owner: '4-20-contracts' }])
    assert.equal(pathHasStoryKey('tests/14-21-x.test.ts', '4-21-schedule'), false)
    assert.equal(pathHasStoryKey('tests/4-210-x.test.ts', '4-21-schedule'), false)
    assert.equal(pathHasStoryKey('tests/story_4_21.test.ts', '4-21'), true)
  })
  it('디렉터리 접두·글롭·역슬래시', () => {
    assert.equal(entryMatches('src/lib/contracts/', 'src/lib/contracts/a/b.ts'), true)
    assert.equal(entryMatches('src/lib/contracts', 'src/lib/contracts-old/b.ts'), false)
    assert.equal(entryMatches('src/**/*.sql', 'src/db/m/1.sql'), true)
    assert.equal(entryMatches('src\\pages\\A.tsx', 'src/pages/A.tsx'), true)
  })
  it('File List 파서 — ##/### 제목 · 백틱 · 설명 괄호 · 체크박스 · 역슬래시 · 펜스 무시 · 절 없음=null', () => {
    const md = '# S\n\n## File List (변경 파일)\n\n- `src/a.ts` — 설명\n- src\\b.ts (신규)\n- [x] `src/c.ts`\n```\n- src/fenced.ts\n```\n\n## Dev Notes\n- src/not.ts\n'
    assert.deepEqual(parseFileListLoose(md), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
    assert.equal(parseFileListLoose('# S\n\n## Dev Notes\n'), null)
  })
})

describe('[review-scope] 실패 경로 — 리뷰를 막지 않는다(fail-open)', () => {
  it('파싱 오류면 전체 범위 + 경고 1줄', () => {
    const warns = []
    const r = safeReviewScope({ files: ['a.ts', 'b.ts'], ownText: '', sprintText: { toString() { throw new Error('boom') } }, readStory }, (m) => warns.push(m))
    assert.deepEqual(r.kept, ['a.ts', 'b.ts'])
    assert.deepEqual(r.excludedByOwner, [])
    assert.equal(warns.length, 1)
    assert.match(warns[0], /종전 전체 범위/)
  })
  it('다른 스토리 하나를 못 읽으면 그 스토리만 건너뛴다(그 소유 파일은 남는다)', () => {
    const r = scope(['src/pages/ContractsPage.tsx', 'src/pages/TicketsPage.tsx'], { readStory: (k) => { if (k === '4-20-contracts') throw new Error('EACCES'); return readStory(k) } })
    assert.deepEqual(r.kept, ['src/pages/ContractsPage.tsx'])
    assert.deepEqual(r.excludedByOwner.map((e) => e.file), ['src/pages/TicketsPage.tsx'])
  })
})

describe('[review-scope] diff 본문에서 뺀 파일 절 들어내기 — 실제 git diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-scope-git-'))
  after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* OS 정리 */ } })
  const g = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  it('제외 파일은 본문 없이 표식 한 줄 · 나머지 파일 본문은 그대로', () => {
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false'])
    writeFileSync(join(dir, 'a.ts'), 'a1\n'); writeFileSync(join(dir, 'b.ts'), 'b1\n')
    g(['add', '-A']); g(['commit', '-q', '-m', 'init'])
    writeFileSync(join(dir, 'a.ts'), 'a2\n'); writeFileSync(join(dir, 'b.ts'), 'OTHER_STORY_BODY\n')
    const out = dropFileSections(g(['diff', 'HEAD']), (p) => p === 'b.ts', (p) => `[범위 밖: ${p}]`)
    assert.match(out, /^diff --git a\/a\.ts b\/a\.ts$/m)
    assert.match(out, /^\+a2$/m)
    assert.match(out, /^\[범위 밖: b\.ts\]$/m)
    assert.ok(!out.includes('OTHER_STORY_BODY'))
  })
})

describe('[review-scope] 계수 — [다른 스토리 소관] 표식 줄은 열린 지적이 아니다', () => {
  const MD = [
    '## Tasks / Subtasks', '- [x] T1', '',
    '### Review Findings — 3차 (2026-10-02 · bmad-code-review)',
    '- [ ] [Review][Patch][medium] 이 스토리 결함 [src/pages/SchedulePage.tsx:3] — 상세',
    '- [ ] [Review][Patch][high] [다른 스토리 소관: src/pages/ContractsPage.tsx] 계약 화면 정렬 [src/pages/ContractsPage.tsx:9] — 상세',
    '- [ ] **[Review][Decision]** 티켓 문구 [다른 스토리 소관: src/pages/TicketsPage.tsx] — 개인정보 노출 여부',
    '- [ ] [Review][Patch][low] 사소한 것 [다른 스토리 소관: src/x.ts]',
    '',
  ].join('\n')
  const owners = (p) => ({ 'src/pages/ContractsPage.tsx': '4-20-contracts', 'src/pages/TicketsPage.tsx': '1-53-tickets' })[p] ?? ''
  it('countOpenFindings · story-ledger.openFindings 둘 다 표식 줄을 세지 않는다', () => {
    assert.equal(countOpenFindings(MD, 'Patch'), 1)
    assert.equal(countOpenFindings(MD, 'Decision'), 0)
    assert.equal(openFindings(MD, 'Patch'), 1)
    assert.equal(openFindings(MD, 'Decision'), 0)
  })
  it('routeForeignFindings — 원장 가드 형식으로 닫고(소유·날짜) 5범주·high 는 guarded · 이 스토리 줄은 그대로', () => {
    const r = routeForeignFindings(MD, { date: '2026-10-03', ownerOf: owners })
    assert.equal(r.closed.length, 3)
    assert.deepEqual(r.closed.map((c) => [c.path, c.owner, c.guarded]), [
      ['src/pages/ContractsPage.tsx', '4-20-contracts', true],
      ['src/pages/TicketsPage.tsx', '1-53-tickets', true],
      ['src/x.ts', '소유 미상', false],
    ])
    assert.match(r.text, /^- \[x\] ~~\[Review\]\[Patch\]\[high\] \[다른 스토리 소관: src\/pages\/ContractsPage\.tsx\] 계약 화면 정렬 .*~~ — ⏭️ 다른 스토리 소관: src\/pages\/ContractsPage\.tsx\(이관 · 소유 4-20-contracts · 2026-10-03\)$/m)
    for (const l of r.text.split('\n').filter((x) => /^- \[x\] .*\[Review\]/.test(x))) assert.ok(/~~|✅|⏭️|❌/.test(l), `닫힘 기호 없음: ${l}`)
    assert.match(r.text, /^- \[ \] \[Review\]\[Patch\]\[medium\] 이 스토리 결함/m)
    assert.equal(countOpenFindings(r.text, 'Patch'), 1)
    assert.equal(routeForeignFindings(r.text, { date: '2026-10-04', ownerOf: owners }).closed.length, 0, '닫힌 줄은 다시 만지지 않는다')
  })
  it('리뷰 꼬리 정책은 표식 줄을 이 스토리 몫으로 이월하지 않는다', () => {
    const t = applyReviewTail(MD, { round: 3, fromRound: 3, date: '2026-10-03', story: '4-21-schedule' })
    assert.equal(t.deferred.length, 1)
    assert.match(t.deferred[0], /이 스토리 결함/)
  })
  it('appendForeignDeferred — 소유 스토리별 절 · 멱등(두 번 넣어도 한 번)', () => {
    const { closed } = routeForeignFindings(MD, { date: '2026-10-03', ownerOf: owners })
    const once = appendForeignDeferred('# Deferred Work\n', { storyKey: '4-21-schedule', date: '2026-10-03', source: 'bmad-code-review', items: closed })
    assert.match(once, /^## Deferred from: bmad-code-review of 4-21-schedule \(2026-10-03\) — 다른 스토리 소관\(소유 = 4-20-contracts\)$/m)
    assert.match(once, /^## Deferred from: .* — 다른 스토리 소관\(소유 = 1-53-tickets\)$/m)
    assert.match(once, /계약 화면 정렬 .* — ⏭️ 다른 스토리 소관\(소유 = 4-20-contracts · 출처 4-21-schedule · 2026-10-03 · 대상 src\/pages\/ContractsPage\.tsx\) ⚠ high\/이월 금지 5범주/)
    const twice = appendForeignDeferred(once, { storyKey: '4-21-schedule', date: '2026-10-04', source: 'bmad-code-review', items: closed })
    assert.equal(twice, once)
    assert.equal(appendForeignDeferred(once, { storyKey: 'x', items: [] }), once)
  })
})

describe('[review-scope] 지시문 · Codex 렌더러', () => {
  it('foreignScopeBrief — 표식 규칙은 항상 · 제외 목록은 있을 때만', () => {
    assert.match(foreignScopeBrief([]), /\[다른 스토리 소관: <경로>\]/)
    assert.ok(!foreignScopeBrief([]).includes('제외된 파일 목록'))
    assert.match(foreignScopeBrief([{ file: 'src/b.ts', owner: '2-2-b' }]), /제외된 파일 목록: src\/b\.ts\(2-2-b\)/)
  })
  it('codexReviewPrompt 에 표식 규칙(title 맨 앞)과 제외 목록이 실린다', () => {
    const p = codexReviewPrompt({ story: '4-21', storyFile: 's.md', diffFile: 'd.txt', changedFiles: ['src/a.ts'], excludedByOwner: [{ file: 'src/b.ts', owner: '4-20-contracts' }] })
    assert.match(p, /title 맨 앞에 `\[다른 스토리 소관: <경로>\]`/)
    assert.match(p, /src\/b\.ts\(4-20-contracts\)/)
  })
  it('renderReviewFindings — 표식 지적은 기재하되 high·상태·인박스 결정에서 뺀다', () => {
    const f = (o) => ({ lens: 'blind', severity: 'high', kind: 'patch', title: 't', file: 'src/b.ts', line: 1, detail: 'd', evidence: '', preExisting: false, ...o })
    const r = renderReviewFindings({ date: '2026-10-03', result: { findings: [f({ title: '[다른 스토리 소관: src/b.ts] 이웃 결함' }), f({ kind: 'decision', title: '[다른 스토리 소관: src/b.ts] 이웃 결정' })] } })
    assert.match(r.block, /\[다른 스토리 소관: src\/b\.ts\] 이웃 결함/)
    assert.equal(r.counts.high, 0)
    assert.equal(r.counts.patch, 0)
    assert.equal(r.newStatus, 'done')
    assert.deepEqual(r.decisions, [])
    const own = renderReviewFindings({ date: '2026-10-03', result: { findings: [f({ title: '이 스토리 결함' })] } })
    assert.equal(own.counts.high, 1)
    assert.equal(own.newStatus, 'in-progress')
  })
})
