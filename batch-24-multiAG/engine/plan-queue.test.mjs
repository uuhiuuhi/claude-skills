// 큐 자동 편성기 규칙 8종(+9 v2·10) — 합성 픽스처만 쓴다(실파일 의존 0: 정책·상태 파일이 바뀌어도
// 이 행위 테스트는 흔들리지 않는다). 원본은 jng-os `tests/auto/plan-queue.test.ts`(vitest) — 이식판은
// node:test 로 돌고, 프로젝트 고유값은 아래 CONFIG 픽스처가 원본의 하드코딩 값을 그대로 재현한다.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { avoidExhaustedPair, plan, parseSprint, readStorySignals } from './plan-queue.mjs'

// ── jng-os 원본의 하드코딩 상수 재현(tools/auto/plan-queue.mjs · tools/lib/story-ledger.mjs) ──
//   EPIC_ORDER = [2, 3, 11, 4] · PARALLEL_ALLOW = { '4-0': 11 } · DAILY_CAP_DEFAULT = 30
//   목업 게이트 = '새 화면' + 'UX-DR-27' · mockups/ · tools/dev-status/mockup-verdicts.json
//   모델 장부(09-01 개정) = 신규·회수 dev=opus/review=fable · 마감 재검수 review=fable
//   EXHAUSTED_MODELS = ['fable'] (2026-08-30 실사고 회수)
const CONFIG = Object.freeze({
  epicOrder: [2, 3, 11, 4],
  parallelAllow: { '4-0': 11 },
  dailyCap: 30,
  mockupGate: {
    marker: '새 화면',
    ruleId: 'UX-DR-27',
    mockupsDir: 'mockups',
    verdictsPath: 'tools/dev-status/mockup-verdicts.json',
  },
  models: {
    new: { dev: 'opus', review: 'fable' },
    recovery: { dev: 'opus', review: 'fable' },
    closeout: { review: 'fable' },
  },
  exhaustedModels: ['fable'],
})
const EXHAUSTED_MODELS = CONFIG.exhaustedModels

/** 합성 저장소 한 벌 — root 와 stateDir 를 임시 폴더에 만든다 */
const fixture = (fx) => {
  const root = mkdtempSync(join(tmpdir(), 'plan-queue-'))
  const art = join(root, '_bmad-output', 'implementation-artifacts')
  const planDir = join(root, '_bmad-output', 'planning-artifacts')
  const devDir = join(root, 'tools', 'dev-status')
  mkdirSync(art, { recursive: true })
  mkdirSync(planDir, { recursive: true })
  mkdirSync(devDir, { recursive: true })
  writeFileSync(join(art, 'sprint-status.yaml'), fx.sprint, 'utf8')
  writeFileSync(join(planDir, 'epics.md'), fx.epics ?? '', 'utf8')
  writeFileSync(join(art, 'DECISIONS-INBOX.md'), fx.inbox ?? '', 'utf8')
  writeFileSync(join(devDir, 'mockup-verdicts.json'), JSON.stringify(fx.verdicts ?? { items: {} }), 'utf8')
  for (const [key, body] of Object.entries(fx.stories ?? {})) writeFileSync(join(art, `${key}.md`), body, 'utf8')
  const stateDir = mkdtempSync(join(tmpdir(), 'plan-state-'))
  return { root, stateDir, config: CONFIG }
}

const story = (over = {}) =>
  [
    '# 스토리',
    'Status: review',
    '## Tasks / Subtasks',
    over.tasks ?? '- [x] **Task 1** 끝',
    '### Review Findings',
    over.findings ?? '',
    '### File List',
    '- `src/a.ts`',
    '## Dev Notes',
    over.extra ?? '',
  ].join('\n')

const run = (fx, max = 12) => plan({ ...fixture(fx), max, today: '2026-08-26' })

describe('[OPS-1] 편성 규칙 8종', () => {
  it('규칙 1 — 에픽 순서 2→3→11→4: 앞 에픽에 후보가 있으면 뒤는 「순서 대기」로 뺀다', () => {
    const { queue } = run({
      sprint: '  2-1-a: review\n  3-1-b: backlog\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] 지적' }) },
    })
    assert.deepEqual(queue._편성.picked.map((p) => p.key), ['2-1-a'])
    assert.ok(queue._편성.excluded.find((e) => e.key === '3-1-b')?.why.includes('순서 대기'))
  })

  it('규칙 1 개정(👤 08-28) — 앞 에픽에 후보가 남아도 뒤 에픽의 회수·마감은 통과, 신규 착수만 대기', () => {
    const { queue } = run({
      sprint: '  2-1-a: review\n  3-1-b: review\n  3-2-c: backlog\n',
      stories: {
        '2-1-a': story({ findings: '- [ ] [Review][Patch] 지적' }),
        '3-1-b': story({ findings: '- [ ] [Review][Patch] 지적' }),
      },
      epics: '### Story 3.2: c\n본문\n## 끝',
    })
    const picked = queue._편성.picked.map((p) => p.key)
    assert.ok(picked.includes('2-1-a')) // 앞 에픽 우선
    assert.ok(picked.includes('3-1-b')) // 뒤 에픽 회수 통과 — 댐이 아니라 우선순위
    assert.ok(picked.indexOf('2-1-a') < picked.indexOf('3-1-b')) // 에픽 순서 = 상한 절단 우선순위
    assert.ok(queue._편성.excluded.find((e) => e.key === '3-2-c')?.why.includes('신규 착수는 에픽 도달 후'))
  })

  it('규칙 1 — 앞 에픽이 전부 막히면 다음 에픽에 길을 내준다(막힌 사유는 excluded 에 남는다)', () => {
    const { queue } = run({
      sprint: '  2-1-a: review\n  3-1-b: backlog\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Decision] 결정 대기' }) },
      epics: '### Story 3.1: b\n본문\n## 끝',
    })
    assert.deepEqual(queue._편성.picked.map((p) => p.key), ['3-1-b'])
  })

  it('규칙 1 — epics ⏸ 이연 확정 문언이 상태값보다 우선한다(2-18 실사례)', () => {
    const { queue } = run({
      sprint: '  2-18-c: backlog\n',
      epics: '### Story 2.18: c\n> **⏸ 파일럿 후로 이연 확정.**\n## 끝',
    })
    assert.equal(queue.batches.length, 0)
    assert.ok(queue._편성.excluded[0].why.includes('이연 확정'))
  })

  it('규칙 2 — 열린 [Review][Decision] 은 제외 + 인박스 미등재면 의심 표기', () => {
    const { queue } = run({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Decision] 정책 판단' }) },
      inbox: '결정 대기 표 — 다른 스토리만 있음', // 대상 키(2.1/2-1)가 없어야 미등재 의심이 선다
    })
    const why = queue._편성.excluded[0].why
    assert.ok(why.includes('결정 대기'))
    assert.ok(why.includes('인박스 미등재 의심'))
  })

  it('규칙 3 — 재투입 금지 지시가 살아 있고 미완 Task 0 이면 제외(1회 해제 소진 — 3-1 실사례)', () => {
    const { queue } = run({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': story({ extra: '3차가 마지막 구현 라운드다(박사장 지시). dev 재투입 금지.' }) },
    })
    assert.ok(queue._편성.excluded[0].why.includes('재투입 금지'))
  })

  it('규칙 3 단서 — 금지 지시가 있어도 미완 기계 Task 가 있으면(새 라운드 개방) 편성한다', () => {
    const { queue } = run({
      sprint: '  2-1-a: in-progress\n',
      stories: {
        '2-1-a': story({ tasks: '- [ ] **Task 10 — 수리 라운드 B** 범위 3건', extra: 'dev 재투입 금지(구 지시) · 라운드 B 로 1회 해제' }),
      },
    })
    assert.deepEqual(queue._편성.picked.map((p) => p.key), ['2-1-a'])
  })

  it('규칙 4 — 열린 Patch 만 있고 미완 Task 0 이면 전제 미충족으로 제외(라운드 절은 사람이 연다)', () => {
    const { queue } = run({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': ['# s', 'Status: review', '## Tasks / Subtasks', '- [x] 끝', '## Review Findings', '- [ ] [Review][Patch] Tasks 밖(h2) 지적', '## Dev Notes'].join('\n') },
    })
    assert.ok(queue._편성.excluded[0].why.includes('전제 미충족'))
  })

  it('규칙 4 재료 — 사람 게이트 [ ] 는 기계 일감으로 세지 않는다(2-10 실사례)', () => {
    const s = readStorySignals(['## Tasks / Subtasks', '- [ ] **사람 게이트** 박사장 확인 대기', '## Dev Notes'].join('\n'))
    assert.equal(s.unfinishedTasks, 0)
  })

  it('규칙 5 — 회수끼리 File List 가 겹치면 같은 배치에 묶지 않는다', () => {
    const overlap = story({ findings: '- [ ] [Review][Patch] a' })
    const { queue } = run({
      sprint: '  2-1-a: review\n  2-2-b: review\n',
      stories: { '2-1-a': overlap, '2-2-b': overlap }, // 같은 src/a.ts
    })
    assert.equal(queue.batches.length, 2)
    assert.equal(queue.batches.every((b) => b.stories.length === 1), true)
  })

  it('규칙 5 — File List 서로소면 회수 2건을 한 배치로 묶는다(병렬 워크트리 안전)', () => {
    const a = story({ findings: '- [ ] [Review][Patch] a' })
    const b = a.replace('`src/a.ts`', '`src/b.ts`')
    const { queue } = run({ sprint: '  2-1-a: review\n  2-2-b: review\n', stories: { '2-1-a': a, '2-2-b': b } })
    assert.equal(queue.batches.length, 1)
    assert.equal(queue.batches[0].stories.length, 2)
  })

  it('규칙 5 — 마감 재검수(closeout · review 만)는 File List 가 겹쳐도 같은 에픽끼리 한 배치로 묶는다 (👤 2026-09-04 리뷰 병렬)', () => {
    // story() 기본 = 전부 [x] · Patch 0 · 같은 src/a.ts → 둘 다 closeout · 코드 무접촉이라 겹침이 병렬을 깨지 않는다
    const { queue } = run({ sprint: '  2-1-a: review\n  2-2-b: review\n', stories: { '2-1-a': story(), '2-2-b': story() } })
    assert.equal(queue.batches.length, 1, JSON.stringify(queue.batches))
    assert.deepEqual(queue.batches[0].stages, ['review'])
    assert.equal(queue.batches[0].stories.length, 2)
    assert.equal((queue.validation?.errors ?? []).length, 0, '검증기 ④ 가 review 전용 배치의 겹침을 충돌로 세면 안 된다')
  })

  it('규칙 6 — 부정문 「새 화면 0 이므로 목업 선행 대상이 아니다(UX-DR-27 단서)」 는 게이트 대상이 아니다 (2026-09-04 2.23 NO-OP STOP 실사고)', () => {
    const epics = '### Story 2.1: a\n**Then** 새 화면 0 이므로 목업 선행 대상이 아니다(UX-DR-27 단서) — 대신 스크린샷으로 잘림 0 을 확인한다.\n## 끝'
    const r = run({ sprint: '  2-1-a: backlog\n', epics })
    assert.equal(r.queue._편성.picked.length, 1, JSON.stringify(r.queue._편성.excluded))
    assert.ok(r.queue.batches.every((b) => !(b.stages ?? []).includes('mockup')), '부정문에 mockup 단계를 붙이면 워커가 NO-OP STOP 으로 배치를 세운다')
    // 같은 절 **안**에 긍정 언급이 하나라도 있으면 종전대로 대상이다(절은 다음 h2/h3 경계에서 끊긴다 — 문장은 「## 끝」 앞에 둔다)
    const bothEpics = '### Story 2.1: a\n**Then** 새 화면 0 이므로 목업 선행 대상이 아니다(UX-DR-27 단서).\n이 스토리는 새 화면 1장을 만든다(UX-DR-27).\n## 끝'
    const both = run({ sprint: '  2-1-a: backlog\n', epics: bothEpics })
    assert.ok(both.queue._편성.excluded[0]?.why.includes('목업 부재'), '긍정 언급이 있으면 게이트 적용(guarded = 승인 목업 부재로 제외): ' + JSON.stringify(both.queue._편성))
  })

  it('규칙 6 — 새 화면(UX-DR-27) backlog 는 승인 목업이 있어야 편성한다', () => {
    const epics = '### Story 2.1: a\n새 화면이므로 구현 전 목업 확인(UX-DR-27)\n## 끝'
    const blocked = run({ sprint: '  2-1-a: backlog\n', epics })
    assert.ok(blocked.queue._편성.excluded[0].why.includes('목업 부재'))
    const ok = run({
      sprint: '  2-1-a: backlog\n', epics,
      verdicts: { items: { 'mockups/story-2-1-x.html': { verdict: 'approved' } } },
    })
    assert.equal(ok.queue._편성.picked.length, 1)
  })

  it('규칙 7 — 하루 상한: 오늘 기편성 수를 빼고 남은 만큼만 고른다', () => {
    const fnd = '- [ ] [Review][Patch] a'
    const { root, stateDir, config } = fixture({
      sprint: '  2-1-a: review\n  2-2-b: review\n  2-3-c: review\n',
      stories: {
        '2-1-a': story({ findings: fnd }),
        '2-2-b': story({ findings: fnd }).replace('`src/a.ts`', '`src/b.ts`'),
        '2-3-c': story({ findings: fnd }).replace('`src/a.ts`', '`src/c.ts`'),
      },
    })
    writeFileSync(join(stateDir, 'auto-plan-state.json'), JSON.stringify({ days: { '2026-08-26': { planned: ['x'], stops: 0, consumed: {} } } }), 'utf8')
    const { queue } = plan({ root, stateDir, max: 3, today: '2026-08-26', config })
    assert.equal(queue._편성.picked.length, 2) // 상한 3 - 기편성 1
    assert.equal(queue._편성.excluded.some((e) => e.why.includes('상한')), true)
  })

  it('규칙 8→10 — review + 고칠 것 0 = 마감 재검수 후보(review→done) · in-progress 0/0 만 헛돈다 제외 (👤 08-28)', () => {
    const co = run({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story() } }) // 전부 [x] · Patch 0
    assert.deepEqual(co.queue.batches[0].stories, ['2-1-a'])
    assert.deepEqual(co.queue.batches[0].stages, ['review'])
    assert.deepEqual(co.queue.batches[0].models, { review: 'opus' })
    assert.ok(co.queue._편성.picked[0].why.includes('마감 재검수'))
    const ip = run({ sprint: '  2-1-a: in-progress\n', stories: { '2-1-a': story() } })
    assert.ok(ip.queue._편성.excluded[0].why.includes('헛돈다'))
  })

  it('규칙 8 — 신규는 create,dev,review · 회수는 dev+force', () => {
    const { queue } = run({
      sprint: '  2-1-a: in-progress\n  2-2-b: backlog\n',
      stories: { '2-1-a': story() }, // 전부 [x]
      epics: '### Story 2.2: b\n화면 없음\n## 끝',
    })
    assert.ok(queue._편성.excluded[0].why.includes('헛돈다'))
    assert.deepEqual(queue.batches[0].stages, ['create', 'dev', 'review'])
    const rec = run({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) } })
    assert.deepEqual(rec.queue.batches[0].stages, ['dev'])
    assert.equal(rec.queue.batches[0].force, true)
  })

  it('출력 계약 — planned=auto · night-queue 스키마(defaults·batches[].stories) · 근거 전건 기록', () => {
    const { queue } = run({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) } })
    assert.equal(queue.planned, 'auto')
    // toMatchObject — 부분 일치
    assert.equal(queue.defaults.commit, true)
    assert.equal(queue.defaults.push, true)
    assert.deepEqual(queue.batches[0].stories, ['2-1-a'])
    assert.ok(queue._편성.picked.length + queue._편성.excluded.length > 0)
  })

  it('파서 극단값 방어 — sprint 빈 파일이면 후보 0 이지 예외가 아니다 · 키 없는 줄 무시', () => {
    assert.deepEqual(parseSprint('# 주석뿐\n'), [])
    const { queue } = run({ sprint: '# 비어 있음\n' })
    assert.equal(queue.batches.length, 0)
  })
})

describe('[OPS-2] 규칙 9 v2 · 모델 장부 (2026-08-27 원탁 · 2026-08-30 무정지 개정)', () => {
  it('규칙 9 v2 — 무진전 편성 2회 연속이면 제외(폭주 백스톱 — 11-3 실사고 클래스 그대로 잡힌다)', () => {
    const fx = fixture({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) },
    })
    writeFileSync(join(fx.stateDir, 'auto-plan-state.json'), JSON.stringify({
      days: {
        '2026-08-25': { planned: ['2-1-a'], stops: 0, consumed: {} },
        '2026-08-26': { planned: ['2-1-a'], stops: 0, consumed: {} },
      },
    }), 'utf8')
    const { queue } = plan({ ...fx, max: 12, today: '2026-08-27' })
    assert.equal(queue.batches.length, 0)
    assert.ok(queue._편성.excluded[0].why.includes('무진전 편성 2회 연속'))
  })

  it('규칙 9 v2 — 진전(스토리 md 커밋)이 있으면 스트릭 0 리셋: 24h 무정지에서 「평생 2회」 사형 선고를 없앤다', () => {
    const fx = fixture({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) },
    })
    writeFileSync(join(fx.stateDir, 'auto-plan-state.json'), JSON.stringify({
      days: {
        // 종전 규칙이면 편성 3회 = 즉사. v2: 08-25 는 진전 있음 → 리셋, 무진전은 08-26 의 1회뿐
        '2026-08-24': { planned: ['2-1-a'], progressed: [], stops: 0, consumed: {} },
        '2026-08-25': { planned: ['2-1-a'], progressed: ['2-1-a'], stops: 0, consumed: {} },
        '2026-08-26': { planned: ['2-1-a'], progressed: [], stops: 0, consumed: {} },
      },
    }), 'utf8')
    const { queue } = plan({ ...fx, max: 12, today: '2026-08-27' })
    assert.deepEqual(queue.batches[0].stories, ['2-1-a']) // 스트릭 1 < 2 — 파이프라인이 계속 흐른다
  })

  it('규칙 9 v2 — 그날 편성되지 않았어도 progressed 면 스트릭 0 리셋(👤 2026-09-02 재편성 승인 무효 사고)', () => {
    const fx = fixture({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) },
    })
    writeFileSync(join(fx.stateDir, 'auto-plan-state.json'), JSON.stringify({
      days: {
        '2026-08-25': { planned: ['2-1-a'], progressed: [], stops: 0, consumed: {} },
        '2026-08-26': { planned: ['2-1-a'], progressed: [], stops: 0, consumed: {} }, // 여기서 스트릭 2 = 봉쇄
        // 편성 밖에서 들어온 진전 기재(사람의 재편성 승인 · 다른 세션의 스토리 md 커밋).
        // 종전 순서는 planned 가 비면 이 날을 통째로 건너뛰어 승인이 영원히 무효였다.
        '2026-08-27': { planned: [], progressed: ['2-1-a'], stops: 0, consumed: {} },
      },
    }), 'utf8')
    const { queue } = plan({ ...fx, max: 12, today: '2026-08-28' })
    assert.deepEqual(queue.batches[0].stories, ['2-1-a'])
  })

  it('규칙 9 v2 — progressed 가 없는 날의 편성은 그대로 누적된다(폭주 백스톱 무손실)', () => {
    const fx = fixture({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) },
    })
    writeFileSync(join(fx.stateDir, 'auto-plan-state.json'), JSON.stringify({
      days: {
        // 같은 날 무진전 2회(11-3 폭주 클래스) + 편성 0 인 무관한 날이 섞여도 리셋되지 않는다
        '2026-08-25': { planned: [], progressed: [], stops: 0, consumed: {} },
        '2026-08-26': { planned: ['2-1-a', '2-1-a'], progressed: [], stops: 0, consumed: {} },
      },
    }), 'utf8')
    const { queue } = plan({ ...fx, max: 12, today: '2026-08-27' })
    assert.equal(queue.batches.length, 0)
    assert.ok(queue._편성.excluded[0].why.includes('무진전 편성 2회 연속'))
  })

  it('규칙 9 v2 — 마감 재검수(closeout)는 상한 1회: 무진전 재검수 재반복은 즉시 사람 판단으로', () => {
    const fx = fixture({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story() } }) // 전부 [x] · Patch 0 = closeout
    writeFileSync(join(fx.stateDir, 'auto-plan-state.json'), JSON.stringify({
      days: { '2026-08-26': { planned: ['2-1-a'], progressed: [], stops: 0, consumed: {} } },
    }), 'utf8')
    const { queue } = plan({ ...fx, max: 12, today: '2026-08-27' })
    assert.equal(queue.batches.length, 0)
    assert.ok(queue._편성.excluded[0].why.includes('무진전 편성 1회 연속'))
  })

  it('/extend 상한 보너스 — cap-extend-<오늘>.json 의 extra 를 읽기 전용 가산(원장 직접 수정 없음)', () => {
    const mk = () => fixture({
      sprint: '  2-1-a: review\n  2-2-b: review\n',
      stories: {
        '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }),
        '2-2-b': story({ findings: '- [ ] [Review][Patch] b' }).replace('`src/a.ts`', '`src/b.ts`'),
      },
    })
    const base = mk()
    assert.equal(plan({ ...base, max: 1, today: '2026-08-27' }).queue._편성.picked.length, 1) // 보너스 없음 = 상한 1
    const ext = mk()
    writeFileSync(join(ext.stateDir, 'cap-extend-2026-08-27.json'), JSON.stringify({ extra: 1 }), 'utf8')
    const q = plan({ ...ext, max: 1, today: '2026-08-27' }).queue
    assert.equal(q._편성.picked.length, 2) // 상한 1+1
    assert.equal(q._편성.capBonus, 1)
    // 남의 날짜 보너스는 무효(자정이면 새 상한) — 파일명이 날짜를 물고 있다
    const stale = mk()
    writeFileSync(join(stale.stateDir, 'cap-extend-2026-08-26.json'), JSON.stringify({ extra: 9 }), 'utf8')
    assert.equal(plan({ ...stale, max: 1, today: '2026-08-27' }).queue._편성.picked.length, 1)
  })

  it('체인 게이트 — 미머지 체인 2일+ 이면 신규 착수만 보류 · 회수는 계속 (발견 16 — ③류 무한 축조 상한)', () => {
    const mk = (ageDays) => {
      const fx = fixture({
        sprint: '  2-1-a: review\n  2-2-b: backlog\n',
        stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) },
        epics: '### Story 2.2: b\n화면 없음\n## 끝',
      })
      writeFileSync(join(fx.stateDir, 'chain-info.json'), JSON.stringify({ ageDays }), 'utf8')
      return plan({ ...fx, max: 12, today: '2026-08-27' }).queue
    }
    const fresh = mk(1)
    assert.deepEqual(fresh._편성.picked.map((p) => p.key), ['2-1-a', '2-2-b']) // 1일이면 신규도 통과
    const aged = mk(2)
    assert.deepEqual(aged._편성.picked.map((p) => p.key), ['2-1-a']) // 회수는 계속
    assert.ok(aged._편성.excluded.find((e) => e.key === '2-2-b')?.why.includes('무머지 체인'))
    assert.equal(aged._편성.chainAgeDays, 2)
  })

  it('모델 장부 — 중요도 배정 + 교차검증(👤 2026-08-28): dev ≠ review 항상 · 소진 모델 미배정', () => {
    // ⚠️ 2026-08-30 개정: 원 장부는 회수 opus/fable · 신규 fable/opus 였다. Fable 전용 주간 한도가
    //    소진되면 `avoidExhaustedPair` 가 **짝 단위로** 대체하는데, 그때도 깨지면 안 되는 것은
    //    「dev ≠ review」(교차검증)와 「소진 모델 미배정」 둘이다. 리터럴이 아니라 그 불변식을 문다.
    const rec = run({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) } })
    const r = rec.queue.batches[0].models
    assert.equal(r.dev, 'opus', '회수 dev 는 상위 모델이어야 한다')
    assert.notEqual(r.review, r.dev, '같은 모델 자기 검증 금지 — 교차가 깨졌다')
    for (const m of EXHAUSTED_MODELS) assert.ok(!Object.values(r).includes(m), `소진 모델 ${m} 이 배정됐다`)
    // 신규(new) — 👤 2026-09-01 역할 분리 개정: fable = 지휘+판정(review), 실행 dev = opus 기본.
    //    fable 소진 중엔 avoidExhaustedPair 가 review 를 대체(opus)하고 dev 가 겹치면 sonnet 으로
    //    내린다 — 리터럴이 아니라 「dev = 실행급 · review ≠ dev · 소진 미배정」 불변식을 문다.
    const neu = run({ sprint: '  2-1-a: backlog\n', stories: {} })
    const n = neu.queue.batches[0].models
    assert.ok(['opus', 'sonnet'].includes(n.dev), '신규 dev 는 실행급(fable 은 지휘·판정 전용 — 09-01 개정)')
    assert.notEqual(n.dev, n.review, '교차가 깨졌다')
    for (const m of EXHAUSTED_MODELS) assert.ok(!Object.values(n).includes(m), `소진 모델 ${m} 이 배정됐다`)
  })
})

// ── 소진 모델 회피 (2026-08-30 실사고 회수) ──
//
// 실사고: Fable 전용 주간 한도가 100%(리셋 = 수요일)인데도 편성기는 회수 배치에 review: 'fable' 을,
// 엔진 사다리는 fable 우선을 유지해 매 슬롯이 소진 모델부터 프로브하며 밤이 통째로 비었다.
// 「모든 모델」 주간은 74% 로 여유가 있었다. 👤 2026-08-30 「fable 100% opus로 진행」.
// 이식판: 소진 목록은 config.exhaustedModels 가 소유하므로 avoidExhaustedPair 에 두 번째 인자로 넘긴다.
describe('[OPS] 소진 모델 회피 — 배정·사다리에서 빼고 대체를 쓴다', () => {
  it('소진 목록의 모델은 배정되지 않고 대체로 바뀐다', () => {
    // ⚠️ 짝 단위여야 한다 — 단계별로 따로 바꾸면 dev === review 가 되어 교차검증이 깨진다
    const 회수 = avoidExhaustedPair({ dev: 'opus', review: 'fable' }, EXHAUSTED_MODELS)
    assert.notEqual(회수.review, 'fable', '소진 모델이 그대로 배정된다')
    assert.notEqual(회수.dev, 회수.review, '교차검증이 깨졌다 — dev 와 review 가 같다')
    const 신규 = avoidExhaustedPair({ dev: 'fable', review: 'opus' }, EXHAUSTED_MODELS)
    assert.notEqual(신규.dev, 'fable')
    assert.notEqual(신규.dev, 신규.review, '교차검증이 깨졌다')
    // 소진이 아닌 짝은 손대지 않는다
    assert.deepEqual(avoidExhaustedPair({ dev: 'opus', review: 'sonnet' }, EXHAUSTED_MODELS), { dev: 'opus', review: 'sonnet' })
  })

  it('실제 편성 산출물에 소진 모델이 한 건도 없다 — 리터럴이 아니라 결과를 문다', () => {
    // 소스의 리터럴은 `avoidExhaustedPair(...)` 안에 남아 있는 것이 정상이다(원 장부 보존).
    // 막아야 하는 것은 **배정 결과**에 소진 모델이 실리는 것이다 — 그래서 결과를 판정한다.
    const rec = run({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) } })
    const neu = run({ sprint: '  2-1-b: backlog\n', stories: {} })
    const 배정 = [...rec.queue.batches, ...neu.queue.batches].flatMap((b) => Object.values(b.models ?? {}))
    assert.ok(배정.length > 0, '배정이 하나도 없다 — 픽스처가 후보를 못 만들었다')
    for (const m of EXHAUSTED_MODELS) assert.ok(!배정.includes(m), `편성 결과에 소진 모델 ${m} 이 실렸다`)
  })
})

// ── 판정 정규식의 표기 흔들림 (2026-08-30 실사고 회수) ──
//
// 실사고: `readStorySignals` 가 `- [ ] [Review][Patch]` **한 표기만** 셌는데 원장 2건이 굵게
// (`- [ ] **[Review][Patch][high] …`) 적혀 있어 **16건이 0건으로 읽혔다**. 결과는 배치 정지가
// 아니라 **품질 구멍**이었다 — 11.2 가 열린 결함 8건인 채 `closeout`(review→done 후보)으로
// 편성됐고, closeout 은 `stages: ['review']` · `force: true` 라 리뷰 한 번으로 done 이 될 수 있다.
// 「무인 실행이 조용히 틀리는」 갈래라 정지보다 나쁘다.
describe('[OPS] 열린 findings 판정 — 표기가 흔들려도 세야 한다', () => {
  const BOLD = '- [ ] **[Review][Patch][high] 굵게 적힌 열린 지적**'

  it('굵게·밑줄굵게·들여쓴 표기의 열린 findings 를 센다', () => {
    assert.equal(readStorySignals(BOLD).openPatches, 1, '굵게 표기를 못 센다 — 실사고 재발')
    assert.equal(readStorySignals('- [ ] __[Review][Patch] 밑줄 굵게').openPatches, 1)
    assert.equal(readStorySignals('  - [ ] **[Review][Patch] 들여쓴 항목').openPatches, 1)
    assert.equal(readStorySignals('- [ ] **[Review][Decision] 굵은 결정').openDecision, true)
    // 종전 표기(굵게 없음)도 그대로 세야 한다 — 회수가 기존 판정을 깨면 안 된다
    assert.equal(readStorySignals('- [ ] [Review][Patch] 종전 표기').openPatches, 1)
  })

  it('해소분(- [x])은 세지 않는다 — 회수한 항목이 다시 열린 것으로 잡히면 안 된다', () => {
    assert.equal(readStorySignals('- [x] **[Review][Patch] 해소됨').openPatches, 0)
    assert.equal(readStorySignals('- [x] [Review][Decision] 해소됨').openDecision, false)
  })

  it('결과 불변식 — 굵게 적힌 열린 Patch 가 있으면 done 후보(closeout)로 편성되지 않는다', () => {
    // 실사고 배치와 같은 배치: findings 가 Tasks 절 **밖**의 h2 에 있어 미완 Task 0 으로 읽힌다.
    const { queue } = run({
      sprint: '  2-1-a: review\n',
      stories: { '2-1-a': story({ extra: '## Review Findings — 4차\n' + BOLD }) },
    })
    const picked = queue._편성.picked.find((p) => p.key === '2-1-a')
    assert.notEqual(picked?.kind, 'closeout', '열린 결함 위에서 done 후보가 됐다 — 리뷰 1회로 done 이 되는 자리다')
    const why = queue._편성.excluded.find((e) => e.key === '2-1-a')?.why
    assert.ok(why?.includes('규칙 4'), '규칙 4(라운드 절은 사람이 연다)로 빠지지 않았다')
  })
})

// ── 계획 DAG·검증기·배정기 배선 (2026-09-02 「9점대 하네스」 · 시나리오 20 회귀) ──
//
// 위 30종은 **종전 규칙**을 문다(회귀 방지). 아래는 새로 배선한 3가지가 종전 큐 형식을
// 흔들지 않으면서 실제로 일하는지를 문다: ① 큐에 자기 검증 결과가 실린다 ② 검증에 걸린
// 스토리만 빠지고 나머지 배치는 그대로 나간다 ③ 배정기가 형식 위반 모델을 큐에 싣지 않는다.
describe('[OPS-F1] 계획 검증·배정 배선 — 큐 형식은 그대로', () => {
  it('정상 편성이면 validation.ok=true 이고 종전 필드(planned·defaults·batches)가 그대로다', () => {
    const { queue } = run({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) } })
    assert.equal(queue.validation.ok, true, JSON.stringify(queue.validation.errors))
    assert.deepEqual(queue.validation.errors, [])
    assert.equal(queue.planned, 'auto')
    assert.equal(queue.defaults.parallel, 2)
    assert.deepEqual(Object.keys(queue.batches[0]).sort(), ['enabled', 'force', 'label', 'models', 'stages', 'stories'])
  })

  it('선행(선행: N-M)이 done 이 아니면 그 스토리만 빠지고 나머지는 계속 나간다', () => {
    const { queue } = run({
      sprint: '  2-1-a: review\n  2-2-b: review\n',
      stories: {
        '2-1-a': story({ findings: '- [ ] [Review][Patch] a', extra: '선행: 2-9' }),
        '2-2-b': story({ findings: '- [ ] [Review][Patch] b' }).replace('`src/a.ts`', '`src/b.ts`'),
      },
    })
    assert.deepEqual(queue._편성.picked.map((p) => p.key), ['2-2-b'])
    assert.equal(queue.validation.ok, false)
    assert.ok(queue._편성.excluded.find((e) => e.key === '2-1-a')?.why.includes('계획 검증 실패'))
  })

  it('선행이 done 이면 통과한다 — 「선행」 표기가 스토리를 영구 봉쇄하지 않는다', () => {
    const { queue } = run({
      sprint: '  2-9-z: done\n  2-1-a: review\n',
      stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a', extra: '선행: 2-9' }) },
    })
    assert.deepEqual(queue._편성.picked.map((p) => p.key), ['2-1-a'])
    assert.equal(queue.validation.ok, true)
  })

  it('배정기 — cfg.models 의 형식 위반 스펙(셸 메타문자)은 큐에 실리지 않는다', () => {
    const cfg = { ...CONFIG, models: { recovery: { dev: 'opus; rm -rf /', review: 'sonnet' } }, exhaustedModels: [] }
    const fx = fixture({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story({ findings: '- [ ] [Review][Patch] a' }) } })
    const { queue } = plan({ ...fx, config: cfg, max: 12, today: '2026-08-26' })
    const m = queue.batches[0].models
    assert.ok(!String(m.dev).includes(';'), '메타문자 스펙이 그대로 실렸다')
    assert.notEqual(m.dev, m.review)
    assert.equal(queue.validation.ok, true)
  })

  it('codex 교차 리뷰 의도는 보존된다(가용성 판정은 엔진 몫) · 꺼져 있으면 종전 그대로', () => {
    const on = { ...CONFIG, providers: { codex: { enabled: true, roles: ['review'], reviewKinds: ['closeout'] } } }
    const fx = fixture({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story() } }) // closeout
    assert.equal(plan({ ...fx, config: on, max: 12, today: '2026-08-26' }).queue.batches[0].models.review, 'codex')
    const off = fixture({ sprint: '  2-1-a: review\n', stories: { '2-1-a': story() } })
    assert.equal(plan({ ...off, config: CONFIG, max: 12, today: '2026-08-26' }).queue.batches[0].models.review, 'opus')
  })
})
