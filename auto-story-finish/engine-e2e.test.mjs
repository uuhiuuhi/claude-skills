// 엔진 종단 테스트 — 실 LLM 0(스텁 claude/codex 심) · **실제 프로세스 spawn · 실제 임시 git 저장소**.
//
// 무엇을 증명하나(2026-09-02 하드닝 · codex-review-r1): 민감 파일이 리뷰 입력에 실리지 않는다(#1) · 로그에
// 자격증명 값이 남지 않는다(정책 2) · 워커의 git 조작이 **실행 단계에서** 끊긴다(#3) · 무인 커밋은 auto/*
// 또는 detached 에서만 된다(#4) · codex 전용 작업은 Claude 프로브를 타지 않는다(#7) · 미추적 신규 테스트의
// `.only` 가 잡힌다(#8) · 트리거된 보안 게이트가 실제로 돌고 실패가 RED 로 전파된다(#10) · 결정 인박스가
// 없으면 만들어진다(#13).
//
// 격리: HOME/USERPROFILE 을 임시 폴더로 바꿔 전역 설정·codex 슬롯 잠금이 임시 폴더 안에서만 논다. 알림은 off.
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(here, 'auto-story-pipeline.mjs')
const IS_WIN = process.platform === 'win32'
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const ok = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${r.stderr || r.stdout}`) }

// ── 스텁: claude ──────────────────────────────────────────────────────────────────────────
// 동작은 전부 env 로 고른다. `E2E_DEV_ACTION` = normal | push | commit-reset | untracked-test | sensitive | auth-code
const CLAUDE_STUB = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
const argv = process.argv.slice(2)
const log = (m) => { try { appendFileSync(join(process.env.E2E_STATE, 'stub-calls.log'), m + '\n') } catch {} }
if (argv.includes('--version')) { console.log('2.1.250-stub (Claude Code)'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const cwd = process.cwd()
const art = join(cwd, '_bmad-output', 'implementation-artifacts')
const findStory = (key) => readdirSync(art).filter((f) => f.startsWith(key) && f.endsWith('.md')).sort((a, b) => a.length - b.length)[0]
if (prompt.trim() === 'ok') {
  log('probe')
  if (process.env.E2E_CLAUDE_401 === '1') { console.error('API Error: 401 unauthorized · please run /login'); process.exit(1) }
  process.exit(0)
}
const runGit = (args) => {
  const r = spawnSync('git ' + args, { cwd, shell: true, encoding: 'utf8' })
  log('git[' + args + '] exit=' + r.status)
  // 엔진이 stderr 로 차단 표식을 본다 — 워커가 삼키지 않고 그대로 흘린다(실제 에이전트도 도구 출력을 보고한다)
  if (r.stderr) console.error(r.stderr.trim())
  return r
}
// shim 우회 — **절대경로 git 을 직접 spawn** 하고 GIT_ALLOW_PROTOCOL 을 스스로 되돌린다(리뷰 N2 의 시나리오).
const absGit = (argv) => {
  const r = spawnSync(process.env.E2E_REAL_GIT, argv, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file:https:ssh', GIT_TERMINAL_PROMPT: '0' },
  })
  log('absgit[' + argv.join(' ') + '] exit=' + r.status)
  return r
}
const devWork = (key) => {
  const f = join(art, findStory(key))
  let md = readFileSync(f, 'utf8')
  const BT = String.fromCharCode(96)
  const files = [...md.matchAll(new RegExp('^- ' + BT + '([^' + BT + ']+)' + BT, 'gm'))].map((x) => x[1])
  for (const p of files) { mkdirSync(join(cwd, dirname(p)), { recursive: true }); writeFileSync(join(cwd, p), 'export const v = 1 // ' + key + '\n') }
  md = md.replace('- [ ] T1', '- [x] T1').replace(/^Status:\s*\S+/m, 'Status: review') + '\n### Dev Agent Record\n- stub dev done\n'
  writeFileSync(f, md)
}
let m = /\/bmad-dev-story (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  log('dev ' + key)
  const action = process.env.E2E_DEV_ACTION || 'normal'
  log('env SHELL=' + (process.env.SHELL || '-') + ' GITBASH=' + (process.env.CLAUDE_CODE_GIT_BASH_PATH || '-'))
  // (H3) 워커가 **실제로 받은** env 를 그대로 기록한다 — 원격 인증 수단 제거를 자식 프로세스에서 확인한다.
  if (process.env.E2E_DUMP_ENV === '1') writeFileSync(join(process.env.E2E_STATE, 'worker-env.json'), JSON.stringify({ keys: Object.keys(process.env), allowProtocol: process.env.GIT_ALLOW_PROTOCOL || null, sshCommand: process.env.GIT_SSH_COMMAND || null }))
  if (action === 'push') runGit('push origin HEAD:main')
  if (action === 'commit-reset') { runGit('commit -q -am "worker sneak"'); runGit('reset --hard HEAD~1') }
  if (action === 'abs-push') {
    writeFileSync(join(cwd, 'sneak.txt'), 'x\n')
    absGit(['add', '-A']); absGit(['-c', 'user.email=w@x', '-c', 'user.name=w', 'commit', '-q', '-m', 'sneak'])
    absGit(['push', 'origin', 'HEAD:refs/heads/sneak'])
  }
  if (action === 'abs-commit-reset') {
    // 사후 HEAD 비교로는 안 잡히는 net-zero 조작 — 하지만 reflog 는 자란다
    writeFileSync(join(cwd, 'sneak.txt'), 'x\n')
    absGit(['add', '-A']); absGit(['-c', 'user.email=w@x', '-c', 'user.name=w', 'commit', '-q', '-m', 'sneak'])
    absGit(['reset', '--hard', 'HEAD~1'])
  }
  if (action === 'untracked-test') {
    mkdirSync(join(cwd, 'tests'), { recursive: true })
    writeFileSync(join(cwd, 'tests', 'new.test.ts'), [
      "import { describe, it, expect } from 'vitest'",
      "describe.only('새 묶음', () => {",
      "  it.skip('나중에', () => {})",
      "  it('언제나 통과', () => { expect(true).toBe(true) })",
      '})',
      '',
    ].join('\n'))
  }
  if (action === 'sensitive') {
    writeFileSync(join(cwd, '.env.production'), 'DB_PASSWORD=PROD_SECRET_VALUE_XYZ\nAPI_HOST=example.com\n')
    mkdirSync(join(cwd, 'secrets'), { recursive: true })
    writeFileSync(join(cwd, 'secrets', 'app.pem'), '-----BEGIN PRIVATE KEY-----\nLEAKED_PEM_BODY_XYZ\n-----END PRIVATE KEY-----\n')
  }
  if (action === 'auth-code') {
    mkdirSync(join(cwd, 'src', 'auth'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'auth', 'session.ts'), 'export const session = { jwt: true }\n')
  }
  devWork(key)
  console.log('dev 완료')
  process.exit(0)
}
m = /\/bmad-code-review (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  log('review ' + key)
  const f = join(art, findStory(key))
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^Status:\s*\S+/m, 'Status: done') + '\n### Review Findings — claude 스텁\n\n- ✅ Clean review — 발견 0건\n')
  console.log('review 완료')
  process.exit(0)
}
// 재계획 스텁 — 결정 줄을 닫고 회수 Task 를 하나 열고 인박스에 사후 확인 절을 남긴다(E2E_REPLAN_ACTION: normal|noop|blocked)
m = /\[REPLAN\] 스토리 (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  log('replan ' + key)
  const action = process.env.E2E_REPLAN_ACTION || 'normal'
  if (action === 'noop') { console.log('replan: 변경 없음'); process.exit(0) }
  const f = join(art, findStory(key))
  let md = readFileSync(f, 'utf8')
  if (action === 'blocked') {
    md = md.replace(/^(# [^\n]*\n)/, '$1BLOCKED-ON-HUMAN: 운영 DB 키 필요 — 풀리는 조건: 키 발급\n')
  } else {
    md = md.replace(/^- \[ \] \[Review\]\[Decision\] ([^\n]*)$/m, '- [x] ~~[Review][Decision] $1~~ — ✅ AI 결정(2026-09-03 · (가) · 사후 확인)')
    md = md.replace('- [ ] T1 구현\n', '- [ ] T1 구현\n- [ ] T2 결정 반영\n')
    const inbox = join(art, 'DECISIONS-INBOX.md')
    const base = existsSync(inbox) ? readFileSync(inbox, 'utf8') : '# 결정 인박스\n'
    writeFileSync(inbox, base.replace(/^(# [^\n]*\n)/, '$1\n## 🔵 사후 확인 — AI 결정 ' + key + ' (2026-09-03)\n\n- 무엇: 문구 / 선택: (가) / 근거: 추천안 / 대안: (나) / 되돌리는 방법: 문구 교체\n'))
  }
  writeFileSync(f, md)
  console.log('replan 완료')
  process.exit(0)
}
// 목업 스텁 — HTML 1개 + 장부(pending) 항목 1개
m = /\[MOCKUP\] 스토리 (\S+)/.exec(prompt)
if (m) {
  const key = m[1]
  log('mockup ' + key)
  const short = key.split('-').slice(0, 2).join('-')
  mkdirSync(join(cwd, 'mockups'), { recursive: true })
  writeFileSync(join(cwd, 'mockups', 'story-' + short + '-main.html'), '<html><body>stub mockup ' + key + '</body></html>\n')
  const vp = join(cwd, 'tools', 'dev-status', 'mockup-verdicts.json')
  mkdirSync(dirname(vp), { recursive: true })
  const v = existsSync(vp) ? JSON.parse(readFileSync(vp, 'utf8')) : { items: {} }
  v.items['mockups/story-' + short + '-main.html'] = { verdict: 'pending', story: short.replace('-', '.'), note: 'AI 초안(2026-09-03 · 사후 확인)' }
  writeFileSync(vp, JSON.stringify(v, null, 2))
  console.log('mockup 완료')
  process.exit(0)
}
console.error('stub: 알 수 없는 프롬프트'); process.exit(1)
`

// ── 스텁: codex ───────────────────────────────────────────────────────────────────────────
// 리뷰 프롬프트와 리뷰 diff 를 **그대로 상태 폴더에 복사**한다 — 벤더에게 실제로 무엇이 갔는지를 테스트가 본다.
const CODEX_STUB = String.raw`
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const argv = process.argv.slice(2)
const state = process.env.E2E_STATE
const log = (m) => { try { appendFileSync(join(state, 'stub-calls.log'), m + '\n') } catch {} }
const ev = (o) => console.log(JSON.stringify(o))
if (argv.includes('--version')) { console.log('codex-cli 0.152.1-stub'); process.exit(0) }
if (argv[0] === 'login' && argv[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null
const sandbox = argv[argv.indexOf('-s') + 1]
// 역할마다 제목 형식이 다르다 — /스토리 (\S+)/ 로 뭉뚱그리면 dev 프롬프트에서 「구현」을 스토리 키로 읽는다(실측)
const story = (/# 적대적 코드 리뷰 — 스토리 (\S+)/.exec(prompt) ?? /# 스토리 구현 — (\S+)/.exec(prompt) ?? /# 자동 수리 [^\n]* — 스토리 (\S+)/.exec(prompt))?.[1] ?? '?'
log('codex ' + sandbox + ' ' + story)
writeFileSync(join(state, 'codex-prompt.txt'), prompt)
// N4/N5 — 벤더가 **실행 중에** 작업 디렉터리에서 무엇을 볼 수 있는지 그대로 기록한다(cat 가능 여부 = 존재 여부)
if (process.env.E2E_WATCH) {
  const seen = {}
  for (const rel of process.env.E2E_WATCH.split(',')) seen[rel] = existsSync(join(process.cwd(), ...rel.split('/')))
  writeFileSync(join(state, 'codex-visible.json'), JSON.stringify(seen))
}
// 격리된 자리에 워커가 **같은 이름의 새 파일**을 만든다 → 복원 충돌(fail-closed 경로 실증)
if (process.env.E2E_CODEX_WRITE) {
  const p = join(process.cwd(), ...process.env.E2E_CODEX_WRITE.split('/'))
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'WORKER-WROTE-THIS\n')
}
const BT = String.fromCharCode(96)
// 입력 절의 그 줄만 본다 — 「스토리 파일 · diff 파일 · …」 같은 안내 문장에 걸리면 엉뚱한 파일을 읽는다(실측)
const diffLine = prompt.split('\n').find((l) => l.startsWith('- 리뷰 대상 diff'))
const diffFile = diffLine ? diffLine.split(BT)[1] : null
log('diffFile=' + diffFile)
if (diffFile) copyFileSync(join(process.cwd(), diffFile), join(state, 'review-diff.txt'))
if (sandbox === 'workspace-write') {
  // codex dev — 스토리 File List 의 파일을 만들고 스토리를 갱신한다(claude 스텁과 같은 계약)
  const art = join(process.cwd(), '_bmad-output', 'implementation-artifacts')
  const f = join(art, readdirSync(art).filter((n) => n.startsWith(story) && n.endsWith('.md')).sort((a, b) => a.length - b.length)[0])
  let md = readFileSync(f, 'utf8')
  for (const p of [...md.matchAll(new RegExp('^- ' + BT + '([^' + BT + ']+)' + BT, 'gm'))].map((x) => x[1])) {
    mkdirSync(join(process.cwd(), dirname(p)), { recursive: true }); writeFileSync(join(process.cwd(), p), 'export const v = 2\n')
  }
  writeFileSync(f, md.replace('- [ ] T1', '- [x] T1').replace(/^Status:\s*\S+/m, 'Status: review') + '\n### Dev Agent Record\n- codex stub dev\n')
  ev({ type: 'thread.started', thread_id: 't' }); ev({ type: 'item.completed', item: { id: 'c1', type: 'file_change', changes: [{ path: 'src/a.ts' }] } })
  ev({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'dev 완료' } })
  ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  process.exit(0)
}
const decision = process.env.E2E_CODEX_DECISION === '1'
  ? [{ lens: 'auditor', severity: 'medium', kind: 'decision', title: '기간 필터 기본값', file: 'src/a.ts', line: 1, detail: '사람이 정해야 한다', evidence: '-', preExisting: false }]
  : []
const json = { summary: '스텁 리뷰', verdict: decision.length ? 'findings' : 'clean', acVerdicts: [{ ac: 'AC-1', status: 'pass', evidence: 'stub' }], findings: decision }
ev({ type: 'thread.started', thread_id: 't1' })
ev({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'cat ' + (diffFile ?? 'x'), exit_code: 0 } })
ev({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'cat _bmad-output/implementation-artifacts/' + story + '.md', exit_code: 0 } })
// (M6) 실제 리뷰어는 **변경 구현 파일도 연다** — 프롬프트의 「변경 파일」 목록에서 첫 구현 파일을 읽은 것으로 기록.
//      E2E_CODEX_NO_IMPL=1 이면 일부러 열지 않는다(미열람 clean 거부 경로 실증).
const lines = prompt.split('\n')
const fi = lines.findIndex((l) => l.startsWith('- 변경 파일:'))
const changed = fi < 0 ? [] : lines.slice(fi + 1).filter((l) => l.startsWith('  - ')).map((l) => l.slice(4).trim()).filter((x) => !x.endsWith('.md'))
if (changed.length && process.env.E2E_CODEX_NO_IMPL !== '1') ev({ type: 'item.completed', item: { id: 'i2b', type: 'command_execution', command: 'sed -n 1,80p ' + changed[0], exit_code: 0 } })
ev({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: JSON.stringify(json) } })
ev({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
if (out) writeFileSync(out, JSON.stringify(json))
process.exit(0)
`

// qa 스텁 — E2E_QA_EXIT 로 결과를 고르고, E2E_QA_LEAK=1 이면 stdout 에 자격증명을 흘린다(마스킹 검증용)
const QA_SCRIPT = String.raw`
if (process.env.E2E_QA_LEAK === '1') {
  console.log('env dump: SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PAYLOADPAYLOAD123456.SIGSIGSIGSIG')
  console.log('db: postgres://appuser:hunter2hunter2@db.internal:5432/app')
}
process.exit(Number(process.env.E2E_QA_EXIT || '0'))
`
// 배치 종료 e2e 스모크 — 결과는 E2E_BATCH_EXIT, 로그 마스킹 검증용 누출은 E2E_BATCH_LEAK
const BATCH_E2E_SCRIPT = String.raw`
if (process.env.E2E_BATCH_LEAK === '1') {
  console.log('e2e env: {"api_key":"BATCHJSONSECRET1"}')
  console.log('e2e header: Authorization: Bearer BATCHBEARERTOKEN1')
}
process.exit(Number(process.env.E2E_BATCH_EXIT || '0'))
`
const SECURITY_SCRIPT = String.raw`
console.log('security gate ran')
if (Number(process.env.E2E_SEC_EXIT || '0') !== 0) console.log('FAIL  tests/security/rls.test.ts > 테넌트 격리\nAssertionError: expected 0 rows')
process.exit(Number(process.env.E2E_SEC_EXIT || '0'))
`

const STORY = (key, file, extra = '') => `# Story ${key}\n${extra}\nStatus: ready-for-dev\n\n## Acceptance Criteria\n\n- AC-1 x\n\n## Tasks / Subtasks\n\n- [ ] T1 구현\n\n### File List\n\n- \`${file}\`\n\n## Dev Notes\n\n없음\n`

const fixtures = []
after(() => { for (const T of fixtures) { try { rmSync(T, { recursive: true, force: true }) } catch { /* 잠긴 파일은 OS 가 정리 */ } } })

const PIPELINE_SETTINGS = JSON.stringify({
  permissions: { deny: ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git stash:*)', 'Bash(git reset:*)'] },
}, null, 2)

function makeFixture({ scripts = {}, stories = { '2-1-a': 'src/a.ts' }, inbox = null, files = {}, settings = PIPELINE_SETTINGS, binDir = 'bin' } = {}) {
  const T = mkdtempSync(join(tmpdir(), 'engine-e2e-'))
  fixtures.push(T)
  const home = join(T, 'home'), state = join(T, 'state'), bin = join(T, binDir), proj = join(T, 'proj')
  for (const d of [home, state, bin]) mkdirSync(d, { recursive: true })
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
  ok(git(T, ['init', '-q', '--bare', origin]), 'bare')
  ok(git(T, ['clone', '-q', origin, proj]), 'clone')
  for (const [k, v] of [['user.email', 'e2e@test'], ['user.name', 'e2e'], ['core.autocrlf', 'false']]) ok(git(proj, ['config', k, v]), 'cfg')
  const art = join(proj, '_bmad-output', 'implementation-artifacts')
  mkdirSync(join(art, 'auto-pipeline-logs'), { recursive: true })
  mkdirSync(join(proj, 'tools'), { recursive: true })
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'package.json'), JSON.stringify({
    name: 'fx', type: 'module',
    scripts: { qa: 'node tools/qa.mjs', typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0', ...scripts },
  }, null, 2))
  writeFileSync(join(proj, 'tools', 'qa.mjs'), QA_SCRIPT)
  writeFileSync(join(proj, 'tools', 'security.mjs'), SECURITY_SCRIPT)
  writeFileSync(join(proj, 'tools', 'batch-e2e.mjs'), BATCH_E2E_SCRIPT)
  writeFileSync(join(proj, 'src', 'keep.ts'), 'export const keep = 1\n')
  writeFileSync(join(proj, '.gitignore'), 'node_modules\n')
  // (N2) nested 워커의 commit/push deny 설정 — 없으면 엔진이 시작조차 하지 않는다(fail-closed).
  if (settings !== null) {
    mkdirSync(join(proj, '.claude'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'pipeline-settings.json'), settings)
  }
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(proj, dirname(p)), { recursive: true }); writeFileSync(join(proj, p), body) }
  const sprint = ['last_updated: 2026-09-01', 'development_status:', ...Object.keys(stories).map((k) => `  ${k}: ready-for-dev`)].join('\n') + '\n'
  for (const [k, f] of Object.entries(stories)) writeFileSync(join(art, `${k}.md`), typeof f === 'string' ? STORY(k, f) : STORY(k, f.file, f.extra))
  writeFileSync(join(art, 'sprint-status.yaml'), sprint)
  writeFileSync(join(art, 'deferred-work.md'), '# Deferred\n')
  if (inbox !== null) writeFileSync(join(art, 'DECISIONS-INBOX.md'), inbox)
  ok(git(proj, ['add', '-A']), 'add')
  ok(git(proj, ['commit', '-q', '-m', 'init']), 'commit')
  ok(git(proj, ['push', '-q', 'origin', 'HEAD:main']), 'push')
  ok(git(proj, ['branch', '-q', '-M', 'main']), 'branch')
  return { T, home, state, bin, proj, art }
}

function runEngine(fx, { args = [], env = {}, cwd = null } = {}) {
  const r = spawnSync(process.execPath, [
    ENGINE, '--stories', '2-1-a', '--stage-timeout-min', '5', '--wait-auth-min', '0', ...args,
  ], {
    cwd: cwd ?? fx.proj, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, USERPROFILE: fx.home, HOME: fx.home, E2E_STATE: fx.state,
      CLAUDE_BIN: join(fx.bin, IS_WIN ? 'claude.cmd' : 'claude'), CODEX_BIN: join(fx.bin, IS_WIN ? 'codex.cmd' : 'codex'),
      PIPELINE_NTFY_TOPIC: 'off', AUTO_CODEX_ALLOW_CWD: '1', E2E_REAL_GIT: REAL_GIT,
      E2E_DEV_ACTION: 'normal', E2E_QA_EXIT: '0', E2E_QA_LEAK: '', E2E_SEC_EXIT: '0', E2E_CLAUDE_401: '', E2E_CODEX_DECISION: '',
      E2E_BATCH_EXIT: '0', E2E_BATCH_LEAK: '', E2E_WATCH: '', E2E_CODEX_WRITE: '',
      E2E_DUMP_ENV: '',
      E2E_CODEX_NO_IMPL: '',
      ...env,
    },
  })
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    status: r.status,
    out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    calls: read(join(fx.state, 'stub-calls.log')),
    prompt: read(join(fx.state, 'codex-prompt.txt')),
    reviewDiff: read(join(fx.state, 'review-diff.txt')),
    visible: () => JSON.parse(read(join(fx.state, 'codex-visible.json')) || 'null'),
    log: (name) => read(join(fx.art, 'auto-pipeline-logs', name)),
    manifest: (story) => JSON.parse(read(join(fx.art, 'auto-pipeline-logs', `${story}-verification.json`)) || 'null'),
    envDump: () => JSON.parse(read(join(fx.state, 'worker-env.json')) || 'null'),
  }
}
/** 진짜 git 절대경로 — shim 우회 시나리오(N2)에서 워커 스텁이 직접 부른다. */
const REAL_GIT = (() => {
  const r = spawnSync(IS_WIN ? 'where' : 'which', ['git'], { encoding: 'utf8' })
  const lines = String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /\.exe$/i.test(l)) ?? lines[0] ?? ''
})()
const originHeads = (proj) => git(proj, ['ls-remote', '--heads', 'origin']).stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')[1])
const commitsAhead = (proj) => git(proj, ['log', '--oneline', 'main..HEAD']).stdout.trim().split('\n').filter(Boolean)

// ── 1 · 2 — 민감 파일은 리뷰 입력에 실리지 않는다 ────────────────────────────────────────────
describe('[engine-e2e][#1] 추적된 민감 파일은 리뷰 diff·변경 파일 목록 어디에도 없다', { timeout: 180_000 }, () => {
  it('.env.production · secrets/app.pem 을 고쳐도 diff 에는 코드만 실린다', () => {
    const fx = makeFixture({ files: { '.env.production': 'DB_PASSWORD=OLD\n', 'secrets/app.pem': '-----BEGIN PRIVATE KEY-----\nOLD\n-----END PRIVATE KEY-----\n' } })
    const r = runEngine(fx, { args: ['--stages', 'dev,review', '--review-model', 'codex'], env: { E2E_DEV_ACTION: 'sensitive' } })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.reviewDiff, /^diff --git a\/src\/a\.ts b\/src\/a\.ts$/m, '코드 변경은 실려야 한다(과잉 제외도 결함)')
    assert.match(r.reviewDiff, /^\+export const v = 1/m, '본문까지 실려야 한다')
    assert.ok(!r.reviewDiff.includes('PROD_SECRET_VALUE_XYZ'), '.env 본문이 실렸다')
    assert.ok(!r.reviewDiff.includes('LEAKED_PEM_BODY_XYZ'), 'PEM 본문이 실렸다')
    assert.ok(!r.reviewDiff.includes('.env.production'), '.env 파일 섹션이 남았다')
    assert.ok(!r.reviewDiff.includes('secrets/app.pem'), 'pem 파일 섹션이 남았다')
    // 프롬프트의 「변경 파일」 목록에도 없다
    const list = r.prompt.slice(r.prompt.indexOf('- 변경 파일:'), r.prompt.indexOf('## 방법'))
    assert.match(list, /src\/a\.ts/)
    assert.ok(!list.includes('.env.production') && !list.includes('app.pem'), list)
  })
})

describe('[engine-e2e][#2] baseline 폴백 diff 도 마스킹된다 — 최종 diff 에 원문 0건', { timeout: 180_000 }, () => {
  it('워킹트리가 clean 이라 baseline..HEAD 로 떨어져도 sk-…·postgres://u:p@ 가 남지 않는다', () => {
    const fx = makeFixture()
    const base = git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim()
    // 이미 커밋된 라운드(재검수) 재현 — 코드 파일에 자격증명이 섞여 커밋됐고, 민감 파일도 함께 추적됐다
    writeFileSync(join(fx.proj, 'src', 'a.ts'), [
      'export const key = "sk-abcdefghijklmnopqrstuvwx1234"',
      'export const db = "postgres://appuser:hunter2hunter2@db.internal:5432/app"',
      '',
    ].join('\n'))
    mkdirSync(join(fx.proj, 'secrets'), { recursive: true })
    writeFileSync(join(fx.proj, 'secrets', 'app.pem'), '-----BEGIN PRIVATE KEY-----\nLEAKED_PEM_BODY_XYZ\n-----END PRIVATE KEY-----\n')
    const md = join(fx.art, '2-1-a.md')
    writeFileSync(md, readFileSync(md, 'utf8').replace('# Story 2-1-a', `# Story 2-1-a\nbaseline_commit: ${base}`))
    ok(git(fx.proj, ['add', '-A']), 'add')
    ok(git(fx.proj, ['commit', '-q', '-m', 'round 1']), 'commit')
    const r = runEngine(fx, { args: ['--stages', 'review', '--review-model', 'codex'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.prompt, /\.\.HEAD/, 'baseline 폴백 경로여야 한다')
    assert.match(r.reviewDiff, /\*\*\*REDACTED\*\*\*/)
    for (const raw of ['sk-abcdefghijklmnopqrstuvwx1234', 'hunter2hunter2', 'LEAKED_PEM_BODY_XYZ']) {
      assert.ok(!r.reviewDiff.includes(raw), `원문 유출: ${raw}`)
    }
    assert.ok(!/\bsk-[A-Za-z0-9]{20,}/.test(r.reviewDiff), '정규식 스윕: 마스킹되지 않은 키 형태가 남았다')
  })
})

// ── 로그 마스킹(정책 2) ──────────────────────────────────────────────────────────────────
describe('[engine-e2e][정책2] qa 로그·워커 로그에 자격증명 값이 남지 않는다', { timeout: 180_000 }, () => {
  it('qa 스텁이 SERVICE_ROLE_KEY·DB URL 을 출력해도 로그에는 ***REDACTED***', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_QA_LEAK: '1', E2E_QA_EXIT: '1' } })
    assert.equal(r.status, 1, 'qa RED 로 멈춰야 한다')
    const qaLog = r.log('2-1-a-qa.log')
    assert.match(qaLog, /SUPABASE_SERVICE_ROLE_KEY=\*\*\*REDACTED\*\*\*/)
    assert.ok(!qaLog.includes('PAYLOADPAYLOAD123456'), 'JWT 본문이 남았다')
    assert.ok(!qaLog.includes('hunter2hunter2'), 'URL 자격증명이 남았다')
  })
})

// ── #3 — 워커의 git 조작은 실행 단계에서 끊긴다 ─────────────────────────────────────────────
describe('[engine-e2e][#4] 워커의 직접 push 는 실행 단계에서 차단되고 배치가 STOP 한다', { timeout: 180_000 }, () => {
  it('스텁 dev 가 `git push origin HEAD:main` → exit 86 → 엔진 exit 6 · 원격 ref 불변', () => {
    const fx = makeFixture()
    const before = originHeads(fx.proj)
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'push' } })
    assert.equal(r.status, 6, r.out.slice(-2000))
    assert.match(r.out, /COMMIT GUARD STOP/)
    assert.match(r.out, /\[GIT-GUARD\] blocked:/)
    assert.match(r.calls, /git\[push origin HEAD:main\] exit=86/, 'shim 이 실제로 가로챘다는 증거')
    assert.deepEqual(originHeads(fx.proj), before, '원격 ref 가 움직였다')
    assert.deepEqual(before, ['refs/heads/main'])
  })
})

describe('[engine-e2e][#4-b] Windows 워커 셸 고정 — shim 을 지나치는 bash 래퍼를 쓰지 못하게 env 를 못 박는다', { timeout: 180_000 }, () => {
  it('워커 env 의 SHELL·CLAUDE_CODE_GIT_BASH_PATH 가 Git\\usr\\bin\\bash.exe 를 가리킨다(win32 한정)', { skip: !IS_WIN }, () => {
    // 실측(2026-09-02): `Git\bin\bash.exe` 는 시작할 때 /mingw64/bin:/usr/bin 을 PATH 앞에 끼워 넣어 shim 을 지나쳐
    // `git commit` 이 **성공**한다. `Git\usr\bin\bash.exe` 는 PATH 순서를 지켜 exit 86 로 막힌다. 그래서 env 로 못 박는다.
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    const line = r.calls.split('\n').find((l) => l.startsWith('env SHELL='))
    assert.ok(line, `워커 env 기록 없음: ${r.calls}`)
    assert.match(line, /usr[\\/]bin[\\/]bash\.exe/i, line)
    assert.match(line, /GITBASH=.*usr[\\/]bin[\\/]bash\.exe/i, line)
  })
})

describe('[engine-e2e][#5] commit → reset 으로 원상복구하는 조작도 막힌다', { timeout: 180_000 }, () => {
  it('사후 비교로는 안 잡히는 net-zero 조작이 commit 단계에서 끊긴다', () => {
    const fx = makeFixture()
    const head = git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim()
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'commit-reset' } })
    assert.equal(r.status, 6, r.out.slice(-2000))
    assert.match(r.calls, /git\[commit -q -am "worker sneak"\] exit=86/)
    assert.match(r.calls, /git\[reset --hard HEAD~1\] exit=86/)
    assert.equal(git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim(), head, 'HEAD 가 움직였다')
  })
})

// ── #6 — 무인 커밋 자리 제한 ───────────────────────────────────────────────────────────────
describe('[engine-e2e][#6] `--commit` 은 auto/* 또는 detached 에서만', { timeout: 180_000 }, () => {
  it('main 에서 --commit(브랜치 미지정) → exit 6 · 커밋 0건', () => {
    const fx = makeFixture()
    const head = git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--commit'] })
    assert.equal(r.status, 6, r.out.slice(-2000))
    assert.match(r.out, /무인 커밋은 auto\/\* 또는 detached worktree 에서만/)
    assert.equal(git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim(), head)
    assert.equal(r.calls, '', '워커를 부르기도 전에 멈춘다')
  })
  it('--branch auto/x → 브랜치 생성 후 스토리 커밋 1건', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--commit', '--branch', 'auto/2026-09-02'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(git(fx.proj, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout, /^auto\/2026-09-02/)
    assert.equal(commitsAhead(fx.proj).length, 1, '스토리 커밋 1건')
  })
  it('detached 워크트리(러너 landing 모드) → 종전대로 커밋된다', () => {
    const fx = makeFixture()
    const wt = join(fx.T, 'wt')
    ok(git(fx.proj, ['worktree', 'add', '--detach', wt, 'HEAD']), 'worktree')
    const r = runEngine(fx, { args: ['--stages', 'dev', '--commit'], cwd: wt })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.equal(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'HEAD', 'detached 여야 한다')
    assert.equal(git(wt, ['log', '--oneline', 'main..HEAD']).stdout.trim().split('\n').filter(Boolean).length, 1)
    git(fx.proj, ['worktree', 'remove', '--force', wt])
  })
})

// ── #7 — Codex 전용 작업은 Claude 프로브를 타지 않는다 ──────────────────────────────────────
describe('[engine-e2e][#10] Claude 불가·Codex 정상 — codex 전용 배치는 프로브 없이 완주', { timeout: 180_000 }, () => {
  it('claude 스텁이 401 을 내도 dev·review 가 codex 면 프로브를 부르지 않는다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, {
      args: ['--stages', 'dev,review', '--dev-model', 'codex:dev-m', '--review-model', 'codex:review-m'],
      env: { E2E_CLAUDE_401: '1' },
    })
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.ok(!/^probe$/m.test(r.calls), `Claude 프로브가 불렸다: ${r.calls}`)
    assert.match(r.out, /Claude 인증 프로브 생략/)
    assert.match(r.calls, /codex workspace-write 2-1-a/)
    assert.match(r.calls, /codex read-only 2-1-a/)
    assert.match(readFileSync(join(fx.art, '2-1-a.md'), 'utf8'), /### Review Findings — Codex 교차리뷰/)
  })
})

// ── #8 — 미추적 신규 테스트의 꼼수 ──────────────────────────────────────────────────────────
describe('[engine-e2e][#11] 미추적 신규 테스트 파일의 .only/skip/항상-참 단언이 잡힌다', { timeout: 180_000 }, () => {
  it('`tests/new.test.ts` 를 새로 만들며 describe.only 를 넣으면 무결성 차단 STOP', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--integrity', 'on'], env: { E2E_DEV_ACTION: 'untracked-test' } })
    assert.equal(r.status, 1, r.out.slice(-2000))
    assert.match(r.out, /\[INTEGRITY\]\[BLOCK\] test-only tests\/new\.test\.ts/)
    assert.match(r.out, /\[INTEGRITY\]\[WARN\] test-skip tests\/new\.test\.ts/)
    assert.match(r.out, /\[INTEGRITY\]\[WARN\] trivial-assertion tests\/new\.test\.ts/)
    assert.match(r.out, /테스트 무결성 차단 1건\(test-only\)/)
  })
})

// ── #10 — 조건부 게이트 실제 실행 ───────────────────────────────────────────────────────────
describe('[engine-e2e][#14] 트리거된 보안 게이트를 실제로 실행하고 실패는 RED 로 전파한다', { timeout: 180_000 }, () => {
  it('auth 경로 변경 + test:security 실패 → 배치 STOP · 매니페스트에 fail 기록', () => {
    const fx = makeFixture({ scripts: { 'test:security': 'node tools/security.mjs' } })
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'auth-code', E2E_SEC_EXIT: '1' } })
    assert.equal(r.status, 1, r.out.slice(-2000))
    assert.match(r.out, /보안 트리거 \d+건 — 게이트 npm run test:security 실행/)
    assert.match(r.out, /security 게이트 RED\(exit=1\)/)
    assert.match(r.log('2-1-a-security.log'), /security gate ran/)
    const m = r.manifest('2-1-a')
    assert.equal(m.checks.qa, 'pass', 'qa 는 GREEN 이었다')
    assert.equal(m.checks.security, 'fail')
    assert.deepEqual(m.conditionalGates.security, { script: 'test:security', exit: 1, result: 'fail' })
  })
  it('대조군 — 같은 변경에 게이트가 통과하면 완주하고 매니페스트는 pass', () => {
    const fx = makeFixture({ scripts: { 'test:security': 'node tools/security.mjs' } })
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'auth-code', E2E_SEC_EXIT: '0' } })
    assert.equal(r.status, 0, r.out.slice(-2000))
    const m = r.manifest('2-1-a')
    assert.equal(m.checks.security, 'pass')
    assert.equal(m.conditionalGates.security.exit, 0)
  })
  it('스크립트가 없으면 종전대로 required-missing 으로 정직하게 남긴다(없는 검사를 통과로 세지 않는다)', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'auth-code' } })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.out, /프로젝트에 대응 스크립트 없음/)
    assert.match(r.manifest('2-1-a').checks.security, /^required-missing/)
  })
})

// ── #13 — 결정 인박스 ──────────────────────────────────────────────────────────────────────
describe('[engine-e2e][#16] DECISIONS-INBOX 가 없으면 만들고 등재한다 · 만들 수 없으면 실패다', { timeout: 180_000 }, () => {
  it('인박스 부재 → 기본 형식으로 생성 + Decision 등재', () => {
    const fx = makeFixture({ inbox: null })
    assert.ok(!existsSync(join(fx.art, 'DECISIONS-INBOX.md')))
    const r = runEngine(fx, { args: ['--stages', 'dev,review', '--review-model', 'codex'], env: { E2E_CODEX_DECISION: '1' } })
    assert.equal(r.status, 0, r.out.slice(-3000))
    const inbox = readFileSync(join(fx.art, 'DECISIONS-INBOX.md'), 'utf8')
    assert.match(inbox, /^# 결정 인박스/)
    assert.match(inbox, /## 🟠 결정 대기 — Story 2\.1/)
    assert.match(inbox, /기간 필터 기본값/)
    assert.match(r.out, /DECISIONS-INBOX\.md 가 없어 기본 형식으로 생성했다/)
  })
  it('인박스를 만들 수 없으면(같은 이름의 디렉터리) 리뷰 적용 실패로 멈춘다', () => {
    const fx = makeFixture({ inbox: null })
    mkdirSync(join(fx.art, 'DECISIONS-INBOX.md'), { recursive: true }) // 쓰기 불가 상황 재현
    const r = runEngine(fx, { args: ['--stages', 'dev,review', '--review-model', 'codex'], env: { E2E_CODEX_DECISION: '1' } })
    assert.equal(r.status, 4, r.out.slice(-3000))
    assert.match(r.out, /인박스.*등재하지 못했다/)
  })
})

// ── 검증표 #2 — 프로바이더 전환은 종류를 가리지 않고 스토리당 장부에 센다 ──────────────────
describe('[engine-e2e][검증표#2] 빈 diff 로 인한 codex→claude 전환도 전환 횟수에 든다', { timeout: 180_000 }, () => {
  it('볼 diff 가 없으면 claude 리뷰로 넘기고, 그 전환을 스토리당 상한 장부에 기록한다', () => {
    const fx = makeFixture() // 트리가 clean 하고 baseline_commit 도 없다 = 리뷰 대상 0
    const r = runEngine(fx, { args: ['--stages', 'review', '--review-model', 'codex'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.out, /리뷰 대상 diff 가 비어 Codex 리뷰 무의미/)
    assert.match(r.out, /\(프로바이더 전환 1회째 — codex→claude · 빈 diff · 스토리당 상한 1\)/)
    assert.ok(!r.calls.includes('codex read-only'), 'codex 리뷰는 실행되지 않아야 한다')
    assert.match(r.calls, /review 2-1-a/, 'claude 리뷰가 대신 돌았다')
  })
})

// ── 모델 스펙 거부 ─────────────────────────────────────────────────────────────────────────
describe('[engine-e2e][#9] 셸 메타문자가 든 모델 스펙은 실행 전에 거부한다', { timeout: 180_000 }, () => {
  it('`--dev-model "opus & git push origin HEAD:main"` → exit 2 · 워커 0회 · 원격 불변', () => {
    const fx = makeFixture()
    const before = originHeads(fx.proj)
    const r = runEngine(fx, { args: ['--stages', 'dev', '--dev-model', 'opus & git push origin HEAD:main'] })
    assert.equal(r.status, 2, r.out.slice(-2000))
    assert.match(r.out, /모델 스펙 거부/)
    assert.equal(r.calls, '', '프로세스가 하나도 뜨면 안 된다')
    assert.deepEqual(originHeads(fx.proj), before)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 2026-09-02 2차 리뷰(codex-review-r2) 수리 — 전부 실제 프로세스·실제 git 저장소로 확인한다
// ═══════════════════════════════════════════════════════════════════════════════════════════

// ── N1 — 순차 경로의 push 는 배치 e2e 뒤로 미룬다 ────────────────────────────────────────────
describe('[engine-e2e][N1] `--push` + `--e2e` — 배치 e2e RED 면 원격 ref 가 움직이지 않는다', { timeout: 180_000 }, () => {
  it('e2e RED → exit 1 · push 0회(원격 불변) · 커밋은 로컬 auto/* 에 남는다', () => {
    const fx = makeFixture()
    const before = originHeads(fx.proj)
    const r = runEngine(fx, {
      args: ['--stages', 'dev', '--commit', '--branch', 'auto/2026-09-02', '--push', '--e2e', 'node tools/batch-e2e.mjs'],
      env: { E2E_BATCH_EXIT: '1' },
    })
    assert.equal(r.status, 1, r.out.slice(-2000))
    assert.match(r.out, /push 보류/, '스토리 단위 push 는 보류돼야 한다')
    assert.match(r.out, /E2E RED/)
    assert.deepEqual(originHeads(fx.proj), before, '원격에 RED 조합이 올라갔다')
    assert.ok(!before.includes('refs/heads/auto/2026-09-02'))
    assert.equal(commitsAhead(fx.proj).length, 1, '로컬 커밋은 남는다(사람이 확인)')
  })
  it('대조군 — e2e GREEN 이면 전 스토리 완주 뒤 **한 번만** push 한다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, {
      args: ['--stages', 'dev', '--commit', '--branch', 'auto/2026-09-02', '--push', '--e2e', 'node tools/batch-e2e.mjs'],
    })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.ok(originHeads(fx.proj).includes('refs/heads/auto/2026-09-02'), '게이트 GREEN 뒤에는 밀어야 한다')
    assert.equal((r.out.match(/push origin\/auto\/2026-09-02/g) ?? []).length, 1, 'push 는 정확히 1회')
    assert.match(r.out, /배치 게이트 GREEN 뒤 1회/)
  })
  it('`--e2e` 가 없으면 종전대로 스토리 단위로 push 한다(하위 호환)', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--commit', '--branch', 'auto/2026-09-02', '--push'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.ok(originHeads(fx.proj).includes('refs/heads/auto/2026-09-02'))
    assert.ok(!/push 보류/.test(r.out))
  })
})

// ── N3 — 배치 e2e 로그도 마스킹을 지난다 ─────────────────────────────────────────────────────
describe('[engine-e2e][N3] 배치 e2e 로그의 JSON key/value·Bearer 토큰이 원문으로 남지 않는다', { timeout: 180_000 }, () => {
  it('e2e 스텁이 api_key JSON 과 Authorization 헤더를 찍어도 batch-e2e.log 에는 ***REDACTED***', () => {
    const fx = makeFixture()
    const r = runEngine(fx, {
      args: ['--stages', 'dev', '--e2e', 'node tools/batch-e2e.mjs'],
      env: { E2E_BATCH_LEAK: '1' },
    })
    assert.equal(r.status, 0, r.out.slice(-2000))
    const log = r.log('batch-e2e.log')
    assert.match(log, /\*\*\*REDACTED\*\*\*/)
    assert.ok(!log.includes('BATCHJSONSECRET1'), `JSON 시크릿이 남았다: ${log}`)
    assert.ok(!log.includes('BATCHBEARERTOKEN1'), `Bearer 토큰이 남았다: ${log}`)
    assert.match(log, /"api_key"/, '이름(키)은 남는다 — 무엇이 새려 했는지는 사람이 알아야 한다')
  })
})

// ── N2 — git 차단은 fail-closed · 우회는 사후에라도 반드시 잡힌다 ──────────────────────────────
describe('[engine-e2e][N2] git 차단 shim 을 만들지 못하면 워커를 실행하지 않는다(fail-closed)', { timeout: 180_000 }, () => {
  it('PATH 에서 git 을 없애면 dev 워커 0회 · exit 6', () => {
    const fx = makeFixture()
    const nodeDir = dirname(process.execPath)
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { PATH: nodeDir, Path: nodeDir } })
    assert.equal(r.status, 6, r.out.slice(-3000))
    assert.match(r.out, /git 차단 shim 을 만들지 못했다/)
    assert.ok(!/^dev 2-1-a$/m.test(r.calls), `워커가 실행됐다: ${r.calls}`)
  })
})

describe('[engine-e2e][N2] nested deny 설정(pipeline-settings.json)이 없으면 배치를 시작하지 않는다', { timeout: 180_000 }, () => {
  it('프로젝트·전역 모두 없으면 exit 6 · 프로세스 0회', () => {
    const fx = makeFixture({ settings: null }) // HOME 도 임시 폴더라 전역 폴백도 없다
    const r = runEngine(fx, { args: ['--stages', 'dev'] })
    assert.equal(r.status, 6, r.out.slice(-2000))
    assert.match(r.out, /SETTINGS STOP/)
    assert.equal(r.calls, '', '워커도 프로브도 뜨면 안 된다')
  })
  it('`--pipeline-settings <경로>` 로 명시 지정하면 그것을 쓴다(러너·워크트리 배선용)', () => {
    const fx = makeFixture({ settings: null })
    const alt = join(fx.T, 'alt-settings.json')
    writeFileSync(alt, PIPELINE_SETTINGS)
    const r = runEngine(fx, { args: ['--stages', 'dev', '--pipeline-settings', alt] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.log('2-1-a-dev.log'), /--settings/, 'nested 워커에 그 경로가 전달된다')
  })
})

describe('[engine-e2e][N2] shim 우회(절대경로 git + GIT_ALLOW_PROTOCOL 재정의)도 사후에 잡아 STOP 한다', { timeout: 180_000 }, () => {
  it('워커가 절대경로 git 으로 push 하면 원격 ref 변화로 exit 6', { skip: REAL_GIT ? false : 'git 없음' }, () => {
    const fx = makeFixture()
    const before = originHeads(fx.proj)
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'abs-push' } })
    assert.match(r.calls, /absgit\[push origin HEAD:refs\/heads\/sneak\] exit=0/, '전제: 우회 push 가 실제로 성공했다')
    assert.equal(r.status, 6, r.out.slice(-3000))
    assert.match(r.out, /원격 ref 가 실행 전후로 달라졌다/)
    assert.ok(originHeads(fx.proj).length > before.length, '전제: 원격이 실제로 늘었다(차단이 아니라 탐지다)')
  })
  it('워커가 절대경로 git 으로 commit→reset 하면 HEAD 는 같아도 reflog 지문 변화로 exit 6', { skip: REAL_GIT ? false : 'git 없음' }, () => {
    const fx = makeFixture()
    const head = git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim()
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'abs-commit-reset' } })
    assert.match(r.calls, /absgit\[reset --hard HEAD~1\] exit=0/, '전제: 우회 조작이 실제로 성공했다')
    assert.equal(git(fx.proj, ['rev-parse', 'HEAD']).stdout.trim(), head, '전제: HEAD 는 원상복구됐다(사후 HEAD 비교로는 못 잡는다)')
    assert.equal(r.status, 6, r.out.slice(-3000))
    assert.match(r.out, /로컬 reflog\/ref 지문이 달라졌다/)
  })
})

// ── N4/N5 — 민감 파일은 실행 중 작업 디렉터리에서 사라진다(깊이 무제한 · `.env` 만이 아니다) ────
describe('[engine-e2e][N4/N5] Codex 실행 동안 민감 파일은 작업 디렉터리에서 보이지 않는다', { timeout: 180_000 }, () => {
  const SENSITIVE = {
    '.env.local': 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_LOCALVALUE123\n',
    'auth.json': '{"token":"AUTHJSONTOKEN123"}\n',
    'secrets/app.pem': '-----BEGIN PRIVATE KEY-----\nPEMBODY\n-----END PRIVATE KEY-----\n',
    'packages/a/services/api/config/.env.production': 'DEEP_TOKEN=deepvalue123\n',
    'infra/service-account-prod.json': '{"private_key":"SAKEY123456"}\n',
  }
  it('`.env` 뿐 아니라 pem·auth.json·service-account·깊이 5 `.env.production` 까지 전부 격리되고 종료 후 복원된다', () => {
    const fx = makeFixture({ files: SENSITIVE })
    const watch = Object.keys(SENSITIVE).join(',')
    const r = runEngine(fx, { args: ['--stages', 'dev,review', '--review-model', 'codex'], env: { E2E_WATCH: watch } })
    assert.equal(r.status, 0, r.out.slice(-3000))
    const seen = r.visible()
    assert.ok(seen, 'codex 스텁이 가시성을 기록하지 않았다')
    for (const rel of Object.keys(SENSITIVE)) assert.equal(seen[rel], false, `실행 중에 벤더가 읽을 수 있었다: ${rel}`)
    for (const [rel, body] of Object.entries(SENSITIVE)) {
      assert.equal(readFileSync(join(fx.proj, ...rel.split('/')), 'utf8'), body, `복원되지 않았다: ${rel}`)
    }
    assert.match(r.out, /민감 파일 격리 5건/)
  })
  it('워커가 격리된 자리에 같은 이름의 새 파일을 만들면 복원 충돌 → exit 6(fail-closed · 원본은 보관 폴더)', () => {
    const fx = makeFixture({ files: { '.env.local': 'ORIGINAL_SECRET=keepme123\n' } })
    const r = runEngine(fx, { args: ['--stages', 'dev,review', '--review-model', 'codex'], env: { E2E_CODEX_WRITE: '.env.local' } })
    assert.equal(r.status, 6, r.out.slice(-3000))
    assert.match(r.out, /민감 파일 복원 실패|복원 충돌/)
    assert.match(r.out, /보관 폴더/, '원본이 어디 있는지 사람에게 알려야 한다')
    assert.equal(readFileSync(join(fx.proj, '.env.local'), 'utf8'), 'WORKER-WROTE-THIS\n', '원본을 덮어쓰지 않는다')
  })
})

// ── N8 — 인박스 확정 실패 시 스토리·sprint 는 한 바이트도 바뀌지 않는다 ────────────────────────
describe('[engine-e2e][N8] 리뷰 적용은 트랜잭션형 — 인박스 실패면 스토리·sprint 원상 유지', { timeout: 180_000 }, () => {
  it('인박스 경로가 디렉터리라 확정 실패 → exit 4 · 스토리/sprint 바이트 동일', () => {
    const fx = makeFixture({ inbox: null })
    mkdirSync(join(fx.art, 'DECISIONS-INBOX.md'), { recursive: true }) // 쓰기 불가 상황 재현
    writeFileSync(join(fx.proj, 'src', 'a.ts'), 'export const v = 9\n') // 리뷰 대상 diff 를 만든다(미커밋)
    const storyBefore = readFileSync(join(fx.art, '2-1-a.md'))
    const sprintBefore = readFileSync(join(fx.art, 'sprint-status.yaml'))
    const r = runEngine(fx, { args: ['--stages', 'review', '--review-model', 'codex'], env: { E2E_CODEX_DECISION: '1' } })
    assert.equal(r.status, 4, r.out.slice(-3000))
    assert.match(r.out, /인박스.*등재하지 못했다/)
    assert.deepEqual(readFileSync(join(fx.art, '2-1-a.md')), storyBefore, '스토리가 부분 적용됐다')
    assert.deepEqual(readFileSync(join(fx.art, 'sprint-status.yaml')), sprintBefore, 'sprint-status 가 부분 적용됐다')
    assert.deepEqual(readdirSync(fx.art).filter((f) => f.includes('auto-tmp')), [], '임시 파일이 남았다')
  })
  it('대조군 — 인박스가 정상이면 스토리·sprint·인박스가 함께 갱신된다', () => {
    const fx = makeFixture({ inbox: null })
    writeFileSync(join(fx.proj, 'src', 'a.ts'), 'export const v = 9\n')
    const r = runEngine(fx, { args: ['--stages', 'review', '--review-model', 'codex'], env: { E2E_CODEX_DECISION: '1' } })
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(readFileSync(join(fx.art, '2-1-a.md'), 'utf8'), /\[Review\]\[Decision\]/)
    assert.match(readFileSync(join(fx.art, 'DECISIONS-INBOX.md'), 'utf8'), /기간 필터 기본값/)
    assert.match(readFileSync(join(fx.art, 'sprint-status.yaml'), 'utf8'), /2-1-a: in-progress/)
  })
})

// ── 완료 판정 강화 — 매니페스트에 completion 이 실리고, 확인 못 한 것은 「완료」로 적히지 않는다 ──
describe('[engine-e2e][완료판정] 검증 매니페스트에 completion.verdict 가 생기고 not-verified 를 완료로 세지 않는다', { timeout: 180_000 }, () => {
  it('스텁 dev(새 테스트 0건·완료 기록 부실)는 ready 가 아니라 not-ready/not-verified 로 남는다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    const m = r.manifest('2-1-a')
    assert.ok(m.completion, '매니페스트에 completion 이 없다')
    assert.ok(['ready', 'not-ready', 'not-verified'].includes(m.completion.verdict), m.completion.verdict)
    assert.notEqual(m.completion.verdict, 'ready', '검증되지 않은 항목이 있는데 「완료」로 적혔다')
    assert.ok(m.completion.counts.total >= 8, `판정 항목 수: ${m.completion.counts.total}`)
    assert.ok(m.completion.counts.fail + m.completion.counts.notVerified > 0)
    assert.ok(Array.isArray(m.completion.notVerified))
    // 매니페스트 본체는 변형 없이 그대로다(completion 은 **추가 필드**)
    assert.equal(m.checks.qa, 'pass')
    assert.equal(m.story, '2-1-a')
  })
})

// ── F6 — 인증 프로브도 실행파일+argv 분리(공백 경로에서 실제로 뜬다) ──────────────────────────
describe('[engine-e2e][F6] 인증 프로브는 공백이 든 CLI 경로에서도 실행된다(셸 문자열 결합 없음)', { timeout: 180_000 }, () => {
  it('`bin with space/claude.cmd` 로도 스토리 경계 프로브가 실제로 호출된다', () => {
    const fx = makeFixture({ binDir: 'bin with space' })
    assert.match(fx.bin, / /, '전제: 경로에 공백이 있다')
    const r = runEngine(fx, { args: ['--stages', 'dev'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.calls, /^probe$/m, '프로브가 실행되지 않았다(공백 경로에서 셸 결합이 깨진다)')
  })
})

// ── F8 — 무결성 검사 기본값 on ──────────────────────────────────────────────────────────────
describe('[engine-e2e][F8] 무결성 검사는 기본 on — `--integrity` 없이도 신규 `.only` 를 잡는다', { timeout: 180_000 }, () => {
  it('플래그 없이 실행해도 미추적 신규 테스트의 describe.only 가 차단된다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev'], env: { E2E_DEV_ACTION: 'untracked-test' } })
    assert.equal(r.status, 1, r.out.slice(-2000))
    assert.match(r.out, /\[INTEGRITY\]\[BLOCK\] test-only tests\/new\.test\.ts/)
  })
  it('`--integrity off` 는 명시 옵트아웃 — 종전처럼 검사를 건너뛴다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--integrity', 'off'], env: { E2E_DEV_ACTION: 'untracked-test' } })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.ok(!/INTEGRITY/.test(r.out))
  })
})

// ── H3 — 원격 URL 에 자격증명이 박혀 있으면 워커를 띄우지 않는다 ─────────────────────────────
// 3차 리뷰 H3: 워커 env 에서 인증 수단을 지워도 `https://x:token@host` 원격 하나면 push 가 된다.
describe('[engine-e2e][H3] 원격 URL 에 박힌 자격증명은 배치 시작 전에 잡아 STOP 한다', { timeout: 180_000 }, () => {
  it('토큰이 박힌 원격이 있으면 exit 6 · 워커도 프로브도 뜨지 않는다 · 로그에 토큰 값이 남지 않는다', () => {
    const fx = makeFixture()
    ok(git(fx.proj, ['remote', 'add', 'tokened', 'https://x:ghp_E2ESECRETSECRET1234@example.invalid/o/r.git']), 'remote add')
    const r = runEngine(fx, { args: ['--stages', 'dev'] })
    assert.equal(r.status, 6, r.out.slice(-3000))
    assert.match(r.out, /REMOTE CREDENTIAL STOP/)
    assert.match(r.out, /tokened/)
    assert.ok(!r.out.includes('ghp_E2ESECRETSECRET1234'), '토큰 값이 로그로 새면 STOP 이 새 유출 경로가 된다')
    assert.equal(r.calls, '', '워커도 프로브도 뜨면 안 된다')
  })
  it('토큰 없는 원격만 있으면 종전대로 완주한다 — 위 STOP 이 URL 때문임을 증명(자기 RED)', () => {
    const fx = makeFixture()
    ok(git(fx.proj, ['remote', 'add', 'clean2', 'https://example.invalid/o/r.git']), 'remote add')
    const r = runEngine(fx, { args: ['--stages', 'dev'] })
    assert.equal(r.status, 0, r.out.slice(-3000))
  })
})

// ── H3 — 워커 자식 프로세스가 받은 env 에 원격 인증 수단이 없다 ──────────────────────────────
describe('[engine-e2e][H3] 실제 워커 프로세스의 env 에 원격 자격증명이 없다', { timeout: 180_000 }, () => {
  it('GH_TOKEN·SSH_AUTH_SOCK·GIT_ASKPASS 를 켜고 돌려도 워커는 그 키를 받지 못한다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, {
      args: ['--stages', 'dev'],
      env: { GH_TOKEN: 'ghp_ENVLEAKENVLEAK1234', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_ASKPASS: 'C:/ask.exe', E2E_DUMP_ENV: '1' },
    })
    assert.equal(r.status, 0, r.out.slice(-3000))
    const dumped = r.envDump()
    assert.ok(dumped, '워커 스텁이 env 를 기록하지 않았다')
    for (const k of ['GH_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS']) {
      assert.ok(!dumped.keys.includes(k), `워커 env 에 ${k} 가 살아 있다`)
    }
    assert.equal(dumped.allowProtocol, 'none', '프로토콜 차단이 사라졌다')
    assert.match(dumped.sshCommand ?? '', /BatchMode=yes/, 'SSH 강제 옵션이 사라졌다')
    assert.match(r.out, /원격 인증 수단 \d+건 제거/)
  })
})

// ── M5 — 자유형 명령의 셸 연산자는 실행 전에 거부한다 ────────────────────────────────────────
describe('[engine-e2e][M5] qa·e2e 명령의 셸 연산자는 실행되지 않고 STOP 한다', { timeout: 180_000 }, () => {
  it('`--qa "… & node tools/leak.mjs"` 는 두 번째 명령을 실행하지 않고 exit 6', () => {
    const fx = makeFixture()
    writeFileSync(join(fx.proj, 'tools', 'leak.mjs'), 'require("fs").writeFileSync(process.env.E2E_STATE + "/leaked.txt", "x")\n')
    const r = runEngine(fx, { args: ['--stages', 'dev', '--qa', 'node tools/qa.mjs & node tools/leak.mjs'] })
    assert.equal(r.status, 6, r.out.slice(-3000))
    assert.match(r.out, /COMMAND FORMAT STOP/)
    assert.equal(existsSync(join(fx.state, 'leaked.txt')), false, '두 번째 명령이 실행됐다 — 셸을 아직 거치고 있다')
  })
  it('`--e2e "… && …"` 도 같은 규율 — 배치 e2e 자리에서 exit 6', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--e2e', 'node tools/batch-e2e.mjs && node tools/leak.mjs'] })
    assert.equal(r.status, 6, r.out.slice(-3000))
    assert.match(r.out, /COMMAND FORMAT STOP/)
  })
  it('정상 형식(`node tools/batch-e2e.mjs`)은 종전대로 돈다 — 위 STOP 이 형식 때문임을 증명(자기 RED)', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--e2e', 'node tools/batch-e2e.mjs'] })
    assert.equal(r.status, 0, r.out.slice(-3000))
    assert.match(r.out, /e2e 스모크 통과/)
  })
})

// ── M6 — 구현 파일을 하나도 열지 않은 clean 리뷰는 무효다 ────────────────────────────────────
describe('[engine-e2e][M6] 변경 구현 파일 미열람 clean 은 리뷰로 인정하지 않는다', { timeout: 180_000 }, () => {
  it('스토리·diff 만 읽고 clean 을 내면 STOP — 리뷰 결과가 스토리에 기재되지 않는다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev,review', '--review-model', 'codex'], env: { E2E_CODEX_NO_IMPL: '1' } })
    assert.notEqual(r.status, 0, r.out.slice(-2000))
    assert.match(r.out, /변경 구현 파일/)
    assert.ok(!/Status:\s*done/.test(readFileSync(join(fx.art, '2-1-a.md'), 'utf8')), '무효 리뷰로 done 이 되면 안 된다')
  })
  it('구현 파일까지 읽으면 종전대로 완주한다 — 위 STOP 이 그 조건 때문임을 증명(자기 RED)', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev,review', '--review-model', 'codex'] })
    assert.equal(r.status, 0, r.out.slice(-3000))
  })
})

// ── 2026-09-03 👤 「무료 운영 안전장치 ②」 — 무인 엔진은 main 을 밀 수 없다 ──────────
// GitHub Free 는 비공개 저장소 main 을 서버가 보호하지 못한다(룰셋 API 403 · Team 플랜 필요).
// 그래서 「거부했다」는 출력이 아니라 **원격 ref 가 안 움직였다**는 사실로 문다.
describe('[engine-e2e][push-guard] `--push --branch main` 은 시작조차 못 한다', { timeout: 180_000 }, () => {
  it('exit ≠ 0 · 원격 ref 불변 · 워커 0회 · 로컬 커밋 0건', () => {
    const fx = makeFixture()
    const before = originHeads(fx.proj)
    const mainBefore = git(fx.proj, ['ls-remote', 'origin', 'main']).stdout.trim()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--commit', '--branch', 'main', '--push'] })
    assert.notEqual(r.status, 0, r.out.slice(-2000))
    assert.match(r.out, /auto\//, '거부 사유에 auto\/ 규칙이 보여야 한다')
    assert.deepEqual(originHeads(fx.proj), before, '원격 ref 가 움직였다')
    assert.equal(git(fx.proj, ['ls-remote', 'origin', 'main']).stdout.trim(), mainBefore)
    assert.equal(commitsAhead(fx.proj).length, 0, '로컬 커밋도 생기면 안 된다')
    assert.ok(!/dev 2-1-a/.test(r.calls), '워커가 돌았다')
  })
  it('`--push --branch master`·`--branch release` 도 같다(보호 이름 전반)', () => {
    for (const b of ['master', 'release', 'production']) {
      const fx = makeFixture()
      const before = originHeads(fx.proj)
      const r = runEngine(fx, { args: ['--stages', 'dev', '--commit', '--branch', b, '--push'] })
      assert.notEqual(r.status, 0, b)
      assert.deepEqual(originHeads(fx.proj), before, b)
    }
  })
  it('대조군 — `--branch auto/2026-09-03` 은 종전대로 1회 push 한다(자기 RED)', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev', '--commit', '--branch', 'auto/2026-09-03', '--push'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.ok(originHeads(fx.proj).includes('refs/heads/auto/2026-09-03'))
    assert.equal((r.out.match(/push origin\/auto\/2026-09-03/g) ?? []).length, 1, 'push 는 정확히 1회')
  })
})

// ── 자율운전(2026-09-03) — replan / mockup 단계 · --autonomy full ────────────────────────────
describe('[engine-e2e][autonomy] replan 단계 — 결정 채택·회수 Task 개설·인박스 사후 확인', { timeout: 180_000 }, () => {
  it('replan→dev→review 가 한 배치로 돌고 열린 Decision 이 AI 결정으로 닫힌다', () => {
    const fx = makeFixture({ inbox: '# 결정 인박스\n' })
    const md = join(fx.art, '2-1-a.md')
    writeFileSync(md, readFileSync(md, 'utf8').replace('## Dev Notes', '### Review Findings\n\n- [ ] [Review][Decision] 문구 ⭐추천 (가)\n\n## Dev Notes'))
    ok(git(fx.proj, ['add', '-A']), 'add')
    ok(git(fx.proj, ['commit', '-q', '-m', 'decision']), 'commit')
    const r = runEngine(fx, { args: ['--stages', 'replan,dev,review', '--autonomy', 'full', '--force'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.calls, /replan 2-1-a[\s\S]*dev 2-1-a[\s\S]*review 2-1-a/, r.calls)
    assert.match(readFileSync(md, 'utf8'), /✅ AI 결정\(/)
    assert.match(readFileSync(join(fx.art, 'DECISIONS-INBOX.md'), 'utf8'), /🔵 사후 확인 — AI 결정/)
    assert.match(r.log('run-summary.log'), /autonomy=full/)
  })
  it('replan 이 아무것도 바꾸지 않으면 NO-OP exit 4(무변경을 성공으로 세지 않는다)', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'replan', '--autonomy', 'full'], env: { E2E_REPLAN_ACTION: 'noop' } })
    assert.equal(r.status, 4, r.out.slice(-1500))
    assert.match(r.out, /NO-OP STOP/)
  })
  it('replan 이 사람 질문 표식(BLOCKED-ON-HUMAN)만 남겨도 사후조건은 충족 — 다음 편성이 사람 몫으로 뺀다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'replan', '--autonomy', 'full'], env: { E2E_REPLAN_ACTION: 'blocked' } })
    assert.equal(r.status, 0, r.out.slice(-1500))
    assert.match(readFileSync(join(fx.art, '2-1-a.md'), 'utf8'), /^BLOCKED-ON-HUMAN:/m)
  })
  it('모르는 단계 이름은 시작 전에 exit 2 — 워커 0회', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'dev,frobnicate'] })
    assert.equal(r.status, 2, r.out.slice(-800))
    assert.ok(!/dev 2-1-a/.test(r.calls), '워커가 돌면 안 된다')
  })
  it('guarded(기본)에서는 dev 프롬프트에 자율운전 문단이 없다 · full 에서만 붙는다', () => {
    const g = runEngine(makeFixture(), { args: ['--stages', 'dev'] })
    assert.equal(g.status, 0)
    assert.ok(!g.log('2-1-a-dev.log').includes('[자율운전]'))
    const f = runEngine(makeFixture(), { args: ['--stages', 'dev', '--autonomy', 'full'] })
    assert.equal(f.status, 0)
    assert.ok(f.log('2-1-a-dev.log').includes('[자율운전]'))
  })
})

describe('[engine-e2e][autonomy] mockup 단계 — AI 초안 + 장부 pending', { timeout: 180_000 }, () => {
  it('장부에 pending 항목이 생기고, 커밋 화이트리스트에 목업 폴더를 주면 HTML 도 같은 커밋에 실린다', () => {
    const fx = makeFixture()
    const r = runEngine(fx, { args: ['--stages', 'mockup', '--autonomy', 'full', '--commit', '--branch', 'auto/2026-09-03', '--commit-paths', 'src,tests,tools,_bmad-output,mockups'] })
    assert.equal(r.status, 0, r.out.slice(-2000))
    const v = JSON.parse(readFileSync(join(fx.proj, 'tools', 'dev-status', 'mockup-verdicts.json'), 'utf8'))
    assert.equal(v.items['mockups/story-2-1-main.html']?.verdict, 'pending')
    const files = git(fx.proj, ['show', '--name-only', '--format=', 'HEAD']).stdout
    assert.match(files, /mockups\/story-2-1-main\.html/, '목업 HTML 이 커밋에 없다: ' + files)
    assert.match(files, /mockup-verdicts\.json/)
  })
  it('장부에 항목이 늘지 않으면 NO-OP exit 4', () => {
    const fx = makeFixture()
    // 스텁이 장부에 쓰기 전에 같은 키가 이미 있으면 「늘지 않음」 — 사전 항목을 심어 둔다
    mkdirSync(join(fx.proj, 'tools', 'dev-status'), { recursive: true })
    writeFileSync(join(fx.proj, 'tools', 'dev-status', 'mockup-verdicts.json'), JSON.stringify({ items: { 'mockups/story-2-1-main.html': { verdict: 'pending' } } }))
    const r = runEngine(fx, { args: ['--stages', 'mockup', '--autonomy', 'full'] })
    assert.equal(r.status, 4, r.out.slice(-1500))
  })
})
