// 자율 마무리 **종단 테스트** — 실제 git 픽스처 · 실제 node 스텁(claude/codex) · 실제 `run-night.mjs` spawn.
//
// 왜 이렇게까지: 자율 마무리는 「읽고 → 판정하고 → 계획하고 → 러너를 띄우는」 이어붙이기다. 이음매마다
// 실물이 아니면 안 보이는 함정이 있다 — Windows `.cmd` 심의 argv, stdin 으로 들어가는 프롬프트,
// 러너가 요구하는 설정 파일(`pipeline-settings.json`), 사람이 고친 파일을 덮지 않는 3-way 해시.
// 그래서 여기서는 실제 프로세스를 띄우고, 실제 파일을 읽고, 결과를 파일로 센다.
//
// 실 LLM 0 · 실 알림 0 · 실 전역 스킬 무접촉(HOME/USERPROFILE 을 임시 폴더로 바꾼다).
//
// 시나리오(설계 §9-2): E1 진단 전용 무변경 · E2 1라운드 왕복 · E3 Fable 채택 · E4 지어낸 키 거부 폴백 ·
// E5 보수 범주 배치 분리 · E6 사용자 변경 덮어쓰기 방지 · E7 신규 스토리를 편성기가 후보로 읽음 ·
// E8 봉쇄 후 독립 작업 계속 · E9 같은 서명 3회 escalate · E10 시크릿 전수 grep · E11 게이트 횟수 ·
// E12 하위 호환(run-night --queue 단독 · plan-queue --dry).
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFakeProject } from './fixtures/fake-bmad-project.mjs'
import { installStubs, readCalls } from './fixtures/stub-claude.mjs'
import { readCodexCalls } from './fixtures/stub-codex.mjs'
import { buildDag, validatePlan } from './plan-dag.mjs'
import { plan as planQueue } from './plan-queue.mjs'
import { runAutoFinish } from './autofinish.mjs'
import { spawnSafe } from '../../auto-story-finish/providers/spawn-safe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const AUTOFINISH = join(HERE, 'autofinish.mjs')
const IS_WIN = process.platform === 'win32'

const QA_SCRIPT = `import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
try { appendFileSync(join(process.env.STUB_DIR, 'qa-calls.log'), process.cwd() + '\\n') } catch {}
if (process.env.QA_LEAK === '1') {
  console.log('OPENAI_API_KEY=sk-leakleakleakleak0123456789abcd')
  console.error('SUPABASE_SERVICE_ROLE=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.bGVha2VkLXNlY3JldA')
}
process.exit(process.env.QA_FAIL === '1' ? 1 : 0)
`
const BUILD_SCRIPT = `import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
try { appendFileSync(join(process.env.STUB_DIR, 'build-calls.log'), '1\\n') } catch {}
process.exit(0)
`

const temps = []
// `KEEP_E2E_TMP=1` 이면 임시 폴더를 남긴다 — 실패했을 때 실물(로그·큐·워크트리)을 그대로 열어 보기 위한 손잡이.
after(() => { if (process.env.KEEP_E2E_TMP === '1') { console.log(`[E2E] 임시 폴더 보존: ${temps.join(' ')}`); return } for (const t of temps) { try { rmSync(t, { recursive: true, force: true }) } catch { /* 잠긴 파일은 OS 가 정리 */ } } })

/**
 * 종단 픽스처 — 가짜 BMAD 프로젝트(실제 git) + 전역 스킬 사본 + 스텁 심 + 엔진 설치본 + 러너 설정.
 * 러너가 요구하는 것(`.claude/pipeline-settings.json` · `~/.claude/skills/auto-story-finish/`)을 전부 채운다.
 */
function makeE2E({ traps = {}, config = {}, scripts = {} } = {}) {
  const T = mkdtempSync(join(tmpdir(), 'nbo-af-'))
  temps.push(T)
  const home = join(T, 'home'), state = join(T, 'state'), afState = join(T, 'af-state'), bin = join(T, 'bin'), stub = join(T, 'stub')
  for (const d of [home, state, afState, bin, stub]) mkdirSync(d, { recursive: true })

  // ① 전역 스킬 사본 — 러너는 `~/.claude/skills/auto-story-finish/` 에서 엔진을 찾는다
  const skill = join(home, '.claude', 'skills', 'auto-story-finish')
  mkdirSync(skill, { recursive: true })
  for (const f of readdirSync(join(REPO, 'auto-story-finish')).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
    cpSync(join(REPO, 'auto-story-finish', f), join(skill, f))
  }
  cpSync(join(REPO, 'auto-story-finish', 'providers'), join(skill, 'providers'), { recursive: true })
  // 엔진이 nested 워커 deny 없이는 시작하지 않는다 — 전역에도 깔아 둔다(프로젝트 쪽에도 아래에서 깐다)
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'pipeline-settings.json'), JSON.stringify({
    permissions: { deny: ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git stash:*)', 'Bash(git reset:*)'] },
  }, null, 2))

  // ② 스텁 심(실제 node 프로세스)
  const bins = installStubs(bin)

  // ③ 프로젝트 — 실제 git
  const proj = join(T, 'proj')
  mkdirSync(proj, { recursive: true })
  const fx = createFakeProject({ dir: proj, traps })

  // ④ 엔진 설치본 — 목록을 고정하지 않는다(새 모듈이 생겨도 ERR_MODULE_NOT_FOUND 가 나지 않게)
  mkdirSync(join(proj, 'tools', 'auto'), { recursive: true })
  for (const f of readdirSync(HERE).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) cpSync(join(HERE, f), join(proj, 'tools', 'auto', f))
  writeFileSync(join(proj, 'tools', 'auto', 'auto.config.json'), JSON.stringify({
    project: 'fx', epicOrder: [1, 2, 3], dailyCap: 30, parallel: 1, stateDir: state,
    mockupGate: { marker: '' }, quality: { autoRepair: false }, integrationGate: { enabled: true },
    workers: { max: 1, batchSize: 2 },
    ...config,
  }, null, 2) + '\n')

  // ⑤ qa·build 는 실제로 도는 node 스크립트(호출 수를 파일로 센다)
  fx.write('tools/qa.mjs', QA_SCRIPT)
  fx.write('tools/build.mjs', BUILD_SCRIPT)
  fx.write('package.json', JSON.stringify({
    name: 'fake-bmad-project', private: true, type: 'module',
    scripts: { qa: 'node tools/qa.mjs', build: 'node tools/build.mjs', typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0', ...scripts },
  }, null, 2) + '\n')
  mkdirSync(join(proj, '.claude'), { recursive: true })
  fx.write('.claude/pipeline-settings.json', JSON.stringify({
    permissions: { deny: ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git stash:*)', 'Bash(git reset:*)'] },
  }, null, 2) + '\n')

  // ⑥ 커밋 신원 — 없으면 엔진의 스토리 커밋이 조용히 실패하고, 다음 배치가 dirty 로 STOP 한다(2026-09-03 실측)
  fx.git(['config', 'user.email', 'e2e@test'])
  fx.git(['config', 'user.name', 'e2e'])
  fx.git(['config', 'commit.gpgsign', 'false'])

  // ⑦ 원격(bare) — 「push 0건」을 ref 로 셀 수 있게
  const origin = join(T, 'origin.git')
  spawnSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' })
  fx.git(['remote', 'add', 'origin', origin])
  fx.git(['add', '-A'])
  fx.git(['commit', '-q', '-m', 'e2e: 러너 설정·스크립트'])
  fx.git(['push', '-q', 'origin', 'HEAD:main'])

  return { T, home, state, afState, bin, stub, proj, fx, origin, bins }
}

const baseEnv = (e) => ({
  ...process.env,
  USERPROFILE: e.home, HOME: e.home,
  AUTO_BATCH_STATE_DIR: e.state, STUB_DIR: e.stub,
  CLAUDE_BIN: e.bins.claude, CODEX_BIN: e.bins.codex,
  PIPELINE_NTFY_TOPIC: 'off', TELEGRAM_BOT_TOKEN: '', QA_FAIL: '', QA_LEAK: '',
  STUB_PLAN: '', STUB_FAIL_STORY: '', STUB_REVIEW_FINDING: '', STUB_CODEX_FINDING: '',
})

/** autofinish 를 **실제 자식 프로세스**로 돌린다(사람이 치는 명령 그대로). */
function runAF(e, args = [], env = {}) {
  const r = spawnSync(process.execPath, [AUTOFINISH, '--root', e.proj, '--state', e.afState, ...args], {
    cwd: e.proj, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...baseEnv(e), ...env },
  })
  const runs = existsSync(join(e.afState, 'autofinish')) ? readdirSync(join(e.afState, 'autofinish')).sort() : []
  const outDir = runs.length ? join(e.afState, 'autofinish', runs[runs.length - 1]) : null
  const readJson = (n) => JSON.parse(readFileSync(join(outDir, n), 'utf8'))
  return {
    status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    outDir, runs,
    run: outDir && existsSync(join(outDir, 'run.json')) ? readJson('run.json') : null,
    report: outDir && existsSync(join(outDir, 'report.json')) ? readJson('report.json') : null,
    reportMd: outDir && existsSync(join(outDir, 'report.md')) ? readFileSync(join(outDir, 'report.md'), 'utf8') : '',
    readJson,
    files: outDir ? readdirSync(outDir) : [],
  }
}

/**
 * BMAD 쓰기만 보고 싶을 때 — **러너만** 스텁으로 막고 나머지(실제 파일·실제 git·실제 계획)는 그대로 돈다.
 * 러너를 진짜로 띄우면 워커가 스토리 md 를 고쳐 「원문 보존」을 볼 수 없다(보는 대상이 달라진다).
 */
async function runAFInProcess(e, opts = {}) {
  const r = await runAutoFinish({
    root: e.proj, state: e.afState, maxRounds: 1, gates: [], log: () => {},
    planRunner: false, spawnRunner: () => ({ status: 0, stdout: '', stderr: '' }),
    ...opts,
  })
  return { ...r, readJson: (n) => JSON.parse(readFileSync(join(r.outDir, n), 'utf8')) }
}

const lines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [])
const gitOut = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout ?? ''

function treeDigest(root) {
  const h = createHash('sha256')
  const walk = (dir) => {
    for (const en of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (en.name === '.git') continue
      const p = join(dir, en.name)
      if (en.isDirectory()) { walk(p); continue }
      h.update(relative(root, p).replace(/\\/g, '/'))
      h.update(readFileSync(p))
      h.update(String(statSync(p).size))
    }
  }
  walk(root)
  return h.digest('hex')
}

/** 산출물 폴더 전체를 훑어 문자열을 찾는다(시크릿 전수 grep 용). */
function grepAll(dir, needle) {
  const hits = []
  const walk = (d) => {
    for (const en of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, en.name)
      if (en.isDirectory()) { walk(p); continue }
      if (readFileSync(p, 'utf8').includes(needle)) hits.push(relative(dir, p))
    }
  }
  walk(dir)
  return hits
}

// ═══════════════════════════════════════════════════════════════════════════
describe('스텁 계약 — 심(shim)으로 부른 실제 프로세스가 약속대로 행동한다', () => {
  // 스텁이 틀리면 아래 시나리오 전부가 거짓말이 된다. 그래서 스텁부터 실물로 검사한다.
  // 호출은 엔진과 **같은 경로**(spawn-safe)로 간다 — Windows `.cmd` 심은 `cmd.exe /d /s /c` 전용
  // 경로로만 지나고, 셸 문자열 결합은 어디에도 없다. 그래서 이 검사는 심 자체의 검사이기도 하다.
  const runShim = (bin, args, { input = '', env = {}, cwd = process.cwd() } = {}) =>
    spawnSafe(bin, args, { input, cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } })

  it('claude 스텁: --version · argv/stdin 기록 · 계획 응답 4갈래', () => {
    const T = mkdtempSync(join(tmpdir(), 'nbo-stub-'))
    temps.push(T)
    const { claude } = installStubs(join(T, 'bin'))
    const stub = join(T, 'stub')

    const v = runShim(claude, ['--version'], { env: { STUB_DIR: stub } })
    assert.equal(v.status, 0)
    assert.match(v.stdout, /stub/)

    const prompt = ['# 야간 배치 편성 계획 요청', '## 후보', '```json', JSON.stringify([{ key: '2-1-가' }, { key: '2-2-나' }]), '```'].join('\n')
    const p = runShim(claude, ['-p', '--model', 'fable', '--output-format', 'json'], { input: prompt, env: { STUB_DIR: stub, STUB_PLAN: 'fable' } })
    assert.equal(p.status, 0)
    const envelope = JSON.parse(p.stdout)
    assert.equal(envelope.type, 'result')
    const planObj = JSON.parse(envelope.result)
    assert.deepEqual(planObj.batches.flatMap((b) => b.stories), ['2-2-나', '2-1-가'], '후보 역순으로 내야 규칙 계획과 구분된다')

    for (const [mode, check] of [['garbage', (r) => !r.stdout.trim().startsWith('{')], ['empty', (r) => !r.stdout.trim()], ['error', (r) => r.status === 1]]) {
      const rr = runShim(claude, ['-p'], { input: prompt, env: { STUB_DIR: stub, STUB_PLAN: mode } })
      assert.ok(check(rr), `STUB_PLAN=${mode} 갈래가 계약과 다르다`)
    }

    // argv 와 stdin 크기가 기록에 남는다(테스트가 「무엇으로 불렸나」를 셀 수 있어야 한다)
    const calls = readCalls(stub)
    assert.ok(calls.some((c) => c.kind === 'version'))
    const planCall = calls.find((c) => c.kind === 'plan')
    assert.ok(planCall.argv.includes('fable') && planCall.promptBytes === prompt.length)
  })

  it('codex 스텁: JSONL 이벤트 · `-o` 절대 경로 · 한도 사건', () => {
    const T = mkdtempSync(join(tmpdir(), 'nbo-stub-'))
    temps.push(T)
    const { codex } = installStubs(join(T, 'bin'))
    const stub = join(T, 'stub')
    const out = join(T, 'deep', 'review.json')

    const r = runShim(codex, ['exec', '-s', 'read-only', '-o', out], { input: '스토리 2-1-가 리뷰', env: { STUB_DIR: stub } })
    assert.equal(r.status, 0, r.stderr)
    const evs = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(evs[0].type, 'thread.started')
    assert.equal(evs[evs.length - 1].type, 'turn.completed')
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).verdict, 'clean', '`-o` 절대 경로에 결과를 쓰지 않았다')

    const lim = runShim(codex, ['exec'], { input: '스토리 2-1-가 리뷰', env: { STUB_DIR: stub, STUB_CODEX_LIMIT: '1' } })
    assert.equal(lim.status, 1)
    assert.match(lim.stdout, /usage limit/)
    assert.equal(readCodexCalls(stub).filter((c) => c.kind === 'exec').length, 2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E1 — 진단 전용은 대상 저장소를 한 바이트도 건드리지 않는다', () => {
  it('실제 CLI 로 돌려도 트리 지문·porcelain·HEAD 가 전부 그대로다', () => {
    const e = makeE2E()
    const before = { digest: treeDigest(e.proj), porcelain: e.fx.porcelain(), head: gitOut(e.proj, ['rev-parse', 'HEAD']).trim(), branch: gitOut(e.proj, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() }

    const r = runAF(e, ['--diagnose-only', '--no-gates'])
    assert.equal(r.status, 0, r.out)

    assert.equal(treeDigest(e.proj), before.digest, '파일 내용이 바뀌었다')
    assert.equal(e.fx.porcelain(), before.porcelain, 'porcelain 이 바뀌었다')
    assert.equal(gitOut(e.proj, ['rev-parse', 'HEAD']).trim(), before.head, 'HEAD 가 움직였다')
    assert.equal(gitOut(e.proj, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), before.branch, '브랜치가 바뀌었다')
    // 게이트 0 · 러너 0 · 모델 호출 0
    assert.deepEqual(r.run.gateCalls, {})
    assert.equal(lines(join(e.stub, 'qa-calls.log')).length, 0)
    assert.equal(readCalls(e.stub).length, 0, '진단 전용은 모델을 부르지 않는다')
    assert.ok(!r.files.some((n) => /queue|runner/.test(n)), '진단 전용은 큐도 러너 기록도 만들지 않는다')
    assert.equal(r.report.verdict, 'not-ready')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E2 · E11 — 1라운드 왕복과 게이트 예산', () => {
  it('라운드 2회를 돌고 · 큐가 검증기를 통과하고 · qa 는 라운드+1회 · build 는 1회 · 실제 dev/review 가 돈다', () => {
    const e = makeE2E()
    const r = runAF(e, ['--max-rounds', '2', '--gates', 'qa,build', '--bmad-writes', 'plan'], { AUTOFINISH_NO_LLM: '1' })
    assert.equal(r.status, 0, r.out)

    // ① 라운드
    assert.equal(r.run.rounds.length, 2, `라운드 ${r.run.rounds.length}회 — 2회여야 한다\n${r.out}`)
    assert.ok(r.run.rounds[1].decision, '두 번째 라운드에는 계속/중단 판정이 있어야 한다')
    assert.equal(r.report.run.rounds, 2)

    // ② 게이트 예산 (E11)
    const qa = lines(join(e.stub, 'qa-calls.log')).length
    const build = lines(join(e.stub, 'build-calls.log')).length
    assert.equal(r.run.gateCalls.qa, r.run.rounds.length + 1, `qa 게이트 ${r.run.gateCalls.qa}회 ≠ 라운드+1`)
    assert.equal(r.run.gateCalls.build, 1, 'build 는 마지막 1회뿐이다')
    assert.ok(qa >= r.run.gateCalls.qa, `실제 qa 실행 ${qa}회 — 러너의 스토리 qa 를 포함해 게이트 호출 이상이어야 한다`)
    assert.ok(build >= 1)

    // ③ 큐 — run-night 스키마 + 검증기 통과
    const queue = r.readJson('round-0-queue.json')
    for (const k of ['planned', 'updated', 'defaults', 'batches', 'validation', '_편성']) assert.ok(k in queue, `큐에 ${k} 없음`)
    assert.equal(queue.defaults.push, false)
    assert.ok(queue.batches.length >= 1, '편성 0건이면 왕복이 아니다')
    const keys = queue.batches.flatMap((b) => b.stories)
    const dag = buildDag({ stories: keys.map((k) => ({ key: k, epic: Number(k.split('-')[0]), kind: 'recovery', files: [], deps: [] })), epicOrder: [1, 2, 3] })
    assert.deepEqual(validatePlan({ batches: queue.batches }, dag, { knownKeys: keys, batchMax: 2 }).errors, [])

    // ④ 러너·모델이 실제로 돌았다
    assert.equal(r.readJson('round-0-runner.json').exit, 0, r.out)
    const calls = readCalls(e.stub)
    assert.ok(calls.some((c) => c.kind === 'dev'), `dev 호출이 없다: ${JSON.stringify(calls.map((c) => c.kind))}`)
    assert.ok(calls.some((c) => c.kind === 'review'), 'review 호출이 없다')

    // ⑤ 커밋은 auto/* 브랜치에서만 · main 은 그대로 · push 0
    const branch = gitOut(e.proj, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    assert.ok(/^auto\//.test(branch) || branch === 'main', `브랜치 ${branch}`)
    assert.deepEqual(gitOut(e.proj, ['ls-remote', '--heads', 'origin']).trim().split('\n').filter(Boolean).map((l) => l.split('\t')[1]), ['refs/heads/main'], 'origin 에 새 브랜치가 올라갔다 = push 했다')

    // ⑥ 보고서 12절이 전부 있다
    assert.equal(r.report.sections.length, 10)
    assert.match(r.reportMd, /## 9\./)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E3 · E4 — Fable 계획 채택과 거부 폴백', () => {
  it('E3: 스텁 지휘 모델이 낸 계획이 검증을 통과하면 채택된다(plan.source=fable)', () => {
    const e = makeE2E()
    const r = runAF(e, ['--max-rounds', '1', '--no-gates', '--dry-run'], { STUB_PLAN: 'fable' })
    assert.equal(r.status, 0, r.out)
    const p = r.readJson('round-0-plan.json')
    assert.equal(p.source, 'fable', `계획 출처 ${p.source}\n${r.out}`)
    assert.equal(p.plan.source, 'fable')
    // 실제 프로세스로 불렸다 — argv·stdin 이 기록에 남는다
    const planCalls = readCalls(e.stub).filter((c) => c.kind === 'plan')
    assert.equal(planCalls.length, 1)
    assert.ok(planCalls[0].argv.includes('--model'), `argv: ${JSON.stringify(planCalls[0].argv)}`)
    assert.ok(planCalls[0].argv.includes('fable'))
    assert.ok(planCalls[0].promptBytes > 200, '프롬프트가 stdin 으로 들어가지 않았다')
    // 채택된 계획이 큐에 그대로 실렸다
    assert.match(r.readJson('round-0-queue.json').batches[0].label, /FABLE-/)
  })

  it('E4: 후보에 없는 스토리를 지어내면 계획 전체를 버리고 규칙 계획으로 계속 돈다(밤이 서지 않는다)', () => {
    const e = makeE2E()
    const r = runAF(e, ['--max-rounds', '1', '--no-gates', '--dry-run'], { STUB_PLAN: 'invented' })
    assert.equal(r.status, 0, r.out)
    const p = r.readJson('round-0-plan.json')
    assert.match(p.source, /^deterministic-fallback\(invented-story/, `출처 ${p.source}`)
    const keys = p.plan.batches.flatMap((b) => b.stories)
    assert.ok(!keys.includes('99-99-없는-스토리'), '지어낸 키가 큐에 실렸다')
    assert.ok(keys.length >= 1, '폴백 계획이 비었다 — 밤이 섰다')
    // 그래도 러너는 돌았다
    assert.equal(r.readJson('round-0-runner.json').exit, 0, r.out)
  })

  it('E4b: 계획 응답이 JSON 이 아니어도 · 실행기가 실패해도 같은 자리에서 규칙 계획으로 돈다', () => {
    for (const mode of ['garbage', 'error', 'empty']) {
      const e = makeE2E()
      const r = runAF(e, ['--max-rounds', '1', '--no-gates', '--dry-run'], { STUB_PLAN: mode })
      assert.equal(r.status, 0, `${mode}: ${r.out}`)
      assert.match(r.readJson('round-0-plan.json').source, /^deterministic-fallback\(/, `${mode} 에서 폴백하지 않았다`)
      assert.equal(r.readJson('round-0-runner.json').exit, 0, `${mode}: 러너가 돌지 않았다`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E5 — 보수 범주는 같은 배치에 들어가지 않는다', () => {
  it('마이그레이션·공유 핵심을 만지는 스토리는 배치가 나뉜다(자기 혼자여도 병렬 금지)', () => {
    const e = makeE2E()
    // 두 스토리에 보수 범주 파일을 심는다 — 하나는 마이그레이션, 하나는 공유 핵심(src/lib).
    const impl = '_bmad-output/implementation-artifacts'
    for (const [key, extra] of [['2-1-패치-열림', 'supabase/migrations/20260301000000_add.sql'], ['1-2-파일목록-부재', 'src/lib/strings.ts']]) {
      const p = join(e.proj, impl, `${key}.md`)
      const md = readFileSync(p, 'utf8')
      writeFileSync(p, md.includes('### File List')
        ? md.replace('### File List\n', `### File List\n\n**수정 (1)**\n\n- \`${extra}\`\n`)
        : md.replace('## Change Log', `### File List\n\n- \`${extra}\`\n\n## Change Log`))
    }
    e.fx.write('supabase/migrations/20260301000000_add.sql', 'alter table t add column x int;\n')
    e.fx.git(['add', '-A']); e.fx.git(['commit', '-q', '-m', 'e2e: 보수 범주 파일'])

    const r = runAF(e, ['--max-rounds', '1', '--no-gates', '--dry-run'], { AUTOFINISH_NO_LLM: '1' })
    assert.equal(r.status, 0, r.out)
    const q = r.readJson('round-0-queue.json')
    for (const b of q.batches) {
      assert.equal(b.stories.length, 1, `보수 범주 스토리가 같은 배치에 묶였다: ${JSON.stringify(b.stories)}`)
    }
    // 검증기도 같은 결론이어야 한다(잣대가 하나다)
    assert.equal(q.validation.ok, true, JSON.stringify(q.validation.errors))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E6 — 사람이 고친 파일을 덮어쓰지 않는다', () => {
  it('E6a: `--bmad-writes on` 은 **덧붙이기만** 한다 — 원문의 모든 줄과 Status 가 그대로 남는다', async () => {
    const e = makeE2E()
    const impl = join(e.proj, '_bmad-output', 'implementation-artifacts')
    const keys = ['1-1-정상-스토리', '1-2-파일목록-부재', '2-1-패치-열림', '2-2-결정-열림']
    const before = Object.fromEntries(keys.map((k) => [k, readFileSync(join(impl, `${k}.md`), 'utf8')]))
    const sprintBefore = readFileSync(join(impl, 'sprint-status.yaml'), 'utf8')

    const r = await runAFInProcess(e, { bmadWrites: 'on' })
    const applied = r.readJson('round-0-bmad-apply.json')
    assert.equal(applied.rolledBack, false, `쓰기가 폐기됐다: ${JSON.stringify(applied.rejected ?? applied.conflicts)}`)
    assert.ok(applied.applied.length >= 1, '적용된 쓰기가 없다 — 이 시나리오가 성립하지 않는다')

    for (const k of keys) {
      const now = readFileSync(join(impl, `${k}.md`), 'utf8')
      for (const line of before[k].split('\n')) {
        assert.ok(now.includes(line), `${k}: 원문 줄이 사라졌다 → ${JSON.stringify(line.slice(0, 60))}`)
      }
      assert.equal(/^Status:\s*(\S+)/m.exec(now)?.[1], /^Status:\s*(\S+)/m.exec(before[k])?.[1], `${k}: Status 줄이 바뀌었다`)
    }
    // sprint 는 키 단위 upsert — 주석 수천 자가 재직렬화로 날아가지 않는다
    for (const line of sprintBefore.split('\n')) {
      assert.ok(readFileSync(join(impl, 'sprint-status.yaml'), 'utf8').includes(line), `sprint 원문 줄이 사라졌다 → ${JSON.stringify(line.slice(0, 50))}`)
    }
  })

  it('E6b: 계획을 세운 뒤 사람이 그 파일을 고치면 계획 **전체**를 폐기하고 원문을 그대로 둔다', async () => {
    const e = makeE2E()
    const impl = join(e.proj, '_bmad-output', 'implementation-artifacts')
    // ① 계획만 세운다(쓰기는 하지 않는다) — 산출물에 baseHash 가 박힌 계획이 남는다
    const r = await runAFInProcess(e, { bmadWrites: 'plan' })
    const plan = r.readJson('round-0-bmad-plan.json')
    assert.ok(plan.writes.length >= 1, '계획이 비었다')

    // ② 사람이 손을 댄다(계획이 본 원문 이후의 변경)
    const touched = plan.writes.find((w) => w.baseHash && w.path.endsWith('.md'))
    assert.ok(touched, `baseHash 가 붙은 쓰기가 없다: ${JSON.stringify(plan.writes.map((w) => w.op))}`)
    const abs = join(e.proj, touched.path)
    const original = readFileSync(abs, 'utf8')
    writeFileSync(abs, `${original}\n<!-- 사람이 나중에 적은 줄 -->\n`)
    const afterHuman = readFileSync(abs, 'utf8')

    // ③ 그 계획을 적용해 본다 — 전체 폐기여야 하고, 사람 글은 그대로여야 한다
    const { applyBmadWrites } = await import('./bmad-sync.mjs')
    const res = applyBmadWrites(plan, { root: e.proj })
    assert.equal(res.rolledBack, true, '계획이 적용됐다 — 사람 변경을 덮었다')
    assert.equal(res.applied.length, 0, '부분 적용이 남았다')
    assert.ok(res.conflicts.length >= 1, '충돌 사유가 기록되지 않았다')
    assert.equal(readFileSync(abs, 'utf8'), afterHuman, '사람이 적은 줄이 사라졌다')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E7 — 새로 만든 스토리를 편성기가 후보로 읽는다', () => {
  it('epics.md 에만 있던 스토리를 파일·원장에 등재하면 plan-queue 가 그 키를 본다', async () => {
    const e = makeE2E()
    const impl = join(e.proj, '_bmad-output', 'implementation-artifacts')
    const cfg = JSON.parse(readFileSync(join(e.proj, 'tools', 'auto', 'auto.config.json'), 'utf8'))
    const seenBefore = planQueue({ root: e.proj, stateDir: join(e.T, 'pq-b'), config: cfg, today: '2026-09-03' })
    const keysBefore = [...seenBefore.queue._편성.picked.map((p) => p.key), ...seenBefore.queue._편성.excluded.map((x) => x.key)]
    assert.ok(!keysBefore.some((k) => k.startsWith('3-1')), `등재 전에 이미 보인다: ${JSON.stringify(keysBefore)}`)

    await runAFInProcess(e, { bmadWrites: 'on' })

    const created = readdirSync(impl).filter((n) => n.startsWith('3-1-') && n.endsWith('.md'))
    assert.equal(created.length, 1, `신규 스토리 파일이 생기지 않았다: ${JSON.stringify(readdirSync(impl))}`)
    const key = created[0].replace(/\.md$/, '')
    const sprint = readFileSync(join(impl, 'sprint-status.yaml'), 'utf8')
    assert.match(sprint, new RegExp(`^ {2}${key}: *backlog`, 'm'), 'sprint 원장에 키가 등재되지 않았다')

    const seenAfter = planQueue({ root: e.proj, stateDir: join(e.T, 'pq-a'), config: cfg, today: '2026-09-03' })
    const keysAfter = [...seenAfter.queue._편성.picked.map((p) => p.key), ...seenAfter.queue._편성.excluded.map((x) => x.key)]
    assert.ok(keysAfter.includes(key), `편성기가 새 스토리를 보지 못했다: ${JSON.stringify(keysAfter)}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E8 — 봉쇄된 스토리만 멈추고 나머지는 계속 돈다', () => {
  it('결정 인박스에 대기 중인 스토리는 큐에서 빠지고 · 다른 스토리는 그대로 편성된다', () => {
    const e = makeE2E()
    const impl = join(e.proj, '_bmad-output', 'implementation-artifacts')
    const inbox = join(impl, 'DECISIONS-INBOX.md')
    // 1-2 를 인박스로 봉쇄한다(그 밖의 스토리는 멀쩡하다)
    writeFileSync(inbox, `${readFileSync(inbox, 'utf8')}\n## 🟠 결정 대기 — 1-2 저장 위치를 어디로 할까\n\n- ⓐ 지금 자리 (추천)\n- ⓑ 다른 자리\n`)
    e.fx.git(['add', '-A']); e.fx.git(['commit', '-q', '-m', 'e2e: 1-2 결정 대기'])

    const r = runAF(e, ['--max-rounds', '1', '--no-gates', '--dry-run'], { AUTOFINISH_NO_LLM: '1' })
    assert.equal(r.status, 0, r.out)
    const q = r.readJson('round-0-queue.json')
    const keys = q.batches.flatMap((b) => b.stories)
    assert.ok(!keys.some((k) => k.startsWith('1-2')), `봉쇄된 1-2 가 편성됐다: ${JSON.stringify(keys)}`)
    assert.ok(keys.length >= 1, '봉쇄 하나가 밤 전체를 세웠다 — 나머지는 계속 돌아야 한다')
    assert.ok(q._편성.excluded.some((x) => /결정 대기|봉쇄/.test(x.why)), `봉쇄 사유가 큐에 남지 않았다: ${JSON.stringify(q._편성.excluded)}`)
    assert.equal(r.readJson('round-0-runner.json').exit, 0, '러너가 돌지 않았다')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E9 — 같은 원인으로 세 번 막히면 사람을 부르고 더 돌지 않는다', () => {
  // 「진전은 있는데 같은 원인이 계속 막는다」가 이 규칙이 노리는 상황이다(무진전이면 그냥 stop 이다).
  // 그래서 라운드마다 실제로 무언가가 달라지게 하고(러너가 파일을 남긴다) qa 는 **같은 실패**를 반복한다.
  // 진단·백로그·판정·산출물은 전부 실물이고, 스텁은 게이트 실행기와 러너 spawn 두 개뿐이다.
  it('진전이 있어도 qa 가 같은 실패로 3회 반복되면 escalate 하고 · 그 라운드는 실행 0 이며 · 6항 보고서를 남긴다', async () => {
    const e = makeE2E()
    const RED = 'FAIL  tests/feature/c.test.ts > 저장한다\nAssertionError: expected 1 to be 2\n'
    let round = 0
    const r = await runAutoFinish({
      root: e.proj, state: e.afState, maxRounds: 5, gates: ['qa'], log: () => {}, planRunner: false,
      exec: () => ({ status: 1, stdout: RED, stderr: '' }),
      spawnRunner: () => {
        // 러너가 「일을 했다」 — 라운드마다 진단 결과가 실제로 달라진다(임시 코드 1건 추가)
        mkdirSync(join(e.proj, 'src', 'feature'), { recursive: true })
        writeFileSync(join(e.proj, 'src', 'feature', `r${round++}.ts`), '// TODO: 임시 구현 — 나중에 고침\nexport const x = 1\n')
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    const last = r.rounds[r.rounds.length - 1]
    assert.equal(last.decision?.action, 'escalate', `마지막 판정 ${JSON.stringify(last.decision)}`)
    assert.equal(last.decision.code, 'repeat-signature')
    assert.equal(last.queue, null, 'escalate 한 라운드가 큐를 만들었다 — 실행이 0 이 아니다')
    assert.equal(last.runner, null, 'escalate 한 라운드가 러너를 띄웠다')
    assert.ok(r.rounds.length < 5, '상한(5)까지 다 돌았다 — 중단되지 않았다')
    assert.equal(round, r.rounds.length - 1, `실행 ${round}회 ≠ 라운드 ${r.rounds.length} - 1 — 중단한 라운드가 또 돌았다`)
    assert.equal(r.exitCode, 1, '사람 호출은 종료 코드로도 보인다')

    const esc = readFileSync(join(r.outDir, 'escalation.md'), 'utf8')
    for (const n of ['1) 상황', '2) 원인', '3) 이미 시도한 것', '4) 선택지', '5) 추천', '6) 위험도']) {
      assert.ok(esc.includes(n), `escalate 보고서에 ${n} 가 없다`)
    }
    assert.match(r.reportMd, /배포/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E10 — 시크릿 원문은 산출물 어디에도 남지 않는다', () => {
  it('.env 값·소스에 박힌 키·qa 로그로 새어 나온 값 전부 전수 grep 0', () => {
    const e = makeE2E()
    const r = runAF(e, ['--max-rounds', '1', '--gates', 'qa', '--dry-run'], { QA_LEAK: '1', AUTOFINISH_NO_LLM: '1' })
    assert.equal(r.status, 0, r.out)

    const secrets = [
      e.fx.secrets.jwt,
      e.fx.secrets.apiKey,
      e.fx.secrets.codeKey,
      'sk-leakleakleakleak0123456789abcd', // qa 표준출력으로 샌 값
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.bGVha2VkLXNlY3JldA', // qa 표준에러로 샌 값
    ]
    for (const s of secrets) {
      assert.deepEqual(grepAll(r.outDir, s), [], `산출물에 시크릿 원문이 남았다(${s.slice(0, 12)}…)`)
    }
    // 마스킹은 했지만 「있었다」는 사실은 남아야 한다(지워 버리면 사람이 못 고친다)
    const round0 = readFileSync(join(r.outDir, 'round-0-snapshot.json'), 'utf8')
    // 마스킹 표식은 **공용 마스커**(`providers/codex.mjs:redactSecrets`)의 것이다 — 2026-09-02 codex-review-r3 H1
    // 에서 진단 자체 마스커(`«masked»`)를 폐기하고 하나로 합쳤다.
    assert.match(round0, /\*\*\*REDACTED\*\*\*/, '마스킹 흔적조차 없다 — 스캔이 돌지 않았을 수 있다')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('교차 리뷰 — 만든 쪽과 다른 제공자가 검토한다', () => {
  it('codex 를 켜면 리뷰 단계가 실제 codex 스텁 프로세스로 간다(구현자 ≠ 리뷰어)', () => {
    const e = makeE2E({ config: { providers: { codex: { enabled: true, max: 1, roles: ['review'] } } } })
    // 엔진은 Codex 를 **배치 워크트리에서만** 돌린다(본 트리의 gitignore 실데이터 반출 방지).
    // 순차 경로는 본 트리라 그 가드에 걸린다 — 임시 픽스처에는 실데이터가 없으므로 엔진이 제공하는
    // 명시 허용 스위치를 켜서 스텁까지 실제로 닿게 한다. 가드 자체는 아래 두 번째 테스트가 지킨다.
    const r = runAF(e, ['--max-rounds', '1', '--no-gates'], { AUTOFINISH_NO_LLM: '1', AUTO_CODEX_ALLOW_CWD: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.readJson('round-0-runner.json').exit, 0, r.out)

    // 배정: dev 는 claude/opus · review 는 codex(모델이 다르면 배치도 나뉜다)
    const assigned = r.readJson('round-0-plan.json').assigned
    assert.ok(assigned.some((a) => a.devProvider === 'claude' && a.reviewProvider === 'codex'), JSON.stringify(assigned))
    const q = r.readJson('round-0-queue.json')
    assert.ok(q.batches.some((b) => b.models?.review === 'codex'), JSON.stringify(q.batches))

    const dev = readCalls(e.stub).filter((c) => c.kind === 'dev')
    const codex = readCodexCalls(e.stub).filter((c) => c.kind === 'exec')
    assert.ok(dev.length >= 1, 'dev 가 claude 로 돌지 않았다')
    assert.ok(codex.length >= 1, `codex 리뷰가 돌지 않았다: ${JSON.stringify(readCodexCalls(e.stub).map((c) => c.kind))}`)
    assert.ok(codex[0].promptBytes > 100, 'codex 프롬프트가 stdin 으로 들어가지 않았다')
  })

  it('허용 스위치가 없으면 본 트리에서는 codex 를 돌리지 않고 claude 로 폴백한다(반출 방지 가드)', () => {
    const e = makeE2E({ config: { providers: { codex: { enabled: true, max: 1, roles: ['review'] } } } })
    const r = runAF(e, ['--max-rounds', '1', '--no-gates'], { AUTOFINISH_NO_LLM: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(readCodexCalls(e.stub).filter((c) => c.kind === 'exec').length, 0, '가드를 뚫고 codex 가 본 트리에서 돌았다')
    const log = readFileSync(join(r.outDir, 'round-0-runner.log'), 'utf8')
    assert.match(log, /codex 폴백 → claude/, '폴백 사유가 기록되지 않았다')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E13 (NEW-H1) — 설정으로 push 를 다시 켤 수 없다', () => {
  const remoteRefs = (e) => gitOut(e.proj, ['ls-remote', '--heads', 'origin']).trim().split('\n').filter(Boolean).map((l) => l.split('\t')[1]).sort()

  it('auto.config.json 의 autofinish.queueDefaults.push:true 는 무시가 아니라 거부다(exit 2 · 원격 ref 불변)', () => {
    const e = makeE2E({ config: { autofinish: { queueDefaults: { push: true } } } })
    const before = { refs: remoteRefs(e), digest: treeDigest(e.proj) }

    const r = runAF(e, ['--max-rounds', '1', '--no-gates', '--dry-run'], { AUTOFINISH_NO_LLM: '1' })
    assert.equal(r.status, 2, `종료 코드 ${r.status} — 설정 거부는 2 다\n${r.out}`)
    assert.match(r.out, /사람 승인/, `거부 사유가 출력되지 않았다: ${r.out}`)
    assert.equal(r.outDir, null, '거부했는데 산출물 폴더가 생겼다')
    assert.equal(lines(join(e.stub, 'qa-calls.log')).length, 0, '거부했는데 게이트가 돌았다')
    assert.equal(readCalls(e.stub).length, 0, '거부했는데 모델이 불렸다')
    assert.deepEqual(remoteRefs(e), before.refs, 'origin ref 가 달라졌다 = push 했다')
    assert.equal(treeDigest(e.proj), before.digest, '거부했는데 저장소가 바뀌었다')
  })

  it('정상 실행에서는 큐의 push 가 false 이고 · 러너 argv 에 --push 가 붙지 않는다', async () => {
    const e = makeE2E()
    const seen = []
    const r = await runAutoFinish({
      root: e.proj, state: e.afState, maxRounds: 1, gates: [], log: () => {}, planRunner: false, bmadWrites: 'plan',
      spawnRunner: (_bin, args) => { seen.push(args); return { status: 0, stdout: '', stderr: '' } },
    })
    const q = JSON.parse(readFileSync(join(r.outDir, 'round-0-queue.json'), 'utf8'))
    assert.equal(q.defaults.push, false)
    assert.equal(seen.length, 1, '러너가 뜨지 않았다')
    assert.ok(!seen[0].includes('--push'), `러너 argv 에 --push 가 붙었다: ${JSON.stringify(seen[0])}`)
    assert.deepEqual(gitOut(e.proj, ['ls-remote', '--heads', 'origin']).trim().split('\n').filter(Boolean).map((l) => l.split('\t')[1]), ['refs/heads/main'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E14 (NEW-H2) — 진단 전용에 --gates 를 주면 거부한다', () => {
  it('`--diagnose-only --gates qa` 는 exit 2 · npm 스크립트 0회 · porcelain 동일', () => {
    const e = makeE2E()
    const before = { porcelain: e.fx.porcelain(), digest: treeDigest(e.proj) }

    const r = runAF(e, ['--diagnose-only', '--gates', 'qa'])
    assert.equal(r.status, 2, `종료 코드 ${r.status} — 인자 거부는 2 다\n${r.out}`)
    assert.match(r.out, /--gates/, `거부 사유가 출력되지 않았다: ${r.out}`)
    assert.equal(lines(join(e.stub, 'qa-calls.log')).length, 0, 'npm run qa 가 대상 저장소에서 돌았다')
    assert.equal(e.fx.porcelain(), before.porcelain)
    assert.equal(treeDigest(e.proj), before.digest)
    assert.equal(r.outDir, null, '거부했는데 산출물이 생겼다')
  })

  // codex-review-r5 Low — 상충 플래그는 조용히 한쪽이 이기지 않는다(모드 무관 거부).
  it('`--gates qa --no-gates` 와 `--diagnose-only --gates qa --no-gates` 는 exit 2 · 실행 0', () => {
    const e = makeE2E()
    const before = { porcelain: e.fx.porcelain(), digest: treeDigest(e.proj) }
    for (const args of [['--gates', 'qa', '--no-gates'], ['--diagnose-only', '--gates', 'qa', '--no-gates']]) {
      const r = runAF(e, args)
      assert.equal(r.status, 2, `${args.join(' ')} — 종료 코드 ${r.status}\n${r.out}`)
      assert.match(r.out, /함께 쓸 수 없다/, r.out)
      assert.equal(r.outDir, null, '거부했는데 산출물이 생겼다')
    }
    assert.equal(lines(join(e.stub, 'qa-calls.log')).length, 0, '거부했는데 게이트가 돌았다')
    assert.equal(e.fx.porcelain(), before.porcelain)
    assert.equal(treeDigest(e.proj), before.digest)
  })

  // codex-review-r6 Low — 값 없는 상충 플래그도 실제 CLI 에서 접혀야 한다(부작용 0).
  it('`--gates --no-gates`(값 없음) 와 `--gates` 단독은 exit 2 · 실행 0', () => {
    const e = makeE2E()
    const before = { porcelain: e.fx.porcelain(), digest: treeDigest(e.proj) }
    const cases = [
      [['--gates', '--no-gates'], /함께 쓸 수 없다/],
      [['--no-gates', '--gates'], /함께 쓸 수 없다/],
      [['--gates'], /--gates 에 값이 없습니다/],
      [['--gates', '--dry-run'], /--gates 에 값이 없습니다/],
    ]
    for (const [args, why] of cases) {
      const r = runAF(e, args)
      assert.equal(r.status, 2, `${args.join(' ')} — 종료 코드 ${r.status}\n${r.out}`)
      assert.match(r.out, why, r.out)
      assert.equal(r.outDir, null, '거부했는데 산출물이 생겼다')
    }
    assert.equal(lines(join(e.stub, 'qa-calls.log')).length, 0, '거부했는데 게이트가 돌았다')
    assert.equal(e.fx.porcelain(), before.porcelain)
    assert.equal(treeDigest(e.proj), before.digest)
  })

  it('`--diagnose-only` 단독은 종전처럼 돌되 게이트는 0 이다(기본 qa 도 접힌다)', () => {
    const e = makeE2E()
    const r = runAF(e, ['--diagnose-only'])
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(r.run.gateCalls, {})
    assert.deepEqual(r.run.options.gates, [])
    assert.equal(lines(join(e.stub, 'qa-calls.log')).length, 0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E15 (NEW-H3) — state·out 은 대상 저장소 안에 둘 수 없다', () => {
  it('--state <root>/src · --out <root>/README.md · 저장소를 가리키는 junction 을 전부 exit 2 로 거부한다', () => {
    const e = makeE2E()
    const before = { digest: treeDigest(e.proj), porcelain: e.fx.porcelain() }

    const bad = [
      ['--state', join(e.proj, 'src')],
      ['--state', e.proj],
      ['--out', join(e.proj, 'README.md')],
    ]
    // 저장소 안을 가리키는 링크(밖에 있어도 실제 위치가 안이면 거부)
    const link = join(e.T, 'into-repo')
    try { symlinkSync(e.proj, link, 'junction'); bad.push(['--state', join(link, 'af')]) } catch { /* 권한 없으면 이 갈래만 건너뛴다 */ }

    for (const [flag, value] of bad) {
      const r = spawnSync(process.execPath, [AUTOFINISH, '--root', e.proj, flag, value, '--diagnose-only'], {
        cwd: e.proj, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024, env: baseEnv(e),
      })
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
      assert.equal(r.status, 2, `${flag} ${value} — 종료 코드 ${r.status}\n${out}`)
      assert.match(out, /저장소 안에 둘 수 없다/, out)
    }
    assert.equal(treeDigest(e.proj), before.digest, '거부했는데 저장소가 바뀌었다')
    assert.equal(e.fx.porcelain(), before.porcelain)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E16 (NEW-H4) — 지휘 모델 실패의 stderr 원문은 프로세스 출력에도 남지 않는다', () => {
  it('스텁이 stderr 로 Authorization 을 흘리며 실패해도 stdout/stderr·산출물 전수 grep 0', () => {
    const e = makeE2E()
    const TOKEN = 'TOKENVALUE123456'
    const r = runAF(e, ['--max-rounds', '1', '--no-gates', '--dry-run'], { STUB_PLAN: 'leak', STUB_LEAK_TOKEN: TOKEN })
    assert.equal(r.status, 0, `계획 실패로 밤이 섰다: ${r.out}`)

    // 실제로 실패 경로를 탔다 — 폴백 사유는 **고정 코드**뿐이다
    const p = r.readJson('round-0-plan.json')
    assert.match(p.source, /^deterministic-fallback\(runner-(error|nonzero|timeout)\)$/, `출처에 원문이 섞였다: ${p.source}`)

    // 프로세스 출력 전수 · 산출물 전수
    assert.ok(!r.stdout.includes(TOKEN), `stdout 에 원문이 남았다: ${r.stdout.slice(-500)}`)
    assert.ok(!r.stderr.includes(TOKEN), `stderr 에 원문이 남았다: ${r.stderr.slice(-500)}`)
    assert.ok(!r.out.includes('Bearer ' + TOKEN))
    assert.deepEqual(grepAll(r.outDir, TOKEN), [], '산출물에 원문이 남았다')
    // 「있었다」는 사실은 남는다 — 상세는 마스킹돼 산출물에만
    assert.match(String(p.plan.errorDetail ?? ''), /REDACTED/, `errorDetail 이 비었다: ${JSON.stringify(p.plan.errorDetail)}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E17 (NEW-M1) — --no-gates 여도 마지막에 다시 진단한다', () => {
  it('러너가 스토리 파일을 바꾼 뒤의 상태로 보고한다(실행 전 스냅숏이 아니다)', () => {
    const e = makeE2E()
    const r = runAF(e, ['--max-rounds', '1', '--no-gates'], { AUTOFINISH_NO_LLM: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.readJson('round-0-runner.json').exit, 0, r.out)
    // 러너가 실제로 스토리를 고쳤다(스텁 dev/review 가 Status·Patch 를 닫는다)
    assert.ok(readCalls(e.stub).some((c) => c.kind === 'dev'), 'dev 가 돌지 않았다 — 이 시나리오가 성립하지 않는다')

    assert.ok(r.files.includes('final-diagnosis.json'), '--no-gates 에서 최종 재진단을 하지 않았다')
    assert.ok(r.files.includes('final-backlog.json'), '--no-gates 에서 최종 백로그를 만들지 않았다')

    const before = r.readJson('round-0-diagnosis.json')
    const after = r.readJson('final-diagnosis.json')
    const sig = (d) => JSON.stringify((d.stories ?? []).map((s) => [s.key, s.verdict]).sort())
    assert.notEqual(sig(after), sig(before), '최종 진단이 실행 전 스냅숏 그대로다')
    // 보고서 수치도 최종 진단에서 나온다
    assert.equal(r.report.run.rounds, 1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E18 (NEW-M3) — BMAD 등재가 폐기되면 그 스토리는 이번 라운드에서 뺀다', () => {
  it('쓰기가 거부된 스토리는 러너 큐에 없고 · 계획에 쓰기가 없던 독립 스토리는 그대로 돈다', async () => {
    // 쓰기 상한 1 로 「계획에 걸린 스토리」를 한 건으로 좁히고, 허용 경로를 좁혀 그 한 건을 거부시킨다.
    // (실전의 발생 원인 — 해시 충돌·junction·경로 거부 — 가운데 경로 거부를 결정적으로 재현한다.)
    const e = makeE2E({
      config: { autofinish: { guards: { maxWritesPerRound: 1, allowedPathPrefixes: ['_bmad-output/planning-artifacts/'] } } },
    })
    const seen = []
    const r = await runAutoFinish({
      root: e.proj, state: e.afState, maxRounds: 1, gates: [], log: () => {}, planRunner: false, bmadWrites: 'on',
      spawnRunner: (_bin, args) => { seen.push(args); return { status: 0, stdout: '', stderr: '' } },
    })
    const readJson = (n) => JSON.parse(readFileSync(join(r.outDir, n), 'utf8'))

    const applied = readJson('round-0-bmad-apply.json')
    assert.equal(applied.rolledBack, true, `등재가 폐기되지 않았다: ${JSON.stringify(applied.rejected)}`)
    const planned = readJson('round-0-bmad-plan.json')
    const blockedKeys = [...new Set(planned.writes.map((w) => /^(story|new|done):(.+)$/.exec(String(w.group ?? ''))?.[2]).filter(Boolean))]
    assert.ok(blockedKeys.length >= 1, '계획에 스토리 쓰기가 없다 — 이 시나리오가 성립하지 않는다')

    const q = readJson('round-0-queue.json')
    const keys = q.batches.flatMap((b) => b.stories)
    for (const k of blockedKeys) assert.ok(!keys.includes(k), `등재가 폐기된 ${k} 가 편성됐다: ${JSON.stringify(keys)}`)
    assert.ok(keys.length >= 1, '봉쇄가 밤 전체를 세웠다 — 쓰기가 없던 스토리는 계속 돌아야 한다')
    assert.ok(q._편성.excluded.some((x) => /BMAD 등재가 폐기/.test(x.why)), `봉쇄 사유가 큐에 남지 않았다: ${JSON.stringify(q._편성.excluded)}`)

    // 러너는 떴고, argv 가 가리키는 큐에도 그 스토리는 없다
    assert.equal(seen.length, 1, '러너가 뜨지 않았다')
    const passed = JSON.parse(readFileSync(seen[0][seen[0].indexOf('--queue') + 1], 'utf8'))
    for (const k of blockedKeys) assert.ok(!passed.batches.flatMap((b) => b.stories).includes(k), `러너에게 넘긴 큐에 ${k} 가 남았다`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E12 — 하위 호환: 기존 경로는 그대로다', () => {
  it('run-night 는 수동 큐 단독으로 종전처럼 돈다(autofinish 와 무관)', () => {
    const e = makeE2E()
    const qPath = join(e.proj, 'tools', 'auto', 'night-queue.json')
    writeFileSync(qPath, JSON.stringify({
      planned: 'manual-e2e',
      defaults: { commit: false, push: false, parallel: 1, stageTimeoutMin: 5, waitAuthMin: 0 },
      batches: [{ label: '수동', enabled: true, stories: ['2-1-패치-열림'], stages: ['dev'], models: { dev: 'opus' } }],
    }, null, 2))
    const r = spawnSync(process.execPath, [join(e.proj, 'tools', 'auto', 'run-night.mjs'), '--queue', qPath, '--dry-run'], {
      cwd: e.proj, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024, env: baseEnv(e),
    })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    const out = `${r.stdout}\n${r.stderr}`
    assert.ok(out.includes(qPath), '수동 큐 경로를 쓰지 않았다')
    assert.ok(out.includes('수동'), '수동 큐의 배치 라벨이 요약에 없다')
    assert.ok(!existsSync(join(e.afState, 'autofinish')), '수동 경로가 autofinish 산출물을 만들었다')
  })

  it('plan-queue 의 판단은 autofinish 산출물이 있든 없든 같다', () => {
    const e = makeE2E()
    const cfg = JSON.parse(readFileSync(join(e.proj, 'tools', 'auto', 'auto.config.json'), 'utf8'))
    const before = planQueue({ root: e.proj, stateDir: join(e.T, 'pq1'), config: cfg, today: '2026-09-03' })
    runAF(e, ['--diagnose-only', '--no-gates'])
    const after = planQueue({ root: e.proj, stateDir: join(e.T, 'pq2'), config: cfg, today: '2026-09-03' })
    assert.deepEqual(after.queue.batches, before.queue.batches, '진단만 돌렸는데 편성 결과가 달라졌다')
    assert.deepEqual(after.queue._편성.picked, before.queue._편성.picked)
  })
})
