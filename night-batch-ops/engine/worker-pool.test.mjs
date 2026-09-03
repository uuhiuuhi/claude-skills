// 다중 프로바이더 워커 풀 규칙 테스트 (2026-09-02) — 순수 함수만 · LLM 0 · git 0.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PARALLEL_MAX, PROVIDER_DEFAULTS, WORKERS_ABS_MAX, applyIntegrationToManifest, assignProviders, blockedProviderFromExit, engineFlagsFromConfig,
  integrationGateDecision, parallelHazards, parallelPlan, parallelPlanWithWorkers, pickRunnable, providerConfig, specProvider,
} from './runner-rules.mjs'
import { plan } from './plan-queue.mjs'

describe('[workers] 설정 정규화 — 없으면 종전 동작(configured=false · Claude 전용 · 하드캡 3)', () => {
  it('빈 설정 → configured=false · codex 꺼짐 · workers.max=3 · autoRepair 0 · 통합 게이트 꺼짐', () => {
    const p = providerConfig({})
    assert.equal(p.configured, false)
    assert.equal(p.providers.codex.enabled, false)
    assert.equal(p.providers.codex.max, 1)
    assert.equal(p.workers.max, PARALLEL_MAX)
    assert.equal(p.workers.batchSize, 2)
    assert.equal(p.quality.autoRepair, 0)
    assert.equal(p.integrationGate.enabled, false)
    assert.deepEqual(providerConfig(undefined).workers, { max: 3, batchSize: 2 })
  })
  it('설정 → 절대 상한 6 클램프 · codex max>1 경고 · roles 검증 · autoRepair true=5/숫자/false', () => {
    const p = providerConfig({ workers: { max: 99, batchSize: 9 }, providers: { codex: { enabled: true, max: 3, roles: ['review', 'dev', 'bogus'] } }, quality: { autoRepair: true, sameRootCauseMaxRetries: 2 }, integrationGate: { enabled: true } })
    assert.equal(p.configured, true)
    assert.equal(p.workers.max, WORKERS_ABS_MAX)
    assert.equal(p.workers.batchSize, WORKERS_ABS_MAX)
    assert.equal(p.providers.codex.max, 3)
    assert.equal(p.warnings.length, 1)
    assert.deepEqual(p.providers.codex.roles, ['review', 'dev'])
    assert.equal(p.quality.autoRepair, 5)
    assert.equal(p.quality.sameRootCauseMaxRetries, 2)
    assert.equal(p.integrationGate.enabled, true)
    assert.equal(providerConfig({ quality: { autoRepair: 2 } }).quality.autoRepair, 2)
    assert.equal(providerConfig({ quality: { autoRepair: false } }).quality.autoRepair, 0)
    assert.equal(providerConfig({ quality: { autoRepair: true, totalRepairAttempts: 3 } }).quality.autoRepair, 3)
    assert.equal(providerConfig({ integrationGate: { enabled: false } }).integrationGate.enabled, false)
  })
  it('[#7] 폐지된 pushOnFail 은 정규화 결과에 남지 않고 경고만 남는다(조용히 먹지 않는다)', () => {
    const p = providerConfig({ integrationGate: { enabled: true, pushOnFail: true } })
    assert.equal(p.integrationGate.enabled, true)
    assert.equal(Object.hasOwn(p.integrationGate, 'pushOnFail'), false, 'pushOnFail 키 자체가 없어야 한다')
    assert.ok(p.warnings.some((w) => /pushOnFail 은 폐지됨/.test(w)), p.warnings.join('|'))
    // false 로 적어 둔 옛 설정도 「그런 스위치가 있다」는 오해를 남기므로 똑같이 경고한다
    assert.ok(providerConfig({ integrationGate: { enabled: true, pushOnFail: false } }).warnings.some((w) => /pushOnFail/.test(w)))
    assert.equal(providerConfig({ integrationGate: { enabled: true } }).warnings.length, 0)
  })
})

describe('[workers] 병렬 폭 — 종전 parallelPlan 과 같은 값(기본) · 설정으로만 확장 · 절대 상한 6', () => {
  it('maxWorkers 기본이면 parallelPlan 과 바이트 단위로 같다(하드캡 3 유지 — 기존 테스트 불변)', () => {
    for (const c of [{ storyCount: 5, stages: ['dev'], parallel: 8 }, { storyCount: 2, stages: ['dev'], parallel: 2 }, { storyCount: 2, stages: ['review'], parallel: 2 }, { storyCount: 1, stages: ['dev'], parallel: 2 }]) {
      assert.equal(parallelPlanWithWorkers(c), parallelPlan(c))
    }
    assert.equal(parallelPlanWithWorkers({ storyCount: 5, stages: ['dev'], parallel: 8 }), 3)
  })
  it('workers.max 로 확장 — 4폭 허용 · 6 초과는 6 · dev 없는 배치는 여전히 1', () => {
    assert.equal(parallelPlanWithWorkers({ storyCount: 5, stages: ['dev'], parallel: 4, maxWorkers: 6 }), 4)
    assert.equal(parallelPlanWithWorkers({ storyCount: 9, stages: ['dev'], parallel: 9, maxWorkers: 99 }), 6)
    assert.equal(parallelPlanWithWorkers({ storyCount: 5, stages: ['review'], parallel: 4, maxWorkers: 6 }), 1)
    assert.equal(parallelPlanWithWorkers({ storyCount: 5, stages: ['dev'], parallel: 4, maxWorkers: 2 }), 2)
  })
})

describe('[workers] 병렬 위험 — package.json/lock 은 한쪽만 만져도 병렬 불가(node_modules junction 공유)', () => {
  it('parallelHazards', () => {
    assert.equal(parallelHazards([['src/a.ts'], ['src/b.ts']]).ok, true)
    const h = parallelHazards([['src/a.ts'], ['package.json', 'src/b.ts']])
    assert.equal(h.ok, false)
    assert.match(h.why, /package\.json/)
    assert.equal(parallelHazards([['package-lock.json']]).ok, false)
    assert.equal(parallelHazards([]).ok, true)
    // 마이그레이션 둘 다 신규는 위험이 아니다(타임스탬프가 달라 git 충돌 없음 · 적대 검토 F35)
    assert.equal(parallelHazards([['supabase/migrations/1.sql'], ['supabase/migrations/2.sql']]).ok, true)
  })
  it('외부 판정기 주입 — judges 가 막으면 그 사유로 병렬 금지 · 통과시키면 그대로 · 던지면 「모르는 것」으로 막는다', () => {
    const lists = [['supabase/migrations/1.sql'], ['supabase/migrations/2.sql']]
    const seen = []
    const pass = (l) => { seen.push(l.length); return null }
    assert.equal(parallelHazards(lists, { judges: [pass] }).ok, true)
    assert.deepEqual(seen, [2], '판정기는 File List 전체를 받는다')
    const block = parallelHazards(lists, { judges: [pass, () => ({ ok: false, why: '같은 스키마 테이블을 둘 다 만진다' })] })
    assert.equal(block.ok, false)
    assert.match(block.why, /같은 스키마/)
    const boom = parallelHazards(lists, { judges: [() => { throw new Error('conflicts.mjs 없음') }] })
    assert.equal(boom.ok, false)
    assert.match(boom.why, /외부 병렬 판정기 오류/)
    // 내장 검사가 먼저다 — 판정기가 통과시켜도 package.json 은 막힌다
    assert.equal(parallelHazards([['package.json']], { judges: [() => ({ ok: true })] }).ok, false)
    assert.equal(parallelHazards(lists, { judges: [null, undefined] }).ok, true)
  })
})

describe('[workers] 프로바이더 배정 — 설정 없으면 배치 models 그대로 · split 은 홀수 번째만 codex · 교차 유지 · 레인 차단 재배정', () => {
  const codex = { ...PROVIDER_DEFAULTS.codex, enabled: true, roles: ['review', 'dev'], split: true }
  it('기본(codex 꺼짐) → 입력 그대로', () => {
    const a = assignProviders({ stories: ['s1', 's2'], batchModels: { dev: 'fable', review: 'opus' } })
    assert.deepEqual(a, [{ story: 's1', dev: 'fable', review: 'opus', devProvider: 'claude' }, { story: 's2', dev: 'fable', review: 'opus', devProvider: 'claude' }])
    assert.equal(specProvider('codex:gpt'), 'codex')
    assert.equal(specProvider(''), 'claude')
  })
  it('codex 가용 + dev 역할 + split → 두 번째 스토리는 codex dev / claude review(교차)', () => {
    const a = assignProviders({ stories: ['s1', 's2', 's3'], batchModels: { dev: 'fable', review: 'codex' }, codex, codexAvailable: true })
    assert.deepEqual(a.map((x) => `${x.devProvider}:${x.dev}/${x.review}`), ['claude:fable/codex', 'codex:codex/fable', 'claude:fable/codex'])
  })
  it('codex 불가(미설치·미인증) → 전부 claude(입력 그대로 · 엔진이 review=codex 는 스스로 폴백)', () => {
    const a = assignProviders({ stories: ['s1', 's2'], batchModels: { dev: 'fable', review: 'opus' }, codex, codexAvailable: false })
    assert.ok(a.every((x) => x.devProvider === 'claude' && x.dev === 'fable'))
  })
  it('roles 에 dev 없음 또는 split 아님 → codex dev 배정 없음', () => {
    assert.ok(assignProviders({ stories: ['a', 'b'], batchModels: { dev: 'fable' }, codex: { ...codex, roles: ['review'] }, codexAvailable: true }).every((x) => x.devProvider === 'claude'))
    assert.ok(assignProviders({ stories: ['a', 'b'], batchModels: { dev: 'fable' }, codex: { ...codex, split: false }, codexAvailable: true }).every((x) => x.devProvider === 'claude'))
  })
  it('codex 레인 차단(한도) → codex dev 는 claude 로 · review=codex 는 빈 값(엔진 교차 기본) · claude 차단 → codex 로', () => {
    const b = assignProviders({ stories: ['s1', 's2'], batchModels: { dev: 'fable', review: 'codex' }, codex, codexAvailable: true, blocked: ['codex'] })
    assert.deepEqual(b.map((x) => `${x.dev}/${x.review}`), ['fable/', 'fable/'])
    const c = assignProviders({ stories: ['s1'], batchModels: { dev: 'fable', review: 'opus' }, codex, codexAvailable: true, blocked: ['claude'] })
    assert.deepEqual(c[0], { story: 's1', dev: 'codex', review: 'fable', devProvider: 'codex' })
  })
})

describe('[workers] 풀 스케줄 — 프로바이더별 상한 · 총 상한 · 순서 보존 · 실패 격리는 호출부(한 워커의 종료가 다른 워커를 건드리지 않는다)', () => {
  const P = (story, devProvider) => ({ story, devProvider })
  it('codex 1 · claude 2 · 총 3: codex 둘은 동시에 못 뜬다 · claude 는 둘까지', () => {
    const pending = [P('a', 'codex'), P('b', 'codex'), P('c', 'claude'), P('d', 'claude'), P('e', 'claude')]
    const first = pickRunnable(pending, [], { total: 3, claude: 2, codex: 1 })
    assert.deepEqual(first.map((x) => x.story), ['a', 'c', 'd'])
    const next = pickRunnable([P('b', 'codex'), P('e', 'claude')], [P('a', 'codex'), P('c', 'claude'), P('d', 'claude')], { total: 3, claude: 2, codex: 1 })
    assert.deepEqual(next, [])
    const afterA = pickRunnable([P('b', 'codex'), P('e', 'claude')], [P('c', 'claude'), P('d', 'claude')], { total: 3, claude: 2, codex: 1 })
    assert.deepEqual(afterA.map((x) => x.story), ['b'])
  })
  it('서로소 스토리 2개 · 총 2 → 둘 다 즉시 · 빈 pending 은 빈 결과 · caps 결손은 기본값', () => {
    assert.equal(pickRunnable([P('a', 'claude'), P('b', 'claude')], [], { total: 2 }).length, 2)
    assert.deepEqual(pickRunnable([], [], {}), [])
    assert.equal(pickRunnable([P('a', 'claude'), P('b', 'claude'), P('c', 'claude'), P('d', 'claude')], [], { total: 6, claude: 3 }).length, 3)
  })
})

describe('[workers] 통합 게이트 판정 · 엔진 플래그 변환 · exit 정보', () => {
  it('integrationGateDecision — 꺼짐/landing 0 은 실행 안 함 · GREEN push · RED 는 rollback', () => {
    assert.equal(integrationGateDecision({ enabled: false, landedCount: 2 }).run, false)
    assert.equal(integrationGateDecision({ enabled: true, landedCount: 0 }).run, false)
    assert.equal(integrationGateDecision({ enabled: true, landedCount: 2 }).action, 'pending')
    assert.equal(integrationGateDecision({ enabled: true, landedCount: 2, qaExit: 0 }).action, 'push')
    assert.equal(integrationGateDecision({ enabled: true, landedCount: 2, qaExit: 1 }).action, 'rollback')
  })
  it('[#7] RED 는 **어떤 설정 조합으로도** push 로 바뀌지 않는다(pushOnFail·force·allowPush… 전부 무시)', () => {
    const evil = [
      { pushOnFail: true }, { pushOnFail: 'true' }, { pushOnFail: 1 }, { push: true }, { force: true },
      { allowPush: true }, { action: 'push' }, { skipPush: false }, { override: 'push-anyway' }, { pushOnFail: true, force: true },
    ]
    for (const extra of evil) {
      for (const qaExit of [1, 2, 5, 127, -1]) {
        const d = integrationGateDecision({ enabled: true, landedCount: 2, qaExit, ...extra })
        assert.equal(d.action, 'rollback', `${JSON.stringify(extra)} exit=${qaExit} → ${d.action}`)
        assert.ok(!/push-anyway/.test(JSON.stringify(d)), 'push-anyway 라는 결과 자체가 없어야 한다')
        assert.match(d.why, /push 금지/)
      }
    }
    // 반대 방향 — GREEN 을 rollback 으로 뒤집는 설정도 없다
    assert.equal(integrationGateDecision({ enabled: true, landedCount: 2, qaExit: 0, pushOnFail: false, force: true }).action, 'push')
  })
  it('[#17] applyIntegrationToManifest — pass/fail/rollback 병합 · 원본 불변 · 알 수 없는 값은 fail 로 닫는다', () => {
    const base = { schema: 'auto-story-finish/verification/1', checks: { qa: 'pass' } }
    const at = '2026-09-02T12:00:00.000Z'
    const pass = applyIntegrationToManifest(base, { result: 'pass', qaExit: 0, landingBase: 'abc123', at })
    assert.deepEqual(pass.integration, { result: 'pass', qaExit: 0, landingBase: 'abc123', at })
    assert.deepEqual(pass.checks, { qa: 'pass' }, '기존 필드 보존')
    assert.equal(Object.hasOwn(base, 'integration'), false, '원본 매니페스트는 변형되지 않는다')
    assert.equal(applyIntegrationToManifest(base, { result: 'rollback', qaExit: 1, landingBase: 'abc123', at }).integration.result, 'rollback')
    assert.equal(applyIntegrationToManifest(base, { result: 'fail', qaExit: 1, landingBase: 'abc123', at }).integration.result, 'fail')
    // 모르는 결과·빈 입력은 「통과」로 새지 않는다
    assert.equal(applyIntegrationToManifest(base, { result: 'push-anyway' }).integration.result, 'fail')
    assert.equal(applyIntegrationToManifest(null, {}).integration.result, 'fail')
    assert.equal(applyIntegrationToManifest(base, { result: 'pass' }).integration.qaExit, null)
    assert.match(applyIntegrationToManifest(base, { result: 'pass' }).integration.at, /^\d{4}-\d{2}-\d{2}T/)
    // 이전 통합 결과는 덮어쓴다(마지막 판정이 산다)
    assert.equal(applyIntegrationToManifest(pass, { result: 'rollback', qaExit: 1, landingBase: 'x', at }).integration.result, 'rollback')
    // (N6) batchId 는 **준 경우에만** 실린다 — rollback 증거·sidecar 가 어느 라운드의 판정인지 말해야
    // 이전 라운드 기록을 덮지 않는다. 안 주면 종전 4필드 그대로(하위 호환).
    const withId = applyIntegrationToManifest(base, { result: 'rollback', qaExit: 1, landingBase: 'abc123', at, batchId: '2026-09-02-17' })
    assert.deepEqual(withId.integration, { result: 'rollback', qaExit: 1, landingBase: 'abc123', at, batchId: '2026-09-02-17' })
    assert.equal(Object.hasOwn(applyIntegrationToManifest(base, { result: 'pass', batchId: '' }).integration, 'batchId'), false, '빈 batchId 는 싣지 않는다')
  })
  it('engineFlagsFromConfig — 설정 없으면 [](종전 명령줄 그대로) · 있으면 수리·프로바이더 플래그', () => {
    assert.deepEqual(engineFlagsFromConfig(providerConfig({})), [])
    // `--integrity` 는 **항상 명시**한다 — 엔진 기본이 on 으로 바뀌어(2026-09-02), 생략하면 설정의
    // auto(= autoRepair>0 일 때만)가 조용히 on 으로 승격된다. 설정이 곧 실행이어야 한다.
    assert.deepEqual(engineFlagsFromConfig(providerConfig({ quality: { autoRepair: true } })), ['--auto-repair', '5', '--repair-same-cause', '3', '--integrity', 'auto', '--no-codex'])
    assert.deepEqual(engineFlagsFromConfig(providerConfig({ quality: { integrity: 'off' } })), ['--integrity', 'off', '--no-codex'])
    const f = engineFlagsFromConfig(providerConfig({ providers: { codex: { enabled: true, roles: ['review'], network: true } } }))
    assert.deepEqual(f, ['--integrity', 'auto', '--providers', 'claude,codex', '--codex-roles', 'review', '--codex-max', '1', '--codex-network', 'on'])
    assert.ok(!engineFlagsFromConfig(providerConfig({ providers: { codex: { enabled: true } } })).includes('--codex-network'))
  })
  it('blockedProviderFromExit — limit/auth/spend 만 · 프로바이더 이름', () => {
    assert.equal(blockedProviderFromExit({ kind: 'limit', provider: 'codex' }), 'codex')
    assert.equal(blockedProviderFromExit({ kind: 'auth', provider: 'claude' }), 'claude')
    assert.equal(blockedProviderFromExit({ kind: 'qa', provider: 'claude' }), null)
    assert.equal(blockedProviderFromExit(null), null)
  })
})

describe('[plan-queue] Codex 교차 리뷰 배정 — providers.codex.enabled 일 때만 · new/closeout · recovery 는 대상 아님 · exhausted "codex" 회피', () => {
  const fixture = ({ sprint, stories = {}, config }) => {
    const root = mkdtempSync(join(tmpdir(), 'pq-codex-'))
    const art = join(root, '_bmad-output', 'implementation-artifacts')
    mkdirSync(art, { recursive: true })
    mkdirSync(join(root, '_bmad-output', 'planning-artifacts'), { recursive: true })
    writeFileSync(join(art, 'sprint-status.yaml'), sprint, 'utf8')
    writeFileSync(join(root, '_bmad-output', 'planning-artifacts', 'epics.md'), '', 'utf8')
    writeFileSync(join(art, 'DECISIONS-INBOX.md'), '', 'utf8')
    for (const [k, v] of Object.entries(stories)) writeFileSync(join(art, `${k}.md`), v, 'utf8')
    return { root, stateDir: mkdtempSync(join(tmpdir(), 'pq-state-')), config: { epicOrder: [2], mockupGate: { marker: '' }, ...config } }
  }
  const sprint = 'development_status:\n  2-1-new: backlog\n  2-2-closeout: review\n  2-3-recovery: review\n'
  const stories = {
    '2-2-closeout': '# S\n## Tasks / Subtasks\n- [x] T1\n### Review Findings\n- [x] [Review][Patch] a ✅\n## Dev Notes\n',
    '2-3-recovery': '# S\n## Tasks / Subtasks\n- [ ] T1\n### Review Findings\n- [ ] [Review][Patch] a\n## Dev Notes\n',
  }
  const byKey = (q) => Object.fromEntries(q.batches.map((b) => [b.stories[0], b]))
  it('꺼짐 → 종전 배정(new dev=fable/review=opus · closeout review=opus · recovery dev only)', () => {
    const fx = fixture({ sprint, stories, config: {} })
    const q = byKey(plan({ ...fx }).queue)
    assert.deepEqual(q['2-1-new'].models, { dev: 'fable', review: 'opus' })
    assert.deepEqual(q['2-2-closeout'].models, { review: 'opus' })
    assert.deepEqual(q['2-3-recovery'].models, { dev: 'opus', review: 'fable' })
  })
  it('켜짐 → new/closeout 의 review=codex · recovery 는 review 단계가 없어 그대로', () => {
    const fx = fixture({ sprint, stories, config: { providers: { codex: { enabled: true } } } })
    const q = byKey(plan({ ...fx }).queue)
    assert.deepEqual(q['2-1-new'].models, { dev: 'fable', review: 'codex' })
    assert.deepEqual(q['2-2-closeout'].models, { review: 'codex' })
    assert.deepEqual(q['2-3-recovery'].models, { dev: 'opus', review: 'fable' })
  })
  it('reviewKinds 로 좁힘 · roles 에 review 없으면 배정 없음 · exhausted 에 codex 면 짝 회피가 claude 로 돌린다', () => {
    const only = fixture({ sprint, stories, config: { providers: { codex: { enabled: true, reviewKinds: ['closeout'] } } } })
    const q1 = byKey(plan({ ...only }).queue)
    assert.equal(q1['2-1-new'].models.review, 'opus')
    assert.equal(q1['2-2-closeout'].models.review, 'codex')
    const noRole = fixture({ sprint, stories, config: { providers: { codex: { enabled: true, roles: ['dev'] } } } })
    assert.equal(byKey(plan({ ...noRole }).queue)['2-1-new'].models.review, 'opus')
    const ex = fixture({ sprint, stories, config: { providers: { codex: { enabled: true } }, exhaustedModels: ['codex'] } })
    const q3 = byKey(plan({ ...ex }).queue)
    assert.notEqual(q3['2-1-new'].models.review, 'codex')
    assert.notEqual(q3['2-1-new'].models.review, q3['2-1-new'].models.dev, '교차검증 유지')
  })
  it('workers.batchSize=3 이면 규칙 5 짝이 3개까지(기본 2 는 종전과 동일)', () => {
    const s3 = 'development_status:\n  2-1-a: review\n  2-2-b: review\n  2-3-c: review\n'
    const st = (f) => `# S\n## Tasks / Subtasks\n- [ ] T1\n### Review Findings\n- [ ] [Review][Patch] a\n### File List\n- \`${f}\`\n## Dev Notes\n`
    const stories3 = { '2-1-a': st('src/a.ts'), '2-2-b': st('src/b.ts'), '2-3-c': st('src/c.ts') }
    const two = fixture({ sprint: s3, stories: stories3, config: {} })
    assert.deepEqual(plan({ ...two }).queue.batches.map((b) => b.stories.length), [2, 1])
    const three = fixture({ sprint: s3, stories: stories3, config: { workers: { batchSize: 3 } } })
    assert.deepEqual(plan({ ...three }).queue.batches.map((b) => b.stories.length), [3])
  })
})

describe('[run-night] 배선 앵커 — 순수 규칙이 실제로 러너에 꽂혀 있다(배선이 죽으면 종전 동작으로 조용히 되돌아간다)', () => {
  const src = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  it('워커 풀·위험·통합 게이트·엔진 플래그·exit 정보·증거 보관이 배선돼 있다', () => {
    // `parallelHazards` 는 **확장 판정기 주입까지** 문다(2026-09-02 배선) — judges 가 빠지면
    // 마이그레이션 번호 경합·API 계약 충돌이 조용히 통과해 종전(겹침만 보던) 동작으로 되돌아간다.
    for (const s of ['pickRunnable(pending, [...running.values()], caps)', 'parallelHazards(lists, { judges: [parallelHazardsCompat] })', 'integrationGateDecision({ enabled: PCFG.integrationGate.enabled', "['reset', '--hard', landingBase]", 'engineFlagsFromConfig(PCFG)', 'blockedProviderFromExit(info)', 'archiveEvidence(wt)', 'parallelPlanWithWorkers({', 'applyIntegrationToManifest(']) assert.ok(src.includes(s), `누락: ${s}`)
  })

  it('[2026-09-02] 배정·계획·계측 배선이 살아 있다(하나라도 빠지면 하네스가 종전으로 되돌아간다)', () => {
    for (const s of [
      'assignWorkers({', 'writeAssignHistory(', 'readAssignHistory()', // 배정 + 기록(러너가 유일 작성자)
      'requestPlan({', 'applyOrchestrator(q, autoOut)', '[ORCHESTRATOR] source=', // Fable 계획 + 폴백 로그
      'summarizeTimeline(', 'renderMetricsTable(', 'metricsHistoryPath(STATE_DIR)', // 계측
      'PLAN_VALIDATION = q.validation', // 편성기 자기 검증 요약
    ]) assert.ok(src.includes(s), `누락: ${s}`)
    // 기본은 꺼짐 — 설정 키가 없으면 종전 동작이어야 한다
    assert.ok(src.includes("enabled: CFG.orchestrator?.enabled === true"), '오케스트레이터 기본 꺼짐이 아니다')
    assert.ok(src.includes('if (!ORCH.enabled) return'), '꺼졌는데도 실행기를 만들면 안 된다')
  })
  it('[#5] 러너는 pushOnFail 을 읽지 않는다 · reset 은 「불렀다」가 아니라 「되돌아갔다」를 확인한다', () => {
    assert.ok(!/PCFG\.integrationGate\.pushOnFail/.test(src), '러너가 폐지된 설정을 다시 읽으면 안 된다')
    assert.ok(!src.includes("gate.action === 'push-anyway'") && !src.includes('[FAIL→PUSH]'), 'RED→push 경로가 남아 있다')
    assert.ok(src.includes('const nowHead = headSha()') && src.includes('nowHead === landingBase'), 'reset 성공 검증 누락')
    assert.ok(src.includes('skipPush = true // reset'), 'reset 결과와 무관하게 push 를 먼저 막아야 한다')
    assert.ok(src.includes('worst = 7'), '되돌림 실패는 exit 코드를 올려야 한다')
  })
  it('[#16] 통합 결과가 스토리 매니페스트·배치 매니페스트로 간다 · 없는 매니페스트를 만들지 않는다', () => {
    assert.ok(src.includes('applyStoryManifests(integration)'))
    assert.ok(src.includes('batch-${batchId}-manifest.json'))
    assert.ok(src.includes('night-batch-ops/batch-manifest/1'))
    assert.ok(src.includes('if (!existsSync(p)) { missing.push(l.story); continue }'), '매니페스트가 없으면 경고만 — 새로 만들지 않는다')
    // 2026-09-04 — RED 되돌림(reset --hard)이 추적 로그 integration-gate.log 를 이전 라운드 내용으로 되돌려 원인이 사라졌다 → reset **전에** 상태 폴더 사본
    const iCopy = src.indexOf('integration-gate-${batchId}.log'), iReset = src.indexOf("['reset', '--hard', landingBase]")
    assert.ok(iCopy > 0 && iReset > iCopy, 'RED 게이트 로그 사본은 reset --hard 보다 앞에서 남긴다')
  })
  it('[#9] 증거 보관은 로그뿐 아니라 코드 diff·미추적 산출물·복구 절차를 남긴다 · 민감 경로는 애초에 제외', () => {
    for (const s of ["writeFileSync(join(dst, 'code.diff')", "join(dst, 'untracked', rel)", "writeFileSync(join(dst, 'summary.json')", "writeFileSync(join(dst, 'RESTORE.md')", 'EVIDENCE_DIFF_EXCLUDES', 'isSensitivePath(rel)', 'EVIDENCE_MAX_BYTES']) assert.ok(src.includes(s), `누락: ${s}`)
    assert.ok(src.includes("':(exclude)*.env'") && src.includes("':(exclude)*.pem'"), 'diff 생성 단계 제외 pathspec')
  })
  it('능력 감지는 셸 문자열 결합을 쓰지 않는다(argv 분리 · 메타문자 거부)', () => {
    assert.ok(src.includes("detectProviders({ want: ['codex'], exec: safeExec })"))
    assert.ok(src.includes('shell: false') && src.includes('SHELL_META_RE'))
    assert.ok(src.includes('windowsVerbatimArguments: true'), 'Windows .cmd 심은 cmd.exe 전용 경로로(공백 경로 대응)')
    // 2026-09-04 — 확장자 없는 bare 이름(`codex`)은 PATH 의 `.cmd` 심을 `where` 로 찾아야 한다(ENOENT → 「미설치」 오판 방지)
    assert.ok(src.includes("spawnSync('where', [file]"), '확장자 없는 bare 이름은 where 로 심을 찾는다')
    // 실동작은 e2e 가 문다 — CODEX_BIN 이 .cmd 스텁일 때 `[PROVIDERS] codex=YES(...)` 가 나온다
  })
  it('병렬 경로는 리허설(dry-run)에서 열리지 않는다 · 통합 게이트도 리허설이면 실행하지 않는다', () => {
    assert.ok(src.includes('if (par > 1 && !dryRun) {'))
    assert.ok(src.includes('if (gate0.run && !dryRun) {'))
  })
  it('통합 게이트 RED 는 push 를 막고 landing 을 되돌린다 · 성공분 태그 보존', () => {
    // 2026-09-02 N1 — push 는 병렬·순차가 **같은 함수**(pushBranchOnce)를 쓴다. 게이트가 막으면
    // 어떤 경로도 나가지 않는다는 조건은 그 함수 한 곳에 있다(종전 앵커 `if (defaults.push && !dryRun && !skipPush) {` 의 이사).
    assert.ok(src.includes('if (enabled && !dryRun && !skipPush) {'), 'push 는 skipPush 를 무조건 존중해야 한다')
    // (2026-09-03) 실제 push 는 push-guard.mjs 의 safeGitPush 가 소유한다 — 러너 안에 날 push 가 남으면 게이트를 우회한다.
    assert.equal((src.match(/spawnSync\('git', \['push',/g) ?? []).length, 0, '러너에 날 git push 가 남았다(우회 경로 금지)')
    assert.equal((src.match(/safeGitPush\(/g) ?? []).length, 1, '러너의 push 경로는 하나뿐이어야 한다')
    assert.ok(src.includes("pushBranchOnce({ enabled: Boolean(defaults.push), skipPush: gateOut.skipPush, record })"), '병렬·순차 모두 같은 push 함수를 쓴다')
    assert.ok(src.includes("`archive/integration-fail-${l.story}-${Date.now()}`"))
    assert.ok(src.includes('landedStories.push({ story: wt.story, head })'), 'landing 목록은 충돌 분기의 boolean `landed` 와 다른 변수여야 한다(2026-09-02 e2e 실측 충돌)')
  })
})
