// autofinish 단위 테스트 — 루프 판정 · 읽기 전용 보증 · 게이트 예산 · 인자 거부 · 큐 스키마.
//
// 실물 원칙: 「쓰기 0」은 **실제 git 저장소**의 porcelain 과 파일 지문으로 센다(주장 말고 측정).
// 게이트 횟수는 **주입한 실행기 호출 수**로 센다(로그 문장 말고 호출).
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { AUTOFINISH_SCHEMA, DEFAULTS, assertOutsideRepo, assertQueueDefaultsSafe, buildQueueFromPlan, candidatesFrom, defaultStateDir, deterministicPlan, loopDecision, parseArgs, roundSummary, runAutoFinish, storiesOfBmadPlan } from './autofinish.mjs'
import { buildDag, validatePlan } from './plan-dag.mjs'
import { createFakeProject } from './fixtures/fake-bmad-project.mjs'

const temps = []
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d }
const fixtures = []
after(() => {
  for (const fx of fixtures) { try { fx.cleanup() } catch { /* 잠긴 파일은 OS 가 정리 */ } }
  for (const d of temps) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 같음 */ } }
})
const project = (opts) => { const fx = createFakeProject(opts); fixtures.push(fx); return fx }

/** 저장소 전체의 내용 지문(.git 제외) — 「한 바이트도 안 바뀌었다」를 파일 단위로 센다. */
function treeDigest(root) {
  const h = createHash('sha256')
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.git') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      h.update(relative(root, p).replace(/\\/g, '/'))
      h.update(readFileSync(p))
      h.update(String(statSync(p).size))
    }
  }
  walk(root)
  return h.digest('hex')
}

// ═══════════════════════════════════════════════════════════════════════════
describe('loopDecision — 계속·중단·사람 호출', () => {
  const fp = (s) => ({ fingerprint: s, critical: 0 })

  it('진전이 있으면 continue', () => {
    const d = loopDecision({ round: 1, before: fp('aaa'), after: fp('bbb'), cfg: { maxRounds: 3, budgetMin: 480, elapsedMin: 10 } })
    assert.equal(d.action, 'continue')
  })

  it('백로그 지문이 그대로면 stop(무진전) — 한 번 더 돌려도 같다', () => {
    const d = loopDecision({ round: 1, before: fp('same'), after: fp('same'), cfg: { maxRounds: 3 } })
    assert.equal(d.action, 'stop')
    assert.equal(d.code, 'no-progress')
  })

  it('라운드 상한이면 stop(max-rounds)', () => {
    const d = loopDecision({ round: 3, before: fp('a'), after: fp('b'), cfg: { maxRounds: 3 } })
    assert.equal(d.action, 'stop')
    assert.equal(d.code, 'max-rounds')
  })

  it('상위 3단계가 늘면 escalate — 고치다 더 망가뜨린 것이라 라운드 상한보다 먼저 본다', () => {
    const d = loopDecision({
      round: 3,
      before: { fingerprint: 'a', critical: 2 },
      after: { fingerprint: 'b', critical: 5 },
      cfg: { maxRounds: 3 },
    })
    assert.equal(d.action, 'escalate')
    assert.equal(d.code, 'critical-increase')
    assert.match(d.why, /2건 → 5건/)
  })

  it('같은 원인 3회면 escalate(무한 재시도 금지)', () => {
    const d = loopDecision({
      round: 1,
      before: fp('a'),
      after: { fingerprint: 'b', critical: 0, signature: 'test:AssertionError' },
      cfg: { maxRounds: 5, signatures: ['test:AssertionError', 'test:AssertionError', 'test:AssertionError'] },
    })
    assert.equal(d.action, 'escalate')
    assert.equal(d.code, 'repeat-signature')
  })

  it('예산을 넘기면 stop(budget)', () => {
    const d = loopDecision({ round: 1, before: fp('a'), after: fp('b'), cfg: { maxRounds: 5, budgetMin: 60, elapsedMin: 61 } })
    assert.equal(d.action, 'stop')
    assert.equal(d.code, 'budget')
  })

  it('roundSummary 는 백로그(byTier)와 진단(counts.findings) 둘 다 같은 요약으로 읽는다', () => {
    assert.equal(roundSummary({ fingerprint: 'x', byTier: { 1: 1, 2: 2, 3: 3, 4: 9 } }).critical, 6)
    assert.equal(roundSummary({ fingerprint: 'x', counts: { findings: { 1: 1, 2: 0, 3: 2, 7: 5 } } }).critical, 3)
    assert.equal(roundSummary(null).critical, 0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('--diagnose-only — 대상 저장소에 한 바이트도 쓰지 않는다', () => {
  it('실제 git 저장소의 porcelain·트리 지문이 전후로 같다 · 게이트 0회 · 러너 0회', async () => {
    const fx = project()
    const state = tmp('af-state-')
    const before = { porcelain: fx.porcelain(), digest: treeDigest(fx.root), head: fx.git(['rev-parse', 'HEAD']).stdout.trim() }

    let gateCalls = 0
    let runnerCalls = 0
    const r = await runAutoFinish({
      root: fx.root, diagnoseOnly: true, gates: ['qa'], gatesExplicit: false, state, log: () => {},
      exec: () => { gateCalls++; return { status: 0, stdout: '', stderr: '' } },
      spawnRunner: () => { runnerCalls++; return { status: 0, stdout: '', stderr: '' } },
      planRunner: false,
    })

    assert.equal(fx.porcelain(), before.porcelain, 'porcelain 이 달라졌다 = 저장소에 썼다')
    assert.equal(treeDigest(fx.root), before.digest, '파일 내용이 달라졌다 = 저장소에 썼다')
    assert.equal(fx.git(['rev-parse', 'HEAD']).stdout.trim(), before.head, 'HEAD 가 움직였다 = 커밋했다')
    assert.equal(gateCalls, 0, '--diagnose-only 는 게이트를 돌리지 않는다')
    assert.equal(runnerCalls, 0, '--diagnose-only 는 러너를 띄우지 않는다')
    assert.equal(r.rounds.length, 1)
    assert.equal(r.exitCode, 0)
    // 판정은 나온다 — 「쓰지 않는다」가 「아무것도 안 한다」는 뜻이 아니다.
    assert.equal(r.report.verdict, 'not-ready')
    assert.ok(r.report.sections.length >= 10, '보고서 10절이 다 있어야 한다')
    assert.ok(readdirSync(r.outDir).some((n) => n === 'run.json'), '감사 산출물이 state 폴더에 남는다')
    // 「사람이 정해 줘야 넘어가는 것」은 진단의 결론이다 — 읽기 전용이어도 계산은 한다(쓰지만 않는다)
    const q = JSON.parse(readFileSync(join(r.outDir, 'round-0-questions.json'), 'utf8'))
    assert.equal(q.inboxPlan.op, 'skip')
    assert.ok(Array.isArray(q.questions))
    for (const one of q.questions) assert.ok(!/`|\.md\b|\.mjs\b/.test(one.title), `질문 제목에 개발 표기가 남았다: ${one.title}`)
    assert.equal(JSON.parse(readFileSync(join(r.outDir, 'run.json'), 'utf8')).schema, AUTOFINISH_SCHEMA)
  })

  // NEW-H2 — 예전에는 이 조합이 게이트를 1회 돌렸다. `npm run <게이트>` 는 코드젠·포맷으로 대상
  // 저장소에 임의로 쓸 수 있어 「읽기 전용」 보증이 그 자리에서 깨진다. 그래서 **거부**로 뒤집었다.
  it('--diagnose-only 에 --gates 를 함께 주면 조용히 무시하지 않고 거부한다(실행 0)', async () => {
    assert.throws(() => parseArgs(['--diagnose-only', '--gates', 'qa']), /--gates/)
    assert.throws(() => parseArgs(['--diagnose-only', '--gates', 'qa,build']), /--diagnose-only/)
    // `--no-gates` 를 덧붙여도 **거부**한다(codex-review-r5 Low) — 예전에는 조용히 `--no-gates` 가 이겨서
    // 사람은 「내가 적은 qa 가 돌았다」고 읽을 수 있었다. 상충 플래그는 모드와 무관하게 끊는다.
    assert.throws(() => parseArgs(['--diagnose-only', '--gates', 'qa', '--no-gates']), /--gates 와 --no-gates/)
    // `--no-gates` 단독은 모순이 없다(둘 다 「돌리지 마라」다)
    assert.deepEqual(parseArgs(['--diagnose-only', '--no-gates']).gates, [])
    // 명시하지 않으면 기본 `qa` 도 빈 배열로 접힌다 — 진단 전용의 게이트는 언제나 0 이다
    assert.deepEqual(parseArgs(['--diagnose-only']).gates, [])

    // 함수를 직접 부르는 길(주입 호출)도 같은 자리에서 막는다 · 저장소는 한 바이트도 안 바뀐다
    const fx = project()
    const state = tmp('af-state-')
    const digest = treeDigest(fx.root)
    let calls = 0
    await assert.rejects(() => runAutoFinish({
      root: fx.root, diagnoseOnly: true, gates: ['qa'], gatesExplicit: true, state, log: () => {},
      exec: () => { calls++; return { status: 0, stdout: 'ok', stderr: '' } },
      planRunner: false,
    }), /--gates/)
    assert.equal(calls, 0, '거부했는데 게이트가 돌았다')
    assert.equal(treeDigest(fx.root), digest)
  })

  // codex-review-r5 Low — 「함께 쓸 수 없다」가 문서 계약인데 코드는 조용히 한쪽을 이기게 뒀다.
  it('--gates 와 --no-gates 를 함께 주면 모드와 무관하게 거부한다', () => {
    assert.throws(() => parseArgs(['--gates', 'qa', '--no-gates']), /--gates 와 --no-gates/)
    assert.throws(() => parseArgs(['--no-gates', '--gates', 'qa,build']), /함께 쓸 수 없다/)
    assert.throws(() => parseArgs(['--diagnose-only', '--gates', 'qa', '--no-gates']), /함께 쓸 수 없다/)
    // codex-review-r6 Low — **값이 빠진** `--gates --no-gates` 도 상충이다. 예전엔 다음 토큰이
    // `--` 로 시작해 값이 null 이 되고, `gatesRaw !== null` 판정이 상충을 못 봐서 조용히
    // `--no-gates` 가 이겼다(고치려던 바로 그 오독). 판정은 `has('gates')` 여야 한다.
    assert.throws(() => parseArgs(['--gates', '--no-gates']), /함께 쓸 수 없다/)
    assert.throws(() => parseArgs(['--no-gates', '--gates']), /함께 쓸 수 없다/)
    // 값 없는 `--gates` 단독도 거부한다 — 조용히 기본 게이트로 돌리면 적으려던 목록이 사라진다
    assert.throws(() => parseArgs(['--gates']), /--gates 에 값이 없습니다/)
    assert.throws(() => parseArgs(['--gates', '--dry-run']), /--gates 에 값이 없습니다/)
    // 한쪽만 주면 종전 그대로다(거부가 「무조건」이 아님을 증명)
    assert.deepEqual(parseArgs(['--no-gates']).gates, [])
    assert.deepEqual(parseArgs(['--gates', 'qa,build']).gates, ['qa', 'build'])
    assert.deepEqual(parseArgs(['--gates', 'qa', '--dry-run']).gates, ['qa'])
  })

  it('--diagnose-only 는 gates 기본값이 실려 있어도 게이트를 0회 돌린다', async () => {
    const fx = project()
    const state = tmp('af-state-')
    let calls = 0
    const r = await runAutoFinish({
      root: fx.root, diagnoseOnly: true, gates: ['qa', 'build'], state, log: () => {},
      exec: () => { calls++; return { status: 0, stdout: 'ok', stderr: '' } },
      planRunner: false,
    })
    assert.equal(calls, 0)
    assert.deepEqual(r.gateCalls, {})
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NEW-H1 — 푸시는 설정으로도 켤 수 없다
describe('큐의 push 는 설정으로도 못 켠다', () => {
  it('queueDefaults.push:true 는 무시가 아니라 거부다(exit 코드 2 를 지닌 오류)', () => {
    assert.throws(() => assertQueueDefaultsSafe({ push: true }), (e) => e.exitCode === 2 && /사람 승인/.test(e.message))
    assert.throws(() => assertQueueDefaultsSafe({ push: 1 }), /push/)
    assert.throws(() => assertQueueDefaultsSafe({ push: 'yes' }), /push/)
    // 끈 값·없는 값은 통과한다
    assert.equal(assertQueueDefaultsSafe({}), true)
    assert.equal(assertQueueDefaultsSafe({ push: false }), true)
  })

  it('buildQueueFromPlan 은 push:true 를 받으면 큐를 만들지 않고, 그 밖에는 언제나 false 를 싣는다', () => {
    const plan = { batches: [{ label: 'x', stories: ['2-1-가'], stages: ['dev'] }] }
    assert.throws(() => buildQueueFromPlan(plan, null, null, { defaults: { push: true } }), /push/)
    assert.equal(buildQueueFromPlan(plan, null, null, {}).defaults.push, false)
    assert.equal(buildQueueFromPlan(plan, null, null, { defaults: { commit: true } }).defaults.push, false)
  })

  it('설정 파일에 push:true 가 있으면 runAutoFinish 가 부작용 전에 끊는다(산출물 0)', async () => {
    const fx = project()
    const state = tmp('af-state-')
    fx.write('tools/auto/auto.config.json', JSON.stringify({ autofinish: { queueDefaults: { push: true } } }, null, 2))
    const digest = treeDigest(fx.root)
    let spawned = 0
    await assert.rejects(() => runAutoFinish({
      root: fx.root, state, gates: [], log: () => {}, planRunner: false,
      spawnRunner: () => { spawned++; return { status: 0, stdout: '', stderr: '' } },
    }), (e) => e.exitCode === 2 && /push/.test(e.message))
    assert.equal(spawned, 0, '거부했는데 러너가 떴다')
    assert.equal(treeDigest(fx.root), digest)
    assert.equal(readdirSync(state).length, 0, '거부했는데 상태 폴더에 산출물이 생겼다')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NEW-H3 — state·out 은 대상 저장소 밖이어야 한다
describe('state·out 경로 경계 — 대상 저장소 안이면 거부한다', () => {
  it('저장소 안 경로 · 저장소 자신 · 저장소 안을 가리키는 junction 을 전부 거부한다', () => {
    const fx = project()
    const outside = tmp('af-outside-')
    // 밖은 통과한다
    assert.equal(assertOutsideRepo(fx.root, outside, '--state'), resolve(outside))
    // 안은 거부한다
    for (const bad of [fx.root, join(fx.root, 'src'), join(fx.root, 'README.md'), join(fx.root, 'a', 'b', 'c')]) {
      assert.throws(() => assertOutsideRepo(fx.root, bad, '--state'), (e) => e.exitCode === 2 && /저장소 안/.test(e.message), `거부하지 않았다: ${bad}`)
    }
    // 밖에 있는 링크가 안을 가리키면 거부한다(실제 junction/symlink 를 만든다)
    const link = join(outside, 'into-repo')
    let made = true
    try { symlinkSync(fx.root, link, 'junction') } catch { made = false } // 권한이 없으면 이 갈래만 건너뛴다
    if (made) {
      assert.throws(() => assertOutsideRepo(fx.root, join(link, 'state'), '--state'), /저장소 안/)
    }
  })

  it('runAutoFinish 는 --state·--out 이 저장소 안이면 부작용 전에 끊는다', async () => {
    const fx = project()
    const digest = treeDigest(fx.root)
    await assert.rejects(() => runAutoFinish({ root: fx.root, state: join(fx.root, 'src'), gates: [], log: () => {}, planRunner: false }),
      (e) => e.exitCode === 2 && /--state/.test(e.message))
    await assert.rejects(() => runAutoFinish({ root: fx.root, state: tmp('af-state-'), out: join(fx.root, 'README.md'), gates: [], log: () => {}, planRunner: false }),
      (e) => e.exitCode === 2 && /--out/.test(e.message))
    assert.equal(treeDigest(fx.root), digest, '거부했는데 저장소가 바뀌었다')
  })

  it('기본 상태 폴더(AUTO_BATCH_STATE_DIR)가 저장소 안이면 그것도 거부한다', async () => {
    const fx = project()
    const prev = process.env.AUTO_BATCH_STATE_DIR
    process.env.AUTO_BATCH_STATE_DIR = join(fx.root, '.state')
    try {
      await assert.rejects(() => runAutoFinish({ root: fx.root, gates: [], log: () => {}, planRunner: false }), /--state/)
      assert.ok(!existsSync(join(fx.root, '.state')), '거부했는데 폴더가 생겼다')
    } finally {
      if (prev === undefined) delete process.env.AUTO_BATCH_STATE_DIR
      else process.env.AUTO_BATCH_STATE_DIR = prev
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('게이트 예산 — 총호출 = 라운드 + 1', () => {
  it('qa 는 라운드마다 1회 + 마지막 1회 · build 는 마지막 1회뿐이다', async () => {
    const fx = project()
    const state = tmp('af-state-')
    const seen = []
    // 첫 라운드만 RED → 백로그 지문이 바뀌어 다음 라운드로 넘어간다(진전이 있어야 라운드가 늘어난다).
    const exec = (bin, args) => {
      const script = args[args.length - 1]
      seen.push(script)
      const isQa = script === 'qa'
      const red = isQa && seen.filter((s) => s === 'qa').length === 1
      return { status: red ? 1 : 0, stdout: red ? 'FAIL tests/x.test.ts\nAssertionError: nope' : '', stderr: '' }
    }
    const r = await runAutoFinish({
      root: fx.root, maxRounds: 3, gates: ['qa', 'build'], state, log: () => {},
      exec, spawnRunner: () => ({ status: 0, stdout: '', stderr: '' }), planRunner: false, bmadWrites: 'plan',
    })
    const qa = seen.filter((s) => s === 'qa').length
    const build = seen.filter((s) => s === 'build').length
    assert.equal(qa, r.rounds.length + 1, `qa 호출 ${qa} ≠ 라운드 ${r.rounds.length} + 1`)
    assert.equal(build, 1, 'build 는 마지막 1회뿐이다')
    assert.equal(r.gateCalls.qa, qa)
    assert.equal(r.gateCalls.build, build)
  })

  it('--no-gates 는 게이트를 한 번도 돌리지 않는다', async () => {
    const fx = project()
    const state = tmp('af-state-')
    let calls = 0
    const r = await runAutoFinish({
      root: fx.root, maxRounds: 2, gates: [], state, log: () => {},
      exec: () => { calls++; return { status: 0 } }, spawnRunner: () => ({ status: 0, stdout: '', stderr: '' }), planRunner: false,
    })
    assert.equal(calls, 0)
    assert.deepEqual(r.gateCalls, {})
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NEW-M2 — 예산은 「총합 상한」이 아니라 **절대 deadline** 이다
describe('예산 deadline — spawn timeout 을 잔여 시간으로 자르고, 다 쓰면 최종 게이트도 건너뛴다', () => {
  /** 진짜로 시간을 쓴다(가짜 시계가 아니라 실제 경과 시간으로 잰다). */
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

  it('--budget-min 이 짧고 스텁이 느리면 러너 timeout 이 잔여 시간으로 잘리고 · 예산 소진이 사유로 남는다', async () => {
    const fx = project()
    const state = tmp('af-state-')
    const budgetMin = 0.05 // 3초
    let runnerTimeout = null
    const r = await runAutoFinish({
      root: fx.root, state, maxRounds: 1, budgetMin, gates: ['qa'], log: () => {}, planRunner: false, dryRun: true,
      exec: () => { sleep(1500); return { status: 0, stdout: '', stderr: '' } },
      spawnRunner: (_bin, _args, opts) => { runnerTimeout = opts.timeout; sleep(2000); return { status: 0, stdout: '', stderr: '' } },
    })

    assert.ok(runnerTimeout !== null, '러너가 뜨지 않았다 — 이 시나리오가 성립하지 않는다')
    assert.ok(runnerTimeout > 0 && runnerTimeout < budgetMin * 60_000,
      `러너 timeout ${runnerTimeout}ms — 잔여 시간(<${budgetMin * 60_000}ms)으로 잘려야 한다`)
    assert.equal(r.budget.exhausted, true, '예산을 다 썼는데 소진으로 기록되지 않았다')
    assert.ok(r.budget.stops.some((s) => /예산 소진/.test(s)), `사유가 없다: ${JSON.stringify(r.budget.stops)}`)
    // 최종 게이트는 돌지 않았다 — qa 는 라운드 1회뿐이다(평소라면 라운드+1 = 2회)
    assert.equal(r.gateCalls.qa, 1, `qa ${r.gateCalls.qa}회 — 예산이 없으면 최종 게이트는 건너뛴다`)
    assert.equal(JSON.parse(readFileSync(join(r.outDir, 'run.json'), 'utf8')).budget.exhausted, true)
  })

  // ── codex-review-r5 Medium — deadline 이 「실제 hard stop」인가 ─────────────
  // 예전에는 timeout 을 자르기만 했다. 그래서 ① 자식이 마감을 넘겨 끝나도 `--no-gates` 면
  // `budget.exhausted:false` 였고 ② 마감 뒤에도 BMAD 등재(대상 저장소 쓰기)와 다음 라운드가 이어졌다.
  it('러너를 실제 자식 프로세스로 띄우고 마감을 넘기면 timeout 으로 죽는다 — --no-gates 여도 예산 소진이 남는다', async () => {
    const fx = project()
    const state = tmp('af-state-')
    const bin = tmp('af-bin-')
    // 60초를 자는 **실제 러너 스텁** — 반드시 마감(≈4.8초)에 걸려 죽는다.
    const sleeper = join(bin, 'sleep-runner.mjs')
    writeFileSync(sleeper, 'setTimeout(() => process.exit(0), 60_000)\n')

    const t0 = Date.now()
    const r = await runAutoFinish({
      root: fx.root, state, maxRounds: 2, budgetMin: 0.08, gates: [], log: () => {},
      planRunner: false, bmadWrites: 'plan', runner: sleeper,
    })
    const spent = Date.now() - t0

    const rn = r.rounds[0].runner
    assert.ok(rn && rn.skipped !== true, `러너가 뜨지 않았다 — 이 시나리오가 성립하지 않는다: ${JSON.stringify(rn)}`)
    assert.notEqual(rn.exit, 0, '자식이 timeout 으로 죽지 않았다(60초를 자는 스텁이다)')
    assert.ok(spent < 30_000, `${spent}ms 를 기다렸다 — 러너 timeout 이 잔여 예산으로 잘리지 않았다`)
    // 게이트가 하나도 없어도 「마감을 넘겼다」는 기록된다
    assert.deepEqual(r.gateCalls, {})
    assert.equal(r.budget.exhausted, true, '--no-gates 에서 예산 초과가 false 로 남았다')
    assert.ok(r.budget.stops.some((s) => /러너/.test(s)), `러너 초과 사유가 없다: ${JSON.stringify(r.budget.stops)}`)
    assert.equal(JSON.parse(readFileSync(join(r.outDir, 'run.json'), 'utf8')).budget.exhausted, true)
    assert.equal(r.rounds.length, 1, '마감을 넘겼는데 다음 라운드를 열었다(상한 2)')
    // 보고서 ⑧ — 안 돌린 것은 통과가 아니라 「모른다」다
    const nv = r.report.sections.find((s) => s.id === 'notVerified').lines.join('\n')
    assert.match(nv, /예산 소진/, `보고서 ⑧ 에 예산 소진이 실리지 않았다:\n${nv}`)
  })

  it('예산이 다하면 BMAD 등재(대상 저장소 쓰기)를 하지 않는다 — 파일 지문이 그대로다', async () => {
    const fx = project()
    const state = tmp('af-state-')
    const before = treeDigest(fx.root)
    let runnerCalls = 0
    const r = await runAutoFinish({
      root: fx.root, state, maxRounds: 2, budgetMin: 0.04, gates: ['qa'], log: () => {},
      planRunner: false, bmadWrites: 'on',
      exec: () => { sleep(2600); return { status: 0, stdout: '', stderr: '' } }, // 마감(2.4초)을 먹는 게이트
      spawnRunner: () => { runnerCalls++; return { status: 0, stdout: '', stderr: '' } },
    })

    const planned = JSON.parse(readFileSync(join(r.outDir, 'round-0-bmad-plan.json'), 'utf8'))
    assert.ok(planned.writes.length >= 1, '등재할 쓰기가 없다 — 이 시나리오가 성립하지 않는다')
    assert.equal(treeDigest(fx.root), before, '예산이 다한 뒤 BMAD 등재가 대상 저장소를 고쳤다')
    assert.equal(existsSync(join(r.outDir, 'round-0-bmad-apply.json')), false, '건너뛰었는데 적용 기록이 남았다')
    assert.equal(runnerCalls, 0, '예산이 다했는데 러너가 떴다')
    assert.equal(r.rounds.length, 1, '예산이 다했는데 다음 라운드를 열었다(상한 2)')
    assert.equal(r.budget.exhausted, true)
    assert.ok(r.budget.stops.some((s) => /BMAD 등재/.test(s)), `등재 중단 사유가 없다: ${JSON.stringify(r.budget.stops)}`)
  })

  it('시작 시점에 이미 마감이면 라운드를 한 번도 열지 않는다(스냅숏·게이트·러너 0)', async () => {
    const fx = project()
    const state = tmp('af-state-')
    const before = treeDigest(fx.root)
    // 시작 시각만 t0 이고 그 뒤로는 마감을 넘긴 시계 — 라운드 **진입** 검사만 남는 상황을 만든다.
    const t0 = Date.now()
    let first = true
    const now = () => { const d = new Date(first ? t0 : t0 + 10 * 60_000); first = false; return d }
    let gateCalls = 0, runnerCalls = 0
    const r = await runAutoFinish({
      root: fx.root, state, maxRounds: 3, budgetMin: 5, gates: ['qa'], log: () => {}, now,
      planRunner: false, bmadWrites: 'on',
      exec: () => { gateCalls++; return { status: 0, stdout: '', stderr: '' } },
      spawnRunner: () => { runnerCalls++; return { status: 0, stdout: '', stderr: '' } },
    })
    assert.equal(r.rounds.length, 0, '마감 뒤인데 라운드를 열었다')
    assert.equal(gateCalls, 0, '마감 뒤인데 게이트가 돌았다')
    assert.equal(runnerCalls, 0, '마감 뒤인데 러너가 떴다')
    assert.equal(existsSync(join(r.outDir, 'round-0-snapshot.json')), false, '라운드를 열지 않았는데 스냅숏이 남았다')
    assert.equal(treeDigest(fx.root), before, '마감 뒤인데 대상 저장소가 바뀌었다')
    assert.equal(r.budget.exhausted, true)
    assert.ok(r.budget.stops.some((s) => /라운드 0/.test(s)), `라운드 진입 중단 사유가 없다: ${JSON.stringify(r.budget.stops)}`)
  })

  it('예산이 넉넉하면 종전대로 최종 게이트까지 돈다(회귀 없음)', async () => {
    const fx = project()
    const state = tmp('af-state-')
    let timeouts = []
    const r = await runAutoFinish({
      root: fx.root, state, maxRounds: 1, budgetMin: 480, gates: ['qa'], log: () => {}, planRunner: false, dryRun: true,
      exec: () => ({ status: 0, stdout: '', stderr: '' }),
      spawnRunner: (_b, _a, o) => { timeouts.push(o.timeout); return { status: 0, stdout: '', stderr: '' } },
    })
    assert.equal(r.budget.exhausted, false)
    assert.equal(r.gateCalls.qa, 2, 'qa 는 라운드 1 + 마지막 1 이다')
    for (const t of timeouts) assert.ok(t > 0 && t <= 480 * 60_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NEW-M3 — BMAD 등재가 폐기되면 그 스토리는 이번 라운드에서 뺀다
describe('storiesOfBmadPlan — 쓰기 계획에 걸린 스토리 키를 뽑는다', () => {
  it('story:·new:·done: 그룹만 스토리로 세고 inbox 는 세지 않는다', () => {
    const keys = storiesOfBmadPlan({
      writes: [
        { group: 'story:2-1-가', path: 'a.md' },
        { group: 'new:3-1-나', path: 'b.md' },
        { group: 'new:3-1-나', path: 'sprint-status.yaml' },
        { group: 'done:1-1-다', path: 'c.md' },
        { group: 'inbox', path: 'DECISIONS-INBOX.md' },
        { path: '그룹 없음' },
      ],
    })
    assert.deepEqual(keys.sort(), ['1-1-다', '2-1-가', '3-1-나'])
    assert.deepEqual(storiesOfBmadPlan(null), [])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('인자 — 셸 메타문자·형식 위반은 실행 전에 거부한다', () => {
  const bad = [
    [['--root', 'C:/proj & git push origin main'], /경로/],
    [['--root', 'C:/proj;rm -rf /'], /경로/],
    [['--state', 'C:/s`whoami`'], /경로/],
    [['--out', 'C:/o$(id)'], /경로/],
    [['--plan-model', 'fable & git push'], /모델/],
    [['--plan-model', 'fable;rm'], /모델/],
    [['--gates', 'qa;rm -rf /'], /--gates/],
    [['--gates', 'qa,build|sh'], /--gates/],
    [['--bmad-writes', 'yes'], /--bmad-writes/],
    [['--max-rounds', '0'], /--max-rounds/],
    [['--max-rounds', 'abc'], /--max-rounds/],
    [['--budget-min', '-3'], /--budget-min/],
  ]
  for (const [argv, re] of bad) {
    it(`거부: ${argv.join(' ')}`, () => {
      assert.throws(() => parseArgs(argv), re)
    })
  }

  it('정상 인자는 그대로 읽는다', () => {
    const o = parseArgs(['--root', 'C:/Projects/jng-os', '--diagnose-only', '--no-gates', '--state', 'C:/tmp/s', '--out', 'C:/tmp/r.md', '--max-rounds', '2', '--bmad-writes', 'on', '--plan-model', 'codex:gpt-5.6-sol'])
    assert.equal(o.root, 'C:/Projects/jng-os')
    assert.equal(o.diagnoseOnly, true)
    assert.deepEqual(o.gates, [])
    assert.equal(o.maxRounds, 2)
    assert.equal(o.bmadWrites, 'on')
    assert.equal(o.planModel, 'codex:gpt-5.6-sol')
  })

  it('기본값은 설계서와 같다(라운드 3 · 예산 480분 · 게이트 qa · 계획 모델 fable · bmad 쓰기는 계획만)', () => {
    const o = parseArgs([])
    assert.equal(o.maxRounds, DEFAULTS.maxRounds)
    assert.equal(o.budgetMin, DEFAULTS.budgetMin)
    assert.deepEqual(o.gates, ['qa'])
    assert.equal(o.planModel, 'fable')
    assert.equal(o.bmadWrites, 'plan')
    assert.equal(o.diagnoseOnly, false)
  })

  it('상태 폴더 기본값은 대상 저장소 밖이다', () => {
    assert.ok(!defaultStateDir().includes('_bmad-output'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('큐 — run-night 스키마 그대로 · 검증기를 통과한다', () => {
  const stories = [
    { key: '2-1-가', epic: 2, kind: 'recovery', files: ['src/a.ts'], deps: [] },
    { key: '2-2-나', epic: 2, kind: 'recovery', files: ['src/b.ts'], deps: [] },
    { key: '2-3-다', epic: 2, kind: 'recovery', files: ['src/a.ts'], deps: [] },
  ]

  it('결정적 계획은 같은 파일을 만지는 스토리를 같은 배치에 넣지 않는다', () => {
    const dag = buildDag({ stories, epicOrder: [2] })
    const plan = deterministicPlan({ candidates: stories, dag, batchMax: 2 })
    const withA = plan.batches.filter((b) => b.stories.includes('2-1-가') || b.stories.includes('2-3-다'))
    for (const b of plan.batches) assert.ok(!(b.stories.includes('2-1-가') && b.stories.includes('2-3-다')), '같은 파일 두 스토리가 한 배치에 들어갔다')
    assert.ok(withA.length >= 2)
  })

  it('buildQueueFromPlan 결과가 night-queue 스키마이고 validatePlan 을 통과한다', () => {
    const dag = buildDag({ stories, epicOrder: [2] })
    const plan = deterministicPlan({ candidates: stories, dag, batchMax: 2, models: { '2-1-가': { dev: 'opus', review: 'fable' } } })
    const q = buildQueueFromPlan(plan, { fingerprint: 'bl1' }, { config: { parallel: 2, dailyCap: 30 } }, { date: '2026-09-03', round: 0, source: 'deterministic' })

    // 스키마 — plan-queue 산출물과 같은 키
    for (const k of ['planned', 'updated', 'defaults', 'batches', 'validation', '_편성']) assert.ok(k in q, `큐에 ${k} 가 없다`)
    assert.equal(q.planned, 'autofinish', '수동 큐 갈래를 타야 러너가 이 큐를 쓴다')
    for (const k of ['waitAuthMin', 'stageTimeoutMin', 'commit', 'push', 'parallel']) assert.ok(k in q.defaults, `defaults.${k} 가 없다`)
    assert.equal(q.defaults.push, false, '푸시는 기본으로 꺼져 있어야 한다(외부 반영은 사람 승인)')
    for (const b of q.batches) {
      assert.equal(b.enabled, true)
      assert.ok(Array.isArray(b.stories) && b.stories.length >= 1)
      assert.ok(Array.isArray(b.stages) && b.stages.every((s) => ['create', 'dev', 'review'].includes(s)))
    }
    assert.equal(q._편성.picked.length, 3)

    const v = validatePlan({ batches: q.batches }, dag, { knownKeys: stories.map((s) => s.key), epicOrder: [2], batchMax: 2 })
    assert.deepEqual(v.errors, [], `검증 오류: ${JSON.stringify(v.errors)}`)
    assert.equal(v.ok, true)
  })

  it('후보는 원장에 실재하고 md 가 있는 스토리만 · 자동 수리 금지 범주와 봉쇄는 사유와 함께 뺀다', () => {
    const snapshot = {
      stories: [
        { key: '2-1-가', epic: 2, exists: true, path: 'x/2-1-가.md', fileList: { declared: ['src/a.ts'] } },
        { key: '2-9-없음', epic: 2, exists: false, path: 'x/2-9-없음.md', fileList: { declared: [] } },
      ],
    }
    const backlog = {
      items: [
        { id: 'W1', story: '2-1-가', tier: 4, score: 10, state: 'open', autoFixAllowed: true, difficulty: 2, risk: 1 },
        { id: 'W2', story: '2-9-없음', tier: 4, score: 9, state: 'open', autoFixAllowed: true },
        { id: 'W3', story: '2-2-비밀', tier: 1, score: 99, state: 'open', autoFixAllowed: false },
        { id: 'W4', story: null, tier: 5, score: 1, state: 'open', autoFixAllowed: true },
      ],
      blocked: [],
    }
    const { candidates, excluded } = candidatesFrom({ backlog, snapshot, cap: 5, blocked: { '2-8-대기': '문구 결정 대기' } })
    assert.deepEqual(candidates.map((c) => c.key), ['2-1-가'])
    const why = Object.fromEntries(excluded.map((e) => [e.key, e.why]))
    assert.match(why['2-9-없음'], /md 가 없다/)
    assert.match(why['2-2-비밀'], /무인 수리 금지/)
    assert.match(why['2-8-대기'], /결정 대기로 봉쇄/, '봉쇄 사유가 사라지면 아침에 「왜 빠졌나」를 못 읽는다')
    assert.match(why['(스토리 밖)'], /1건/)
  })
})
