// 병렬 워커 풀 · 엔진 · landing · 통합 게이트 **종단 테스트** — 실 LLM 0 (claude/codex 는 스텁 .cmd · CLAUDE_BIN/CODEX_BIN 규약).
//
// 무엇을 증명하나: 러너(run-night)가 워크트리 2개를 만들고 엔진 2개를 프로바이더 상한 안에서 띄우며, 엔진은 dev(claude 스텁) →
// qa → review(codex 스텁 · JSON → 엔진이 원장 기재) → 커밋(detached) 을 하고, 러너가 cherry-pick landing → 통합 게이트 → 요약까지
// 실제 git 위에서 완주한다. 실패 격리 · 통합 RED 되돌림 · codex 한도 → claude 폴백 · dry-run 무실행도 같은 하네스로 검증한다.
//
// 격리: USERPROFILE/HOME 을 임시 폴더로 바꿔 전역 스킬·알림 설정·codex 슬롯 잠금이 전부 임시 폴더 안에서 논다(실 알림 0 · 실 전역 무접촉).
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '..', '..')
const IS_WIN = process.platform === 'win32'
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const ok = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${r.stderr || r.stdout}`) }

// ── 스텁: claude ─────────────────────────────────────────────────────────────────────────
const CLAUDE_STUB = String.raw`
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
const argv = process.argv.slice(2)
const log = (m) => { try { appendFileSync(join(process.env.E2E_STATE, 'stub-calls.log'), m + '\n') } catch {} }
// (N2 보조) 워커가 실제로 어떤 git 환경에서 도는지 남긴다 — 러너가 워크트리 워커에게 credential.helper 를
// 껐다면 in-flight config 로 그 값이 **빈 문자열로 조회된다**(안 껐으면 미설정 = exit 1).
const logEnv = () => { try {
  const g = spawnSync('git', ['config', '--get', 'credential.helper'], { encoding: 'utf8' })
  appendFileSync(join(process.env.E2E_STATE, 'worker-env.log'),
    'count=' + (process.env.GIT_CONFIG_COUNT || '-') + ' key=' + (process.env.GIT_CONFIG_KEY_0 || '-') +
    ' credhelper exit=' + (g.status ?? '?') + ' out=' + JSON.stringify((g.stdout || '').trim()) + '\n')
} catch {} }
if (argv.includes('--version')) { console.log('2.1.250-stub (Claude Code)'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const cwd = process.cwd()
const art = join(cwd, '_bmad-output', 'implementation-artifacts')
const findStory = (key) => readdirSync(art).filter((f) => f.startsWith(key) && f.endsWith('.md')).sort((a, b) => a.length - b.length)[0]
const setSprint = (key, status) => { const p = join(art, 'sprint-status.yaml'); writeFileSync(p, readFileSync(p, 'utf8').replace(new RegExp('^(  ' + key + ':\\s*)\\S+', 'm'), '$1' + status)) }
if (prompt.trim() === 'ok') { log('probe'); process.exit(0) }
let m = /\/bmad-dev-story (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  log('dev ' + key)
  logEnv()
  if (process.env.E2E_CLAUDE_FAIL_STORY === key) {
    // 실패 직전에 「절반쯤 해 둔 일」을 남긴다 — 증거 보존(#13)의 재료: 추적 파일 수정 · 미추적 신규 · 민감 파일(추적/미추적)
    appendFileSync(join(cwd, 'src', 'keep.ts'), 'export const half_done = 2\n')
    writeFileSync(join(cwd, 'secrets', 'app.pem'), '-----BEGIN PRIVATE KEY-----\nLEAKED_PEM_BODY_XYZ\n-----END PRIVATE KEY-----\n')
    writeFileSync(join(cwd, 'src', 'new-thing.ts'), 'export const brand_new = 3\n')
    writeFileSync(join(cwd, 'src', 'leaky-note.txt'), 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_ABCDEFGH12345678\n')
    writeFileSync(join(cwd, 'secret.pem'), 'UNTRACKED_PEM_LEAK_XYZ\n')
    mkdirSync(join(cwd, 'config'), { recursive: true })
    writeFileSync(join(cwd, 'config', 'credentials.json'), '{"password":"hunter2hunter2"}\n')
    console.error('boom: simulated worker failure'); process.exit(1)
  }
  const f = join(art, findStory(key))
  let md = readFileSync(f, 'utf8')
  const BT = String.fromCharCode(96)
  const files = [...md.matchAll(new RegExp('^- ' + BT + '([^' + BT + ']+)' + BT, 'gm'))].map((x) => x[1])
  for (const p of files) { mkdirSync(join(cwd, dirname(p)), { recursive: true }); writeFileSync(join(cwd, p), 'export const ' + key.replace(/-/g, '_') + ' = 1\n') }
  md = md.replace('- [ ] T1', '- [x] T1').replace(/^Status:\s*\S+/m, 'Status: review') + '\n### Dev Agent Record\n- stub dev done\n'
  writeFileSync(f, md)
  setSprint(key, 'review')
  console.log('dev 완료')
  process.exit(0)
}
m = /\/bmad-code-review (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  log('review ' + key)
  const f = join(art, findStory(key))
  let md = readFileSync(f, 'utf8')
  md = md.replace(/^Status:\s*\S+/m, 'Status: done').replace('## Dev Notes', '### Review Findings — claude 스텁\n\n- ✅ Clean review — 발견 0건\n\n## Dev Notes')
  writeFileSync(f, md)
  setSprint(key, 'done')
  console.log('review 완료')
  process.exit(0)
}
if (/자동 수리/.test(prompt)) { log('repair'); const f = join(cwd, 'REPAIRED'); writeFileSync(f, '1'); console.log('수리 완료'); process.exit(0) }
console.error('stub: 알 수 없는 프롬프트'); process.exit(1)
`

// ── 스텁: codex ──────────────────────────────────────────────────────────────────────────
const CODEX_STUB = String.raw`
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const argv = process.argv.slice(2)
const log = (m) => { try { appendFileSync(join(process.env.E2E_STATE, 'stub-calls.log'), m + '\n') } catch {} }
const ev = (o) => console.log(JSON.stringify(o))
if (argv.includes('--version')) { console.log('codex-cli 0.152.1-stub'); process.exit(0) }
if (argv[0] === 'login' && argv[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const out = argv[argv.indexOf('-o') + 1]
const sandbox = argv[argv.indexOf('-s') + 1]
const story = /스토리 (\S+)/.exec(prompt)?.[1] ?? '?'
log('codex ' + sandbox + ' ' + story)
if (process.env.E2E_CODEX_LIMIT === '1') { ev({ type: 'thread.started', thread_id: 't' }); ev({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro" }); ev({ type: 'turn.failed', error: { message: 'usage limit' } }); process.exit(1) }
const BT = String.fromCharCode(96)
const diffFile = new RegExp('리뷰 대상 diff[^' + BT + ']*' + BT + '([^' + BT + ']+)' + BT).exec(prompt)?.[1]
const diff = diffFile ? readFileSync(join(process.cwd(), diffFile), 'utf8') : ''
const findings = /2-1-a/.test(story) && diff.includes('src/a.ts')
  ? [{ lens: 'blind', severity: 'medium', kind: 'patch', title: 'stub finding', file: 'src/a.ts', line: 1, detail: '스텁이 낸 지적', evidence: 'export const', preExisting: false }]
  : []
const json = { summary: '스텁 리뷰', verdict: findings.length ? 'findings' : 'clean', acVerdicts: [{ ac: 'AC-1', status: 'pass', evidence: 'stub' }], findings }
ev({ type: 'thread.started', thread_id: 't1' })
ev({ type: 'turn.started' })
ev({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'cat', exit_code: 0 } })
ev({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: JSON.stringify(json) } })
ev({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
if (out) writeFileSync(out, JSON.stringify(json))
process.exit(0)
`

const QA_SCRIPT = String.raw`
import { existsSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
try { appendFileSync(process.env.E2E_STATE + '/qa-calls.log', process.cwd() + '\n') } catch {}
if (process.env.E2E_QA_LEAK === '1') {
  // 시크릿을 **qa 출력에** 흘린다 — 통합 게이트 로그·증거 사본·요약이 원문을 남기는지 보는 재료(N3).
  console.log('{"api_key":"JSONSECRET123456"}')
  console.log('Authorization: Bearer TOKENVALUE123456')
  console.error('PRIVATE_KEY="alpha beta gamma secret"')
}
if (process.env.E2E_QA_FAIL_WHEN_BOTH === '1' && existsSync('src/a.ts') && existsSync('src/b.ts')) { console.log('FAIL  tests/integration.test.ts > both present\nAssertionError: integration conflict'); process.exit(1) }
// 순차 경로용 — 두 스토리가 **커밋까지 끝난 뒤**에만 RED. 스토리별 엔진 qa 는 통과하고(그때 뒤 스토리는
// 아직 미커밋) 배치 통합 게이트에서만 걸린다 = 「각자 GREEN · 합치면 RED」를 순차에서 재현하는 유일한 갈래다.
if (process.env.E2E_QA_FAIL_WHEN_BOTH_COMMITTED === '1') {
  const t = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).stdout || ''
  if (t.includes('src/a.ts') && t.includes('src/b.ts')) { console.log('FAIL  tests/integration.test.ts > both committed\nAssertionError: integration conflict'); process.exit(1) }
}
process.exit(0)
`

function makeFixture({ config = {}, models = { dev: 'fable', review: 'codex' }, queueDefaults = {} } = {}) {
  const T = mkdtempSync(join(tmpdir(), 'nbo-e2e-'))
  const home = join(T, 'home'), state = join(T, 'state'), bin = join(T, 'bin'), proj = join(T, 'proj')
  mkdirSync(home, { recursive: true }); mkdirSync(state, { recursive: true }); mkdirSync(bin, { recursive: true })
  // 전역 스킬(엔진) 사본 — 러너는 ~/.claude/skills/auto-story-finish/ 에서 엔진을 찾는다
  const skill = join(home, '.claude', 'skills', 'auto-story-finish')
  mkdirSync(skill, { recursive: true })
  // 목록을 고정하지 않는다 — 엔진에 새 모듈(completion-rules…)이 생기면 픽스처만 구판이 되어 ERR_MODULE_NOT_FOUND 로 죽는다(2026-09-02 실측 2회).
  for (const f of readdirSync(join(REPO, 'auto-story-finish')).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) cpSync(join(REPO, 'auto-story-finish', f), join(skill, f))
  cpSync(join(REPO, 'auto-story-finish', 'providers'), join(skill, 'providers'), { recursive: true })
  // 스텁 실행 파일
  writeFileSync(join(bin, 'claude-stub.mjs'), CLAUDE_STUB)
  writeFileSync(join(bin, 'codex-stub.mjs'), CODEX_STUB)
  if (IS_WIN) {
    writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude-stub.mjs" %*\r\n')
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-stub.mjs" %*\r\n')
  } else {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node "${join(bin, 'claude-stub.mjs')}" "$@"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec node "${join(bin, 'codex-stub.mjs')}" "$@"\n`, { mode: 0o755 })
  }
  // 저장소 — bare origin + 작업 클론
  const origin = join(T, 'origin.git')
  ok(git(T, ['init', '-q', '--bare', origin]), 'bare')
  ok(git(T, ['clone', '-q', origin, proj]), 'clone')
  ok(git(proj, ['config', 'user.email', 'e2e@test']), 'cfg'); ok(git(proj, ['config', 'user.name', 'e2e']), 'cfg')
  ok(git(proj, ['config', 'core.autocrlf', 'false']), 'cfg')
  const art = join(proj, '_bmad-output', 'implementation-artifacts')
  mkdirSync(join(art, 'auto-pipeline-logs'), { recursive: true })
  mkdirSync(join(proj, 'tools', 'auto'), { recursive: true })
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'fx', type: 'module', scripts: { qa: 'node tools/qa.mjs', typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0' } }, null, 2))
  writeFileSync(join(proj, 'tools', 'qa.mjs'), QA_SCRIPT)
  // nested 워커의 commit/push deny 설정 — 엔진은 이게 없으면 시작조차 하지 않는다(2026-09-02 fail-closed).
  mkdirSync(join(proj, '.claude'), { recursive: true })
  writeFileSync(join(proj, '.claude', 'pipeline-settings.json'), JSON.stringify({
    permissions: { deny: ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git stash:*)', 'Bash(git reset:*)'] },
  }, null, 2))
  // 증거 보존(#13) 재료 — 워커가 만질 **추적** 파일 하나와, diff 에 실리면 안 되는 **추적 민감** 파일 하나
  mkdirSync(join(proj, 'src'), { recursive: true }); writeFileSync(join(proj, 'src', 'keep.ts'), 'export const keep = 1\n')
  mkdirSync(join(proj, 'secrets'), { recursive: true }); writeFileSync(join(proj, 'secrets', 'app.pem'), '-----BEGIN PRIVATE KEY-----\nORIGINAL_PEM_BODY\n-----END PRIVATE KEY-----\n')
  writeFileSync(join(proj, '.gitignore'), 'node_modules\n.env*\n!.env.example\n_bmad-output/implementation-artifacts/auto-pipeline-logs/*qa*.log\n')
  const story = (key, file) => `# Story ${key}\n\nStatus: ready-for-dev\n\n## Acceptance Criteria\n\n- AC-1 x\n\n## Tasks / Subtasks\n\n- [ ] T1 구현\n\n### File List\n\n- \`${file}\`\n\n## Dev Notes\n\n없음\n`
  writeFileSync(join(art, '2-1-a.md'), story('2-1-a', 'src/a.ts'))
  writeFileSync(join(art, '2-2-b.md'), story('2-2-b', 'src/b.ts'))
  writeFileSync(join(art, 'sprint-status.yaml'), 'last_updated: 2026-09-01\ndevelopment_status:\n  2-1-a: ready-for-dev\n  2-2-b: ready-for-dev\n')
  writeFileSync(join(art, 'deferred-work.md'), '# Deferred\n')
  writeFileSync(join(art, 'DECISIONS-INBOX.md'), '# 결정 인박스\n')
  writeFileSync(join(art, 'auto-pipeline-logs', 'state.json'), '{"done":{}}\n')
  // 엔진 모듈은 **목록을 고정하지 않고** 통째로 복사한다 — 새 모듈(plan-dag·conflicts…)이 추가될 때마다
  // 픽스처가 ERR_MODULE_NOT_FOUND 로 죽던 자리다(2026-09-02 실측).
  for (const f of readdirSync(here).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) cpSync(join(here, f), join(proj, 'tools', 'auto', f))
  writeFileSync(join(proj, 'tools', 'auto', 'auto.config.json'), JSON.stringify({
    project: 'fx', epicOrder: [2], dailyCap: 30, parallel: 2, stateDir: state, qa: 'node tools/qa.mjs', mockupGate: { marker: '' },
    providers: { codex: { enabled: true, max: 1, roles: ['review'] } }, quality: { autoRepair: true }, integrationGate: { enabled: true },
    ...config,
  }, null, 2))
  writeFileSync(join(proj, 'tools', 'auto', 'night-queue.json'), JSON.stringify({
    planned: 'manual-e2e', defaults: { commit: true, push: false, parallel: 2, stageTimeoutMin: 5, waitAuthMin: 0, ...queueDefaults },
    batches: [{ label: 'E2E 병렬 짝', enabled: true, stories: ['2-1-a', '2-2-b'], stages: ['dev', 'review'], models }],
  }, null, 2))
  writeFileSync(join(proj, '.env.local'), 'SECRET_TOKEN=abcdefghijklmnop\n')
  ok(git(proj, ['add', '-A']), 'add'); ok(git(proj, ['commit', '-q', '-m', 'init']), 'commit'); ok(git(proj, ['push', '-q', 'origin', 'HEAD:main']), 'push')
  ok(git(proj, ['branch', '-q', '-M', 'main']), 'branch')
  return { T, home, state, bin, proj, art }
}

function runRunner(fx, { env = {}, args = [] } = {}) {
  const r = spawnSync(process.execPath, [join(fx.proj, 'tools', 'auto', 'run-night.mjs'), '--queue', join(fx.proj, 'tools', 'auto', 'night-queue.json'), ...args], {
    cwd: fx.proj, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, USERPROFILE: fx.home, HOME: fx.home, AUTO_BATCH_STATE_DIR: fx.state, E2E_STATE: fx.state,
      CLAUDE_BIN: join(fx.bin, IS_WIN ? 'claude.cmd' : 'claude'), CODEX_BIN: join(fx.bin, IS_WIN ? 'codex.cmd' : 'codex'),
      PIPELINE_NTFY_TOPIC: 'off', E2E_CLAUDE_FAIL_STORY: '', E2E_CODEX_LIMIT: '', E2E_QA_FAIL_WHEN_BOTH: '',
      E2E_QA_FAIL_WHEN_BOTH_COMMITTED: '', E2E_QA_LEAK: '', ...env,
    },
  })
  const summary = existsSync(join(fx.art, 'auto-pipeline-logs', 'night-last-run.md')) ? readFileSync(join(fx.art, 'auto-pipeline-logs', 'night-last-run.md'), 'utf8') : ''
  const runLog = existsSync(join(fx.art, 'auto-pipeline-logs', 'run-summary.log')) ? readFileSync(join(fx.art, 'auto-pipeline-logs', 'run-summary.log'), 'utf8') : ''
  const calls = existsSync(join(fx.state, 'stub-calls.log')) ? readFileSync(join(fx.state, 'stub-calls.log'), 'utf8') : ''
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary, runLog, calls, out: `${r.stdout}\n${r.stderr}` }
}
const commitsOnBranch = (proj) => git(proj, ['log', '--oneline', 'main..HEAD']).stdout.trim().split('\n').filter(Boolean)
/** 원격(bare origin)에 실제로 올라간 브랜치 — 「push 0건」을 말로가 아니라 ref 로 센다 */
const originHeads = (proj) => git(proj, ['ls-remote', '--heads', 'origin']).stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')[1])
const walkFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)]))
/** 증거 폴더 — state/archive/<시각>-evidence/<story> */
const evidenceDir = (fx, story) => {
  const root = join(fx.state, 'archive')
  if (!existsSync(root)) return ''
  // 스토리마다 별도 스탬프 폴더가 생긴다 — 이름이 아니라 **그 스토리를 담은** 폴더를 찾는다
  const stamp = readdirSync(root).filter((d) => d.endsWith('-evidence')).find((d) => existsSync(join(root, d, story)))
  return stamp ? join(root, stamp, story) : ''
}
const fixtures = []
after(() => { for (const fx of fixtures) { try { rmSync(fx.T, { recursive: true, force: true }) } catch { /* 잠긴 파일은 OS 가 정리 */ } } })

describe('[e2e] 병렬 워커 풀 → 엔진(claude dev · codex review) → landing → 통합 게이트', { timeout: 300_000 }, () => {
  let fx, r
  before(() => { fx = makeFixture(); fixtures.push(fx); r = runRunner(fx) })
  it('러너 exit 0 · 워커 풀 2폭 · 두 스토리 모두 landing · 통합 게이트 PASS', () => {
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(r.summary, /병렬 실행 2폭/)
    assert.match(r.summary, /워커 풀 — 총 2 · claude 3 · codex 1/)
    assert.match(r.summary, /완주: 2-1-a \(병렬 dev → landing\)/)
    // 두 번째 landing 은 공유 장부(run-summary·state.json·sprint-status) 3파일 충돌을 OPS-4 규칙(union/ours)으로 자동 해소한다
    assert.match(r.summary, /완주: 2-2-b \(병렬 dev → landing · 충돌 자동 해소 3파일\)/)
    assert.match(r.summary, /\[INTEGRATION\]\[PASS\]/)
    // 스토리 2 + 통합 게이트 결과 매니페스트 1 (2026-09-02 #16 — 매니페스트를 커밋해 트리를 깨끗이 남긴다)
    const cs = commitsOnBranch(fx.proj)
    assert.equal(cs.length, 3, cs.join('|'))
    assert.equal(cs.filter((l) => /통합 게이트 결과 매니페스트 반영/.test(l)).length, 1, cs.join('|'))
    assert.match(git(fx.proj, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout, /^auto\//)
  })
  it('엔진: 프로바이더 감지 줄 · codex 리뷰가 원장 형식으로 기재 · 상태 전이(findings → in-progress · clean → done) · sprint-status 동기', () => {
    assert.match(r.runLog, /\[PROVIDERS\] claude=YES\(.*\) codex=YES\(codex-cli 0\.152\.1-stub\)/)
    const a = readFileSync(join(fx.art, '2-1-a.md'), 'utf8')
    const b = readFileSync(join(fx.art, '2-2-b.md'), 'utf8')
    assert.match(a, /### Review Findings — Codex 교차리뷰 \(\d{4}-\d{2}-\d{2} · 1차 · codex exec · default model\)/)
    assert.match(a, /^- \[ \] \[Review\]\[Patch\]\[medium\] stub finding \[src\/a\.ts:1\] — 스텁이 낸 지적/m)
    assert.match(a, /^Status: in-progress/m)
    assert.match(b, /- ✅ Clean review — 발견 0건/)
    assert.match(b, /^Status: done/m)
    const sprint = readFileSync(join(fx.art, 'sprint-status.yaml'), 'utf8')
    assert.match(sprint, /^  2-1-a: in-progress/m)
    assert.match(sprint, /^  2-2-b: done/m)
    assert.match(r.runLog, /\[2-1-a\]\[CODEX\]\[REVIEW\] 기재 완료 — decision 0 · patch 1\(high 0\)/)
    // 현황판이 읽는 줄 형식 그대로
    assert.match(r.runLog, /→ \[2-1-a\] review \(model=codex:default, perm=sandbox:read-only\)/)
    assert.match(r.runLog, /→ \[2-2-b\] dev \(model=fable, perm=acceptEdits\)/)
  })
  it('검증 매니페스트 · .env 격리 후 복원 · transient 파일 0 · 워크트리 정리 · 시크릿이 로그에 없다', () => {
    const m = JSON.parse(readFileSync(join(fx.art, 'auto-pipeline-logs', '2-1-a-verification.json'), 'utf8'))
    assert.equal(m.schema, 'auto-story-finish/verification/1')
    assert.equal(m.checks.qa, 'pass')
    assert.equal(m.workers.review.provider, 'codex')
    assert.equal(m.workers.dev.provider, 'claude')
    assert.equal(m.review.provider, 'codex')
    assert.equal(m.review.counts.patch, 1)
    assert.ok(existsSync(join(fx.proj, '.env.local')), '.env.local 은 배치 트리에 그대로')
    assert.ok(!existsSync(join(fx.T, 'proj-wt0')) && !existsSync(join(fx.T, 'proj-wt1')), '워크트리 제거')
    assert.ok(!readdirSync(join(fx.art, 'auto-pipeline-logs')).some((f) => /^codex-.*\.(last\.txt|txt)$/.test(f)), 'transient 파일 없음')
    assert.match(r.calls, /codex read-only 2-1-a/)
    assert.ok(!r.runLog.includes('abcdefghijklmnop'), '시크릿 값이 run-summary 에 없다')
  })
  // (N2 보조 · 2026-09-02 codex-review-r2) 워크트리는 본 트리의 `.git/config` 를 공유한다 —
  // `git config credential.helper ""` 를 워크트리에서 부르면 **본 트리의 자격증명까지** 끈다.
  // 그래서 프로세스 환경(GIT_CONFIG_COUNT/KEY_0/VALUE_0)으로 끈다. 여기서는 워커(엔진의 자식)가
  // 실제로 `git config --get credential.helper` 를 불러 **빈 값이 조회되는지**를 본다
  // (안 껐으면 미설정이라 exit 1 · 조회값 없음 — 두 상태가 실행으로 구분된다).
  it('[N2] 워크트리 워커의 git 은 credential.helper 가 빈 값으로 강제된다(저장소 config 무접촉)', () => {
    const p = join(fx.state, 'worker-env.log')
    assert.ok(existsSync(p), 'worker-env.log 없음 — 스텁이 환경을 남기지 않았다')
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 2, lines.join(' | '))
    // 앵커의 **의미**: ① `credential.helper` 가 강제 키 목록의 첫 칸이고 ② git 이 그 값을 **빈 문자열로 조회**한다.
    // 강제 항목 수(`count=`)는 기계적 세부다 — 2026-09-02 R3 에서 엔진 git 가드가 askpass·프록시까지 함께
    // 끄면서 1 → 5 로 늘었다(더 세진 것이지 느슨해진 것이 아니다). 그래서 개수는 **1 이상**만 요구한다.
    for (const l of lines) {
      assert.match(l, / key=credential\.helper credhelper exit=0 out=""$/, l)
      const n = Number(/^count=(\d+) /.exec(l)?.[1] ?? 0)
      assert.ok(n >= 1, `강제 config 가 하나도 없다: ${l}`)
    }
    // 본 트리 저장소 config 는 건드리지 않았다 — 워크트리에서 `git config` 를 썼다면 여기에 남는다
    assert.equal(git(fx.proj, ['config', '--local', '--get', 'credential.helper']).status, 1, '저장소 config 가 수정됐다')
  })
})

describe('[e2e] 통합 게이트 RED → landing 되돌림 · push 없음 · archive 태그 보존 · exit 1', { timeout: 300_000 }, () => {
  it('두 스토리는 각자 GREEN 이지만 합치면 RED — 브랜치는 landing 전으로', () => {
    const fx = makeFixture(); fixtures.push(fx)
    const r = runRunner(fx, { env: { E2E_QA_FAIL_WHEN_BOTH: '1' } })
    assert.equal(r.status, 1, r.out.slice(-2000))
    assert.match(r.summary, /\[INTEGRATION\]\[FAIL\] 통합 게이트 RED\(exit 1\)/)
    assert.equal(commitsOnBranch(fx.proj).length, 0, 'landing 커밋이 브랜치에 남지 않는다')
    const tags = git(fx.proj, ['tag', '-l', 'archive/integration-fail-*']).stdout.trim().split('\n').filter(Boolean)
    assert.equal(tags.length, 2, tags.join(','))
    assert.ok(existsSync(join(fx.art, 'auto-pipeline-logs', 'integration-gate.log')))
  })
})

// ── #7 / #16 — 통합 게이트 RED 는 설정으로 우회되지 않는다 · 결과는 매니페스트로 남는다 ──────────
// 여기서만 `push: true` 로 돌린다(원격 = 같은 임시 폴더의 bare 저장소). 「push 0건」을 로그 문구가 아니라
// **원격 ref** 로 센다. codex 는 끄고 claude 스텁만 쓴다 — 검증 대상은 게이트지 프로바이더가 아니다.
const gateFixture = () => makeFixture({
  models: { dev: 'fable', review: 'opus' },
  // pushOnFail: true 를 **일부러 남겨 둔다** — 폐지된 설정이 실제로 무력한지 보는 것이 이 테스트다
  config: { providers: { codex: { enabled: false } }, integrationGate: { enabled: true, pushOnFail: true } },
  queueDefaults: { push: true },
})
const batchManifest = (fx) => {
  const dir = join(fx.art, 'auto-pipeline-logs')
  const f = readdirSync(dir).find((n) => /^batch-.*-manifest\.json$/.test(n))
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null
}

describe('[e2e][#7] 통합 RED — pushOnFail 이 켜져 있어도 원격에 아무것도 올라가지 않는다', { timeout: 300_000 }, () => {
  let fx, r
  before(() => { fx = gateFixture(); fixtures.push(fx); r = runRunner(fx, { env: { E2E_QA_FAIL_WHEN_BOTH: '1' } }) })
  it('폐지 경고 · rollback · 원격 ref 0건 · 로컬 landing 0건 · exit 1', () => {
    assert.equal(r.status, 1, r.out.slice(-3000))
    assert.match(r.out, /⚠ \[INTEGRATION\] pushOnFail 은 폐지됨 — RED 는 항상 rollback/)
    assert.match(r.summary, /\[INTEGRATION\]\[FAIL\] 통합 게이트 RED\(exit 1\)/)
    assert.ok(!/FAIL→PUSH|push-anyway/.test(r.summary + r.out), 'RED→push 경로가 살아 있으면 안 된다')
    assert.deepEqual(originHeads(fx.proj), ['refs/heads/main'], '원격에 auto/* 가 올라가면 안 된다')
    assert.equal(commitsOnBranch(fx.proj).length, 0, 'landing 커밋도 되돌아가 있어야 한다')
  })
  it('[#16] 배치 매니페스트에 rollback 이 남고 push=false', () => {
    const m = batchManifest(fx)
    assert.ok(m, '배치 매니페스트 없음')
    assert.equal(m.schema, 'night-batch-ops/batch-manifest/1')
    assert.equal(m.integration.result, 'rollback')
    assert.equal(m.integration.qaExit, 1)
    assert.match(m.integration.landingBase, /^[0-9a-f]{40}$/)
    assert.equal(m.pushed, false)
    assert.deepEqual(m.landing.map((l) => `${l.order}:${l.story}`), ['1:2-1-a', '2:2-2-b'], 'landing 순서')
    assert.deepEqual(m.stories, ['2-1-a', '2-2-b'])
    // 되돌린 뒤 추적 파일을 고쳐 두면 다음 라운드 cherry-pick 이 그 파일에서 거부된다 — 되돌림 뒤 트리는 깨끗해야 한다
    const dirty = git(fx.proj, ['status', '--porcelain']).stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('??'))
    assert.deepEqual(dirty, [], dirty.join('|'))
  })
  // ── N6 / 정책 16(2026-09-02 codex-review-r2) ────────────────────────────────────────
  // 종전 이 테스트는 「rollback 이면 스토리 매니페스트가 **없어야 한다**」를 정답으로 고정했다 —
  // 그건 정책 16(각 story manifest 에 pass/fail/rollback 을 반영)의 정반대다. 실제로 story 단위
  // 도구는 배치 매니페스트를 읽지 않으므로 「되돌아갔다」는 사실을 영영 알 수 없었다.
  // 지금 규칙: **추적 매니페스트는 되돌린 그대로 두되**(다음 cherry-pick 을 막지 않으려고),
  // reset 전에 읽어 둔 사본에 rollback 을 새겨 ⓐ 상태 폴더 증거 ⓑ 미추적 sidecar 두 곳에 남긴다.
  it('[#16/N6] rollback 이 각 스토리 매니페스트에 남는다 — 증거 사본 + batchId 붙은 미추적 sidecar', () => {
    const logs = join(fx.art, 'auto-pipeline-logs')
    // ① 추적 매니페스트는 종전대로 되돌아가 있다(작업 트리를 더럽히지 않는다)
    assert.ok(!existsSync(join(logs, '2-1-a-verification.json')), 'rollback 이면 추적 매니페스트는 되돌아간다')
    const batchId = batchManifest(fx).batchId
    for (const s of ['2-1-a', '2-2-b']) {
      // ② 미추적 sidecar — 이름에 batchId 가 들어가 이전 라운드 파일을 덮지 않는다
      const side = join(logs, `${s}-verification.rollback-${batchId}.json`)
      assert.ok(existsSync(side), `sidecar 없음: ${side} (있는 것: ${readdirSync(logs).join(',')})`)
      const v = JSON.parse(readFileSync(side, 'utf8'))
      assert.equal(v.schema, 'auto-story-finish/verification/1', '엔진이 남긴 기존 필드 보존')
      assert.equal(v.integration.result, 'rollback', s)
      assert.equal(v.integration.qaExit, 1)
      assert.equal(v.integration.batchId, batchId, '어느 라운드의 판정인지 적혀 있어야 한다')
      // ③ 상태 폴더 증거 사본 — 작업 트리가 정리돼도 남는다
      const ev = evidenceDir(fx, s)
      assert.ok(ev && existsSync(join(ev, 'verification.json')), `증거 사본 없음: ${s}`)
      assert.equal(JSON.parse(readFileSync(join(ev, 'verification.json'), 'utf8')).integration.result, 'rollback')
    }
    // sidecar 는 **미추적**이어야 한다 — 추적되면 다음 라운드 cherry-pick 이 그 파일에서 거부된다
    const tracked = git(fx.proj, ['ls-files', '--', '_bmad-output/implementation-artifacts/auto-pipeline-logs']).stdout
    assert.ok(!/verification\.rollback-/.test(tracked), `sidecar 가 추적되면 안 된다: ${tracked}`)
    assert.match(r.summary, /\[INTEGRATION\] rollback 기재 2건/, r.summary)
  })
})

describe('[e2e][#7 대조군] 통합 GREEN 이면 실제로 원격에 push 된다(= 위 테스트의 「0건」이 헛것이 아니다)', { timeout: 300_000 }, () => {
  let fx, r
  before(() => { fx = gateFixture(); fixtures.push(fx); r = runRunner(fx) })
  it('exit 0 · 원격에 auto/<날짜> 존재 · 배치 매니페스트 pass/pushed', () => {
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(r.summary, /\[INTEGRATION\]\[PASS\]/)
    const heads = originHeads(fx.proj)
    assert.ok(heads.some((h) => /^refs\/heads\/auto\//.test(h)), heads.join(','))
    const m = batchManifest(fx)
    assert.equal(m.integration.result, 'pass')
    assert.equal(m.integration.qaExit, 0)
    assert.equal(m.pushed, true)
    assert.equal(m.failed.length, 0)
    const cs = commitsOnBranch(fx.proj)
    assert.equal(cs.length, 3, cs.join('|')) // 스토리 2 + 통합 매니페스트 1
    assert.equal(cs.filter((l) => /통합 게이트 결과 매니페스트 반영/.test(l)).length, 1, cs.join('|'))
  })
  it('[#16] 각 스토리 검증 매니페스트에 integration=pass 가 병합되고, 작업 트리는 깨끗하게 남는다', () => {
    for (const s of ['2-1-a', '2-2-b']) {
      const v = JSON.parse(readFileSync(join(fx.art, 'auto-pipeline-logs', `${s}-verification.json`), 'utf8'))
      assert.equal(v.schema, 'auto-story-finish/verification/1', '기존 필드 보존')
      assert.equal(v.integration.result, 'pass', s)
      assert.equal(v.integration.qaExit, 0)
      assert.match(v.integration.landingBase, /^[0-9a-f]{40}$/)
      assert.match(v.integration.at, /^\d{4}-\d{2}-\d{2}T/)
    }
    assert.match(r.summary, /매니페스트 커밋: 통합 결과 pass 2건/)
    // 매니페스트를 고쳐 놓고 커밋하지 않으면 다음 라운드 cherry-pick 이 그 파일에서 거부된다 — 추적 파일 변경 0 이어야 한다
    const dirty = git(fx.proj, ['status', '--porcelain']).stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('??'))
    assert.deepEqual(dirty, [], dirty.join('|'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// N1(2026-09-02 codex-review-r2) — **순차** 경로도 「전 스토리 → 통합 게이트 → 그때 1회 push」다.
// 종전에는 러너가 엔진에 `--push` 를 그대로 넘겨 엔진이 **스토리마다 즉시** push 했다. 두 스토리가
// 각자 qa GREEN 으로 원격 `auto/*` 에 올라간 뒤 합쳐진 트리가 RED 여도, 프로세스만 exit 1 이고
// 원격에는 이미 RED 조합이 남았다. 여기서는 그것을 **실제 bare origin 의 ref** 로 센다.
const seqFixture = () => makeFixture({
  models: { dev: 'fable', review: 'opus' },
  config: { providers: { codex: { enabled: false } }, integrationGate: { enabled: true } },
  queueDefaults: { push: true, parallel: 1 }, // parallel 1 = 병렬 경로가 열리지 않는다(순차 폴백이 아니라 순차 그 자체)
})

describe('[e2e][N1] 순차 + 통합 게이트 RED — 원격 ref 불변 · landing 되돌림 · 엔진에 --push 를 넘기지 않는다', { timeout: 300_000 }, () => {
  let fx, r
  before(() => { fx = seqFixture(); fixtures.push(fx); r = runRunner(fx, { env: { E2E_QA_FAIL_WHEN_BOTH_COMMITTED: '1' } }) })
  it('원격에 auto/* 가 하나도 없다 · 로컬 landing 0건 · exit 1', () => {
    assert.equal(r.status, 1, r.out.slice(-3000))
    assert.ok(!/병렬 실행 \d폭/.test(r.summary), `순차 경로여야 한다: ${r.summary}`)
    assert.match(r.summary, /\[INTEGRATION\]\[FAIL\] 통합 게이트 RED\(exit 1\)/, r.summary)
    assert.deepEqual(originHeads(fx.proj), ['refs/heads/main'], '원격에 auto/* 가 올라가면 안 된다')
    assert.equal(commitsOnBranch(fx.proj).length, 0, 'landing 커밋도 되돌아가 있어야 한다')
  })
  // run-summary.log 는 되돌림과 함께 사라지므로(추적 파일) 엔진 stdout 으로 센다.
  it('엔진은 push 를 보류만 했다 — 원격에 나간 것은 0건', () => {
    assert.match(r.out, /⏸ push 보류 — 배치 통합 게이트 통과 후 1회만 민다/, r.out.slice(-4000))
    assert.ok(!/✔ push origin\//.test(r.out), `엔진이 push 하면 안 된다: ${r.out.slice(-1500)}`)
  })
  it('순차도 배치 매니페스트·rollback sidecar 를 남긴다(mode=sequential)', () => {
    const m = batchManifest(fx)
    assert.ok(m, '순차 경로에 배치 매니페스트가 없다')
    assert.equal(m.mode, 'sequential')
    assert.equal(m.integration.result, 'rollback')
    assert.equal(m.integration.qaExit, 1)
    assert.equal(m.pushed, false)
    assert.deepEqual(m.landing.map((l) => l.story).sort(), ['2-1-a', '2-2-b'], JSON.stringify(m.landing))
    const logs = join(fx.art, 'auto-pipeline-logs')
    for (const s of ['2-1-a', '2-2-b']) {
      assert.ok(existsSync(join(logs, `${s}-verification.rollback-${m.batchId}.json`)), `sidecar 없음: ${s} (${readdirSync(logs).join(',')})`)
    }
    const tags = git(fx.proj, ['tag', '-l', 'archive/integration-fail-*']).stdout.trim().split('\n').filter(Boolean)
    assert.equal(tags.length, 2, tags.join(','))
  })
})

describe('[e2e][N1 대조군] 순차 + 통합 GREEN — 게이트 뒤 **한 번** push 되고 원격 tip 이 최종 HEAD 와 같다', { timeout: 300_000 }, () => {
  let fx, r
  before(() => { fx = seqFixture(); fixtures.push(fx); r = runRunner(fx) })
  it('exit 0 · 원격 auto/<날짜> 존재 · 원격 tip == 로컬 HEAD(통합 매니페스트 커밋 포함)', () => {
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(r.summary, /\[INTEGRATION\]\[PASS\]/, r.summary)
    const heads = originHeads(fx.proj)
    assert.ok(heads.some((h) => /^refs\/heads\/auto\//.test(h)), heads.join(','))
    // 「게이트 **뒤** 1회」의 증거 — 원격 tip 이 통합 매니페스트 커밋까지 담은 최종 HEAD 다.
    // 스토리별로 push 했다면 원격 tip 은 마지막 스토리 커밋에 머문다.
    const localHead = git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim()
    const remoteTip = git(fx.proj, ['ls-remote', 'origin', 'refs/heads/*']).stdout.split(/\r?\n/)
      .find((l) => /refs\/heads\/auto\//.test(l))?.split('\t')[0]
    assert.equal(remoteTip, localHead)
    assert.match(git(fx.proj, ['log', '-1', '--format=%s']).stdout, /통합 게이트 결과 매니페스트 반영/)
    // 엔진은 `--push --defer-push` 를 받았다 — 스토리마다 밀지 않고 **보류**했고, 실제 push 는 러너 몫이다.
    // (BATCH START 줄은 엔진이 run-summary.log 에 적는다.)
    assert.match(r.runLog, /BATCH START .* commit=true branch=auto\/[\d-]+ push=true/, r.runLog.slice(0, 1500))
    assert.match(r.out, /⏸ push 보류 — 배치 통합 게이트 통과 후 1회만 민다/, r.out.slice(-4000))
    assert.match(r.out, /--defer-push: 스토리 커밋은 로컬 auto\/[\d-]+ 에만 있다/, r.out.slice(-4000))
    assert.ok(!/✔ push origin\//.test(r.out), '엔진이 직접 push 하면 안 된다(러너가 1회 민다)')
    const m = batchManifest(fx)
    assert.equal(m.mode, 'sequential')
    assert.equal(m.integration.result, 'pass')
    assert.equal(m.pushed, true)
  })
  it('[#16] 순차에서도 각 스토리 검증 매니페스트에 integration=pass 가 병합된다', () => {
    for (const s of ['2-1-a', '2-2-b']) {
      const v = JSON.parse(readFileSync(join(fx.art, 'auto-pipeline-logs', `${s}-verification.json`), 'utf8'))
      assert.equal(v.integration.result, 'pass', s)
      assert.equal(v.integration.qaExit, 0)
    }
    // 추적 파일 변경 0 — 단 엔진 자기 로그(run-summary.log)의 꼬리는 순차 경로에서 늘 미커밋으로 남는다(러너 dirty 가드도 같은 예외).
    const dirty = git(fx.proj, ['status', '--porcelain']).stdout.split(/\r?\n/)
      .filter((l) => l && !l.startsWith('??') && !l.includes('auto-pipeline-logs/'))
    assert.deepEqual(dirty, [], dirty.join('|'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// N3 / 정책 2·12 — 통합 게이트 로그 · 증거 폴더 사본 · 요약 · 알림 본문에 **자격증명 값이 남지 않는다**.
// qa 스텁이 리뷰 원문 3형식(JSON 값 · Bearer 토큰 · 공백 포함 인용값)을 뱉게 하고 원문 존재 여부를 센다.
// 마스킹기 자체는 엔진 `providers/codex.mjs` 의 `redactSecrets` 하나다(러너는 배선만 한다).
describe('[e2e][N3] qa 가 흘린 시크릿이 통합 로그·증거·요약 어디에도 원문으로 남지 않는다', { timeout: 300_000 }, () => {
  const LEAKS = ['JSONSECRET123456', 'TOKENVALUE123456', 'alpha beta gamma secret']
  let fx, r
  before(() => {
    fx = makeFixture({ models: { dev: 'fable', review: 'opus' }, config: { providers: { codex: { enabled: false } }, integrationGate: { enabled: true } } })
    fixtures.push(fx)
    r = runRunner(fx, { env: { E2E_QA_LEAK: '1', E2E_CLAUDE_FAIL_STORY: '2-2-b' } }) // 실패 1건 = 증거 폴더(로그 사본)도 만들어진다
  })
  // ① 배선 — 러너가 통합 로그·증거 사본을 **마스킹기에 통과시킨다**(이 단언은 마스커 품질과 무관하게 지금 GREEN).
  it('[배선] 통합 게이트 로그·증거 사본이 마스킹기를 거친다', () => {
    const p = join(fx.art, 'auto-pipeline-logs', 'integration-gate.log')
    assert.ok(existsSync(p), '통합 게이트가 돌지 않았다')
    assert.match(readFileSync(p, 'utf8'), /REDACTED/, '통합 로그가 마스킹기를 거치지 않았다(종전: stdout/stderr 원문 기록)')
    const ev = evidenceDir(fx, '2-2-b')
    assert.ok(ev && existsSync(join(ev, 'auto-pipeline-logs')), `증거 로그 폴더 없음: ${ev}`)
    // 픽스처의 워커는 실패 직전 `SUPABASE_SERVICE_ROLE_KEY=sb_secret_…` 를 남긴다 — 증거 사본에서 그 값이 사라져야 한다
    for (const f of walkFiles(join(ev, 'auto-pipeline-logs'))) {
      assert.ok(!readFileSync(f, 'utf8').includes('sb_secret_ABCDEFGH12345678'), `${f} 에 시크릿 원문(증거 로그가 cpSync 원문 복사다)`)
    }
  })
  // ② 마스커 품질 회귀 — 리뷰 N3 이 실증한 3형식. 마스킹기는 엔진 providers/codex.mjs 소유이므로,
  //    그 구조 인식 확장이 들어오기 전까지 이 단언이 RED 다(러너 배선은 ① 이 이미 증명한다).
  it('[N3] JSON 값 · Bearer 토큰 · 공백 포함 인용값이 통합 로그·증거·요약·stdout 어디에도 원문으로 없다', () => {
    const files = [join(fx.art, 'auto-pipeline-logs', 'integration-gate.log'), ...walkFiles(join(evidenceDir(fx, '2-2-b'), 'auto-pipeline-logs'))]
    for (const l of LEAKS) {
      for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(l), `${f} 에 원문 ${l}`)
      assert.ok(!r.summary.includes(l), `night-last-run.md 에 원문 ${l}`)
      assert.ok(!r.stdout.includes(l), `러너 stdout 에 원문 ${l}`)
    }
  })
})

describe('[e2e] Codex 한도 → 같은 스토리 안에서 claude 리뷰로 전환(대기 없음) · 배치는 계속', { timeout: 300_000 }, () => {
  it('codex 스텁이 usage limit 을 내면 review=opus(dev fable 회피)로 폴백하고 완주한다', () => {
    const fx = makeFixture(); fixtures.push(fx)
    const r = runRunner(fx, { env: { E2E_CODEX_LIMIT: '1' } })
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(r.runLog, /↘ \[2-1-a\] review: codex:default 한도 — opus 로 자동 전환\(프로바이더 전환 · 스토리당 1회 · 대기 없음\)/)
    assert.match(r.runLog, /→ \[2-1-a\] review \(model=opus, perm=acceptEdits\)/)
    assert.ok(!/AUTH WAIT|LIMIT WAIT/.test(r.runLog), 'codex 실패에 claude 프로브 대기가 없어야 한다')
    assert.match(readFileSync(join(fx.art, '2-1-a.md'), 'utf8'), /claude 스텁/)
    assert.equal(commitsOnBranch(fx.proj).length, 3, '스토리 2 + 통합 매니페스트 1')
  })
})

describe('[e2e] 워커 실패 격리 — 한 스토리가 죽어도 다른 스토리는 landing · 증거 보관 · 배치 STOP', { timeout: 300_000 }, () => {
  let fx, r, ev
  before(() => {
    fx = makeFixture(); fixtures.push(fx)
    r = runRunner(fx, { env: { E2E_CLAUDE_FAIL_STORY: '2-2-b' } })
    ev = evidenceDir(fx, '2-2-b')
  })
  it('2-2-b dev 가 exit 1 → 2-1-a 만 landing · 요약에 중단 기록 · 상태 폴더 archive 에 증거', () => {
    assert.equal(r.status, 1)
    assert.match(r.summary, /완주: 2-1-a \(병렬 dev → landing\)/)
    assert.match(r.summary, /\*\*중단\(exit 1\): 2-2-b \(병렬 dev\)\*\*/)
    assert.match(r.summary, /증거 보관 /)
    // 브랜치에 남는 커밋 = 성공 스토리 landing 1개 + 통합 게이트 매니페스트 반영 1개.
    // **실패한 2-2-b 의 커밋은 없다** — 개수만 세면 「매니페스트가 늘었나 실패분이 샜나」를 못 가리므로 주체까지 문다.
    const cs = commitsOnBranch(fx.proj)
    assert.equal(cs.length, 2, cs.join(' | '))
    assert.equal(cs.filter((l) => /auto\(2-1-a\)/.test(l)).length, 1, cs.join(' | '))
    assert.equal(cs.filter((l) => /2-2-b/.test(l)).length, 0, `실패 스토리가 landing 되면 안 된다: ${cs.join(' | ')}`)
    assert.equal(cs.filter((l) => /통합 게이트 결과 매니페스트 반영/.test(l)).length, 1, cs.join(' | '))
    const arc = join(fx.state, 'archive')
    assert.ok(existsSync(arc) && readdirSync(arc).some((d) => d.endsWith('-evidence')), '증거 폴더')
  })
  it('[#13] 실패 워크트리의 코드 diff·미추적 산출물·엔진 로그·복구 절차가 남는다', () => {
    assert.ok(ev && existsSync(ev), `증거 폴더 없음: ${ev}`)
    for (const f of ['code.diff', 'summary.json', 'RESTORE.md']) assert.ok(existsSync(join(ev, f)), `누락: ${f}`)
    assert.ok(existsSync(join(ev, 'auto-pipeline-logs')), '엔진 로그도 종전대로 보관')
    const diff = readFileSync(join(ev, 'code.diff'), 'utf8')
    assert.match(diff, /src\/keep\.ts/, '추적 파일의 미커밋 변경이 있어야 한다')
    assert.match(diff, /half_done = 2/)
    assert.ok(existsSync(join(ev, 'untracked', 'src', 'new-thing.ts')), '미추적 신규 파일 복사')
    assert.match(readFileSync(join(ev, 'untracked', 'src', 'new-thing.ts'), 'utf8'), /brand_new = 3/)
    const s = JSON.parse(readFileSync(join(ev, 'summary.json'), 'utf8'))
    assert.equal(s.story, '2-2-b')
    assert.match(s.head, /^[0-9a-f]{40}$/)
    assert.match(s.diffStat, /src\/keep\.ts/)
    assert.ok(s.untracked.some((u) => u.path === 'src/new-thing.ts'))
    // 민감 「경로」가 아니어도 저장 직전 마스킹이 돈다(정책 1·2 — 같은 redact 가 code.diff 에도 적용된다)
    const leak = readFileSync(join(ev, 'untracked', 'src', 'leaky-note.txt'), 'utf8')
    assert.match(leak, /\*\*\*REDACTED\*\*\*/)
    assert.ok(!leak.includes('sb_secret_ABCDEFGH12345678'), leak)
  })
  it('[#13] 민감 파일은 diff 본문에도 untracked 복사본에도 없다 · 시크릿 값이 증거 폴더 어디에도 없다', () => {
    const diff = readFileSync(join(ev, 'code.diff'), 'utf8')
    assert.ok(!diff.includes('secrets/app.pem'), '추적 민감 파일은 diff 생성 단계에서 제외')
    assert.ok(!diff.includes('LEAKED_PEM_BODY_XYZ'), 'PEM 본문 유출')
    assert.ok(!existsSync(join(ev, 'untracked', 'secret.pem')), '미추적 pem 복사 금지')
    assert.ok(!existsSync(join(ev, 'untracked', 'config', 'credentials.json')), '미추적 credential 복사 금지')
    assert.ok(!existsSync(join(ev, 'untracked', '.env.local')), '.env.local 복사 금지')
    const s = JSON.parse(readFileSync(join(ev, 'summary.json'), 'utf8'))
    for (const p of ['secret.pem', 'config/credentials.json']) {
      assert.ok(s.skipped.some((x) => x.path === p && x.why === 'sensitive'), `${p} 는 sensitive 로 기록돼야 한다`)
      assert.ok(!s.untracked.some((x) => x.path === p))
    }
    // 폴더 전체 스윕 — 어떤 파일에도 시크릿 **값** 은 없다(파일 이름은 남아도 된다)
    const leaks = ['abcdefghijklmnop', 'LEAKED_PEM_BODY_XYZ', 'UNTRACKED_PEM_LEAK_XYZ', 'hunter2hunter2', 'sb_secret_ABCDEFGH12345678']
    for (const f of walkFiles(ev)) {
      const t = readFileSync(f, 'utf8')
      for (const l of leaks) assert.ok(!t.includes(l), `${f} 에 시크릿 ${l}`)
    }
  })
  it('[#13] code.diff 로 실제 복구된다 — RESTORE.md 절차대로 base 에서 git apply 성공 · 내용 일치', () => {
    // RESTORE.md 1단계가 「summary.json 의 base 커밋으로 맞춘 뒤 apply」다. 그 절차를 그대로 밟는다 —
    // 현재 HEAD 는 성공분 landing 으로 이미 앞서 있어(로그·장부 파일이 바뀌었다) 문맥이 맞지 않는다.
    const s = JSON.parse(readFileSync(join(ev, 'summary.json'), 'utf8'))
    assert.match(s.base, /^[0-9a-f]{40}$/, 'base 커밋이 기록돼야 절차가 성립한다')
    const wt = join(fx.T, 'restore-wt')
    ok(git(fx.proj, ['worktree', 'add', '--detach', wt, s.base]), 'restore worktree')
    try {
      const ap = git(wt, ['apply', join(ev, 'code.diff')])
      assert.equal(ap.status, 0, `git apply 실패: ${ap.stderr}`)
      assert.match(readFileSync(join(wt, 'src', 'keep.ts'), 'utf8'), /half_done = 2/, '절반쯤 한 일이 복구된다')
    } finally {
      git(fx.proj, ['worktree', 'remove', '--force', wt])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// [OPS] 지출 한도 차단 — 종전에는 `spendBlockNotice(` 라는 **문자열이 소스에 있다**까지만 물었다
// (anchor-only · codex-review-r2 §4). 여기서는 엔진을 exit 5 스텁으로 갈아 끼워 러너를 실제로 돌리고,
// ① 상태 파일의 연속 카운트가 실제로 올라가는지 ② 억제·발신 판정이 그 경로에서 실제로 쓰이는지 본다.
describe('[e2e][OPS] 지출 한도 차단 — 실제 러너 경로에서 연속 카운트가 오르고 알림 판정이 쓰인다', { timeout: 300_000 }, () => {
  const exit5Fixture = (seed) => {
    const fx = makeFixture({ models: { dev: 'fable', review: 'opus' }, queueDefaults: { parallel: 1 } })
    fixtures.push(fx)
    // 엔진을 「한도(exit 5)로 아무것도 못 했다」 스텁으로 교체 — 실 LLM·실 배치 없이 그 갈래만 재현한다
    writeFileSync(join(fx.home, '.claude', 'skills', 'auto-story-finish', 'auto-story-pipeline.mjs'), 'process.exit(5)\n')
    if (seed) writeFileSync(join(fx.state, 'auto-plan-state.json'), JSON.stringify(seed, null, 2))
    return fx
  }
  it('첫 차단 — 연속 1회 · 알림 발신 · 상태 파일에 최초 시각이 남는다', () => {
    const fx = exit5Fixture(null)
    const r = runRunner(fx, { args: ['--auto-plan'] })
    assert.equal(r.status, 5, r.out.slice(-2000))
    assert.match(r.summary, /무인 실행 지출 한도 차단 — 연속 1회 무작업.*알림 발신/, r.summary)
    const s = JSON.parse(readFileSync(join(fx.state, 'auto-plan-state.json'), 'utf8'))
    assert.equal(s.spendBlock.streak, 1)
    assert.match(s.spendBlock.firstIso, /^\d{4}-\d{2}-\d{2}T/)
  })
  it('반복 차단 — 연속 2회째는 같은 말을 하지 않는다(억제)', () => {
    const fx = exit5Fixture({ spendBlock: { streak: 1, firstIso: new Date(Date.now() - 30 * 60_000).toISOString() } })
    const r = runRunner(fx, { args: ['--auto-plan'] })
    assert.equal(r.status, 5, r.out.slice(-2000))
    assert.match(r.summary, /연속 2회 무작업.*알림 억제\(반복\)/, r.summary)
    assert.equal(JSON.parse(readFileSync(join(fx.state, 'auto-plan-state.json'), 'utf8')).spendBlock.streak, 2)
  })
  it('4회째는 다시 말한다 — 억제가 영구화되지 않는다', () => {
    const fx = exit5Fixture({ spendBlock: { streak: 3, firstIso: new Date(Date.now() - 95 * 60_000).toISOString() } })
    const r = runRunner(fx, { args: ['--auto-plan'] })
    assert.equal(r.status, 5, r.out.slice(-2000))
    assert.match(r.summary, /연속 4회 무작업.*알림 발신/, r.summary)
    assert.equal(JSON.parse(readFileSync(join(fx.state, 'auto-plan-state.json'), 'utf8')).spendBlock.streak, 4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// nested 워커 deny 설정(pipeline-settings.json) — 엔진은 없으면 시작조차 하지 않는다(fail-closed).
// 러너는 ① 시작 전에 실측해 없으면 exit 3 으로 **한 번만** 말하고 ② 찾은 경로를 절대경로로 엔진에 넘긴다
// (워크트리에 `.claude/` 가 없어도 워커가 같은 설정을 본다 — 사본을 흩뿌리지 않는다).
describe('[e2e][settings] nested deny 설정 — 절대경로 전달 · 없으면 배치 전에 멈춘다', { timeout: 300_000 }, () => {
  const stripSettings = () => {
    const fx = makeFixture({ models: { dev: 'fable', review: 'opus' } })
    fixtures.push(fx)
    rmSync(join(fx.proj, '.claude'), { recursive: true, force: true })
    ok(git(fx.proj, ['commit', '-qam', 'drop pipeline-settings']), 'commit')
    return fx
  }
  // 가장 아픈 갈래 — `.claude/` 를 **gitignore 하는 저장소**. 워크트리에는 그 파일이 없으므로 워커가
  // 스스로 찾을 방법이 없다. 러너가 본 트리에서 실측한 절대경로를 `--pipeline-settings` 로 넘겨야만 산다.
  it('.claude/ 가 gitignore 라 워크트리에 없어도 병렬 워커가 산다(러너가 --pipeline-settings 절대경로 전달)', () => {
    const fx = stripSettings()
    writeFileSync(join(fx.proj, '.gitignore'), readFileSync(join(fx.proj, '.gitignore'), 'utf8') + '.claude/\n')
    ok(git(fx.proj, ['commit', '-qam', 'ignore .claude']), 'commit')
    mkdirSync(join(fx.proj, '.claude'), { recursive: true }) // 추적되지 않는다 = 워크트리에 복사되지 않는다
    writeFileSync(join(fx.proj, '.claude', 'pipeline-settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(git commit:*)', 'Bash(git push:*)'] } }, null, 2))
    assert.equal(git(fx.proj, ['ls-files', '--', '.claude']).stdout.trim(), '', '추적되면 이 시험이 무의미하다')
    const r = runRunner(fx, { env: { PIPELINE_SETTINGS_PATH: '' } }) // 환경변수 경로도 막는다 — 플래그 하나만 남긴다
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.ok(!/SETTINGS STOP/.test(r.out), `워크트리 워커가 설정을 못 찾았다: ${r.out.slice(-2000)}`)
    assert.match(r.summary, /병렬 실행 2폭/, r.summary)
  })
  it('셋 다 없으면 러너가 배치를 시작하기 **전에** exit 3 으로 멈춘다(밤새 exit 6 이 쌓이지 않게)', () => {
    const fx = stripSettings()
    const r = runRunner(fx, { args: ['--dry-run'], env: { PIPELINE_SETTINGS_PATH: '' } })
    assert.equal(r.status, 3, r.out.slice(-2500))
    assert.match(r.out, /pipeline-settings\.json 이 없다/)
    assert.equal(r.calls, '', '엔진·워커를 한 번도 부르지 않았다')
  })
})

describe('[e2e] dry-run — 워커 실행 0 · 워크트리 0 · 커밋 0', { timeout: 300_000 }, () => {
  it('--dry-run 이면 스텁이 한 번도 불리지 않고 병렬 경로도 열리지 않는다', () => {
    const fx = makeFixture(); fixtures.push(fx)
    const r = runRunner(fx, { args: ['--dry-run'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.equal(r.calls, '', '스텁 호출 0')
    assert.ok(!existsSync(join(fx.T, 'proj-wt0')))
    assert.equal(commitsOnBranch(fx.proj).length, 0)
    assert.ok(!/병렬 2폭 시도/.test(r.stdout))
  })
})

describe('[e2e] Claude 전용(설정 없음) — 종전 명령줄 그대로 · codex 감지 0 · 통합 게이트 없음', { timeout: 300_000 }, () => {
  it('providers/quality/integrationGate 키가 없으면 [PROVIDERS] 줄도, 통합 게이트도 없다', () => {
    const fx = makeFixture({ models: { dev: 'fable', review: 'opus' } }); fixtures.push(fx)
    const cfgPath = join(fx.proj, 'tools', 'auto', 'auto.config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    delete cfg.providers; delete cfg.quality; delete cfg.integrationGate
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    ok(git(fx.proj, ['commit', '-qam', 'claude-only']), 'commit')
    const r = runRunner(fx)
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.ok(!r.runLog.includes('[PROVIDERS]'), 'codex 감지 없음')
    assert.ok(!r.calls.includes('codex'), 'codex 스텁 호출 0')
    assert.ok(!/\[INTEGRATION\]/.test(r.summary), '통합 게이트 없음(설정 없음)')
    assert.ok(!/워커 풀/.test(r.summary))
    assert.equal(commitsOnBranch(fx.proj).length, 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #20 회귀 — 기존 Claude-only 설정·명령줄이 종전과 같은 큐·로그·exit 를 낸다.
// 기준선(EXPECTED_*)은 **하네스 배선 전에 실제로 돌려서 받은 문자열**이다(2026-09-02 · 워커 F2).
// 배선 뒤에도 이 문자열이 바이트 단위로 같아야 한다 — 다만 계측(`## 계측`)은 **뒤에 덧붙는 절**이라
// 비교에서 잘라 낸다(덧붙임은 회귀가 아니다 · 잘라 낸 자리 앞이 한 글자라도 다르면 실패한다).
const BSLASH = String.fromCharCode(92)
const CUT_METRICS = (s) => s.split('\n## 계측')[0].replace(/\s+$/, '')
/** 실행마다 달라지는 값(날짜·시각·임시경로·SHA)만 자리표시자로 바꾼다 — 나머지는 그대로 문다. */
const normalizeSummary = (s, fx) => CUT_METRICS(String(s ?? ''))
  .split(fx.proj).join('<PROJ>')
  .split(fx.proj.split(BSLASH).join('/')).join('<PROJ>')
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TS>')
  .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
  .replace(/\b[0-9a-f]{7,40}\b/g, '<SHA>')
  .split(BSLASH).join('/')

const claudeOnlyFixture = () => {
  const fx = makeFixture({ models: { dev: 'fable', review: 'opus' } })
  fixtures.push(fx)
  const cfgPath = join(fx.proj, 'tools', 'auto', 'auto.config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  delete cfg.providers; delete cfg.quality; delete cfg.integrationGate
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  ok(git(fx.proj, ['commit', '-qam', 'claude-only']), 'commit')
  return fx
}

/** 하네스 배선 **전에** 실제 실행에서 받은 요약(수동 큐 · Claude 전용 · 커밋 켬 · 푸시 끔) */
const EXPECTED_QUEUE_SUMMARY = `# 야간 배치 <DATE>

- 큐: \`<PROJ>/tools/auto/night-queue.json\`
- 브랜치: \`auto/<DATE>\` (푸시 끔)
- 실행 대상 배치: 1건
· 병렬 실행 2폭 — dev 만 병렬, 커밋 가드는 엔진 그대로, landing·push 는 직렬
- 완주: 2-1-a (병렬 dev → landing)
- 완주: 2-2-b (병렬 dev → landing · 충돌 자동 해소 3파일)
- 배치 매니페스트: auto-pipeline-logs/batch-<DATE>-<SHA>-manifest.json (통합 pass(미실행) · push 안 함)
- 완주: E2E 병렬 짝 (병렬)

## 아침에 할 일
- 아침 브리핑: 배치 결과 → 현황판 → **결정 인박스** 순으로 읽는다.
- 이 배치의 커밋은 \`auto/<DATE>\` 에 있다. **main 머지는 사람 승인**이다.`

/** 같은 조건의 `--dry-run` — 워커 0 · 워크트리 0 · 병렬 경로 미개방 */
const EXPECTED_DRYRUN_SUMMARY = `# 야간 배치 <DATE>

- 큐: \`<PROJ>/tools/auto/night-queue.json\`
- 브랜치: \`auto/<DATE>\` (푸시 끔)
- 실행 대상 배치: 1건
- 완주: E2E 병렬 짝

## 아침에 할 일
- 아침 브리핑: 배치 결과 → 현황판 → **결정 인박스** 순으로 읽는다.
- 이 배치의 커밋은 \`auto/<DATE>\` 에 있다. **main 머지는 사람 승인**이다.`

describe('[e2e][#20] Claude-only 회귀 — 종전 큐·로그·exit 가 바이트 단위로 같다', { timeout: 300_000 }, () => {
  it('--queue 수동 큐: 요약·스텁 호출·exit·커밋 수가 배선 전 기준선과 같다', () => {
    const fx = claudeOnlyFixture()
    const r = runRunner(fx)
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.equal(normalizeSummary(r.summary, fx), EXPECTED_QUEUE_SUMMARY)
    // 두 워커가 동시에 돌아 **기록 순서**는 경합한다 — 순서가 아니라 「무엇이 몇 번 불렸나」를 문다.
    assert.deepEqual(r.calls.split('\n').filter(Boolean).sort(), ['dev 2-1-a', 'dev 2-2-b', 'probe', 'probe', 'review 2-1-a', 'review 2-2-b'])
    assert.equal(commitsOnBranch(fx.proj).length, 2)
    assert.ok(!r.runLog.includes('[PROVIDERS]'), 'codex 감지 없음')
    assert.ok(!/\[ORCHESTRATOR\]/.test(r.out), '오케스트레이터는 기본 꺼짐 — 로그 줄도 없다')
    assert.ok(!/\[PARALLEL\]\[HAZARD\]/.test(r.summary), '충돌 없음 → 순차 폴백 로그도 없다')
  })

  it('--dry-run: 요약이 기준선과 같고 스텁 호출·워크트리·커밋이 0 이다', () => {
    const fx = claudeOnlyFixture()
    const r = runRunner(fx, { args: ['--dry-run'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.equal(normalizeSummary(r.summary, fx), EXPECTED_DRYRUN_SUMMARY)
    assert.equal(r.calls, '')
    assert.ok(!existsSync(join(fx.T, 'proj-wt0')))
    assert.equal(commitsOnBranch(fx.proj).length, 0)
  })

  it('계측 파일은 남기되(덧붙임) 종전 절은 건드리지 않는다', () => {
    const fx = claudeOnlyFixture()
    const r = runRunner(fx)
    assert.equal(r.status, 0, r.out.slice(-2000))
    const logs = join(fx.art, 'auto-pipeline-logs')
    const m = readdirSync(logs).filter((n) => /^metrics-.*\.json$/.test(n))
    assert.equal(m.length, 1, `계측 파일 1개: ${readdirSync(logs).join(',')}`)
    const one = JSON.parse(readFileSync(join(logs, m[0]), 'utf8'))
    assert.equal(one.schema, 'night-batch-ops/metrics/1')
    assert.equal(one.planSource, 'deterministic')
    assert.ok(one.stories.some((s) => s.story === '2-1-a'), JSON.stringify(one.stories))
    // 누적 이력도 같은 라운드에 한 줄 쌓인다(상태 폴더 · JSONL)
    const hist = readFileSync(join(fx.state, 'metrics-history.jsonl'), 'utf8').split('\n').filter(Boolean)
    assert.equal(hist.length, 1, hist.join('|'))
    assert.equal(JSON.parse(hist[0]).qualityGate.passed, true, hist[0])
    assert.ok(/## 계측/.test(r.summary), '요약에 계측 절이 있다')
    assert.equal(CUT_METRICS(r.summary).endsWith('**main 머지는 사람 승인**이다.'), true, '계측 절은 맨 뒤에만 붙는다')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #19 확장 충돌 판정 — File List 가 **겹치지 않아도** 마이그레이션은 번호가 경합한다.
// 러너는 자동으로 뭉개지 않고 순차로 내려가고, 그 사유를 요약에 남긴다.
const migrationFixture = () => {
  const fx = makeFixture({ models: { dev: 'fable', review: 'opus' } })
  fixtures.push(fx)
  const rewrite = (key, file) => {
    const p = join(fx.art, `${key}.md`)
    writeFileSync(p, readFileSync(p, 'utf8').replace(/- `[^`]+`/, '- `' + file + '`'))
  }
  rewrite('2-1-a', 'supabase/migrations/20260902100000_a.sql')
  rewrite('2-2-b', 'supabase/migrations/20260902100001_b.sql')
  ok(git(fx.proj, ['commit', '-qam', 'migration file lists']), 'commit')
  return fx
}

describe('[e2e][#19] 마이그레이션 신규 2건 → 병렬 금지·순차 폴백', { timeout: 300_000 }, () => {
  it('겹침이 없어도 [PARALLEL][HAZARD] 로 순차 폴백하고 워크트리를 만들지 않는다', () => {
    const fx = migrationFixture()
    const r = runRunner(fx)
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(r.summary, /\[PARALLEL\]\[HAZARD\]/, r.summary)
    assert.match(r.summary, /마이그레이션 충돌/, r.summary)
    assert.ok(!/병렬 실행 \d폭/.test(r.summary), '병렬 실행 기록이 없어야 한다')
    assert.ok(!existsSync(join(fx.T, 'proj-wt0')), '워크트리 0개')
    assert.ok(!existsSync(join(fx.T, 'proj-wt1')), '워크트리 0개')
    // 순차 경로로 실제 완주 — 폴백이 「아무것도 안 함」이 되면 안 된다
    assert.match(r.summary, /완주: E2E 병렬 짝/)
    assert.ok(commitsOnBranch(fx.proj).length >= 1, '순차 경로 커밋')
  })

  it('겹치지 않는 평범한 File List 면 병렬을 유지한다(대조군 — 위 폴백이 헛것이 아니다)', () => {
    const fx = claudeOnlyFixture()
    const r = runRunner(fx)
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.summary, /병렬 실행 2폭/)
    assert.ok(!/\[PARALLEL\]\[HAZARD\]/.test(r.summary))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #18 Fable 계획 — 주입 실행기(실제 프로세스 · LLM 아님)로 채택·거부·기본(꺼짐)을 문다.
/** 계획 실행기 스텁 — stdin 프롬프트를 읽고 `body` 를 그대로 낸다. */
const planStub = (fx, body) => {
  const p = join(fx.bin, `plan-stub-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(p, `import { readFileSync } from 'node:fs'\nconst prompt = readFileSync(0, 'utf8')\nif (!prompt.includes('야간 배치 편성 계획')) { process.exit(3) }\nprocess.stdout.write(${JSON.stringify(body)})\n`)
  return p
}
const orchFixture = (enabled) => {
  const fx = makeFixture({ config: { orchestrator: { enabled, model: 'fable', timeoutMin: 2 } }, models: { dev: 'fable', review: 'opus' } })
  fixtures.push(fx)
  // 수동 큐(planned!=='auto')는 자동 편성을 이긴다 — 이 시험은 편성기 경로를 봐야 하므로 표식을 auto 로 바꾼다
  const qp = join(fx.proj, 'tools', 'auto', 'night-queue.json')
  writeFileSync(qp, JSON.stringify({ ...JSON.parse(readFileSync(qp, 'utf8')), planned: 'auto' }, null, 2))
  ok(git(fx.proj, ['commit', '-qam', 'auto queue marker']), 'commit')
  return fx
}

describe('[e2e][#18] Fable 계획 — 채택 · 거부 폴백 · 기본 꺼짐', { timeout: 300_000 }, () => {
  it('유효 계획이면 채택되고 plan.source 가 run-summary 에 fable 로 남는다', () => {
    const fx = orchFixture(true)
    const stub = planStub(fx, JSON.stringify({ rationale: '스텁 계획', batches: [{ label: '스텁 A', stories: ['2-1-a'], stages: ['dev', 'review'] }, { label: '스텁 B', stories: ['2-2-b'], stages: ['dev', 'review'] }] }))
    const r = runRunner(fx, { args: ['--auto-plan', '--dry-run'], env: { AUTO_PLAN_RUNNER_STUB: stub } })
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(r.out, /\[ORCHESTRATOR\] source=fable/, r.out.slice(-2000))
    assert.match(r.summary, /- 계획 출처: `fable`/, r.summary)
    assert.match(r.summary, /스텁 A|스텁 B|실행 대상 배치: 2건/, r.summary)
  })

  it('지어낸 스토리·비JSON 은 거부하고 규칙 큐로 되돌아간다(밤이 서지 않는다)', () => {
    for (const [why, body] of [['invented-story', JSON.stringify({ batches: [{ stories: ['9-9-없는스토리'] }] })], ['parse', '이건 JSON 이 아니다']]) {
      const fx = orchFixture(true)
      const r = runRunner(fx, { args: ['--auto-plan', '--dry-run'], env: { AUTO_PLAN_RUNNER_STUB: planStub(fx, body) } })
      assert.equal(r.status, 0, r.out.slice(-3000))
      assert.match(r.out, /\[ORCHESTRATOR\] source=deterministic-fallback\(/, `${why}: ${r.out.slice(-1500)}`)
      assert.ok(r.summary.includes('- 계획 출처: `deterministic-fallback(' + why), `${why}: ${r.summary}`)
    }
  })

  // 2026-09-03: 설치 템플릿의 기본값이 **켜짐**으로 바뀌었다(👤 「(가)」). 그래서 이 시험은
  // 「기본」이 아니라 **설정에 명시된 false**를 문다 — 끄고 싶다고 적은 프로젝트에서 실행기가
  // 불리지 않는지가 지켜야 할 계약이다(설정 키가 아예 없는 구판은 아래 #20 회귀가 문다).
  it('설정에 enabled:false 를 명시하면 실행기를 부르지 않고 종전 로그 그대로다', () => {
    const fx = orchFixture(false)
    const cfg = JSON.parse(readFileSync(join(fx.proj, 'tools', 'auto', 'auto.config.json'), 'utf8'))
    assert.equal(cfg.orchestrator.enabled, false, '이 시험의 전제 — 설정이 명시적으로 꺼져 있다')
    // 스텁을 붙여 두어도 **부르지 않는다** — 껐다는 말이 진짜인지 문다
    const r = runRunner(fx, { args: ['--auto-plan', '--dry-run'], env: { AUTO_PLAN_RUNNER_STUB: planStub(fx, '{"batches":[]}') } })
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.ok(!/\[ORCHESTRATOR\]/.test(r.out), '오케스트레이터 로그 없음')
    assert.match(r.summary, /- 계획 출처: `deterministic`/, r.summary)
    assert.ok(!/- 계획 캐시:/.test(r.summary), '꺼져 있으면 캐시 줄도 없다')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 계획 캐시 (2026-09-03 👤 「(가) 캐시 추가 후 Fable 계획을 켠다 · 항상 켜 두어 최대 작업량으로」)
// 상시로 켜면 30분 슬롯마다 같은 질문을 사게 된다 — 후보 지문이 같으면 지난 계획을 그대로 쓴다.
// 여기서 「부르지 않았다」는 **실행기 스텁이 실제로 몇 번 실행됐는지**(파일에 남긴 호출 수)로 센다.
const PLAN_BODY = JSON.stringify({
  rationale: '스텁 계획', batches: [
    { label: '스텁 A', stories: ['2-1-a'], stages: ['dev', 'review'] },
    { label: '스텁 B', stories: ['2-2-b'], stages: ['dev', 'review'] },
  ],
})
/** 호출 수를 세는 계획 실행기 스텁 — exitCode 를 주면 그 코드로 죽는다(실행기 오류 재현). */
const countingPlanStub = (fx, body, { exitCode = 0 } = {}) => {
  const p = join(fx.bin, `plan-count-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(p, [
    "import { readFileSync, appendFileSync } from 'node:fs'",
    "const prompt = readFileSync(0, 'utf8')",
    "if (!prompt.includes('야간 배치 편성 계획')) { process.exit(3) }",
    `appendFileSync(${JSON.stringify(join(fx.state, 'plan-calls.log'))}, 'call\\n')`,
    exitCode ? `process.exit(${exitCode})` : `process.stdout.write(${JSON.stringify(body)})`,
  ].join('\n') + '\n')
  return p
}
const planCalls = (fx) => {
  const p = join(fx.state, 'plan-calls.log')
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0
}
const cachePath = (fx) => join(fx.state, 'orchestrator-cache.json')
const readCache = (fx) => JSON.parse(readFileSync(cachePath(fx), 'utf8'))
const writeCache = (fx, o) => writeFileSync(cachePath(fx), JSON.stringify(o, null, 2) + '\n', 'utf8')
/** 러너가 남긴 최신 자동 큐 — `_orchestrator` 형태(현황판이 읽는 자리)를 그대로 본다 */
const latestAutoQueue = (fx) => {
  const f = readdirSync(fx.state).filter((n) => /^auto-queue-.*\.json$/.test(n)).sort().pop()
  return f ? JSON.parse(readFileSync(join(fx.state, f), 'utf8')) : null
}
const runOrch = (fx, stub) => runRunner(fx, { args: ['--auto-plan', '--dry-run'], env: { AUTO_PLAN_RUNNER_STUB: stub } })

describe('[e2e][계획 캐시] 같은 후보면 다시 묻지 않는다 · 바뀌면 다시 묻는다', { timeout: 600_000 }, () => {
  it('같은 후보로 두 슬롯을 돌리면 실행기는 1회만 불린다(2회차 = cache hit)', () => {
    const fx = orchFixture(true)
    const stub = countingPlanStub(fx, PLAN_BODY)
    const r1 = runOrch(fx, stub)
    assert.equal(r1.status, 0, r1.out.slice(-3000))
    assert.match(r1.out, /\[ORCHESTRATOR\] source=fable \(cache miss\)/, r1.out.slice(-2000))
    assert.equal(planCalls(fx), 1, '첫 슬롯은 실제로 물어봐야 한다')
    const c = readCache(fx)
    assert.match(c.fingerprint, /^[0-9a-f]{64}$/, JSON.stringify(c).slice(0, 300))
    assert.equal(c.source, 'fable')
    assert.equal(c.model, 'fable')
    assert.deepEqual(c.plan.batches.map((b) => b.stories), [['2-1-a'], ['2-2-b']])
    assert.ok(!('source' in c.plan), '캐시에는 계획 본문만 — 출처는 그때그때 다시 붙인다')

    const r2 = runOrch(fx, stub)
    assert.equal(r2.status, 0, r2.out.slice(-3000))
    assert.match(r2.out, /\[ORCHESTRATOR\] source=fable\(cache\) \(cache hit\)/, r2.out.slice(-2000))
    assert.equal(planCalls(fx), 1, '두 번째 슬롯이 실행기를 다시 불렀다 — 캐시가 죽었다')
    assert.match(r2.summary, /- 계획 출처: `fable\(cache\)`/, r2.summary)
    assert.match(r2.summary, /- 계획 캐시: cache hit \(유효 12시간\)/, r2.summary)
    // 현황판이 읽는 형태는 그대로 — 값만 fable(cache)
    const orch = latestAutoQueue(fx)?._orchestrator
    assert.deepEqual(Object.keys(orch ?? {}).sort(), ['at', 'model', 'rationale', 'source'])
    assert.equal(orch.source, 'fable(cache)')
    assert.equal(orch.rationale, '스텁 계획')
  })

  it('후보가 바뀌면 지문이 달라져 다시 묻는다', () => {
    const fx = orchFixture(true)
    const stub = countingPlanStub(fx, PLAN_BODY)
    assert.equal(runOrch(fx, stub).status, 0)
    assert.equal(planCalls(fx), 1)
    // 후보 하나를 더한다 — 지문의 「정렬된 후보 키」가 바뀐다
    writeFileSync(join(fx.art, '2-3-c.md'), readFileSync(join(fx.art, '2-1-a.md'), 'utf8').replace('2-1-a', '2-3-c').replace('src/a.ts', 'src/c.ts'))
    writeFileSync(join(fx.art, 'sprint-status.yaml'), readFileSync(join(fx.art, 'sprint-status.yaml'), 'utf8') + '  2-3-c: ready-for-dev\n')
    ok(git(fx.proj, ['add', '-A']), 'add'); ok(git(fx.proj, ['commit', '-qm', 'new candidate']), 'commit')
    const r2 = runOrch(fx, stub)
    assert.equal(r2.status, 0, r2.out.slice(-3000))
    assert.equal(planCalls(fx), 2, '후보가 바뀌었는데 캐시를 재사용했다')
    assert.match(r2.out, /\[ORCHESTRATOR\] source=\S+ \(cache miss\)/, r2.out.slice(-2000))
  })

  it('캐시가 유효 시간을 넘기면 다시 묻는다', () => {
    const fx = orchFixture(true)
    const stub = countingPlanStub(fx, PLAN_BODY)
    assert.equal(runOrch(fx, stub).status, 0)
    assert.equal(planCalls(fx), 1)
    writeCache(fx, { ...readCache(fx), at: new Date(Date.now() - 13 * 3_600_000).toISOString() }) // 13시간 전 > 기본 12시간
    const r2 = runOrch(fx, stub)
    assert.equal(r2.status, 0, r2.out.slice(-3000))
    assert.equal(planCalls(fx), 2, '만료된 캐시를 그대로 썼다')
    assert.match(r2.out, /\[ORCHESTRATOR\] source=fable \(cache miss\)/, r2.out.slice(-2000))
  })

  it('캐시된 계획이 지금 규칙을 통과하지 못하면 버리고 다시 묻는다', () => {
    const fx = orchFixture(true)
    const stub = countingPlanStub(fx, PLAN_BODY)
    assert.equal(runOrch(fx, stub).status, 0)
    // 지문은 그대로 두고 **계획만** 후보 밖 스토리로 바꾼다 — 나이·지문은 적중, 검증은 실패
    const c = readCache(fx)
    writeCache(fx, { ...c, plan: { rationale: '오염', batches: [{ label: 'X', stories: ['9-9-없는스토리'] }] } })
    const r2 = runOrch(fx, stub)
    assert.equal(r2.status, 0, r2.out.slice(-3000))
    assert.match(r2.out, /캐시 계획이 지금 규칙을 통과하지 못한다\(deterministic-fallback\(invented-story/, r2.out.slice(-2000))
    assert.equal(planCalls(fx), 2, '검증에 떨어진 캐시를 그대로 썼다')
    assert.match(r2.out, /\[ORCHESTRATOR\] source=fable \(cache miss\)/, r2.out.slice(-2000))
    assert.deepEqual(readCache(fx).plan.batches.map((b) => b.stories), [['2-1-a'], ['2-2-b']], '캐시가 다시 정상 계획으로 갱신됐다')
  })

  it('폴백(규칙 큐)은 캐시하지 않는다 — 다음 슬롯이 다시 시도한다', () => {
    const fx = orchFixture(true)
    const stub = countingPlanStub(fx, '이건 JSON 이 아니다')
    const r1 = runOrch(fx, stub)
    assert.equal(r1.status, 0, r1.out.slice(-3000))
    assert.match(r1.out, /\[ORCHESTRATOR\] source=deterministic-fallback\(parse:not-json\) \(cache miss\)/, r1.out.slice(-2000))
    assert.ok(!existsSync(cachePath(fx)) || !readCache(fx).plan, '폴백이 캐시로 남았다')
    const r2 = runOrch(fx, stub)
    assert.equal(r2.status, 0, r2.out.slice(-3000))
    assert.equal(planCalls(fx), 2, '폴백 뒤 슬롯이 다시 시도하지 않았다')
  })

  it('실행기 오류가 연속 3회면 그 뒤 유효 시간 동안 부르지 않는다(cooldown)', () => {
    const fx = orchFixture(true)
    const stub = countingPlanStub(fx, '', { exitCode: 1 })
    for (let i = 1; i <= 3; i++) {
      const r = runOrch(fx, stub)
      assert.equal(r.status, 0, r.out.slice(-3000))
      assert.match(r.out, /\[ORCHESTRATOR\] source=deterministic-fallback\(runner-error\) \(cache miss\)/, `${i}회차: ${r.out.slice(-1500)}`)
      assert.equal(planCalls(fx), i, `${i}회차까지는 계속 시도한다`)
    }
    const c = readCache(fx)
    assert.equal(c.runnerErrors, 3)
    assert.ok(Date.parse(c.cooldownUntil) > Date.now(), `쿨다운 미설정: ${c.cooldownUntil}`)
    assert.ok(!c.plan, '실패는 계획을 캐시하지 않는다')
    const r4 = runOrch(fx, stub)
    assert.equal(r4.status, 0, r4.out.slice(-3000))
    assert.match(r4.out, /\[ORCHESTRATOR\] source=deterministic-fallback\(runner-cooldown\) \(cache cooldown\)/, r4.out.slice(-2000))
    assert.equal(planCalls(fx), 3, '쿨다운 중에 실행기를 불렀다')
    assert.match(r4.summary, /- 계획 캐시: cache cooldown/, r4.summary)
  })

  it('설치 템플릿의 orchestrator 기본값은 켜짐 + 캐시 12시간이다 (👤 2026-09-03 「(가)」)', () => {
    const src = readFileSync(join(REPO, 'night-batch-ops', 'install.mjs'), 'utf8')
    assert.match(src, /orchestrator: \{ enabled: true, model: 'fable', timeoutMin: 5, cacheHours: 12 \}/, '설치 기본값이 꺼짐으로 되돌아갔다')
    assert.match(src, /👤 2026-09-03 결정/, '기본값을 켠 근거(👤 결정) 인용이 없다')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// assign-history — 러너가 유일 작성자 · 연속 실패 2회면 다음 편성에서 그 프로바이더를 피한다.
describe('[e2e][assign] 배정 기록 — 라운드 뒤 갱신 · 연속 실패 회피', { timeout: 300_000 }, () => {
  it('라운드가 끝나면 스토리·프로바이더·역할별 기록이 상태 폴더에 남는다', () => {
    const fx = makeFixture(); fixtures.push(fx)
    const r = runRunner(fx)
    assert.equal(r.status, 0, r.out.slice(-2000))
    const h = JSON.parse(readFileSync(join(fx.state, 'assign-history.json'), 'utf8'))
    assert.equal(h.entries['2-1-a|claude|dev'].attempts, 1)
    assert.equal(h.entries['2-1-a|claude|dev'].fails, 0)
    assert.equal(h.entries['2-1-a|codex|review'].attempts, 1, Object.keys(h.entries).join(','))
    assert.equal(h.entries['2-1-a|codex|review'].failStreak, 0)
    // `providers.codex.max` 는 **배치당 코덱스 몫**이다(assign.assignWorkers 의 슬롯 예산).
    // max=1 이면 두 번째 스토리의 review 는 claude 로 간다 — 종전 홀짝 분할과 달라진 지점이다.
    assert.equal(h.entries['2-2-b|claude|review'].attempts, 1, Object.keys(h.entries).join(','))
    assert.ok(!h.entries['2-2-b|codex|review'], 'codex 몫은 max 만큼만 쓴다')
  })

  it('codex review 가 그 스토리에서 연속 2회 실패한 기록이면 claude 로 배정한다', () => {
    const fx = makeFixture(); fixtures.push(fx)
    const failed = { attempts: 2, fails: 2, failStreak: 2, rounds: 2, avgRounds: 1 }
    writeFileSync(join(fx.state, 'assign-history.json'), JSON.stringify({
      version: 1, entries: { '2-1-a|codex|review': failed, '2-2-b|codex|review': failed },
    }, null, 2))
    const r = runRunner(fx)
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.summary, /\[ASSIGN\] 2-1-a .*review=opus\(claude\)/, r.summary)
    assert.match(r.summary, /연속 실패/, r.summary)
    assert.ok(!/codex read-only/.test(r.calls), `codex 리뷰가 불리면 안 된다: ${r.calls}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M5(codex-review-r3 · BRIEF 정책 8) — 통합 게이트도 **셸 문자열이 아니라 argv** 로 돈다.
// `auto.config.json` 의 `qa` 값은 저장소 안 파일이라, 종전 `spawnSync(QA_CMD, { shell:true })` 는
// 그 값을 cmd.exe 구문으로 재해석했다. 여기서는 `… && node tools/evil.mjs` 를 심어 두고
// **두 번째 명령이 실제로 돌았는지**를 파일 존재로 센다(말이 아니라 부작용으로).
describe('[e2e][M5] 통합 게이트 명령의 셸 결합 제거 — 두 번째 명령이 돌지 않고 push 도 없다', { timeout: 300_000 }, () => {
  let fx, r, marker
  before(() => {
    fx = makeFixture({
      models: { dev: 'fable', review: 'opus' },
      config: { providers: { codex: { enabled: false } }, integrationGate: { enabled: true }, qa: 'node tools/qa.mjs && node tools/evil.mjs' },
      queueDefaults: { push: true, parallel: 1 },
    })
    fixtures.push(fx)
    marker = join(fx.T, 'PWNED.txt')
    // 두 번째 명령의 실체 — 돌면 파일이 생긴다. 커밋해 둬야 러너의 dirty 가드에 걸리지 않는다.
    writeFileSync(join(fx.proj, 'tools', 'evil.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'pwned')\n`)
    ok(git(fx.proj, ['add', '-A']), 'add evil')
    ok(git(fx.proj, ['commit', '-q', '-m', 'fixture: 게이트 명령 두 번째 조각']), 'commit evil')
    ok(git(fx.proj, ['push', '-q', 'origin', 'HEAD:main']), 'push evil')
    r = runRunner(fx)
  })

  it('두 번째 명령이 실행되지 않았다 — 셸 결합이 살아 있으면 여기서 파일이 생긴다', () => {
    assert.ok(!existsSync(marker), `게이트 명령이 셸로 재해석됐다(${marker})`)
  })

  it('게이트는 실행 전에 거부되고, 원격에는 아무것도 나가지 않는다', () => {
    assert.match(r.summary, /\[INTEGRATION\]\[REJECT\]/, r.summary.slice(-2000))
    assert.notEqual(r.status, 0, '거부는 성공으로 끝나면 안 된다')
    assert.deepEqual(originHeads(fx.proj), ['refs/heads/main'], '원격에 auto/* 가 올라가면 안 된다')
    const m = batchManifest(fx)
    assert.equal(m.integration.result, 'fail')
    assert.equal(m.pushed, false)
  })

  it('스토리 단계(엔진 qa = `npm run qa`)는 정상으로 돌았다 — 과잉 차단이 아니다', () => {
    assert.match(r.out, /\[2-1-a\]/, r.out.slice(-2000))
    assert.ok(existsSync(join(fx.state, 'qa-calls.log')), '엔진 qa 가 아예 안 돌았다면 이 시험은 게이트를 증명하지 못한다')
  })
})
