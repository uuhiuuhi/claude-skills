// 계획 DAG + 검증기 — 위상 순서 · 사이클 탐지 · 결정적 거부 사유
//
// 무는 것: ① 순서를 정할 수 있는가(위상) ② 정할 수 없는 것을 정한 척하지 않는가(사이클)
// ③ 검증 결과가 **결정적**인가(같은 입력 → 같은 errors 배열) ④ 규칙 편성기가 낸 큐가
// 이 검증을 통과하는가(회귀 방지 — 자기 잣대에 자기가 걸리면 밤이 선다).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildDag, isValidModelSpec, parseDependsOn, shortKey, validatePlan } from './plan-dag.mjs'
import { plan } from './plan-queue.mjs'

const S = (key, over = {}) => ({ key, epic: Number(key.split('-')[0]), kind: 'recovery', files: [], deps: [], ...over })

describe('[DAG] 위상 순서 · 간선', () => {
  it('선행 표기 · 같은 파일 · 같은 에픽 신규 순서로 간선을 만들고 위상 순서를 낸다', () => {
    const dag = buildDag({
      stories: [
        S('2-3-c', { deps: ['2-1'] }),
        S('2-1-a'),
        S('3-1-x', { kind: 'new' }),
        S('3-2-y', { kind: 'new' }),
      ],
      epicOrder: [2, 3],
    })
    assert.deepEqual(dag.order, ['2-1-a', '2-3-c', '3-1-x', '3-2-y'])
    assert.ok(dag.edges.some((e) => e.from === '2-1-a' && e.to === '2-3-c' && e.why === '선행 표기'))
    assert.ok(dag.edges.some((e) => e.from === '3-1-x' && e.to === '3-2-y' && e.why === '같은 에픽 순서'))
    assert.deepEqual(dag.cycles, [])
  })

  it('같은 파일을 만지는 스토리는 순서 간선으로 이어진다(병렬이 아니라 순차 근거)', () => {
    const dag = buildDag({ stories: [S('2-2-b', { files: ['src/a.ts'] }), S('2-1-a', { files: ['src/a.ts'] })], epicOrder: [2] })
    assert.ok(dag.edges.some((e) => e.from === '2-1-a' && e.to === '2-2-b' && e.why.includes('같은 파일')))
    assert.deepEqual(dag.order, ['2-1-a', '2-2-b'])
  })

  it('사이클은 order 에서 빠지고 cycles 에 이름으로 남는다(정렬 = 결정적)', () => {
    const dag = buildDag({ stories: [S('2-1-a', { deps: ['2-2'] }), S('2-2-b', { deps: ['2-1'] })], epicOrder: [2] })
    assert.deepEqual(dag.order, [])
    assert.deepEqual(dag.cycles, ['2-1-a', '2-2-b'])
  })

  it('같은 입력이면 간선·순서가 같다(결정적) · 입력 순서를 바꿔도 같다', () => {
    const a = buildDag({ stories: [S('2-2-b'), S('2-1-a')], epicOrder: [2] })
    const b = buildDag({ stories: [S('2-1-a'), S('2-2-b')], epicOrder: [2] })
    assert.deepEqual(a.order, b.order)
    assert.deepEqual(a.edges, b.edges)
  })

  it('선행 표기는 줄머리 라벨만 인정한다 — 본문에 스친 「선행」은 의존이 아니다', () => {
    assert.deepEqual(parseDependsOn('선행: 2.1, 11-3'), ['2-1', '11-3'])
    assert.deepEqual(parseDependsOn('- **선행 조건**: 4-6 완료 후'), ['4-6'])
    assert.deepEqual(parseDependsOn('depends-on: 2-9'), ['2-9'])
    assert.deepEqual(parseDependsOn('이 스토리는 2.1 의 선행 작업을 참고한다'), [])
    assert.deepEqual(parseDependsOn('선행: 없음'), [])
    assert.equal(shortKey('2-16-티켓목록'), '2-16')
  })
})

describe('[DAG] 검증기 — 무엇을 거부하는가', () => {
  const dag = buildDag({ stories: [S('2-1-a', { files: ['src/a.ts'] }), S('2-2-b', { files: ['src/b.ts'] })], epicOrder: [2] })
  const base = { knownKeys: ['2-1-a', '2-2-b'], doneKeys: [], epicOrder: [2], currentEpic: 2, batchMax: 2 }
  const codes = (p, c = base, d = dag) => validatePlan(p, d, c).errors.map((e) => e.code)

  it('정상 계획은 ok', () => {
    const v = validatePlan({ batches: [{ stories: ['2-1-a', '2-2-b'], stages: ['dev'], models: { dev: 'opus', review: 'sonnet' } }] }, dag, base)
    assert.equal(v.ok, true)
    assert.deepEqual(v.errors, [])
  })

  it('④ 같은 배치 안 File List 겹침 — dev 배치는 batch-conflict · review 전용(마감 재검수) 배치는 코드 무접촉이라 통과 (👤 2026-09-04 리뷰 병렬)', () => {
    const overlap = buildDag({ stories: [S('2-1-a', { files: ['src/a.ts'] }), S('2-2-b', { files: ['src/a.ts'] })], epicOrder: [2] })
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a', '2-2-b'], stages: ['dev'] }] }, base, overlap), ['batch-conflict'])
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a', '2-2-b'], stages: ['review'] }] }, base, overlap), [])
    // stages 를 안 적은 배치는 종전대로 코드를 쓴다고 보고 검사한다(보수 방향)
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a', '2-2-b'] }] }, base, overlap), ['batch-conflict'])
  })

  it('없는 스토리 키 · 중복 편성 · 빈 배치 · 배치 상한 초과', () => {
    assert.deepEqual(codes({ batches: [{ stories: ['9-9-x'] }] }), ['unknown-story'])
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a'] }, { stories: ['2-1-a'] }] }), ['duplicate'])
    assert.deepEqual(codes({ batches: [{ stories: [] }] }), ['empty-batch'])
    assert.ok(codes({ batches: [{ stories: ['2-1-a', '2-2-b'] }] }, { ...base, batchMax: 1 }).includes('batch-size'))
  })

  it('모델 스펙 — opus·codex·codex:m 만 통과, 메타문자·공백은 거부', () => {
    for (const ok of ['opus', 'fable', 'sonnet', 'codex', 'codex:gpt-5.6-sol', 'claude:opus']) assert.equal(isValidModelSpec(ok), true, ok)
    for (const bad of ['', ' opus', 'opus ', 'opus;rm', 'codex:$(id)', 'a|b', 'a&b', 'codex:a:b', 'o pus', '../x']) assert.equal(isValidModelSpec(bad), false, bad)
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a'], models: { dev: 'opus && evil' } }] }), ['model-spec'])
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a'], models: { dev: 'codex:gpt-5.6-sol', review: 'opus' } }] }), [])
  })

  it('미해결 선행 — done 이면 통과, 아니면 거부. 같은 계획 안이면 순서를 본다', () => {
    const d = buildDag({ stories: [S('2-2-b', { deps: ['2-1'] }), S('2-1-a')], epicOrder: [2] })
    assert.deepEqual(codes({ batches: [{ stories: ['2-2-b'] }] }, base, d), ['unresolved-dep'])
    assert.deepEqual(codes({ batches: [{ stories: ['2-2-b'] }] }, { ...base, doneKeys: ['2-1-a'] }, d), [])
    // 같은 계획에서 선행이 먼저면 경고, 뒤면 순서 역전 오류
    const okOrder = validatePlan({ batches: [{ stories: ['2-1-a'] }, { stories: ['2-2-b'] }] }, d, base)
    assert.equal(okOrder.ok, true)
    assert.equal(okOrder.warnings[0].code, 'dep-same-plan')
    assert.deepEqual(codes({ batches: [{ stories: ['2-2-b'] }, { stories: ['2-1-a'] }] }, base, d), ['dep-order'])
  })

  it('규칙 1·7·9 · 사람 게이트 봉쇄', () => {
    const d = buildDag({ stories: [S('3-1-n', { kind: 'new' }), S('2-1-a')], epicOrder: [2, 3] })
    const c = { ...base, knownKeys: ['2-1-a', '3-1-n'], epicOrder: [2, 3], currentEpic: 2 }
    assert.deepEqual(codes({ batches: [{ stories: ['3-1-n'] }] }, c, d), ['epic-order'])
    // parallelAllow 예외는 통과시킨다
    assert.deepEqual(codes({ batches: [{ stories: ['3-1-n'] }] }, { ...c, parallelAllow: { '3-1': 2 } }, d), [])
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a'] }] }, { ...base, streakSpent: ['2-1-a'] }), ['streak'])
    assert.deepEqual(codes({ batches: [{ stories: ['2-1-a'] }] }, { ...base, blocked: { '2-1-a': '결정 대기' } }), ['blocked'])
    assert.deepEqual(
      codes({ batches: [{ stories: ['2-1-a'] }, { stories: ['2-2-b'] }] }, { ...base, cap: { limit: 2, plannedToday: ['9-9-x'] } }),
      ['daily-cap'],
    )
  })

  it('errors 는 결정적으로 정렬된다 — 같은 입력 두 번이면 같은 배열', () => {
    const p = { batches: [{ stories: ['2-1-a', '9-9-x'], models: { dev: 'bad spec' } }] }
    assert.deepEqual(validatePlan(p, dag, base).errors, validatePlan(p, dag, base).errors)
  })
})

// ── 회귀: 규칙 편성기가 낸 큐가 자기 검증을 통과한다 ──
describe('[DAG] plan() 산출 큐는 validator 를 통과한다', () => {
  const CONFIG = { epicOrder: [2, 3], dailyCap: 30, models: { new: { dev: 'opus', review: 'fable' }, recovery: { dev: 'opus', review: 'fable' }, closeout: { review: 'fable' } } }
  const story = (files = ['src/a.ts'], findings = '- [ ] [Review][Patch] a') =>
    ['# s', 'Status: review', '## Tasks / Subtasks', '- [x] 끝', '### Review Findings', findings,
      '### File List', ...files.map((f) => '- `' + f + '`'), '## Dev Notes', ''].join('\n')

  it('회수 2건(서로소) 편성 결과가 ok · validation 필드가 큐에 실린다', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-dag-'))
    const art = join(root, '_bmad-output', 'implementation-artifacts')
    mkdirSync(art, { recursive: true })
    mkdirSync(join(root, '_bmad-output', 'planning-artifacts'), { recursive: true })
    writeFileSync(join(art, 'sprint-status.yaml'), '  2-1-a: review\n  2-2-b: review\n  2-0-z: done\n', 'utf8')
    writeFileSync(join(root, '_bmad-output', 'planning-artifacts', 'epics.md'), '', 'utf8')
    writeFileSync(join(art, '2-1-a.md'), story(['src/a.ts']), 'utf8')
    writeFileSync(join(art, '2-2-b.md'), story(['src/b.ts']), 'utf8')
    const stateDir = mkdtempSync(join(tmpdir(), 'plan-dag-state-'))
    const { queue } = plan({ root, stateDir, max: 12, today: '2026-09-02', config: CONFIG })
    assert.equal(queue.validation.ok, true, JSON.stringify(queue.validation.errors))
    assert.deepEqual(queue._편성.picked.map((p) => p.key), ['2-1-a', '2-2-b'])
  })

  it('선행이 done 이 아닌 스토리는 계획 검증에서 빠지고 사유가 남는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-dag-'))
    const art = join(root, '_bmad-output', 'implementation-artifacts')
    mkdirSync(art, { recursive: true })
    mkdirSync(join(root, '_bmad-output', 'planning-artifacts'), { recursive: true })
    writeFileSync(join(art, 'sprint-status.yaml'), '  2-1-a: review\n', 'utf8')
    writeFileSync(join(root, '_bmad-output', 'planning-artifacts', 'epics.md'), '', 'utf8')
    writeFileSync(join(art, '2-1-a.md'), story(['src/a.ts']).replace('## Dev Notes', '## Dev Notes\n선행: 2-9\n'), 'utf8')
    const stateDir = mkdtempSync(join(tmpdir(), 'plan-dag-state-'))
    const { queue } = plan({ root, stateDir, max: 12, today: '2026-09-02', config: CONFIG })
    assert.equal(queue.batches.length, 0)
    assert.equal(queue.validation.ok, false)
    assert.ok(queue._편성.excluded.some((e) => e.key === '2-1-a' && e.why.includes('계획 검증 실패') && e.why.includes('선행 2-9')))
  })
})
