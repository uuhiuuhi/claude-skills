// 자율운전(full) — 2026-09-03 👤 「판단을 사람에게 넘기는 기준 전부 삭제 · 시니어 기획자 수준 24시간 자율운전」.
// 편성기(plan-queue)·검증기(plan-dag)·오케스트레이터(orchestrate)·러너 규칙(runner-rules)의 full 모드 계약을 문다.
// guarded 는 종전 테스트가 그대로 지킨다 — 여기서는 「같은 픽스처에서 guarded 는 막고 full 은 연다」 대조만 한 번 한다.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { plan, readStorySignals } from './plan-queue.mjs'
import { PLAN_SCHEMA, buildPlanPrompt, validatePlanShape } from './orchestrate.mjs'
import { STAGE_NAMES, buildDag, validatePlan } from './plan-dag.mjs'
import { engineFlagsFromConfig, parallelPlan, providerConfig } from './runner-rules.mjs'

const FULL = Object.freeze({
  epicOrder: [2, 3],
  parallelAllow: {},
  dailyCap: 0,
  mockupGate: { marker: '새 화면', ruleId: 'UX-DR-27', mockupsDir: 'mockups', verdictsPath: 'tools/dev-status/mockup-verdicts.json' },
  autonomy: { mode: 'full', maxReplansPerStory: 2, epicScope: 'all', mockups: 'ai-draft' },
})
const GUARDED = Object.freeze({ ...FULL, dailyCap: 30, autonomy: undefined })

const fixture = (fx) => {
  const root = mkdtempSync(join(tmpdir(), 'autonomy-'))
  const art = join(root, '_bmad-output', 'implementation-artifacts')
  const planDir = join(root, '_bmad-output', 'planning-artifacts')
  const devDir = join(root, 'tools', 'dev-status')
  for (const d of [art, planDir, devDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(art, 'sprint-status.yaml'), 'development_status:\n' + Object.entries(fx.sprint).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n', 'utf8')
  writeFileSync(join(planDir, 'epics.md'), fx.epics ?? '', 'utf8')
  writeFileSync(join(art, 'DECISIONS-INBOX.md'), fx.inbox ?? '# 결정 인박스\n', 'utf8')
  writeFileSync(join(devDir, 'mockup-verdicts.json'), JSON.stringify(fx.verdicts ?? { items: {} }), 'utf8')
  for (const [key, body] of Object.entries(fx.stories ?? {})) writeFileSync(join(art, `${key}.md`), body, 'utf8')
  const stateDir = mkdtempSync(join(tmpdir(), 'autonomy-state-'))
  if (fx.state) writeFileSync(join(stateDir, 'auto-plan-state.json'), JSON.stringify(fx.state), 'utf8')
  if (fx.chainAgeDays != null) writeFileSync(join(stateDir, 'chain-info.json'), JSON.stringify({ ageDays: fx.chainAgeDays, branches: [] }), 'utf8')
  return { root, stateDir }
}
// findings 는 기본으로 Tasks 절 **안**(h3)에 둔다 — 원장 해석기는 그 안의 `- [ ]` 를 dev 일감으로 센다(2-9·2-24 실측).
// outside=true 면 형제 h2 절로 뺀다(3-1 no-op 실사례 형태 · 「열린 Patch 인데 미완 Task 0」 재현용).
const story = ({ status = 'review', tasks = '- [x] **Task 1** 끝', findings = '', head = '', files = '- `src/a.ts`', outside = false } = {}) =>
  ['# 스토리', head, `Status: ${status}`, '', '## Tasks / Subtasks', tasks, '', ...(outside ? [] : ['### Review Findings', findings, '']), '### File List', files, '', '## Dev Notes', '', ...(outside ? ['## Review Findings', findings, ''] : [])].join('\n')
const EPICS_END = '\n## 끝\n' // epicSection 은 다음 절 경계(### Story / ## )가 있어야 절을 자른다 — 실제 epics.md 와 같은 형태
const run = (fx, config = FULL) => {
  const { root, stateDir } = fixture(fx)
  const r = plan({ root, stateDir, today: '2026-09-03', config })
  const info = r.queue._편성
  const pick = (k) => info.picked.find((p) => p.key === k)
  const ex = (k) => info.excluded.find((e) => e.key === k)
  const batch = (k) => r.queue.batches.find((b) => b.stories.includes(k))
  return { ...r, info, pick, ex, batch }
}

describe('[자율운전] 편성기 full 모드 — 사람 대기 대신 replan', () => {
  it('열린 [Review][Decision] → 제외가 아니라 replan→dev (AI 결정 채택)', () => {
    const r = run({ sprint: { '2-1-a': 'review' }, stories: { '2-1-a': story({ findings: '- [ ] [Review][Decision] 문구 ⭐추천 (가)' }) } })
    assert.ok(r.pick('2-1-a'), JSON.stringify(r.info.excluded))
    assert.deepEqual(r.batch('2-1-a').stages, ['replan', 'dev'])
    assert.match(r.pick('2-1-a').why, /AI 결정 1건/)
    assert.equal(r.batch('2-1-a').force, true)
    assert.equal(r.info.mode, 'full')
  })
  it('열린 Patch 만 있고 미완 Task 0 → replan 이 회수 라운드를 연다(규칙 4 대체)', () => {
    const r = run({ sprint: { '2-1-a': 'review' }, stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch][high] 버그', outside: true }) } })
    assert.deepEqual(r.batch('2-1-a').stages, ['replan', 'dev'])
    assert.match(r.pick('2-1-a').why, /회수 라운드 개방/)
    // 같은 findings 가 Tasks 절 안에 있으면 그 자체가 dev 일감이라 replan 없이 dev 로 간다(원장 해석 그대로)
    const inside = run({ sprint: { '2-1-a': 'review' }, stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch][high] 버그' }) } })
    assert.deepEqual(inside.batch('2-1-a').stages, ['dev'])
  })
  it('review + 고칠 것 0 + 결정 0 은 종전대로 마감 재검수(closeout)', () => {
    const r = run({ sprint: { '2-1-a': 'review' }, stories: { '2-1-a': story() } })
    assert.deepEqual(r.batch('2-1-a').stages, ['review'])
    assert.match(r.pick('2-1-a').why, /마감 재검수/)
  })
  it('무진전 편성 2회 → replan 을 앞세우고 힌트를 싣는다 · 회차(state.replans)는 편성기가 올리지 않는다(러너가 실행 기준으로 센다)', () => {
    const r = run({
      sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [ ] T1' }) },
      state: { days: { '2026-09-01': { planned: ['2-1-a', '2-1-a'], stops: 0 } } },
    })
    assert.deepEqual(r.batch('2-1-a').stages, ['replan', 'dev'])
    assert.match(r.batch('2-1-a').replanHint, /무진전 편성 2회/)
    assert.equal(r.state.replans['2-1-a'] ?? 0, 0)
  })
  it('「재투입 금지」 문구가 있어도 미완 기계 Task 가 있으면 replan 없이 dev(무한 replan 방지 · 리뷰 #1)', () => {
    const r = run({ sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [ ] T1', head: '재투입 금지 — 마지막 구현 라운드였다' }) } })
    assert.deepEqual(r.batch('2-1-a').stages, ['dev'])
    const zero = run({ sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [x] T1', head: '재투입 금지' }) } })
    assert.deepEqual(zero.batch('2-1-a').stages, ['replan', 'dev'])
  })
  it('Tasks 절이 파일의 마지막 h2 여도 미완 Task 를 센다(엔진과 같은 잣대)', () => {
    const s = readStorySignals('# S\nStatus: in-progress\n## Tasks / Subtasks\n- [ ] T1\n- [x] T2\n')
    assert.equal(s.unfinishedTasks, 1)
  })
  it('replan 을 상한만큼 썼는데도 무진전 → 그 스토리만 「자율 한계」로 사람 질문(humanGates question)', () => {
    const r = run({
      sprint: { '2-1-a': 'in-progress', '2-2-b': 'in-progress' },
      stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [ ] T1' }), '2-2-b': story({ status: 'in-progress', tasks: '- [ ] T1', files: '- `src/b.ts`' }) },
      state: { days: { '2026-09-01': { planned: ['2-1-a', '2-1-a'], stops: 0 } }, replans: { '2-1-a': 2 } },
    })
    assert.match(r.ex('2-1-a').why, /자율 한계/)
    assert.deepEqual(r.info.humanGates.map((g) => [g.key, g.type]), [['2-1-a', 'question']])
    assert.ok(r.pick('2-2-b'), '다른 스토리는 계속 돈다')
  })
  it('편성만 되고 실행이 안 된 슬롯이 이어져도 「자율 한계」로 빠지지 않는다(회차는 러너가 실행 기준으로 센다 · 리뷰 #2)', () => {
    const fx = { sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [ ] T1' }) }, state: { days: { '2026-09-01': { planned: ['2-1-a', '2-1-a', '2-1-a', '2-1-a'], stops: 0 } } } }
    for (let i = 0; i < 3; i++) {
      const r = run(fx)
      assert.ok(r.pick('2-1-a'), '편성 ' + (i + 1) + '회차에서 빠졌다: ' + JSON.stringify(r.info.excluded))
      assert.deepEqual(r.batch('2-1-a').stages, ['replan', 'dev'])
      assert.equal(r.state.replans['2-1-a'] ?? 0, 0)
    }
  })
  it('진전이 나면 replan 회차는 0 으로 본다(스트릭 리셋과 같은 잣대)', () => {
    const r = run({
      sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [ ] T1' }) },
      state: { days: { '2026-09-01': { planned: ['2-1-a', '2-1-a'], stops: 0 }, '2026-09-02': { planned: ['2-1-a'], progressed: ['2-1-a'], stops: 0 } }, replans: { '2-1-a': 2 } },
    })
    assert.ok(r.pick('2-1-a'))
    assert.deepEqual(r.batch('2-1-a').stages, ['dev'])
  })
  it('BLOCKED-ON-HUMAN 표식은 사람 질문 대기 — 취소선(~~)이면 해소', () => {
    const blocked = story({ status: 'in-progress', tasks: '- [ ] T1', head: 'BLOCKED-ON-HUMAN: 운영 DB 키가 필요하다 — 풀리는 조건: 키 발급' })
    const r = run({ sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': blocked } })
    assert.match(r.ex('2-1-a').why, /사람 질문 대기: BLOCKED-ON-HUMAN: 운영 DB 키/)
    assert.equal(r.info.humanGates[0].type, 'question')
    const solved = story({ status: 'in-progress', tasks: '- [ ] T1', head: '~~BLOCKED-ON-HUMAN: 운영 DB 키가 필요하다~~ — ✅ 해소(2026-09-03)' })
    assert.ok(run({ sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': solved } }).pick('2-1-a'))
    // 인용·목록 안의 과거 기재는 표식이 아니다(줄머리 0열만 · 리뷰 #14)
    const quoted = story({ status: 'in-progress', tasks: '- [ ] T1', head: '> 지난주 replan 은 BLOCKED-ON-HUMAN: 키 필요 를 남겼었다\n- BLOCKED-ON-HUMAN: 이것도 인용' })
    assert.ok(run({ sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': quoted } }).pick('2-1-a'))
  })
  it('사람 게이트 Task 만 남은 스토리는 gate 로 사람 몫(그 외 스토리는 계속)', () => {
    const r = run({ sprint: { '2-1-a': 'in-progress' }, stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [ ] 사람 게이트: 운영 DB 적용은 박사장 승인' }) } })
    assert.match(r.ex('2-1-a').why, /사람 게이트만 남음/)
    assert.equal(r.info.humanGates[0].type, 'gate')
  })
  it('미머지 체인 3일이어도 신규 착수를 막지 않는다 · 상한 0 = 무제한', () => {
    const sprint = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`2-${i + 1}-s`, 'backlog']))
    const r = run({ sprint, chainAgeDays: 3, epics: '' })
    assert.equal(r.info.picked.length, 6, JSON.stringify(r.info.excluded))
    assert.equal(r.info.cap, null)
    assert.equal(r.info.chainAgeDays, 3)
  })
  it('epicOrder 밖 에픽은 뒤에 이어 붙고(epicScope all) ⏸ 이연 확정은 여전히 제외', () => {
    const epics = ['### Story 5.1: 근태', '평범', '### Story 5.2: 이연', '⏸ 이연 확정 — MVP 범위 밖'].join('\n') + EPICS_END
    const r = run({ sprint: { '2-1-a': 'backlog', '5-1-x': 'backlog', '5-2-y': 'backlog' }, epics })
    assert.deepEqual(r.info.picked.map((p) => p.key), ['2-1-a', '5-1-x'])
    assert.match(r.ex('5-2-y').why, /이연 확정/)
  })
  it('선행이 review(코드 실재)면 후속을 허용하고, 선행이 계획 밖(사람 몫)이면 후속을 「선행」 사유로 미룬다', () => {
    const dep = story({ status: 'in-progress', tasks: '- [ ] T1', head: '선행: 2.1', files: '- `src/c.ts`' })
    const ok = run({ sprint: { '2-1-a': 'review', '2-16-c': 'in-progress' }, stories: { '2-1-a': story(), '2-16-c': dep } })
    assert.ok(ok.pick('2-16-c'), JSON.stringify(ok.info.excluded))
    // 선행이 같은 계획에 먼저 실리면 후속도 같이 간다(검증기 dep-same-plan · guarded 와 같은 잣대)
    const same = run({ sprint: { '2-1-a': 'in-progress', '2-16-c': 'in-progress' }, stories: { '2-1-a': story({ status: 'in-progress', tasks: '- [ ] T1' }), '2-16-c': dep } })
    assert.ok(same.pick('2-1-a') && same.pick('2-16-c'))
    assert.ok(same.info.picked.findIndex((p) => p.key === '2-1-a') < same.info.picked.findIndex((p) => p.key === '2-16-c'), '선행이 앞이다')
    // 선행이 사람 몫으로 빠지면(계획 밖 + done/review 아님) 후속은 선행 미해소로 미룬다
    const blocked = story({ status: 'in-progress', tasks: '- [ ] T1', head: 'BLOCKED-ON-HUMAN: 키 필요 — 풀리는 조건: 발급' })
    const wait = run({ sprint: { '2-1-a': 'in-progress', '2-16-c': 'in-progress' }, stories: { '2-1-a': blocked, '2-16-c': dep } })
    assert.match(wait.ex('2-16-c').why, /선행/)
  })
  it('새 화면 스토리 — 목업 부재면 create→mockup→dev→review · pending 은 진행+사후 확인 · rejected 는 mockup 재작성', () => {
    const epics = ['### Story 3.1: 새 화면 하나', '새 화면 · UX-DR-27 적용'].join('\n') + EPICS_END
    const none = run({ sprint: { '3-1-n': 'backlog' }, epics })
    assert.deepEqual(none.batch('3-1-n').stages, ['create', 'mockup', 'dev', 'review'])
    const pending = run({ sprint: { '3-1-n': 'ready-for-dev' }, epics, stories: { '3-1-n': story({ status: 'ready-for-dev', tasks: '- [ ] T1' }) }, verdicts: { items: { 'mockups/story-3-1-main.html': { verdict: 'pending' } } } })
    assert.deepEqual(pending.batch('3-1-n').stages, ['create', 'dev', 'review'])
    assert.deepEqual(pending.info.humanGates.map((g) => g.type), ['post-hoc'])
    const rejected = run({ sprint: { '3-1-n': 'ready-for-dev' }, epics, stories: { '3-1-n': story({ status: 'ready-for-dev', tasks: '- [ ] T1' }) }, verdicts: { items: { 'mockups/story-3-1-main.html': { verdict: 'rejected' } } } })
    assert.equal(rejected.batch('3-1-n').stages[0], 'mockup')
  })
  it('replan/mockup 단계 모델은 최상위(fable) · fable 소진이면 opus', () => {
    const fx = { sprint: { '2-1-a': 'review' }, stories: { '2-1-a': story({ findings: '- [ ] [Review][Decision] 문구' }) } }
    assert.equal(run(fx).batch('2-1-a').models.replan, 'fable')
    assert.equal(run(fx, { ...FULL, exhaustedModels: ['fable'] }).batch('2-1-a').models.replan, 'opus')
  })
  it('같은 픽스처를 guarded 로 돌리면 결정 대기로 막힌다(대조)', () => {
    const r = run({ sprint: { '2-1-a': 'review' }, stories: { '2-1-a': story({ findings: '- [ ] [Review][Decision] 문구' }) } }, GUARDED)
    assert.match(r.ex('2-1-a').why, /결정 대기/)
    assert.equal(r.info.mode, 'guarded')
    assert.deepEqual(r.info.humanGates, [])
  })
})

describe('[자율운전] 원장 신호 · 검증기 · 오케스트레이터 · 러너 규칙', () => {
  it('readStorySignals — humanGateTasks · blockedOnHuman · openDecisions', () => {
    const s = readStorySignals('# S\nBLOCKED-ON-HUMAN: 키 필요 — 풀리는 조건: 발급\n## Tasks\n- [ ] 사람 게이트: QA 계정\n- [ ] 기계 일\n- [ ] [Review][Decision] x\n## X\n')
    assert.equal(s.unfinishedTasks, 2)
    assert.equal(s.humanGateTasks, 1)
    assert.equal(s.openDecisions, 1)
    assert.match(s.blockedOnHuman, /^BLOCKED-ON-HUMAN: 키 필요/)
  })
  it('STAGE_NAMES 5종 — 검증기가 replan/mockup 을 받고 모르는 단계는 거부한다', () => {
    assert.deepEqual([...STAGE_NAMES], ['create', 'mockup', 'replan', 'dev', 'review'])
    const dag = buildDag({ stories: [{ key: '2-1-a', epic: 2, kind: 'recovery', files: [], deps: [] }], epicOrder: [2] })
    assert.ok(validatePlan({ batches: [{ stories: ['2-1-a'], stages: ['replan', 'dev'] }] }, dag, { knownKeys: ['2-1-a'] }).ok)
    assert.ok(validatePlan({ batches: [{ stories: ['2-1-a'], stages: ['foo'] }] }, dag, { knownKeys: ['2-1-a'] }).errors.some((e) => e.code === 'stage'))
  })
  it('오케스트레이터 스키마·형태 검사가 새 단계·모델 키를 받는다', () => {
    assert.ok(PLAN_SCHEMA.properties.batches.items.properties.stages.items.enum.includes('replan'))
    assert.deepEqual(validatePlanShape({ batches: [{ stories: ['2-1-a'], stages: ['replan', 'dev', 'review'], models: { replan: 'fable', dev: 'opus', review: 'codex' } }] }), [])
    assert.ok(validatePlanShape({ batches: [{ stories: ['2-1-a'], stages: ['nope'] }] }).length > 0)
  })
  it('full 모드 프롬프트 — 시니어 기획자 역할 · 진행 에픽 댐 없음 · 병렬 폭 · notes/replanHint 실림', () => {
    const ctx = { date: '2026-09-03', mode: 'full', parallel: 3, candidates: [{ key: '2-1-a', epic: 2, kind: 'recovery', stages: ['replan', 'dev'], notes: ['AI 결정 1건'], replanHint: '무진전 2회' }], constraints: { epicOrder: [2, 3], batchMax: 2, cap: { limit: Infinity, plannedToday: [] } } }
    const { prompt } = buildPlanPrompt(ctx)
    assert.match(prompt, /시니어 개발 기획자/)
    assert.match(prompt, /병렬 폭: 3/)
    assert.match(prompt, /제한 없음/)
    assert.ok(!prompt.includes('신규 착수는 진행 에픽에서만'))
    assert.match(prompt, /"replanHint": "무진전 2회"/)
    const guarded = buildPlanPrompt({ ...ctx, mode: 'guarded' }).prompt
    assert.match(guarded, /신규 착수는 진행 에픽에서만/)
    assert.ok(!guarded.includes('시니어 개발 기획자'))
  })
  it('러너 규칙 — autonomy 정규화 · --autonomy full 플래그 · replan 은 병렬 가능, mockup 은 순차', () => {
    const pc = providerConfig({ providers: { codex: { enabled: false } }, autonomy: { mode: 'full' } })
    assert.equal(pc.autonomy.mode, 'full')
    const flags = engineFlagsFromConfig(pc)
    assert.ok(flags.includes('--autonomy') && flags[flags.indexOf('--autonomy') + 1] === 'full')
    assert.equal(providerConfig({ providers: {} }).autonomy.mode, 'guarded')
    assert.ok(!engineFlagsFromConfig(providerConfig({ providers: {} })).includes('--autonomy'))
    // autonomy 키만 있는 설정: guarded 면 명령줄 불변([]) · full 이면 --autonomy 만 붙는다(리뷰 #3)
    assert.deepEqual(engineFlagsFromConfig(providerConfig({ autonomy: { mode: 'guarded' } })), [])
    assert.deepEqual(engineFlagsFromConfig(providerConfig({ autonomy: { mode: 'full' } })), ['--autonomy', 'full'])
    assert.equal(providerConfig({ autonomy: { mode: 'full' } }).configured, false)
    assert.equal(parallelPlan({ storyCount: 2, stages: ['replan', 'dev'], parallel: 2 }), 2)
    assert.equal(parallelPlan({ storyCount: 2, stages: ['mockup', 'dev', 'review'], parallel: 2 }), 1)
  })
})
