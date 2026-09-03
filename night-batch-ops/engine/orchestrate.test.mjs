// 시나리오 18 — Fable 계획 검증·거부·deterministic fallback
//
// 실제 LLM 은 **호출하지 않는다**(BRIEF 금지). 실행기는 전부 주입 스텁이고, 검증기·파서는
// 실제 코드를 그대로 돈다. 무는 것은 하나다: 「LLM 계획이 조금이라도 어긋나면 규칙 계획으로
// 되돌아가고, 왜 되돌아갔는지가 plan.source 에 남는다」.
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDag } from './plan-dag.mjs'
import { writeShim } from './fixtures/stub-claude.mjs'
import {
  DEFAULT_PLAN_TIMEOUT_MS, PLAN_SCHEMA, RUNNER_ERROR_CODES, buildPlanPrompt, makeClaudePlanRunner, parsePlanResponse, requestPlan, validatePlanShape,
} from './orchestrate.mjs'

const temps = []
after(() => { for (const t of temps) { try { rmSync(t, { recursive: true, force: true }) } catch { /* 잠긴 파일은 OS 가 정리 */ } } })

const CANDIDATES = [
  { key: '2-1-a', epic: 2, kind: 'recovery', files: ['src/a.ts'], stages: ['dev'] },
  { key: '2-2-b', epic: 2, kind: 'recovery', files: ['src/b.ts'], stages: ['dev'] },
  { key: '2-3-c', epic: 2, kind: 'recovery', files: ['src/c.ts'], stages: ['dev'] },
]
const DAG = buildDag({ stories: CANDIDATES, epicOrder: [2, 3] })
const CONSTRAINTS = {
  knownKeys: ['2-1-a', '2-2-b', '2-3-c'],
  doneKeys: [],
  epicOrder: [2, 3],
  currentEpic: 2,
  cap: { limit: 10, plannedToday: [] },
  batchMax: 2,
}
const DETERMINISTIC = {
  planned: 'auto',
  batches: [{ label: 'AUTO-1', stories: ['2-1-a'], stages: ['dev'], models: { dev: 'opus', review: 'sonnet' } }],
}
const ctx = { date: '2026-09-02', candidates: CANDIDATES, history: [] }
const ask = (runner) => requestPlan({ context: ctx, dag: DAG, constraints: CONSTRAINTS, deterministic: DETERMINISTIC, runner })
const runnerOf = (payload) => () => (typeof payload === 'string' ? payload : JSON.stringify(payload))

describe('[18] Fable 계획 — 유효하면 채택', () => {
  it('후보 부분집합 + 제약 준수 계획을 채택하고 source=fable 을 남긴다', async () => {
    const r = await ask(runnerOf({
      rationale: '서로소 2건을 한 배치로',
      batches: [{ label: 'F-1', stories: ['2-1-a', '2-2-b'], stages: ['dev'], models: { dev: 'opus', review: 'sonnet' }, parallel: 2 }],
    }))
    assert.equal(r.source, 'fable')
    assert.equal(r.plan.source, 'fable')
    assert.deepEqual(r.plan.batches[0].stories, ['2-1-a', '2-2-b'])
  })

  it('`claude -p --output-format json` 봉투·코드펜스·앞뒤 잡문을 벗겨 낸다', async () => {
    const inner = JSON.stringify({ batches: [{ stories: ['2-3-c'], stages: ['dev'] }] })
    const envelope = await ask(runnerOf({ type: 'result', result: inner }))
    assert.equal(envelope.source, 'fable')
    const fenced = await ask(() => '계획입니다.\n```json\n' + inner + '\n```\n끝.')
    assert.equal(fenced.source, 'fable')
    assert.deepEqual(fenced.plan.batches[0].stories, ['2-3-c'])
  })
})

describe('[18] Fable 계획 — 거부하고 규칙 계획으로 되돌아간다', () => {
  const rejected = (r, whyIncludes) => {
    assert.equal(r.source.startsWith('deterministic-fallback('), true, `폴백이 아니다: ${r.source}`)
    assert.ok(r.source.includes(whyIncludes), `사유가 다르다: ${r.source}`)
    assert.deepEqual(r.plan.batches, DETERMINISTIC.batches, '규칙 계획 내용이 보존되지 않았다')
    assert.equal(r.plan.source, r.source)
  }

  it('지어낸 스토리 키 → 계획 전체 폐기', async () => {
    rejected(await ask(runnerOf({ batches: [{ stories: ['9-9-없는스토리'], stages: ['dev'] }] })), 'invented-story')
  })

  it('셸 메타문자 모델 스펙 → 거부(argv 로 나가는 값이다)', async () => {
    rejected(await ask(runnerOf({ batches: [{ stories: ['2-1-a'], stages: ['dev'], models: { dev: 'opus; rm -rf /' } }] })), 'schema')
    // 스키마를 통과하는 형태여도 검증기가 다시 문다(이중 방어)
    const r = await requestPlan({
      context: ctx, dag: DAG, constraints: CONSTRAINTS, deterministic: DETERMINISTIC,
      runner: () => JSON.stringify({ batches: [{ stories: ['2-1-a'], stages: ['dev'], models: { dev: 'opus' } }] }),
    })
    assert.equal(r.source, 'fable')
  })

  it('사이클 · 미해결 선행 → 검증기가 거부', async () => {
    const cyc = buildDag({ stories: [{ key: '2-1-a', epic: 2, kind: 'recovery', deps: ['2-2'] }, { key: '2-2-b', epic: 2, kind: 'recovery', deps: ['2-1'] }], epicOrder: [2] })
    assert.deepEqual(cyc.cycles, ['2-1-a', '2-2-b'])
    const rc = await requestPlan({
      context: ctx, dag: cyc, constraints: { ...CONSTRAINTS, knownKeys: ['2-1-a', '2-2-b'] }, deterministic: DETERMINISTIC,
      runner: runnerOf({ batches: [{ stories: ['2-1-a'], stages: ['dev'] }] }),
    })
    assert.equal(rc.source, 'deterministic-fallback(validator:cycle)')

    const dep = buildDag({ stories: [{ key: '2-2-b', epic: 2, kind: 'recovery', deps: ['2-1'] }], epicOrder: [2] })
    const rd = await requestPlan({
      context: { ...ctx, candidates: [{ key: '2-2-b' }] }, dag: dep,
      constraints: { ...CONSTRAINTS, knownKeys: ['2-2-b'], doneKeys: [] }, deterministic: DETERMINISTIC,
      runner: runnerOf({ batches: [{ stories: ['2-2-b'], stages: ['dev'] }] }),
    })
    assert.equal(rd.source, 'deterministic-fallback(validator:unresolved-dep)')
    // 선행이 done 이면 같은 계획이 통과한다 — 거부가 「무조건」이 아님을 증명
    const rok = await requestPlan({
      context: { ...ctx, candidates: [{ key: '2-2-b' }] }, dag: dep,
      constraints: { ...CONSTRAINTS, knownKeys: ['2-2-b'], doneKeys: ['2-1-a'] }, deterministic: DETERMINISTIC,
      runner: runnerOf({ batches: [{ stories: ['2-2-b'], stages: ['dev'] }] }),
    })
    assert.equal(rok.source, 'fable')
  })

  it('같은 배치 안 File List 겹침 → 거부(순차화는 규칙 계획이 한다)', async () => {
    const dag = buildDag({ stories: [{ key: '2-1-a', epic: 2, kind: 'recovery', files: ['src/x.ts'] }, { key: '2-2-b', epic: 2, kind: 'recovery', files: ['src/x.ts'] }], epicOrder: [2] })
    const r = await requestPlan({
      context: { ...ctx, candidates: [{ key: '2-1-a' }, { key: '2-2-b' }] }, dag,
      constraints: { ...CONSTRAINTS, knownKeys: ['2-1-a', '2-2-b'] }, deterministic: DETERMINISTIC,
      runner: runnerOf({ batches: [{ stories: ['2-1-a', '2-2-b'], stages: ['dev'] }] }),
    })
    assert.equal(r.source, 'deterministic-fallback(validator:batch-conflict)')
  })

  it('실행기 예외 · 타임아웃 · 비JSON · 빈 응답 · 실행기 부재 → 전부 폴백', async () => {
    rejected(await ask(() => { throw new Error('boom') }), 'runner-error')
    rejected(await ask(() => { const e = new Error('runner-timeout'); e.code = 'runner-timeout'; throw e }), 'runner-timeout')
    // 실행기가 **비동기**(실제 spawn 경로)여도 같은 자리에서 흡수된다 — codex-review-r6 Medium
    rejected(await ask(async () => { const e = new Error('runner-timeout'); e.code = 'runner-timeout'; throw e }), 'runner-timeout')
    rejected(await ask(() => '계획을 세울 수 없습니다.'), 'parse:not-json')
    rejected(await ask(() => ''), 'empty-response')
    rejected(await requestPlan({ context: ctx, dag: DAG, constraints: CONSTRAINTS, deterministic: DETERMINISTIC }), 'no-runner')
  })

  // NEW-H4 — `source` 에 외부 오류 원문을 담으면 `[ORCHESTRATOR] source=…` 로그가 토큰을 그대로 찍는다.
  // 상세는 `plan.errorDetail` 로만 가고, 그 자리는 산출물 쓰기 직전에 마스킹된다(E16 이 파일로 확인한다).
  it('실행기 오류 원문은 source 에 절대 실리지 않고 · errorDetail 로만 간다', async () => {
    const LEAK = 'Authorization: Bearer TOKENVALUE123456'
    const cases = [
      ['runner-error', () => { throw new Error(`boom ${LEAK}`) }],
      ['runner-nonzero', () => { const e = new Error('runner-nonzero'); e.code = 'runner-nonzero'; e.detail = `exit 1: ${LEAK}`; throw e }],
      ['runner-timeout', () => { const e = new Error('runner-timeout'); e.code = 'runner-timeout'; e.detail = 'signal SIGTERM'; throw e }],
    ]
    for (const [code, mk] of cases) {
      const r = await ask(mk)
      assert.equal(r.source, `deterministic-fallback(${code})`, `고정 코드가 아니다: ${r.source}`)
      assert.ok(!r.source.includes('TOKENVALUE123456'), `source 에 원문이 실렸다: ${r.source}`)
      assert.ok(!r.plan.source.includes('TOKENVALUE123456'), `plan.source 에 원문이 실렸다: ${r.plan.source}`)
      assert.ok(r.plan.errorDetail, '상세가 통째로 사라졌다 — 사람이 원인을 못 찾는다')
    }
    // 고정 코드는 세 개뿐이다 — 늘리면 로그로 새는 길이 다시 생긴다.
    assert.deepEqual([...RUNNER_ERROR_CODES], ['runner-error', 'runner-timeout', 'runner-nonzero'])
  })

  it('스키마 불일치(batches 없음 · stories 빈 배열 · 알 수 없는 단계) → 폴백', async () => {
    rejected(await ask(runnerOf({ plan: 'ok' })), 'schema')
    rejected(await ask(runnerOf({ batches: [{ stories: [] }] })), 'schema')
    rejected(await ask(runnerOf({ batches: [{ stories: ['2-1-a'], stages: ['deploy'] }] })), 'schema')
  })
})

describe('[18] 프롬프트·스키마·기본 실행기', () => {
  it('프롬프트에 후보·의존 간선·제약·스키마가 실린다', () => {
    const { prompt, schema } = buildPlanPrompt({ ...ctx, dag: DAG, constraints: CONSTRAINTS })
    assert.equal(schema, PLAN_SCHEMA)
    for (const c of CANDIDATES) assert.ok(prompt.includes(c.key), `후보 ${c.key} 가 프롬프트에 없다`)
    assert.ok(prompt.includes('밖의 스토리 키를 쓰면'))
    assert.ok(prompt.includes('"batches"'))
  })

  it('parsePlanResponse / validatePlanShape 는 형식 위반을 이름으로 말한다', () => {
    assert.equal(parsePlanResponse(null).error, 'empty')
    assert.equal(parsePlanResponse('x').error, 'not-json')
    assert.ok(parsePlanResponse('{"batches":[{"stories":[1]}]}').error.startsWith('schema:'))
    assert.deepEqual(validatePlanShape({ batches: [{ stories: ['2-1-a'] }] }), [])
  })

  it('기본 실행기는 셸 문자열이 아니라 argv 로 spawn 하고, 메타문자 모델·경로는 거부한다', async () => {
    let seen = null
    const spawn = (file, args, opts) => { seen = { file, args, opts }; return { status: 0, stdout: '{"batches":[]}', stderr: '' } }
    const run = makeClaudePlanRunner({ bin: 'claude', model: 'fable', spawn })
    assert.equal(await run('프롬프트'), '{"batches":[]}')
    assert.equal(seen.file, 'claude')
    assert.deepEqual(seen.args, ['-p', '--model', 'fable', '--output-format', 'json'])
    assert.equal(seen.opts.shell, false)
    assert.equal(seen.opts.input, '프롬프트')
    // Windows .cmd 심은 셸이 아니라 cmd.exe 전용 경로로만 지난다
    const shim = makeClaudePlanRunner({ bin: 'C:/Program Files/claude.cmd', model: 'opus', spawn, env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } })
    await shim('p')
    assert.equal(seen.file, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(seen.args.slice(0, 4), ['/d', '/s', '/c', 'C:/Program Files/claude.cmd'])
    assert.equal(seen.opts.shell, false)
    assert.throws(() => makeClaudePlanRunner({ model: 'fable; rm -rf /', spawn }), /모델 스펙 거부/)
    assert.throws(() => makeClaudePlanRunner({ bin: 'claude && evil', model: 'fable', spawn }), /실행파일 경로 거부/)
    // 비0 종료·시그널은 예외 → requestPlan 이 폴백으로 흡수한다.
    // 오류 **메시지는 고정 코드**고, stderr 원문은 `detail` 로만 나온다(NEW-H4).
    const bad = makeClaudePlanRunner({ model: 'fable', spawn: () => ({ status: 1, stdout: '', stderr: 'nope' }) })
    await assert.rejects(() => bad('p'), (e) => e.message === 'runner-nonzero' && e.code === 'runner-nonzero' && /exit 1: nope/.test(e.detail))
    // 원인 없는 signal 은 종전대로 안전 폴백(runner-timeout)이다
    const killed = makeClaudePlanRunner({ model: 'fable', spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }) })
    await assert.rejects(() => killed('p'), (e) => e.message === 'runner-timeout' && e.code === 'runner-timeout')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// codex-review-r5 Medium — 계획 실행기도 전체 예산의 hard stop 안에 있어야 한다.
// 예전에는 고정 180초라, 마감이 1분 남았어도 계획 한 번이 3분을 더 쓸 수 있었다.
describe('[18] 계획 실행기 예산 — 설정 상한과 잔여 예산 중 짧은 쪽으로 자른다', () => {
  it('실제 자식 프로세스가 timeout 을 넘기면 죽고 · requestPlan 이 runner-timeout 으로 흡수한다', async () => {
    const T = mkdtempSync(join(tmpdir(), 'nbo-plan-'))
    temps.push(T)
    // 2.5초를 자고서야 계획을 내는 **실제 프로세스** — 0.3초 상한에 걸려 죽어야 한다.
    const script = join(T, 'sleeper.mjs')
    writeFileSync(script, 'setTimeout(() => { console.log(JSON.stringify({ batches: [] })) }, 2500)\n')
    const shim = writeShim(join(T, 'bin'), 'sleepy', script)

    const run = makeClaudePlanRunner({ bin: shim, model: 'fable', timeoutMs: 300 })
    let thrown = null
    try { await run('프롬프트') } catch (e) { thrown = e }
    assert.ok(thrown, '자식이 죽지 않고 계획을 냈다 — timeout 이 걸리지 않았다')
    assert.equal(thrown.code, 'runner-timeout', `오류 코드가 다르다: ${thrown.code} · ${thrown.message}`)

    // 죽은 실행기는 밤을 세우지 않는다 — 규칙 계획으로 되돌아간다
    const r = await requestPlan({ context: ctx, dag: DAG, constraints: CONSTRAINTS, deterministic: DETERMINISTIC, runner: run, timeoutMs: 250 })
    assert.equal(r.source, 'deterministic-fallback(runner-timeout)')
    assert.deepEqual(r.plan.batches, DETERMINISTIC.batches)
  })

  it('잔여 예산이 짧으면 잔여가 이기고 · 길면 설정 상한이 이긴다 · 안 주면 종전 기본값', async () => {
    const seen = []
    const spawn = (_file, _args, o) => { seen.push(o.timeout); return { status: 0, stdout: '{"batches":[]}', stderr: '' } }
    const run = makeClaudePlanRunner({ bin: 'claude', model: 'fable', timeoutMs: DEFAULT_PLAN_TIMEOUT_MS, spawn })
    await run('p')                                  // 잔여를 주지 않으면 설정 상한 그대로(회귀 없음)
    await run('p', null, { timeoutMs: 5_000 })      // 잔여가 짧으면 잔여
    await run('p', null, { timeoutMs: 900_000 })    // 잔여가 길어도 상한을 넘지 않는다
    assert.deepEqual(seen, [DEFAULT_PLAN_TIMEOUT_MS, 5_000, DEFAULT_PLAN_TIMEOUT_MS])
    assert.equal(DEFAULT_PLAN_TIMEOUT_MS, 180_000, '기본 상한이 바뀌면 예산을 안 주는 기존 호출의 동작이 달라진다')

    // requestPlan 은 받은 잔여를 실행기에 그대로 넘긴다(주입 실행기도 볼 수 있어야 한다)
    let got = 'not-called'
    await requestPlan({
      context: ctx, dag: DAG, constraints: CONSTRAINTS, deterministic: DETERMINISTIC, timeoutMs: 1234,
      runner: (_p, _s, opts) => { got = opts?.timeoutMs ?? null; return JSON.stringify({ batches: [] }) },
    })
    assert.equal(got, 1234)
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// codex-review-r6 Low — 「error + signal」을 통째로 timeout 으로 읽으면 진단이 거짓말을 한다.
// 마감에 걸린 실행도, `maxBuffer` 를 넘긴 실행도 **똑같이** error 와 signal 을 함께 준다.
// 순서를 ETIMEDOUT → 일반 error → signal 로 두어야 출력 과다가 예산 초과로 둔갑하지 않는다.
describe('[18] 실행 실패 분류 — 예산 초과와 출력 과다를 뒤섞지 않는다', () => {
  it('maxBuffer 초과(ENOBUFS)는 runner-error 다 — 실제 프로세스가 8MB 를 넘겨 뱉는다', async () => {
    const T = mkdtempSync(join(tmpdir(), 'nbo-flood-'))
    temps.push(T)
    // 실행기의 상한은 8MB 다. 12MB 를 뱉어 확실히 넘긴다(자는 프로세스가 아니라 **떠드는** 프로세스).
    const script = join(T, 'flood.mjs')
    writeFileSync(script, "const chunk = 'x'.repeat(1024 * 1024)\nfor (let i = 0; i < 12; i++) process.stdout.write(chunk)\n")
    const shim = writeShim(join(T, 'bin'), 'floody', script)

    const run = makeClaudePlanRunner({ bin: shim, model: 'fable', timeoutMs: 60_000 })
    let thrown = null
    try { await run('프롬프트') } catch (e) { thrown = e }
    assert.ok(thrown, '8MB 를 넘겼는데 그대로 통과했다 — 이 시나리오가 성립하지 않는다')
    assert.equal(thrown.code, 'runner-error',
      `출력 과다가 ${thrown.code} 로 분류됐다 — 운영자가 예산을 늘리며 헛발질한다: ${thrown.detail}`)
    assert.match(String(thrown.detail), /ENOBUFS/, `사유에 실제 원인이 없다: ${thrown.detail}`)

    // 밤은 계속 돈다 — 사유만 정확해진다
    const r = await requestPlan({ context: ctx, dag: DAG, constraints: CONSTRAINTS, deterministic: DETERMINISTIC, runner: run, timeoutMs: 60_000 })
    assert.equal(r.source, 'deterministic-fallback(runner-error)')
    assert.deepEqual(r.plan.batches, DETERMINISTIC.batches)
  })

  it('진짜 timeout 만 runner-timeout 이고 · 원인 없는 signal 은 종전대로 안전 폴백이다', async () => {
    // 우리 타이머가 죽인 표식(timedOut) — ETIMEDOUT 과 같은 자리
    const timed = makeClaudePlanRunner({ model: 'fable', spawn: () => ({ status: null, signal: 'SIGTERM', timedOut: true, error: Object.assign(new Error('spawn timeout'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }) })
    await assert.rejects(() => timed('p'), (e) => e.code === 'runner-timeout')
    // 표식이 없어도 ETIMEDOUT 이면 timeout
    const etime = makeClaudePlanRunner({ model: 'fable', spawn: () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }) })
    await assert.rejects(() => etime('p'), (e) => e.code === 'runner-timeout')
    // 그 밖의 error 는 signal 이 붙어 있어도 runner-error
    const other = makeClaudePlanRunner({ model: 'fable', spawn: () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('x'), { code: 'EACCES' }), stdout: '', stderr: '' }) })
    await assert.rejects(() => other('p'), (e) => e.code === 'runner-error' && /EACCES/.test(e.detail))
    // 원인 없는 signal 은 안전 폴백(runner-timeout) — 종전 동작 보존
    const sig = makeClaudePlanRunner({ model: 'fable', spawn: () => ({ status: null, signal: 'SIGKILL', error: null, stdout: '', stderr: '' }) })
    await assert.rejects(() => sig('p'), (e) => e.code === 'runner-timeout')
  })
})
