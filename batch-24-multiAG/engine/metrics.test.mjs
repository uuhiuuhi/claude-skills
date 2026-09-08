// metrics.mjs 테스트 — 2026-09-02 「9점대 하네스」 (워커 F2)
// 실제 파일·실제 프로세스로 문다. 스텁 assertion 금지.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  appendJsonl, compareRuns, METRICS_HISTORY_FILE, metricsHistoryPath, parseCodexUsage,
  parseEngineLog, percentile, renderComparison, renderMetricsTable, summarizeTimeline, writeJsonAtomic,
} from './metrics.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'nbo-metrics-'))

// 실제 엔진이 남기는 형식 그대로(auto-story-pipeline.mjs note() — 현황판도 읽는 고정 형식)
const LOG = [
  '[2026-09-02T18:00:00.000Z] → [2-1-a] dev (model=fable, perm=sandbox:workspace-write)',
  '[2026-09-02T18:00:00.000Z] [2-1-a][CLAUDE][DEV] start model=fable cwd=/w/wt0',
  '[2026-09-02T18:00:10.000Z]    exit=0 log=/w/2-1-a-dev.log',
  '[2026-09-02T18:00:10.000Z] → [2-1-a] qa-gate: npm run qa',
  '[2026-09-02T18:00:12.000Z]    qa exit=1 log=/w/2-1-a-qa.log',
  '[2026-09-02T18:00:12.000Z] → [2-1-a] dev-repair (model=opus, perm=sandbox:workspace-write)',
  '[2026-09-02T18:00:12.000Z] [2-1-a][CODEX][REPAIR] start model=gpt-5 cwd=/w/wt0',
  '[2026-09-02T18:00:20.000Z]    exit=0 log=/w/2-1-a-dev-repair-1.log',
  '[2026-09-02T18:00:20.000Z] → [2-1-a] qa-gate: npm run qa',
  '[2026-09-02T18:00:21.000Z]    qa exit=0 log=/w/2-1-a-qa.log',
  '[2026-09-02T18:00:21.000Z] → [2-1-a] review (model=opus, perm=read-only)',
  '[2026-09-02T18:00:21.000Z] [2-1-a][CLAUDE][REVIEW] start model=opus cwd=/w/wt0',
  '[2026-09-02T18:00:30.000Z]    exit=0 log=/w/2-1-a-review.log',
].join('\n')

test('parseEngineLog — 단계·프로바이더·역할·모델·exit·소요를 실제 로그 형식에서 뽑는다', () => {
  const evs = parseEngineLog(LOG)
  assert.equal(evs.length, 5)
  assert.deepEqual(evs.map((e) => e.stage), ['dev', 'qa', 'dev-repair', 'qa', 'review'])
  assert.equal(evs[0].provider, 'claude')
  assert.equal(evs[0].role, 'dev')
  assert.equal(evs[0].ms, 10_000)
  assert.equal(evs[1].stage, 'qa')
  assert.equal(evs[1].exit, 1)
  assert.equal(evs[2].provider, 'codex')
  assert.equal(evs[2].role, 'repair')
  assert.equal(evs[2].model, 'gpt-5')
  assert.equal(evs[4].role, 'review')
})

test('parseEngineLog — 닫히지 않은 단계는 지우지 않고 end=null 로 남긴다(죽은 워커를 숨기지 않는다)', () => {
  const evs = parseEngineLog('[2026-09-02T18:00:00.000Z] → [x] dev (model=opus, perm=p)')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].end, null)
  assert.equal(evs[0].exit, null)
})

test('percentile — nearest-rank(결정적)', () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20)
  assert.equal(percentile([10, 20, 30, 40], 95), 40)
  assert.equal(percentile([5], 50), 5)
  assert.equal(percentile([], 50), 0)
})

const storyEv = (story, s, e, exit = 0) => ({ kind: 'story', story, provider: 'claude', model: 'fable', start: s, end: e, ms: Date.parse(e) - Date.parse(s), exit })

test('summarizeTimeline — 유휴·병렬 효율 산식이 정의대로다(워커수×벽시계 − 점유)', () => {
  const evs = [
    { kind: 'batch', start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:00:40.000Z' },
    storyEv('a', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:30.000Z'),
    storyEv('b', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:10.000Z'),
    ...parseEngineLog(LOG),
  ]
  const s = summarizeTimeline(evs, { workers: 2, quality: { highFindings: 0, integration: 'pass' } })
  assert.equal(s.wallMs, 40_000)
  assert.equal(s.occupancyMs, 40_000) // 30s + 10s
  assert.equal(s.idleMs, 2 * 40_000 - 40_000)
  assert.equal(s.idleRatio, 0.5)
  // 직렬 합 = 단계 합 10+2+8+1+9 = 30s → 30/(2×40)
  assert.equal(s.serialMs, 30_000)
  assert.equal(s.parallelEfficiency, 0.375)
})

test('summarizeTimeline — p50/p95 · 재시도 · 모델 호출량이 스토리 단위로 집계된다', () => {
  // 스토리 5개(10·20·30·40s + 로그의 2-1-a 30s) → 정렬 [10,20,30,30,40] · p50=v[2] · p95=v[4]
  const evs = [
    storyEv('a', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:10.000Z'),
    storyEv('b', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:20.000Z'),
    storyEv('c', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:30.000Z'),
    storyEv('d', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:40.000Z'),
    ...parseEngineLog(LOG),
  ]
  const s = summarizeTimeline(evs, { workers: 2, tokens: { codex: { 'gpt-5': { total: 1234 } } } })
  assert.equal(s.p50Ms, 30_000)
  assert.equal(s.p95Ms, 40_000)
  assert.equal(s.retries.repairRounds, 1, 'dev-repair 1회')
  assert.equal(s.retries.providerSwitches, 2, 'claude→codex→claude')
  const codex = s.modelCalls.find((m) => m.provider === 'codex')
  assert.equal(codex.calls, 1)
  assert.equal(codex.tokens, 1234)
  assert.equal(s.tokens, 1234)
  assert.ok(s.modelCalls.every((m, i, arr) => i === 0 || arr[i - 1].provider <= m.provider), '정렬 결정적')
})

test('summarizeTimeline — 결정성: 같은 입력은 같은 출력 · 스토리 나열 순서는 결과를 바꾸지 않는다', () => {
  const sa = storyEv('a', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:30.000Z')
  const sb = storyEv('b', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:10.000Z')
  const stages = parseEngineLog(LOG)
  const a = JSON.stringify(summarizeTimeline([sa, sb, ...stages], { workers: 2 }))
  // 같은 입력(독립 파싱본) — 같은 출력
  assert.equal(a, JSON.stringify(summarizeTimeline([storyEv('a', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:30.000Z'), storyEv('b', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:10.000Z'), ...parseEngineLog(LOG)], { workers: 2 })))
  // 스토리 나열 순서만 바꿔도 같은 출력(집계는 정렬 뒤에 한다). 단계 순서는 의미가 있으므로 유지한다.
  assert.equal(a, JSON.stringify(summarizeTimeline([sb, sa, ...stages], { workers: 2 })))
})

test('qualityGate — qa RED · high 잔여 · 통합 RED · 워커 STOP 을 각각 잡는다', () => {
  const base = [{ kind: 'batch', start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:00:10.000Z' }, storyEv('a', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:10.000Z')]
  const green = summarizeTimeline([...base, ...parseEngineLog(LOG)], { workers: 1 })
  assert.equal(green.qualityGate.passed, true, green.qualityGate.why)

  assert.equal(summarizeTimeline([...base, ...parseEngineLog(LOG)], { workers: 1, quality: { qaExit: 1 } }).qualityGate.passed, false)
  assert.match(summarizeTimeline([...base, ...parseEngineLog(LOG)], { workers: 1, quality: { highFindings: 2 } }).qualityGate.why, /high 2건/)
  assert.match(summarizeTimeline([...base, ...parseEngineLog(LOG)], { workers: 1, quality: { integration: 'rollback' } }).qualityGate.why, /통합 게이트 rollback/)
  const stop = summarizeTimeline([{ kind: 'batch', start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:00:10.000Z' }, storyEv('a', '2026-09-02T18:00:00.000Z', '2026-09-02T18:00:10.000Z', 1), ...parseEngineLog(LOG)], { workers: 1 })
  assert.equal(stop.qualityGate.passed, false)
  assert.match(stop.qualityGate.why, /워커 STOP a/)
  // qa 단계가 아예 없으면 「없음」 — 통과로 봐주지 않는다
  assert.match(summarizeTimeline(base, { workers: 1 }).qualityGate.why, /qa 결과 없음/)
})

test('compareRuns — 한쪽이라도 품질 미달이면 비교 제외로 표시된다', () => {
  const mk = (passed, wall) => ({ ...summarizeTimeline([{ kind: 'batch', start: '2026-09-02T18:00:00.000Z', end: new Date(Date.parse('2026-09-02T18:00:00.000Z') + wall).toISOString() }], { workers: 1 }), qualityGate: { passed, why: passed ? 'ok' : 'qa RED' } })
  const good = compareRuns(mk(true, 40_000), mk(true, 20_000))
  assert.equal(good.comparable, true)
  assert.equal(good.rows.find((r) => r.key === 'wallMs').direction, '개선')
  const bad = compareRuns(mk(true, 40_000), mk(false, 20_000))
  assert.equal(bad.comparable, false)
  assert.match(renderComparison(bad), /품질 미달 · 비교 제외/)
})

test('renderMetricsTable — 표 1개 · 품질 판정 포함', () => {
  const s = summarizeTimeline([{ kind: 'batch', start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:00:10.000Z' }, ...parseEngineLog(LOG)], { workers: 2 })
  const md = renderMetricsTable(s)
  assert.equal((md.match(/^\| --- \|/gm) ?? []).length, 1, '표 1개')
  assert.match(md, /품질 게이트 \| PASS/)
  assert.match(md, /병렬 효율/)
})

test('parseCodexUsage — turn.completed 토큰 합산(다른 줄이 섞여도)', () => {
  const t = ['not json', '{"type":"item.completed","item":{"type":"agent_message","text":"x"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":5,"total_tokens":11}}'].join('\n')
  const u = parseCodexUsage(t)
  assert.equal(u.turns, 2)
  assert.equal(u.input, 105)
  assert.equal(u.output, 25)
  assert.equal(u.total, 131)
})

test('writeJsonAtomic — tmp→rename · 결과가 완전한 JSON', () => {
  const d = tmp()
  try {
    const f = join(d, 'sub', 'metrics.json')
    writeJsonAtomic(f, { a: 1 })
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 1 })
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('appendJsonl — 실제 프로세스 2개가 동시에 append 해도 줄이 섞이지 않는다', () => {
  const d = tmp()
  try {
    const file = metricsHistoryPath(d)
    assert.ok(file.endsWith(METRICS_HISTORY_FILE))
    const script = join(d, 'w.mjs')
    writeFileSync(script, [
      `import { appendJsonl } from ${JSON.stringify(pathToFileURL(join(HERE, 'metrics.mjs')).href)}`,
      'const [file, tag] = process.argv.slice(2)',
      "for (let i = 0; i < 200; i++) appendJsonl(file, { tag, i, pad: 'x'.repeat(300) })",
    ].join('\n'))
    const procs = ['A', 'B'].map((tag) => spawnSync(process.execPath, [script, file, tag], { encoding: 'utf8' }))
    for (const p of procs) assert.equal(p.status, 0, p.stderr)
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 400)
    const parsed = lines.map((l) => JSON.parse(l)) // 한 줄이라도 섞였으면 여기서 throw
    assert.equal(parsed.filter((x) => x.tag === 'A').length, 200)
    assert.equal(parsed.filter((x) => x.tag === 'B').length, 200)
  } finally { rmSync(d, { recursive: true, force: true }) }
})
