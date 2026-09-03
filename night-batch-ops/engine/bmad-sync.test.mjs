// bmad-sync.test.mjs — BMAD 동기(설계 §9-1 `bmad-sync` 항목) 테스트.
//
// 실행: node --test night-batch-ops/engine/bmad-sync.test.mjs
//
// 스텁을 쓰지 않는다: **실제 임시 폴더 · 실제 git 저장소 · 실제 rename** 으로 돌린다.
// 「덮어쓰기 방지가 된다」는 주장은 실제로 파일을 고쳐 보고 0바이트 변화를 재 봐야 증거가 된다.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createFakeProject, FIXTURE_STORY_KEYS, FIXTURE_PATHS } from './fixtures/fake-bmad-project.mjs'
import { readProject, diagnose } from './diagnose.mjs'
import { buildBacklog } from './backlog.mjs'
import { readStorySignals, openFindings, parseSprint } from './story-ledger.mjs'
import {
  APPEND_ONLY_ANCHORS, DEFAULT_GUARDS, WRITE_OPS,
  anchorAllowed, applyBmadWrites, applyWriteToText, collectTexts, findHeadingLine, inferEpic, lineLoss,
  mapToStories, nextStoryNumber, pathAllowed, planBmadWrites, renderCompletionRecord, renderDefectBlock,
  renderEpicsEntry, renderNewStory, renderSprintEntry, sectionBody, slugify, storyKeyFor,
} from './bmad-sync.mjs'

const K = FIXTURE_STORY_KEYS
const IMPL = FIXTURE_PATHS.IMPL
const PLAN = FIXTURE_PATHS.PLAN
const GREEN = { qa: { exit: 0, ms: 10, source: 'gate' } }
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex')

/** 저장소 전체 파일 지문 — 「0바이트도 안 바뀌었다」를 증명할 때 쓴다(.git 제외). */
function fingerprintTree(root) {
  const out = new Map()
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(child)
      else if (e.isFile()) out.set(child, sha(readFileSync(join(root, child), 'utf8')))
    }
  }
  walk('')
  return out
}
const treeDiff = (a, b) => {
  const changed = []
  for (const [k, v] of b) if (a.get(k) !== v) changed.push(k)
  for (const k of a.keys()) if (!b.has(k)) changed.push(`(삭제) ${k}`)
  return changed.sort()
}

/** git 이 본 변경 경로 — 한글 경로가 8진 escape 로 나오지 않게 quotepath 를 끈다. */
function porcelainPaths(fx) {
  const out = fx.git(['-c', 'core.quotepath=false', 'status', '--porcelain']).stdout ?? ''
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/, '')).sort()
}

function project() {
  const fx = createFakeProject()
  const snapshot = readProject(fx.root)
  const diagnosis = diagnose(snapshot, { gates: GREEN })
  const backlog = buildBacklog({ diagnosis, snapshot })
  return { fx, snapshot, diagnosis, backlog }
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 번호·키·매핑
// ═══════════════════════════════════════════════════════════════════════════

test('nextStoryNumber 는 sprint ∪ epics ∪ md 파일 **세 출처의 합집합** 에서 max+1 을 낸다', () => {
  const { fx, snapshot } = project()
  try {
    // 픽스처 실측: epic 1 = sprint 1-1·1-2 + epics 1.1·1.2 + 고아 문서 1-9-…
    assert.equal(nextStoryNumber(1, snapshot), 10, '고아 문서 1-9 를 세지 않으면 3 이 나온다 — md 출처가 빠진 것')
    assert.equal(nextStoryNumber(2, snapshot), 3)
    // epic 3 은 sprint 에 없고 epics.md 에만 3.1 이 있다 → 계획 출처만으로 4 가 아니라 2
    assert.equal(nextStoryNumber(3, snapshot), 2, 'epics.md 만 있는 스토리도 번호를 차지한다')
    assert.equal(nextStoryNumber(9, snapshot), 1, '아무 것도 없는 에픽은 1 부터')

    // 출처를 하나씩 빼 보면 값이 내려간다 — 합집합이 진짜로 동작한다는 증거
    const noDocs = { ...snapshot, orphanStoryDocs: [] }
    assert.equal(nextStoryNumber(1, noDocs), 3)
    const noEpics = { ...snapshot, epicStories: [], epicOnly: [] }
    assert.equal(nextStoryNumber(3, noEpics), 1)
  } finally { fx.cleanup() }
})

test('storyKeyFor·slugify 는 한글을 살리고 40자로 자른다 · 결함은 접두사가 붙는다', () => {
  assert.equal(storyKeyFor({ epic: 11, num: 8, title: '계약 목록 — 등록·변경' }), '11-8-계약-목록-등록-변경')
  assert.equal(storyKeyFor({ epic: 2, num: 30, title: '저장 실패 문구', defect: true }), '2-30-결함-저장-실패-문구')
  assert.ok(slugify('가'.repeat(80)).length <= 40)
  assert.equal(slugify('`src/a.ts` 를 고친다'), 'src-a-ts-를-고친다'.slice(0, 40))
})

test('mapToStories — 원장에 있으면 기존 스토리에 붙이고, 없으면 새 스토리/결함, 에픽을 모르면 질문으로 뺀다', () => {
  const { fx, snapshot } = project()
  try {
    const items = [
      { id: 'W-1', story: K.openPatch, title: '리뷰 지적 회수', tier: 4, files: ['src/feature/c.ts'] },
      { id: 'W-2', story: '3-1', title: '이관 골격', tier: 4, files: [] }, // epics.md 에만 있는 스토리
      { id: 'W-3', story: null, epic: 1, title: '테스트 없는 파일에 테스트 추가', tier: 5, storyLink: 'new', files: [] },
      { id: 'W-4', story: null, epic: null, title: '열쇠가 코드에 박혀 있다', tier: 1, storyLink: 'defect', files: ['src/lib/strings.ts'] },
      { id: 'W-5', story: null, epic: null, title: '어디에도 속하지 않는 일', tier: 7, storyLink: 'new', files: ['docs/none.md'] },
    ]
    const m = mapToStories({ items, snapshot })
    assert.deepEqual(m.mapped.map((x) => x.key), [K.openPatch])
    assert.equal(m.newStories.length, 2)
    assert.ok(m.newStories.some((n) => n.epicsEntry === false && n.key.startsWith('3-1-')), 'epics 에만 있던 3.1 은 번호를 그대로 쓰고 epics 등재를 다시 하지 않는다')
    assert.equal(m.defects.length, 1, 'W-4 는 파일 경로로 에픽 1 을 추정해 결함 스토리가 된다')
    assert.equal(m.defects[0].epic, 1)
    assert.equal(m.unmappable.length, 1)
    assert.equal(m.unmappable[0].category, 'product-intent')
  } finally { fx.cleanup() }
})

test('inferEpic 은 File List 에 그 파일을 선언한 스토리의 에픽을 쓴다', () => {
  const { fx, snapshot } = project()
  try {
    assert.equal(inferEpic({ files: ['src/feature/c.ts'] }, snapshot), 2)
    assert.equal(inferEpic({ files: ['src/lib/strings.ts'] }, snapshot), 1)
    assert.equal(inferEpic({ files: ['nowhere/x.ts'] }, snapshot), null)
    assert.equal(inferEpic({ epic: 7, files: ['src/feature/c.ts'] }, snapshot), 7, '명시된 에픽이 추정을 이긴다')
  } finally { fx.cleanup() }
})

// ═══════════════════════════════════════════════════════════════════════════
// B. 렌더 — 만든 문서를 **기존 해석기가 읽는가**(왕복)
// ═══════════════════════════════════════════════════════════════════════════

test('renderDefectBlock 이 만든 줄을 story-ledger.openFindings 가 센다(원장 줄 형식)', () => {
  const block = renderDefectBlock({
    date: '2026-09-03', round: 1,
    findings: [
      { title: '저장 실패 문구가 안 뜬다', why: '실패 갈래에서 아무 말이 없다', severity: 'high', path: 'src/feature/c.ts', line: 12 },
      { title: '문구를 어느 쪽으로 할지 사람 판단', tag: 'Decision' },
    ],
  })
  assert.equal(openFindings(block, 'Patch'), 1)
  assert.equal(openFindings(block, 'Decision'), 1)
  assert.ok(!/- \[x\]/.test(block), '이 모듈은 닫힌 줄(- [x])을 만들지 않는다 — 닫는 것은 회수한 dev 의 몫')
})

test('renderNewStory 출력은 readStorySignals·parseFileList 가 읽는 형식이다', () => {
  const md = renderNewStory({ epic: 4, num: 9, title: '새 화면', baselineCommit: 'abc123', round: 1, tasks: ['재현', '수정'] })
  const sig = readStorySignals(md)
  assert.equal(sig.unfinishedTasks, 2, 'Tasks 절의 미완 항목이 일감으로 읽혀야 한다')
  assert.equal(sig.openPatches, 0)
  assert.equal(sig.openDecision, false)
  assert.match(md, /^baseline_commit: abc123$/m)
  assert.match(md, /^# Story 4\.9: 새 화면$/m)
  assert.match(md, /^Status: backlog$/m)
  for (const s of ['## Story', '## Acceptance Criteria', '## Tasks / Subtasks', '### Review Findings', '## Dev Notes', '### References', '## Dev Agent Record', '### Agent Model Used', '### Debug Log References', '### Completion Notes List', '### File List', '## Change Log']) {
    assert.ok(md.includes(`\n${s}\n`), `절 이름 누락: ${s}`)
  }
  assert.match(md, /생성 근거/, '어디서 왔는지 없는 스토리는 만들지 않는다')
})

test('renderSprintEntry·renderEpicsEntry 는 파서가 읽는 실물 형식이다', () => {
  const line = renderSprintEntry('11-9-새-스토리', 'backlog', '2026-09-03 자율 마무리 신설')
  const rows = parseSprint(`development_status:\n${line}\n`)
  assert.deepEqual(rows, [{ key: '11-9-새-스토리', status: 'backlog', epic: 11 }])
  const entry = renderEpicsEntry({ epic: 11, num: 9, title: '새 스토리', date: '2026-09-03' })
  assert.match(entry, /^### Story 11\.9: 새 스토리$/m)
  assert.match(entry, /^\*\*Acceptance Criteria:\*\*$/m)
  assert.match(entry, /^\*\*Then\*\* /m)
})

test('renderCompletionRecord 는 매니페스트 수치를 그대로 옮기고, 없으면 NOT VERIFIED 라고 적는다', () => {
  const withNums = renderCompletionRecord({
    date: '2026-09-03', round: 2, summary: '지적 3건 회수',
    manifest: { qa: { exit: 0, files: 215, passed: 6147, skipped: 81 }, checks: { qa: 'pass', security: 'n/a(스크립트 없음)' }, review: { provider: 'codex', model: 'codex', high: 0 }, workers: { dev: { provider: 'claude', model: 'opus' } } },
    files: { 신규: ['a'], 수정: ['b', 'c'] },
  })
  assert.match(withNums, /qa exit 0 \(215 files \/ 6147 passed \/ 81 skipped\)/)
  assert.match(withNums, /신규 1 · 수정 2/)
  assert.match(withNums, /codex\/codex \(dev = claude\/opus\)/)
  assert.match(withNums, /security: n\/a/, '없는 게이트는 NOT VERIFIED 절에 남는다')

  const noManifest = renderCompletionRecord({ date: '2026-09-03', round: 1 })
  assert.match(noManifest, /\*\*테스트\*\*: NOT VERIFIED/)
  assert.match(noManifest, /검증 매니페스트 없음/)
  assert.ok(!/\d+ passed/.test(noManifest), '실행하지 않은 수치를 지어내지 않는다')

  const noNums = renderCompletionRecord({ manifest: { checks: { qa: 'pass' } } })
  assert.match(noNums, /qa exit 0 — 통과 수치는 NOT VERIFIED/)
})

// ═══════════════════════════════════════════════════════════════════════════
// C. 가드 — 경로·앵커·줄 유실
// ═══════════════════════════════════════════════════════════════════════════

test('pathAllowed — `_bmad-output/` 밖·절대경로·상위참조를 거부한다', () => {
  assert.equal(pathAllowed('_bmad-output/implementation-artifacts/a.md').ok, true)
  assert.equal(pathAllowed('src/App.tsx').ok, false)
  assert.equal(pathAllowed('/etc/passwd').ok, false)
  assert.equal(pathAllowed('C:/Windows/system32/x').ok, false)
  assert.equal(pathAllowed('_bmad-output/../src/App.tsx').ok, false)
})

test('anchorAllowed — append-only 목록 밖(`## Acceptance Criteria`)은 거부한다', () => {
  for (const a of APPEND_ONLY_ANCHORS) assert.equal(anchorAllowed('append-within-section', a).ok, true, a)
  assert.equal(anchorAllowed('append-within-section', '### Story 11.7:').ok, true, 'epics 등재 자리는 허용')
  assert.equal(anchorAllowed('append-within-section', '## Acceptance Criteria').ok, false)
  assert.equal(anchorAllowed('append-within-section', '## Story').ok, false)
  assert.equal(anchorAllowed('insert-after-heading', '# 결정 인박스 (상시)').ok, true)
  assert.equal(anchorAllowed('insert-after-heading', '## Acceptance Criteria').ok, false)
})

test('lineLoss — 원문 줄이 사라지면 센다(덮어쓰기 탐지의 근거)', () => {
  assert.equal(lineLoss('a\nb\nc', 'a\nb\nx\nc'), 0)
  assert.equal(lineLoss('a\nb\nc', 'a\nc'), 1)
  assert.equal(lineLoss('a\nb\nc', '완전히 다른 내용'), 3)
})

test('앵커 밖 삽입은 계획 전체를 거부하고 파일을 0바이트도 바꾸지 않는다', () => {
  const { fx, snapshot } = project()
  try {
    const before = fingerprintTree(fx.root)
    const storyPath = `${IMPL}/${K.ok}.md`
    const texts = collectTexts(fx.root, [storyPath])
    const plan = {
      schema: 'x', writes: [{
        op: 'append-within-section', path: storyPath, anchor: '## Acceptance Criteria',
        baseHash: sha(texts[storyPath]), body: '- [ ] [Review][Patch] 몰래 끼워넣기',
      }],
      guards: DEFAULT_GUARDS,
    }
    const r = applyBmadWrites(plan, { root: fx.root })
    assert.equal(r.applied.length, 0)
    assert.equal(r.rolledBack, true)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].why, /append-only/)
    assert.deepEqual(treeDiff(before, fingerprintTree(fx.root)), [])
  } finally { fx.cleanup() }
})

test('`_bmad-output/` 밖 경로가 하나라도 있으면 나머지 정상 쓰기까지 전부 폐기한다', () => {
  const { fx, snapshot } = project()
  try {
    const before = fingerprintTree(fx.root)
    const storyPath = `${IMPL}/${K.ok}.md`
    const texts = collectTexts(fx.root, [storyPath])
    const plan = {
      writes: [
        { op: 'append-within-section', path: storyPath, anchor: '### Review Findings', baseHash: sha(texts[storyPath]), body: '- [ ] [Review][Patch] 정상 등재' },
        { op: 'create-file', path: 'src/hack.ts', body: 'export const x = 1\n', ifAbsent: true },
      ],
      guards: DEFAULT_GUARDS,
    }
    const r = applyBmadWrites(plan, { root: fx.root })
    assert.equal(r.applied.length, 0)
    assert.equal(r.rolledBack, true)
    assert.match(r.rejected[0].why, /허용 경로/)
    assert.deepEqual(treeDiff(before, fingerprintTree(fx.root)), [], '앞선 정상 쓰기도 들어가면 안 된다(부분 적용 0)')
    assert.equal(existsSync(join(fx.root, 'src/hack.ts')), false)
  } finally { fx.cleanup() }
})

// codex-review-r3 M3 — `pathAllowed()` 는 문자열 접두사만 봤다. `_bmad-output/implementation-artifacts`
// 가 바깥 폴더 junction 이면 경로는 여전히 `_bmad-output/…` 인데 실제 쓰기는 저장소 밖에서 일어난다.
// 스텁이 아니라 **실제 junction**(Windows `mklink /J` 와 같은 `fs.symlinkSync(…, 'junction')`)으로 문다.
test('M3 — `_bmad-output/implementation-artifacts` 가 바깥 폴더 junction 이면 쓰기를 거부하고 밖에 파일 0건', () => {
  const fx = createFakeProject()
  const outside = mkdtempSync(join(tmpdir(), 'bmad-outside-'))
  try {
    const linked = join(fx.root, '_bmad-output', 'implementation-artifacts')
    // 원래 폴더를 치우고 같은 이름을 바깥 폴더로 건다(실물 reparse point).
    rmSync(linked, { recursive: true, force: true })
    try {
      symlinkSync(outside, linked, 'junction')
    } catch (e) {
      // 링크를 만들 권한이 없는 환경에서는 이 시나리오를 검증할 수 없다 — 조용히 통과시키지 않는다.
      assert.fail(`junction 을 만들지 못해 M3 를 검증하지 못했다(NOT VERIFIED): ${e?.message ?? e}`)
    }
    assert.equal(lstatSync(linked).isSymbolicLink(), true, 'junction 이 실제로 걸리지 않았다')

    const target = `${IMPL}/침입.md`
    const r = applyBmadWrites({
      writes: [{ op: 'create-file', path: target, body: '바깥에 쓰면 안 된다\n', ifAbsent: true }],
      guards: DEFAULT_GUARDS,
    }, { root: fx.root })

    assert.equal(r.rolledBack, true, 'junction 을 타고 쓰기가 통과했다')
    assert.equal(r.applied.length, 0)
    assert.match(r.rejected[0].why, /링크|밖을 가리킨다/)
    assert.deepEqual(readdirSync(outside), [], '허용 폴더 밖에 파일이 생겼다')
    assert.equal(r.wrote.length, 0)
  } finally {
    try { rmSync(join(fx.root, '_bmad-output', 'implementation-artifacts'), { recursive: true, force: true }) } catch { /* 링크 정리 실패는 임시 폴더와 함께 사라진다 */ }
    fx.cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('M3 — 링크가 없는 정상 경로는 종전대로 쓴다(과잉 차단이 아님)', () => {
  const fx = createFakeProject()
  try {
    const target = `${IMPL}/정상-신규.md`
    const r = applyBmadWrites({
      writes: [{ op: 'create-file', path: target, body: '정상 경로\n', ifAbsent: true }],
      guards: DEFAULT_GUARDS,
    }, { root: fx.root })
    assert.equal(r.rolledBack, false, `정상 경로가 막혔다: ${JSON.stringify(r.rejected)}`)
    assert.equal(readFileSync(join(fx.root, target), 'utf8'), '정상 경로\n')
  } finally { fx.cleanup() }
})

test('Status 줄을 바꾸는 body 는 거부한다 — 상태 전이는 setStoryStatus 만 한다', () => {
  const { fx } = project()
  try {
    const storyPath = `${IMPL}/${K.ok}.md`
    const texts = collectTexts(fx.root, [storyPath])
    // Change Log 절에 붙이는 척하면서 Status 줄을 지운 본문을 만든다 — 실제로는 op 가 못 지우므로
    // 직접 텍스트 변환을 확인한다(줄 유실 가드가 잡는 경로).
    const broken = texts[storyPath].replace(/^Status: done$/m, 'Status: in-progress')
    assert.ok(lineLoss(texts[storyPath], broken) > 0)
  } finally { fx.cleanup() }
})

// ═══════════════════════════════════════════════════════════════════════════
// D. baseHash / sectionHash — 사람 변경 덮어쓰기 방지 (실제 rename)
// ═══════════════════════════════════════════════════════════════════════════

test('계획 도중 사람이 파일을 고치면 baseHash 불일치로 **전체 계획을 폐기**하고 0바이트도 안 바뀐다', () => {
  const { fx, snapshot, backlog } = project()
  try {
    const storyPath = `${IMPL}/${K.openPatch}.md`
    const otherPath = `${IMPL}/${K.ok}.md`
    const texts = collectTexts(fx.root, [storyPath, otherPath])
    const mapping = mapToStories({
      items: [
        { id: 'W-a', story: K.openPatch, title: '리뷰 지적 회수', tier: 4, files: ['src/feature/c.ts'] },
        { id: 'W-b', story: K.ok, title: '기록 채우기', tier: 5, files: [] },
      ],
      snapshot,
    })
    const plan = planBmadWrites({ mapping, snapshot, texts, round: 1, now: new Date('2026-09-03T00:00:00Z') })
    assert.equal(plan.writes.length, 2)

    // ← 여기서 사람이 스토리 파일을 고친다(실제 파일 수정)
    fx.write(storyPath, texts[storyPath] + '\n> 사람이 손으로 덧붙인 줄\n')
    const before = fingerprintTree(fx.root)

    const r = applyBmadWrites(plan, { root: fx.root })
    assert.equal(r.applied.length, 0)
    assert.equal(r.rolledBack, true)
    assert.equal(r.conflicts.length, 1)
    assert.equal(r.conflicts[0].path, storyPath)
    assert.match(r.conflicts[0].why, /사람 변경/)
    assert.deepEqual(treeDiff(before, fingerprintTree(fx.root)), [], '다른 스토리 쓰기도 같이 폐기돼야 한다')
    assert.ok(fx.read(otherPath).indexOf('자율 마무리 진단') < 0)
  } finally { fx.cleanup() }
})

test('sectionHash 만 어긋나도(그 절만 바뀌어도) 전체 폐기한다', () => {
  const { fx, snapshot } = project()
  try {
    const storyPath = `${IMPL}/${K.openPatch}.md`
    const texts = collectTexts(fx.root, [storyPath])
    const write = {
      op: 'append-within-section', path: storyPath, anchor: '### Review Findings', anchorOccurrence: 1,
      baseHash: sha(texts[storyPath]),
      sectionHash: sha('예전 절 내용 — 지금과 다르다'),
      body: '- [ ] [Review][Patch] 등재 시도',
    }
    const before = fingerprintTree(fx.root)
    const r = applyBmadWrites({ writes: [write], guards: DEFAULT_GUARDS }, { root: fx.root })
    assert.equal(r.rolledBack, true)
    assert.equal(r.conflicts[0].section, '### Review Findings')
    assert.deepEqual(treeDiff(before, fingerprintTree(fx.root)), [])
  } finally { fx.cleanup() }
})

// ═══════════════════════════════════════════════════════════════════════════
// E. sprint 키 단위 upsert — 90KB 주석 무손실
// ═══════════════════════════════════════════════════════════════════════════

test('sprint upsert 는 90KB 주석 파일에서 **딱 한 줄만** 바꾼다(재직렬화 금지)', () => {
  const bigComment = Array.from({ length: 1300 }, (_, i) =>
    `#   ${i} 이 줄은 사람이 손으로 쓴 기록이다 — 재직렬화하면 통째로 날아간다. "9-9-가짜-키: done" 같은 문자열도 그대로 있어야 한다.`).join('\n')
  const yaml = [
    '# generated: 2026-01-01',
    '# last_updated: 2026-09-02',
    bigComment,
    '',
    'development_status:',
    '  epic-1: done',
    '  1-1-정상: done  # 사람이 쓴 주석 1',
    '  1-2-두번째: review  # 사람이 쓴 주석 2',
    '  epic-2: in-progress',
    '  2-1-패치: in-progress  # 사람이 쓴 주석 3',
    '',
  ].join('\n')
  assert.ok(yaml.length > 90_000, `픽스처가 90KB 미만이다(${yaml.length})`)

  // ① 기존 키 상태 변경
  const r1 = applyWriteToText({ op: 'upsert-sprint-key', key: '1-2-두번째', value: 'done' }, yaml)
  assert.equal(r1.ok, true)
  const d1 = diffLines(yaml, r1.text)
  assert.equal(d1.length, 1, `바뀐 줄이 1개여야 한다: ${JSON.stringify(d1)}`)
  assert.equal(d1[0].after, '  1-2-두번째: done  # 사람이 쓴 주석 2', '뒤 주석이 살아 있어야 한다')

  // ② 새 키 추가 — 그 에픽 마지막 키 다음 줄
  const r2 = applyWriteToText({ op: 'upsert-sprint-key', key: '1-3-신규', value: 'backlog', after: '1-2-두번째', comment: '2026-09-03 자율 마무리 신설' }, yaml)
  const added = r2.text.split('\n').filter((l) => !yaml.split('\n').includes(l))
  assert.deepEqual(added, ['  1-3-신규: backlog  # 2026-09-03 자율 마무리 신설'])
  assert.equal(r2.text.split('\n').length, yaml.split('\n').length + 1)
  assert.equal(lineLoss(yaml, r2.text), 0, '주석 한 줄도 사라지면 안 된다')
  assert.equal(parseSprint(r2.text).length, 4)
  assert.ok(r2.text.includes('"9-9-가짜-키: done"'), '주석 안 문자열까지 1바이트 그대로')
})

function diffLines(a, b) {
  const A = a.split('\n')
  const B = b.split('\n')
  const out = []
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) out.push({ i, before: A[i], after: B[i] })
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// F. 왕복 — 만든 스토리를 진단기가 다시 읽는다 + git 이 의도한 파일만 본다
// ═══════════════════════════════════════════════════════════════════════════

test('신규 스토리 등재 후 재진단에서 그 스토리가 잡힌다(missing 아님) · git 은 의도한 파일만 바뀐다', () => {
  const { fx, snapshot } = project()
  try {
    assert.equal(fx.porcelain().trim(), '', '픽스처는 clean 상태로 시작한다')
    const epicsPath = `${PLAN}/epics.md`
    const sprintPath = `${IMPL}/sprint-status.yaml`
    const texts = collectTexts(fx.root, [epicsPath, sprintPath])
    const mapping = mapToStories({
      items: [{ id: 'W-new', story: null, epic: 2, title: '저장 실패 문구 보이기', tier: 4, storyLink: 'new', purpose: '실패를 알려 준다', userImpact: '사용자가 저장 실패를 안다', files: [], acceptance: ['실패하면 문구가 뜬다'] }],
      snapshot,
    })
    assert.equal(mapping.newStories.length, 1)
    const key = mapping.newStories[0].key
    assert.equal(key, '2-3-저장-실패-문구-보이기')

    const plan = planBmadWrites({ mapping, snapshot, texts, round: 1, now: new Date('2026-09-03T00:00:00Z') })
    assert.deepEqual(plan.writes.map((w) => w.op), ['create-file', 'append-within-section', 'upsert-sprint-key'])
    for (const w of plan.writes) assert.ok(WRITE_OPS.includes(w.op))

    const r = applyBmadWrites(plan, { root: fx.root })
    assert.equal(r.rolledBack, false, JSON.stringify(r.conflicts.concat(r.rejected)))
    assert.equal(r.applied.length, 3)

    // git 이 보는 변경 — 의도한 3파일뿐
    assert.deepEqual(porcelainPaths(fx), [epicsPath, sprintPath, `${IMPL}/${key}.md`].sort())

    // 재진단 왕복 — 원장·계획·파일 세 곳에서 다 읽힌다
    const snap2 = readProject(fx.root)
    assert.ok(snap2.sprint.some((r2) => r2.key === key), 'sprint 원장에 올라야 한다')
    assert.ok(snap2.epicStories.some((s) => s.id === '2-3'), 'epics.md 에도 올라야 한다')
    const st = snap2.stories.find((s) => s.key === key)
    assert.ok(st && st.exists, '스토리 파일이 스냅숏에 잡혀야 한다')
    assert.equal(st.statusInFile, 'backlog')
    assert.ok(st.signals.unfinishedTasks > 0, 'Tasks 가 일감으로 읽혀야 다음 배치가 집는다')
    assert.equal(st.fileList.sectionPresent, true, 'File List 절이 있어야 한다(없으면 partial 로 떨어진다)')

    const d2 = diagnose(snap2, { gates: GREEN })
    const v = d2.stories.find((s) => s.key === key)
    assert.ok(v, '재진단에 그 스토리가 있어야 한다')
    assert.notEqual(v.verdict, 'missing', `방금 만든 스토리가 여전히 missing 이면 왕복이 깨진 것: ${JSON.stringify(v)}`)
    assert.equal(v.verdict, 'partial')
    assert.equal(d2.counts.epicOnly, snapshot.epicOnly.length, 'epics-only 집계는 늘지 않아야 한다')
  } finally { fx.cleanup() }
})

test('기존 스토리에는 Review Findings 절에만 붙고 열린 Patch 수가 실제로 늘어난다', () => {
  const { fx, snapshot } = project()
  try {
    const storyPath = `${IMPL}/${K.openPatch}.md`
    const before = readFileSync(join(fx.root, storyPath), 'utf8')
    const beforeOpen = openFindings(before, 'Patch')
    const texts = collectTexts(fx.root, [storyPath])
    const mapping = mapToStories({ items: [{ id: 'W-x', story: K.openPatch, title: '목록 정렬이 흔들린다', purpose: '정렬을 고정한다', tier: 4, files: ['src/feature/c.ts'] }], snapshot })
    const plan = planBmadWrites({ mapping, snapshot, texts, round: 2, now: new Date('2026-09-03T00:00:00Z') })
    const r = applyBmadWrites(plan, { root: fx.root })
    assert.equal(r.rolledBack, false)
    const after = readFileSync(join(fx.root, storyPath), 'utf8')
    assert.equal(openFindings(after, 'Patch'), beforeOpen + 1)
    assert.equal(lineLoss(before, after), 0, '원문 줄이 하나도 사라지지 않아야 한다')
    // Review Findings 절 안에 들어갔는가(다음 절 `## Dev Notes` 앞)
    const idxFindings = after.indexOf('### Review Findings')
    const idxDevNotes = after.indexOf('## Dev Notes')
    const idxNew = after.indexOf('자율 마무리 진단 —')
    assert.ok(idxFindings < idxNew && idxNew < idxDevNotes, '다른 절로 새면 안 된다')
    assert.equal(fx.porcelain().trim().split('\n').length, 1, '스토리 1파일만 바뀐다')
  } finally { fx.cleanup() }
})

// ═══════════════════════════════════════════════════════════════════════════
// G. 상한·연동
// ═══════════════════════════════════════════════════════════════════════════

test('라운드당 신규 스토리 상한을 넘으면 초과분은 deferred 후보로 돌아온다', () => {
  const { fx, snapshot } = project()
  try {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `W-${i}`, story: null, epic: 1, title: `새 일 ${i}`, tier: 5, storyLink: 'new', files: [] }))
    const mapping = mapToStories({ items, snapshot })
    assert.equal(mapping.newStories.length, 5)
    assert.equal(new Set(mapping.newStories.map((n) => n.num)).size, 5, '한 라운드 안에서 번호가 겹치면 안 된다')
    const plan = planBmadWrites({ mapping, snapshot, texts: collectTexts(fx.root, [`${PLAN}/epics.md`, `${IMPL}/sprint-status.yaml`]), round: 1 })
    const created = plan.writes.filter((w) => w.op === 'create-file').length
    assert.equal(created, DEFAULT_GUARDS.maxNewStories)
    assert.equal(plan.deferred.filter((d) => /신규 스토리 상한/.test(d.why)).length, 2)
  } finally { fx.cleanup() }
})

test('진단 → 백로그 → 매핑 → 계획이 실제 픽스처에서 끝까지 돈다(스모크)', () => {
  const { fx, snapshot, backlog } = project()
  try {
    const mapping = mapToStories({ items: backlog.items, snapshot })
    const total = mapping.mapped.length + mapping.newStories.length + mapping.defects.length + mapping.unmappable.length
    assert.equal(total, backlog.items.length, '작업 항목은 하나도 사라지지 않는다')
    assert.ok(mapping.mapped.length >= 3, '픽스처의 열린 스토리들은 기존 스토리로 매핑돼야 한다')
    const paths = [`${PLAN}/epics.md`, `${IMPL}/sprint-status.yaml`, ...snapshot.stories.filter((s) => s.exists).map((s) => s.path)]
    const plan = planBmadWrites({ mapping, snapshot, texts: collectTexts(fx.root, paths), round: 1 })
    assert.ok(plan.writes.length > 0)
    assert.ok(plan.writes.length <= DEFAULT_GUARDS.maxWritesPerRound)
    for (const w of plan.writes) assert.equal(pathAllowed(w.path).ok, true, w.path)
    const before = fingerprintTree(fx.root)
    const r = applyBmadWrites(plan, { root: fx.root })
    assert.equal(r.rolledBack, false, JSON.stringify(r.conflicts.concat(r.rejected)))
    const changed = treeDiff(before, fingerprintTree(fx.root))
    assert.ok(changed.every((p) => p.startsWith('_bmad-output/')), `허용 경로 밖이 바뀌었다: ${changed.join(', ')}`)
    assert.equal(changed.filter((p) => p.startsWith('(삭제)')).length, 0, '삭제 op 는 없다')
  } finally { fx.cleanup() }
})

test('sectionBody·findHeadingLine 은 같은 이름 절이 여러 번 나와도 순번으로 짚는다', () => {
  const md = '# t\n\n### Debug Log References\n\nA\n\n### Debug Log References — 2차\n\nB\n\n## 끝\n'
  assert.equal(findHeadingLine(md, '### Debug Log References', 1), 2)
  assert.equal(findHeadingLine(md, '### Debug Log References', -1), 6)
  assert.match(sectionBody(md, '### Debug Log References', 1), /A/)
  assert.match(sectionBody(md, '### Debug Log References', -1), /B/)
  assert.equal(findHeadingLine(md, '### 없는 절'), -1)
})
