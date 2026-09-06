#!/usr/bin/env node
// 하네스 벤치(스텁 실측) — 2026-09-02 「9점대 하네스」 (워커 F2)
//
// 무엇을 재나: **같은 스토리 세트**를 두 하네스로 각각 돌려 비교한다.
//   ① 기준선 = 종전 Claude-only(설정 없음 · parallel 1 · 순차)
//   ② 새 하네스 = parallel 2 · Codex 리뷰 · 확장 충돌 판정 · 배정(assign) · 통합 게이트
//
// ⚠️ **절대 시간은 의미가 없다** — claude/codex 는 스텁 프로세스이고 「생각하는 시간」이 0 이다.
// 여기서 뜻이 있는 것은 ㉠ 재시도 수 ㉡ 모델 호출 수 ㉢ 병렬 효율 ㉣ 워커 유휴 비율
// ㉤ **품질 게이트 통과 여부**뿐이다. 실제 LLM 실측은 이 파일이 하지 않는다(NOT VERIFIED).
//
// 왜 품질이 먼저인가: 품질을 깎아서 얻은 속도는 개선이 아니다. 두 실행 중 하나라도 품질
// 게이트(qa GREEN · 리뷰 high 0 · 통합 pass · 워커 STOP 0)를 못 넘기면 비교표는 수치 대신
// 「품질 미달 · 비교 제외」를 찍는다(metrics.compareRuns).
//
// 실행: node night-batch-ops/engine/bench.mjs --stub [--out <경로.md>] [--keep]
//   --stub  스텁 하네스로 실측(현재 유일한 모드 — 실 LLM 호출은 하지 않는다)
//   --out   비교표 경로(기본 references/hardening-2026-09-02/bench-stub.md)
//   --keep  임시 픽스처를 지우지 않는다(디버깅)

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareRuns, renderComparison, renderMetricsTable } from './metrics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const IS_WIN = process.platform === 'win32'
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${r.stderr || r.stdout}`) }

// ── 스텁 ─────────────────────────────────────────────────────────────────────
// e2e 픽스처와 **같은 규약**(CLAUDE_BIN/CODEX_BIN · stdin 프롬프트 · JSON 리뷰)을 쓴다.
const CLAUDE_STUB = String.raw`
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
const argv = process.argv.slice(2)
if (argv.includes('--version')) { console.log('2.1.250-stub (Claude Code)'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const cwd = process.cwd()
const art = join(cwd, '_bmad-output', 'implementation-artifacts')
const findStory = (key) => readdirSync(art).filter((f) => f.startsWith(key) && f.endsWith('.md')).sort((a, b) => a.length - b.length)[0]
const setSprint = (key, status) => { const p = join(art, 'sprint-status.yaml'); writeFileSync(p, readFileSync(p, 'utf8').replace(new RegExp('^(  ' + key + ':\\s*)\\S+', 'm'), '$1' + status)) }
if (prompt.trim() === 'ok') process.exit(0)
let m = /\/bmad-dev-story (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  const f = join(art, findStory(key))
  let md = readFileSync(f, 'utf8')
  const BT = String.fromCharCode(96)
  const files = [...md.matchAll(new RegExp('^- ' + BT + '([^' + BT + ']+)' + BT, 'gm'))].map((x) => x[1])
  for (const p of files) { mkdirSync(join(cwd, dirname(p)), { recursive: true }); writeFileSync(join(cwd, p), 'export const ' + key.replace(/-/g, '_') + ' = 1\n') }
  md = md.replace('- [ ] T1', '- [x] T1').replace(/^Status:\s*\S+/m, 'Status: review') + '\n### Dev Agent Record\n- stub dev done\n'
  writeFileSync(f, md)
  setSprint(key, 'review')
  console.log('dev 완료'); process.exit(0)
}
m = /\/bmad-code-review (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  const f = join(art, findStory(key))
  let md = readFileSync(f, 'utf8')
  md = md.replace(/^Status:\s*\S+/m, 'Status: done').replace('## Dev Notes', '### Review Findings — claude 스텁\n\n- ✅ Clean review — 발견 0건\n\n## Dev Notes')
  writeFileSync(f, md)
  setSprint(key, 'done')
  console.log('review 완료'); process.exit(0)
}
console.error('bench stub: 알 수 없는 프롬프트'); process.exit(1)
`

const CODEX_STUB = String.raw`
import { readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const ev = (o) => console.log(JSON.stringify(o))
if (argv.includes('--version')) { console.log('codex-cli 0.152.1-stub'); process.exit(0) }
if (argv[0] === 'login' && argv[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const out = argv[argv.indexOf('-o') + 1]
// clean 판정은 「스토리 파일과 리뷰 diff 를 실제로 읽은 증거」를 요구한다(providers/codex.validateReviewRun).
// 스텁도 같은 관문을 지나야 벤치가 실제 경로를 재는 것이 된다 — 증거 없는 clean 은 엔진이 무효 처리한다.
const BT = String.fromCharCode(96)
const story = /스토리 (\S+)/.exec(prompt)?.[1] ?? '?'
const diffFile = new RegExp('리뷰 대상 diff[^' + BT + ']*' + BT + '([^' + BT + ']+)' + BT).exec(prompt)?.[1] ?? ''
// (M6) 프롬프트의 "- 변경 파일:" 아래 들여쓴 목록도 **글자 그대로** 읽은 것으로 남긴다 — 엔진은
// 「변경 구현 파일 0건 열람」인 clean 을 무효 처리한다(NO-OP STOP exit 4). 확장자로 거르거나
// 따옴표를 벗기면 git C-인용 경로("…\355\214…")가 엔진의 문자열 대조와 어긋난다.
const changed = []
const lines = prompt.split(/\r?\n/)
for (let i = 0; i < lines.length; i++) {
  if (!/^-\s*변경 파일:/.test(lines[i])) continue
  for (let j = i + 1; j < lines.length; j++) {
    const mm = /^\s+-\s+(.+?)\s*$/.exec(lines[j])
    if (!mm) break
    if (!mm[1].startsWith('(')) changed.push(mm[1])
  }
}
const json = { summary: '스텁 리뷰', verdict: 'clean', acVerdicts: [{ ac: 'AC-1', status: 'pass', evidence: 'stub' }], findings: [] }
ev({ type: 'thread.started', thread_id: 't1' })
ev({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'cat _bmad-output/implementation-artifacts/' + story + '.md', exit_code: 0 } })
ev({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'cat ' + diffFile, exit_code: 0 } })
changed.slice(0, 12).forEach((p, i) => ev({ type: 'item.completed', item: { id: 'f' + i, type: 'command_execution', command: 'cat ' + p, exit_code: 0 } }))
ev({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: JSON.stringify(json) } })
ev({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 300 } })
if (out) writeFileSync(out, JSON.stringify(json))
process.exit(0)
`

const QA_SCRIPT = 'process.exit(0)\n'

const STORY = (key, file) => `# Story ${key}\n\nStatus: ready-for-dev\n\n## Acceptance Criteria\n\n- AC-1 x\n\n## Tasks / Subtasks\n\n- [ ] T1 구현\n\n### File List\n\n- \`${file}\`\n\n## Dev Notes\n\n없음\n`

/** 두 팔이 **같은 스토리 세트**를 받는다 — 비교의 전제다. */
export const BENCH_STORIES = Object.freeze([
  { key: '2-1-a', file: 'src/a.ts' },
  { key: '2-2-b', file: 'src/b.ts' },
])

/**
 * 벤치 픽스처(실제 git 저장소 + 실제 엔진 + 스텁 CLI). arm = 'baseline' | 'harness'
 * baseline = 설정 키 없음 · parallel 1(순차) — 배선 전 러너와 같은 경로
 * harness  = providers.codex(review) · workers 2 · autoRepair · integrationGate · parallel 2
 */
export function makeBenchFixture(arm, { root = tmpdir() } = {}) {
  const T = mkdtempSync(join(root, `nbo-bench-${arm}-`))
  const home = join(T, 'home'), state = join(T, 'state'), bin = join(T, 'bin'), proj = join(T, 'proj')
  for (const d of [home, state, bin]) mkdirSync(d, { recursive: true })
  const skill = join(home, '.claude', 'skills', 'auto-story-finish')
  mkdirSync(skill, { recursive: true })
  // 목록을 고정하지 않는다 — 엔진에 새 모듈(completion-rules…)이 생기면 픽스처만 구판이 되어 ERR_MODULE_NOT_FOUND 로 죽는다(2026-09-02 실측 2회).
  for (const f of readdirSync(join(REPO, 'auto-story-finish')).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) cpSync(join(REPO, 'auto-story-finish', f), join(skill, f))
  cpSync(join(REPO, 'auto-story-finish', 'providers'), join(skill, 'providers'), { recursive: true })
  writeFileSync(join(bin, 'claude-stub.mjs'), CLAUDE_STUB)
  writeFileSync(join(bin, 'codex-stub.mjs'), CODEX_STUB)
  if (IS_WIN) {
    writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude-stub.mjs" %*\r\n')
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-stub.mjs" %*\r\n')
  } else {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node "${join(bin, 'claude-stub.mjs')}" "$@"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec node "${join(bin, 'codex-stub.mjs')}" "$@"\n`, { mode: 0o755 })
  }
  const origin = join(T, 'origin.git')
  must(git(T, ['init', '-q', '--bare', origin]), 'bare')
  must(git(T, ['clone', '-q', origin, proj]), 'clone')
  for (const kv of [['user.email', 'bench@test'], ['user.name', 'bench'], ['core.autocrlf', 'false']]) must(git(proj, ['config', ...kv]), 'cfg')
  const art = join(proj, '_bmad-output', 'implementation-artifacts')
  mkdirSync(join(art, 'auto-pipeline-logs'), { recursive: true })
  mkdirSync(join(proj, 'tools', 'auto'), { recursive: true })
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'bench', type: 'module', scripts: { qa: 'node tools/qa.mjs' } }, null, 2))
  writeFileSync(join(proj, 'tools', 'qa.mjs'), QA_SCRIPT)
  writeFileSync(join(proj, '.gitignore'), 'node_modules\n.env*\n')
  // nested 워커의 commit/push deny 설정 — 엔진은 이게 없으면 시작조차 하지 않는다(2026-09-02 fail-closed).
  mkdirSync(join(proj, '.claude'), { recursive: true })
  writeFileSync(join(proj, '.claude', 'pipeline-settings.json'), JSON.stringify({
    permissions: { deny: ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git stash:*)', 'Bash(git reset:*)'] },
  }, null, 2))
  for (const s of BENCH_STORIES) writeFileSync(join(art, `${s.key}.md`), STORY(s.key, s.file))
  writeFileSync(join(art, 'sprint-status.yaml'), `last_updated: 2026-09-01\ndevelopment_status:\n${BENCH_STORIES.map((s) => `  ${s.key}: ready-for-dev`).join('\n')}\n`)
  writeFileSync(join(art, 'deferred-work.md'), '# Deferred\n')
  writeFileSync(join(art, 'DECISIONS-INBOX.md'), '# 결정 인박스\n')
  writeFileSync(join(art, 'auto-pipeline-logs', 'state.json'), '{"done":{}}\n')
  for (const f of readdirSync(HERE).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) cpSync(join(HERE, f), join(proj, 'tools', 'auto', f))

  const harness = arm === 'harness'
  writeFileSync(join(proj, 'tools', 'auto', 'auto.config.json'), JSON.stringify({
    project: 'bench', epicOrder: [2], dailyCap: 30, parallel: harness ? 2 : 1, stateDir: state,
    qa: 'node tools/qa.mjs', mockupGate: { marker: '' },
    ...(harness ? {
      workers: { max: 2, batchSize: 2 },
      providers: { codex: { enabled: true, max: 1, roles: ['review'] } },
      quality: { autoRepair: true },
      integrationGate: { enabled: true },
    } : {}),
  }, null, 2))
  writeFileSync(join(proj, 'tools', 'auto', 'night-queue.json'), JSON.stringify({
    planned: 'manual-bench',
    defaults: { commit: true, push: false, parallel: harness ? 2 : 1, stageTimeoutMin: 5, waitAuthMin: 0 },
    batches: [{
      label: `BENCH ${arm}`, enabled: true, stories: BENCH_STORIES.map((s) => s.key), stages: ['dev', 'review'],
      models: harness ? { dev: 'fable', review: 'codex' } : { dev: 'fable', review: 'opus' },
    }],
  }, null, 2))
  must(git(proj, ['add', '-A']), 'add')
  must(git(proj, ['commit', '-q', '-m', 'bench init']), 'commit')
  must(git(proj, ['push', '-q', 'origin', 'HEAD:main']), 'push')
  must(git(proj, ['branch', '-q', '-M', 'main']), 'branch')
  return { T, home, state, bin, proj, art, arm }
}

/** 러너 1회 실행 → 러너가 남긴 계측 요약(metrics-*.json)을 그대로 읽어 온다. */
export function runArm(fx, { timeoutMs = 300_000 } = {}) {
  const startedAt = Date.now()
  const r = spawnSync(process.execPath, [join(fx.proj, 'tools', 'auto', 'run-night.mjs'), '--queue', join(fx.proj, 'tools', 'auto', 'night-queue.json')], {
    cwd: fx.proj, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, USERPROFILE: fx.home, HOME: fx.home, AUTO_BATCH_STATE_DIR: fx.state,
      CLAUDE_BIN: join(fx.bin, IS_WIN ? 'claude.cmd' : 'claude'), CODEX_BIN: join(fx.bin, IS_WIN ? 'codex.cmd' : 'codex'),
      PIPELINE_NTFY_TOPIC: 'off',
    },
  })
  const logs = join(fx.art, 'auto-pipeline-logs')
  const file = existsSync(logs) ? readdirSync(logs).filter((n) => /^metrics-.*\.json$/.test(n)).sort().pop() : null
  const metrics = file ? JSON.parse(readFileSync(join(logs, file), 'utf8')) : null
  return { arm: fx.arm, exit: r.status, wallClockMs: Date.now() - startedAt, metrics, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const HEADER = [
  '# 하네스 벤치 (스텁 실측) — 2026-09-02',
  '',
  '> **절대 시간은 의미가 없다.** claude·codex 는 스텁 프로세스라 「생각하는 시간」이 0 이다.',
  '> 이 표에서 뜻이 있는 것은 **재시도 수 · 모델 호출 수 · 병렬 효율 · 워커 유휴 비율 ·',
  '> 품질 게이트 통과 여부**뿐이다. 벽시계·p50/p95 는 하네스 자체의 오버헤드(워크트리 생성 ·',
  '> landing · 통합 게이트) 를 보여 줄 뿐 LLM 작업 시간을 대표하지 않는다.',
  '>',
  '> **실제 LLM 실측 = NOT VERIFIED** — 이 파일은 실 모델을 한 번도 부르지 않았다.',
  '> 실측하려면 같은 스토리 세트를 실제 야간 배치로 두 번 돌리고 `metrics-history.jsonl` 의',
  '> 두 줄을 `metrics.compareRuns` 로 비교한다(품질 게이트를 통과한 실행끼리만).',
  '',
  '재현: `node night-batch-ops/engine/bench.mjs --stub`',
  '',
].join('\n')

/** 비교 문서(마크다운) — 두 팔의 요약 표 + 비교표 + 원자료 JSON. */
export function renderBenchDoc(baseline, candidate) {
  const cmp = compareRuns(baseline.metrics, candidate.metrics)
  return [
    HEADER,
    `- 스토리 세트: ${BENCH_STORIES.map((s) => s.key).join(', ')} (동일)`,
    `- 기준선 exit=${baseline.exit} · 새 하네스 exit=${candidate.exit}`,
    '',
    '## 비교',
    '',
    renderComparison(cmp),
    '',
    '## 기준선(Claude-only · parallel 1)',
    '',
    baseline.metrics ? renderMetricsTable(baseline.metrics, { title: '' }).trim() : '(계측 없음 — 실행 실패)',
    '',
    '## 새 하네스(parallel 2 · Codex 리뷰 · 확장 충돌 · assign)',
    '',
    candidate.metrics ? renderMetricsTable(candidate.metrics, { title: '' }).trim() : '(계측 없음 — 실행 실패)',
    '',
    '## 원자료',
    '',
    '```json',
    JSON.stringify({ baseline: baseline.metrics, candidate: candidate.metrics, comparison: cmp }, null, 2),
    '```',
    '',
  ].join('\n')
}

/** 두 팔을 돌리고 문서를 쓴다. 반환 { baseline, candidate, doc, out } */
export function runBench({ out, keep = false, root = tmpdir() } = {}) {
  const fixtures = []
  try {
    const arms = ['baseline', 'harness'].map((arm) => {
      const fx = makeBenchFixture(arm, { root })
      fixtures.push(fx)
      console.log(`[BENCH] ${arm} 실행…`)
      return runArm(fx)
    })
    const [baseline, candidate] = arms
    const doc = renderBenchDoc(baseline, candidate)
    if (out) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, doc, 'utf8')
    }
    return { baseline, candidate, doc, out }
  } finally {
    if (!keep) for (const fx of fixtures) { try { rmSync(fx.T, { recursive: true, force: true }) } catch { /* 잠긴 파일은 OS 가 정리 */ } }
  }
}

// ── CLI ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const argv = process.argv.slice(2)
  if (!argv.includes('--stub')) {
    console.error('사용법: node night-batch-ops/engine/bench.mjs --stub [--out <경로.md>] [--keep]')
    console.error('  실 LLM 벤치는 이 도구가 하지 않는다 — 실제 야간 배치의 metrics-history.jsonl 을 비교할 것.')
    process.exit(2)
  }
  const oi = argv.indexOf('--out')
  const out = oi >= 0 && argv[oi + 1] ? resolve(argv[oi + 1]) : join(REPO, 'night-batch-ops', 'references', 'hardening-2026-09-02', 'bench-stub.md')
  const r = runBench({ out, keep: argv.includes('--keep') })
  console.log(`\n${renderComparison(compareRuns(r.baseline.metrics, r.candidate.metrics))}`)
  console.log(`\n✔ ${out}`)
  process.exit(r.baseline.exit === 0 && r.candidate.exit === 0 ? 0 : 1)
}
