// providers 하드닝 테스트 — **실제 동작**(실 프로세스 spawn · 실 파일 rename · 실 git 저장소).
// codex-review-r1 finding #2(슬롯 TOCTOU) · #3(워커 git 차단) · #6(셸 주입/argv) · #11(.env fail-closed) · #12(미열람 clean).
// 시나리오 번호표(BRIEF): 3 · 8 · 9 · 12 · 15 + git-guard.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CODEX_SLOT_STALE_MS, acquireCodexSlot, buildCodexCommand, collectEnvFiles, collectSensitiveFiles,
  hideEnvFiles, hideSensitiveFiles, isSensitivePath, isSlotStale, parseCodexEvents,
  redactSecrets, releaseCodexSlot, restoreEnvFiles, runCodexWorker, slotStaleMsFor, startSlotHeartbeat,
  stripSensitiveFileSections, unquoteGitPath, validateReviewRun, withCodexSlot,
} from './providers/codex.mjs'
import { buildClaudeCommand, runClaudeWorker } from './providers/claude.mjs'
import { defaultExec, parseModelSpec } from './providers/index.mjs'
import { normalizeCommand, planSpawn, quoteWindowsArg, spawnSafe, tokenizeCommand } from './providers/spawn-safe.mjs'
import {
  GIT_GUARD_EXIT, createGitGuard, findCredentialRemotes, remoteUrlHasCredentials, renderCmdShim, renderShShim,
  resolveRealGit, stripRemoteCredentials,
} from './providers/git-guard.mjs'
import { deepRedact, redactSecrets as redactSecretsShared } from './providers/redact.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'
const CODEX_MOD = pathToFileURL(join(here, 'providers', 'codex.mjs')).href
// ⚠ Git for Windows 의 래퍼 `Git/bin/sh.exe` 는 시작 시 `/mingw64/bin:/usr/bin` 을 PATH 앞에 끼워 넣어
// shim 을 지나친다(실측). PATH 순서를 지키는 **진짜** sh 는 `Git/usr/bin/sh.exe` 다.
const SH = ['C:/Program Files/Git/usr/bin/sh.exe', '/bin/sh'].find((p) => existsSync(p)) ?? null
const SH_WRAPPER = 'C:/Program Files/Git/bin/bash.exe'

/** 정리까지 책임지는 임시 폴더 — **이름에 공백을 넣어** Windows 공백 경로를 항상 지난다. */
function tmp(t, label = 'tmp dir with space') {
  const root = mkdtempSync(join(tmpdir(), 'prov-hard-'))
  const dir = join(root, label)
  mkdirSync(dir, { recursive: true })
  t.after(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* 잠김 */ } })
  return dir
}

// ─────────────────────────────────────────────────────────────────────────────
// 시나리오 3 — 두 실제 프로세스가 동시에 Codex 슬롯을 잡으려 한다(#2 TOCTOU)
// ─────────────────────────────────────────────────────────────────────────────
// 자식은 ready 표식을 남긴 뒤 **START 배리어**를 기다렸다가 동시에 달려든다 — 프로세스 기동 지터로
// 「경쟁이 아예 일어나지 않는」 위양성(부하 높은 CI 에서 실측된 흔들림)을 없앤다.
const RACE_SCRIPT = `
  const m = await import(process.env.CODEX_MOD);
  const fs = await import('node:fs');
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  fs.writeFileSync(process.env.READY_FILE, '1');
  while (!fs.existsSync(process.env.START_FILE)) nap(5);
  const s = m.acquireCodexSlot({ dir: process.env.SLOT_DIR, max: Number(process.env.SLOT_MAX) });
  const rec = { got: Boolean(s), index: s ? s.index : null, acq: Date.now(), rel: null };
  if (s) { nap(Number(process.env.HOLD_MS)); rec.rel = Date.now(); m.releaseCodexSlot(s); }
  fs.writeFileSync(process.env.REC_FILE, JSON.stringify(rec));
`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 실제 자식 프로세스 N 개를 배리어로 동시에 풀어 각자의 슬롯 점유 구간(acq~rel)을 기록시킨다. */
async function raceForSlots({ dir, max, workers, holdMs = 1500, recDir }) {
  mkdirSync(recDir, { recursive: true })
  const readyDir = join(recDir, 'ready')
  mkdirSync(readyDir, { recursive: true })
  const startFile = join(recDir, 'START')
  const runs = Array.from({ length: workers }, (_, i) => new Promise((res) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', RACE_SCRIPT], {
      env: {
        ...process.env, CODEX_MOD, SLOT_DIR: dir, SLOT_MAX: String(max), HOLD_MS: String(holdMs),
        REC_FILE: join(recDir, `w${i}.json`), READY_FILE: join(readyDir, `${i}`), START_FILE: startFile,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', () => res(err))
  }))
  const until = Date.now() + 60_000
  while (readdirSync(readyDir).length < workers && Date.now() < until) await sleep(20)
  assert.equal(readdirSync(readyDir).length, workers, '자식 프로세스가 준비되지 않았다')
  writeFileSync(startFile, '1')
  const errs = (await Promise.all(runs)).filter(Boolean)
  assert.deepEqual(errs, [], '자식 프로세스 stderr')
  return readdirSync(recDir).filter((f) => /^w\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(recDir, f), 'utf8')))
}

/** 점유 구간이 겹친 최대 개수 — 상호배제의 진짜 불변식(총 획득 횟수는 타이밍에 흔들린다). */
function maxOverlap(held) {
  const ev = held.flatMap((h) => [{ t: h.acq, d: 1 }, { t: h.rel, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d)
  let cur = 0, peak = 0
  for (const e of ev) { cur += e.d; peak = Math.max(peak, cur) }
  return peak
}

describe('[3] Codex 슬롯은 고정 파일 wx 원자 선점 — 실제 동시 프로세스에서 상호배제된다(#2)', () => {
  it('max=1 · 실제 자식 4개 동시 → 정확히 1개만 획득(나머지는 거부) · 점유 겹침 0', async (t) => {
    const root = tmp(t)
    const dir = join(root, 'locks')
    const rs = await raceForSlots({ dir, max: 1, workers: 4, recDir: join(root, 'rec') })
    const held = rs.filter((r) => r.got)
    const j = JSON.stringify(rs)
    assert.equal(rs.length, 4, j)
    assert.equal(held.length, 1, `max=1 인데 획득이 1이 아니다: ${j}`)
    assert.equal(held[0].index, 0, j)
    assert.equal(rs.filter((r) => !r.got).length, 3, `경쟁이 실제로 일어나지 않았다: ${j}`)
    assert.equal(maxOverlap(held), 1, `동시 점유가 max 를 넘었다: ${j}`)
    assert.deepEqual(readdirSync(dir), [], '해제 후 lock 파일이 남지 않는다')
  })
  it('max=2 · 실제 자식 4개 동시 → 동시 점유는 2를 넘지 않고 같은 슬롯을 둘이 쥐지 않는다', async (t) => {
    const root = tmp(t)
    const dir = join(root, 'locks')
    const rs = await raceForSlots({ dir, max: 2, workers: 4, recDir: join(root, 'rec') })
    const held = rs.filter((r) => r.got)
    const j = JSON.stringify(rs)
    assert.ok(held.length >= 2, `max=2 인데 동시 획득이 2에 못 미친다: ${j}`)
    assert.equal(maxOverlap(held), 2, `동시 점유가 max 를 넘었다(TOCTOU): ${j}`)
    assert.ok(rs.some((r) => !r.got), `경쟁이 실제로 일어나지 않았다: ${j}`)
    for (const idx of [0, 1]) assert.equal(maxOverlap(held.filter((h) => h.index === idx)), 1, `슬롯 ${idx} 을 둘이 동시에 쥐었다: ${j}`)
    assert.ok(held.every((h) => h.index === 0 || h.index === 1), j)
    assert.deepEqual(readdirSync(dir), [], '해제 후 lock 파일이 남지 않는다')
  })
  it('죽은 pid 의 stale 슬롯은 rename 으로 치우고 재선점한다(사람 개입 없이 풀린다)', (t) => {
    const dir = join(tmp(t), 'locks')
    mkdirSync(dir, { recursive: true })
    // 절대 살아 있을 수 없는 pid + 오래된 심박
    writeFileSync(join(dir, 'codex-slot-0.lock'), JSON.stringify({ pid: 0x7ffffffe, hb: new Date(0).toISOString() }))
    const s = acquireCodexSlot({ dir, max: 1 })
    assert.ok(s, 'stale 슬롯을 회수하지 못했다')
    assert.equal(s.index, 0)
    assert.equal(JSON.parse(readFileSync(s.path, 'utf8')).pid, process.pid)
    releaseCodexSlot(s)
  })
  it('기록 중(방금 생긴 빈 lock)을 손상으로 오판해 회수하지 않는다 — 유예 지난 빈 lock 만 회수', (t) => {
    const dir = join(tmp(t), 'locks')
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, 'codex-slot-0.lock')
    // openSync('wx') 직후 · writeSync 이전 상태 = 빈 파일. 이걸 stale 로 보면 둘이 같은 슬롯을 쥔다(실측 사고).
    writeFileSync(lock, '')
    assert.equal(acquireCodexSlot({ dir, max: 1 }), null, '기록 중인 슬롯을 빼앗았다')
    // 유예(10초)를 넘긴 빈 lock 은 진짜 손상 — 회수한다
    const old = Date.now() / 1000 - 3600
    utimesSync(lock, old, old)
    const s = acquireCodexSlot({ dir, max: 1 })
    assert.ok(s && s.index === 0, '오래된 손상 lock 을 회수하지 못했다')
    releaseCodexSlot(s)
  })
  it('살아 있는 슬롯(현재 프로세스 pid)은 치우지 않는다 — 오탐 회수 금지', (t) => {
    const dir = join(tmp(t), 'locks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'codex-slot-0.lock'), JSON.stringify({ pid: process.pid, hb: new Date(0).toISOString() }))
    assert.equal(acquireCodexSlot({ dir, max: 1 }), null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 시나리오 8 — 공백 포함 Windows CLI 경로 (#6)
// ─────────────────────────────────────────────────────────────────────────────
/** 받은 인자를 한 줄씩 되뱉는 가짜 CLI 심(.cmd) */
const ECHO_CMD = ['@echo off', ':l', 'if "%~1"=="" goto e', 'echo ARG:[%~1]', 'shift', 'goto l', ':e', ''].join('\r\n')
const ECHO_SH = ['#!/bin/sh', 'for a in "$@"; do echo "ARG:[$a]"; done', ''].join('\n')

describe('[8] 공백 포함 경로의 CLI 를 실제로 실행한다 — 인자가 온전히 전달된다(#6)', () => {
  it('Windows `.cmd` 심 + 공백 경로 → codex argv 가 그대로 도착 (win32 전용)', { skip: !isWin ? 'win32 전용' : false }, (t) => {
    const dir = tmp(t)
    const bin = join(dir, 'bin', 'codex.cmd')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, ECHO_CMD)
    const wt = join(dir, 'work tree')
    mkdirSync(wt, { recursive: true })
    const cmd = buildCodexCommand({ bin, role: 'review', cwd: wt, model: 'gpt-5.6-sol', outFile: join(dir, 'out file.txt') })
    const res = runCodexWorker({ cmd, prompt: 'P', timeoutMs: 60_000 })
    assert.equal(res.code, 0, res.stderr)
    const args = res.stdout.split(/\r?\n/).filter((l) => l.startsWith('ARG:[')).map((l) => l.slice(5, -1))
    assert.deepEqual(args, ['exec', '-C', wt, '-s', 'read-only', '--json', '--ephemeral', '-m', 'gpt-5.6-sol', '-o', join(dir, 'out file.txt'), '-'])
  })
  it('Windows `.cmd` 심 + 공백 경로 → claude argv 가 그대로 도착 (win32 전용)', { skip: !isWin ? 'win32 전용' : false }, (t) => {
    const dir = tmp(t)
    const bin = join(dir, 'bin', 'claude.cmd')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, ECHO_CMD)
    const settings = join(dir, 'my settings.json')
    writeFileSync(settings, '{}')
    const res = runClaudeWorker({ cmd: buildClaudeCommand({ bin, model: 'opus', settingsPath: settings }), prompt: 'P', timeoutMs: 60_000 })
    assert.equal(res.code, 0, res.stderr)
    const args = res.stdout.split(/\r?\n/).filter((l) => l.startsWith('ARG:[')).map((l) => l.slice(5, -1))
    assert.deepEqual(args, ['-p', '--model', 'opus', '--permission-mode', 'acceptEdits', '--settings', settings])
  })
  it('POSIX 분기(sh 스크립트) — cmd.exe 를 거치지 않는 직접 spawn 으로도 공백 인자가 온전하다', { skip: SH ? false : 'sh 없음' }, (t) => {
    const dir = tmp(t)
    const script = join(dir, 'echo args.sh')
    writeFileSync(script, ECHO_SH)
    const r = spawnSafe(SH, [script, 'plain', join(dir, 'work tree'), '-'], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.plan.viaCmd, false, 'sh 는 cmd.exe 전용 경로를 타지 않는다')
    assert.equal(r.status, 0, r.stderr)
    const norm = (a) => a.replace(/\\/g, '/')
    const args = String(r.stdout).split(/\r?\n/).filter((l) => l.startsWith('ARG:[')).map((l) => norm(l.slice(5, -1)))
    assert.deepEqual(args, ['plain', norm(join(dir, 'work tree')), '-'])
  })
  it('planSpawn: `.cmd` 만 cmd.exe 전용 경로 · POSIX 플랫폼은 언제나 직접 실행 · 인용 규칙', () => {
    const w = planSpawn('C:/a b/codex.cmd', ['exec', '-C', 'C:/w t'], { platform: 'win32', comspec: 'cmd.exe' })
    assert.equal(w.file, 'cmd.exe')
    assert.deepEqual(w.argv, ['/d', '/s', '/c', '""C:/a b/codex.cmd" "exec" "-C" "C:/w t""'])
    assert.equal(w.verbatim, true)
    const p = planSpawn('/usr/bin/codex', ['exec'], { platform: 'linux' })
    assert.deepEqual([p.file, p.argv, p.verbatim, p.viaCmd], ['/usr/bin/codex', ['exec'], false, false])
    // 확장자 없는 실행파일은 Windows 에서도 직접 spawn(EINVAL 회피는 .cmd/.bat 에만 필요하다)
    assert.equal(planSpawn('C:/tools/codex.exe', [], { platform: 'win32' }).viaCmd, false)
    assert.equal(quoteWindowsArg('a\\b'), '"a\\b"')
    assert.equal(quoteWindowsArg('a\\'), '"a\\\\"')
  })

  // 2026-09-02 R4 — bare `.cmd` 이름(`npm.cmd`)을 그대로 인용해 넘기면 심 안의 `%~dp0` 가 어긋난다.
  // 스텁이 아니라 **실제 심**을 PATH 에 놓고, 심이 `%~dp0` 로 옆 파일을 읽게 해서 실물로 문다.
  it('planSpawn: PATH 의 bare `.cmd` 는 절대경로로 바꿔 실행한다 — 심 안 `%~dp0` 가 살아 있다', { skip: !isWin ? 'Windows 전용' : false }, (t) => {
    const dir = tmp(t, 'shim dir')
    writeFileSync(join(dir, 'sibling.txt'), 'SIBLING-OK')
    writeFileSync(join(dir, 'r4shim.cmd'), '@echo off\r\ntype "%~dp0sibling.txt"\r\n')
    // PATH 키의 **대소문자는 그대로** 써야 한다 — `Path` 를 새로 넣으면 기존 `PATH` 가 그대로 남아 자식이 그것을 본다(실측).
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH'
    const env = { ...process.env, [pathKey]: `${dir};${process.env[pathKey] ?? ''}` }
    const plan = planSpawn('r4shim.cmd', [], { env })
    assert.match(plan.file.toLowerCase(), /cmd\.exe$/, '`.cmd` 심은 cmd.exe 전용 경로로 간다')
    assert.ok(plan.argv[3].includes(dir), `절대경로화되지 않았다: ${plan.argv[3]}`)
    const r = spawnSafe('r4shim.cmd', [], { encoding: 'utf8', env })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.match(String(r.stdout), /SIBLING-OK/, `%~dp0 가 깨졌다: ${r.stdout} / ${r.stderr}`)
  })

  it('planSpawn: PATH 에 없는 bare `.cmd` 는 인용해서 넘기지 않고 실행 전에 거부한다', { skip: !isWin ? 'Windows 전용' : false }, () => {
    assert.throws(
      () => planSpawn('r4-no-such-shim-9421.cmd', [], { env: { ...process.env, PATHEXT: '.COM;.EXE;.BAT;.CMD' } }),
      (e) => e.code === 'EXECUTABLE_NOT_FOUND',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 시나리오 9 — 셸 메타문자 model/bin/config 거부 (#6)
// ─────────────────────────────────────────────────────────────────────────────
describe('[9] 셸 메타문자는 실행 전에 거부된다 — 부작용 파일이 생기지 않는다(#6)', () => {
  const evil = ['opus & echo pwned', 'codex:gpt|x', 'opus; rm -rf /', 'opus`whoami`', 'opus$(id)', 'opus%PATH%', 'opus\ncodex', 'opus > out.txt']
  it('parseModelSpec 이 첫 관문 — 큐/설정의 악성 모델 값은 여기서 죽는다', () => {
    for (const s of evil) assert.throws(() => parseModelSpec(s), /SPAWN-SAFE/, `통과해 버림: ${s}`)
    // 정상 스펙은 그대로
    assert.deepEqual(parseModelSpec('codex:gpt-5.6-sol'), { provider: 'codex', model: 'gpt-5.6-sol' })
    assert.deepEqual(parseModelSpec('us.anthropic.claude-opus-4-5'), { provider: 'claude', model: 'us.anthropic.claude-opus-4-5' })
  })
  it('빌더도 독립적으로 거부한다 — model · bin · config · 경로', () => {
    assert.throws(() => buildClaudeCommand({ model: 'opus & echo pwned' }), /SPAWN-SAFE/)
    assert.throws(() => buildClaudeCommand({ bin: 'claude & echo pwned' }), /SPAWN-SAFE/)
    assert.throws(() => buildClaudeCommand({ settingsPath: 'C:/p.json" & echo x' }), /SPAWN-SAFE/)
    assert.throws(() => buildCodexCommand({ role: 'review', cwd: 'C:/wt', model: 'codex:gpt|x' }), /SPAWN-SAFE/)
    assert.throws(() => buildCodexCommand({ role: 'dev', cwd: 'C:/wt', extraConfig: ['a=b;c'] }), /SPAWN-SAFE/)
    assert.throws(() => buildCodexCommand({ role: 'dev', cwd: 'C:/wt', extraConfig: ['-c "a=b;c"'] }), /SPAWN-SAFE/)
    assert.throws(() => buildCodexCommand({ role: 'dev', cwd: 'C:/wt & echo x' }), /SPAWN-SAFE/)
  })
  it('실제 실행 시도 — 거부 예외가 나고 셸이었다면 만들어졌을 카나리아 파일이 없다', (t) => {
    // 리디렉션 대상은 **공백 없는** 경로여야 셸에서 실제로 만들어진다(자기 RED 가 성립하려면 페이로드가 유효해야 한다)
    const canary = join(tmpdir(), `prov-hard-canary-${process.pid}.txt`)
    t.after(() => { try { rmSync(canary, { force: true }) } catch { /* 없음 */ } })
    const redirect = canary.replace(/\\/g, '/')
    // 셸이었다면 `echo pwned > canary` 가 실행됐을 문자열
    assert.throws(() => defaultExec(`codex & echo pwned > ${redirect}`, ['--version']), /SPAWN-SAFE/)
    assert.throws(() => spawnSafe('cmd.exe', [`/c echo pwned > ${redirect}`, '&&', 'echo x'], { encoding: 'utf8' }), /SPAWN-SAFE/)
    assert.equal(existsSync(canary), false, '부작용 파일이 생겼다 — 셸을 거쳤다는 뜻')
    // 자기 RED — 같은 문자열을 **셸로** 돌리면 카나리아가 실제로 생긴다(페이로드가 무해해서 통과한 게 아니다)
    spawnSync(`codex & echo pwned > ${redirect}`, { shell: true, encoding: 'utf8' })
    assert.equal(existsSync(canary), true, '페이로드가 셸에서도 무해하다 — 이 테스트는 아무것도 증명하지 못한다')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 시나리오 12 — `.env` 격리·복원 실패 fail-closed (#11)
// ─────────────────────────────────────────────────────────────────────────────
describe('[12] .env 격리는 fail-closed — 하나라도 실패하면 되돌리고 던진다(#11)', () => {
  const seed = (dir) => {
    mkdirSync(join(dir, 'supabase'), { recursive: true })
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, '.env'), 'A=1')
    writeFileSync(join(dir, '.env.example'), 'A=')
    writeFileSync(join(dir, 'supabase', '.env'), 'B=2')
    writeFileSync(join(dir, 'apps', 'web', '.env.local'), 'C=3')
    writeFileSync(join(dir, 'node_modules', 'pkg', '.env'), 'D=4')
  }
  it('중첩 디렉터리까지 수집하고 node_modules·.env.example 은 제외한다', (t) => {
    const dir = tmp(t); seed(dir)
    assert.deepEqual(collectEnvFiles(dir), ['.env', 'apps/web/.env.local', 'supabase/.env'])
  })
  it('격리·복원 정상 왕복 — 실행 중에는 작업 루트에 .env 가 하나도 없다', (t) => {
    const dir = tmp(t); seed(dir)
    const hold = hideEnvFiles(dir, { holdRoot: join(tmp(t, 'hold root'), 'h') })
    assert.deepEqual(hold.moved, ['.env', 'apps/web/.env.local', 'supabase/.env'])
    assert.deepEqual(collectEnvFiles(dir), [], '실행 중 .env 가 남아 있다 — 벤더가 읽을 수 있다')
    assert.equal(readFileSync(join(hold.holdDir, 'supabase', '.env'), 'utf8'), 'B=2')
    assert.deepEqual(restoreEnvFiles(dir, hold), ['.env', 'apps/web/.env.local', 'supabase/.env'])
    assert.equal(readFileSync(join(dir, 'apps', 'web', '.env.local'), 'utf8'), 'C=3')
    assert.equal(existsSync(hold.holdDir), false, '보관 폴더는 복원 후 정리된다')
  })
  it('실제 rename 실패(대상 없음) → ENV_ISOLATION_FAILED throw + 이미 옮긴 파일 원상복구', (t) => {
    const dir = tmp(t); seed(dir)
    const files = ['.env', 'supabase/.env', 'ghost/.env.local'] // 세 번째는 실재하지 않는다 → renameSync ENOENT
    assert.throws(
      () => hideEnvFiles(dir, { holdRoot: join(tmp(t, 'hold root'), 'h'), files }),
      (e) => e.code === 'ENV_ISOLATION_FAILED' && /Codex 실행을 중단/.test(e.message),
    )
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'A=1', '되돌리지 못했다')
    assert.equal(readFileSync(join(dir, 'supabase', '.env'), 'utf8'), 'B=2', '되돌리지 못했다')
  })
  it('실제 파일 잠금으로 rename 실패를 유발했을 때도 fail-closed (Windows 잠금이 실제로 걸릴 때만 판정)', (t) => {
    const dir = tmp(t); seed(dir)
    const fd = openSync(join(dir, 'supabase', '.env'), 'r')
    try {
      let thrown = null
      try { hideEnvFiles(dir, { holdRoot: join(tmp(t, 'hold root'), 'h') }) } catch (e) { thrown = e }
      if (thrown) {
        assert.equal(thrown.code, 'ENV_ISOLATION_FAILED')
        assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'A=1', '되돌리지 못했다')
      } else {
        t.diagnostic('이 플랫폼은 열린 파일의 rename 을 허용한다 — 잠금 경로는 이 환경에서 재현되지 않음(대상 없음 케이스로 검증됨)')
      }
    } finally { closeSync(fd) }
  })
  it('복원 충돌(워커가 같은 이름의 새 파일 생성) → ENV_RESTORE_FAILED throw + 원본은 보관 폴더에 보존', (t) => {
    const dir = tmp(t); seed(dir)
    const hold = hideEnvFiles(dir, { holdRoot: join(tmp(t, 'hold root'), 'h') })
    writeFileSync(join(dir, '.env'), 'WORKER-WROTE-THIS')
    assert.throws(
      () => restoreEnvFiles(dir, hold),
      (e) => e.code === 'ENV_RESTORE_FAILED' && /복원 충돌/.test(e.message) && e.holdDir === hold.holdDir,
    )
    assert.equal(readFileSync(join(hold.holdDir, '.env'), 'utf8'), 'A=1', '원본을 덮어썼다 — 자격증명 유실')
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'WORKER-WROTE-THIS')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// N4 · N5 · 정책 3 — 격리 대상은 `.env*` 가 아니라 **모든 민감 파일** · 깊이 무제한 · 탐색 실패 fail-closed
// ─────────────────────────────────────────────────────────────────────────────
describe('[N4/N5] 민감 파일 격리 — 깊이 제한 없음 · isSensitivePath 전부 · 탐색 실패는 fail-closed', () => {
  const seedDeep = (dir) => {
    const deep = join(dir, 'packages', 'a', 'services', 'api', 'config')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, '.env.production'), 'DEEP=1') // 깊이 5 — 종전 ENV_SCAN_DEPTH=4 로는 못 봤다
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'app.pem'), '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----')
    writeFileSync(join(dir, 'auth.json'), '{"token":"t"}')
    writeFileSync(join(dir, '.env.example'), 'A=')
    writeFileSync(join(dir, 'src.ts'), 'export const a = 1')
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', '.env'), 'D=4')
  }
  it('깊이 5 `.env.production` · pem · auth.json 을 전부 수집하고 견본·node_modules 는 제외한다', (t) => {
    const dir = tmp(t); seedDeep(dir)
    assert.deepEqual(collectSensitiveFiles(dir), ['auth.json', 'packages/a/services/api/config/.env.production', 'secrets/app.pem'])
  })
  it('실제 격리·복원 왕복 — 실행 중에는 하나도 남지 않는다', (t) => {
    const dir = tmp(t); seedDeep(dir)
    const hold = hideSensitiveFiles(dir, { holdRoot: join(tmp(t, 'hold root'), 'h') })
    assert.equal(hold.moved.length, 3)
    assert.deepEqual(collectSensitiveFiles(dir), [], '민감 파일이 남아 있다 — 벤더가 cat 으로 읽을 수 있다')
    assert.equal(existsSync(join(dir, 'src.ts')), true, '코드는 그대로 있어야 한다')
    assert.equal(existsSync(join(dir, '.env.example')), true, '견본은 건드리지 않는다')
    restoreEnvFiles(dir, hold)
    assert.equal(readFileSync(join(dir, 'packages', 'a', 'services', 'api', 'config', '.env.production'), 'utf8'), 'DEEP=1')
    assert.equal(readFileSync(join(dir, 'secrets', 'app.pem'), 'utf8').includes('BEGIN PRIVATE KEY'), true)
  })
  it('탐색 중 readdir 이 한 건이라도 실패하면 ENV_ISOLATION_FAILED — 빈 디렉터리처럼 삼키지 않는다(정책 3)', (t) => {
    const dir = tmp(t); seedDeep(dir)
    const blocked = join(dir, 'secrets')
    const readdir = (p, o) => { if (String(p) === blocked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return readdirSync(p, o) }
    assert.throws(
      () => collectSensitiveFiles(dir, { readdir }),
      (e) => e.code === 'ENV_ISOLATION_FAILED' && /Codex 실행을 중단/.test(e.message) && /secrets/.test(e.message),
    )
    assert.equal(existsSync(join(dir, 'auth.json')), true, '탐색이 실패하면 아무것도 옮기지 않는다')
  })
  it('git ls-files 병행 — walk 가 못 본 목록의 민감 파일도 함께 집는다', (t) => {
    const dir = tmp(t); seedDeep(dir)
    const readdir = (p, o) => (String(p) === dir ? [] : readdirSync(p, o)) // walk 를 눈멀게 한다
    const git = () => ({ status: 0, stdout: 'auth.json\nsecrets/app.pem\nsrc.ts\nnode_modules/pkg/.env\n' })
    assert.deepEqual(collectSensitiveFiles(dir, { readdir, git }), ['auth.json', 'secrets/app.pem'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// N9 — 슬롯 심박: 실행 중 `hb` 를 실제 자식이 갱신한다(고정 3시간 뒤 살아 있는 슬롯을 뺏기지 않게)
// ─────────────────────────────────────────────────────────────────────────────
describe('[N9] Codex 슬롯 심박 — 실제 자식이 hb 를 원자 갱신한다', () => {
  it('슬롯을 쥔 동안 hb 가 계속 전진하고, 낡은 at 기준이면 stale 인 시점에도 회수되지 않는다', async (t) => {
    const dir = tmp(t)
    const slot = acquireCodexSlot({ dir, max: 1 })
    assert.ok(slot, '슬롯 획득 실패')
    const at0 = JSON.parse(readFileSync(slot.path, 'utf8')).at
    const hb = startSlotHeartbeat(slot, { intervalMs: 150 })
    assert.ok(hb.child, '심박 자식이 뜨지 않았다')
    const seen = new Set()
    for (let i = 0; i < 12; i++) { // 고정 ~1.4초 — at0 가 확실히 낡도록 일찍 끊지 않는다
      await sleep(120)
      try { seen.add(JSON.parse(readFileSync(slot.path, 'utf8')).hb) } catch { /* rename 순간 */ }
    }
    hb.stop()
    const last = JSON.parse(readFileSync(slot.path, 'utf8'))
    assert.ok(seen.size >= 3, `hb 가 갱신되지 않았다(관측 ${[...seen].join(', ')})`)
    assert.equal(last.pid, process.pid, 'pid·slot 같은 다른 필드는 보존한다')
    // 심박이 없었다면 = at 기준: 1초 staleMs 로는 stale. 심박 덕분에 현재 hb 는 stale 이 아니다.
    assert.equal(isSlotStale({ pid: null, hb: at0, staleMs: 1000, now: Date.now() }), true, '전제: 낡은 at 는 stale')
    assert.equal(isSlotStale({ pid: null, hb: last.hb, staleMs: 1000, now: Date.now() }), false, '심박 갱신본은 살아 있다')
    releaseCodexSlot(slot)
  })
  it('withCodexSlot 이 실제로 심박을 배선한다 — fn 이 도는 동안 hb 가 전진한다', (t) => {
    const dir = tmp(t)
    const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    const beats = []
    withCodexSlot({ dir, max: 1, waitMs: 5000, hbMs: 120 }, () => {
      for (let i = 0; i < 8; i++) {
        nap(120)
        try { beats.push(JSON.parse(readFileSync(join(dir, 'codex-slot-0.lock'), 'utf8')).hb) } catch { /* rename 순간 */ }
      }
      return { code: 0 }
    })
    assert.ok(new Set(beats).size >= 2, `withCodexSlot 이 심박을 켜지 않았다(관측 ${beats.length}회 · 고유 ${new Set(beats).size})`)
    assert.equal(existsSync(join(dir, 'codex-slot-0.lock')), false, '끝나면 슬롯을 놓아야 한다(심박 자식이 되살리면 안 된다)')
  })
  it('slotStaleMsFor: 고정 3시간과 stage 타임아웃×1.5 중 큰 값', () => {
    assert.equal(slotStaleMsFor(0), CODEX_SLOT_STALE_MS)
    assert.equal(slotStaleMsFor(60 * 60 * 1000), CODEX_SLOT_STALE_MS, '1h 스테이지는 3h 기준 유지')
    assert.equal(slotStaleMsFor(4 * 60 * 60 * 1000), 6 * 60 * 60 * 1000, '4h 스테이지면 6h')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 시나리오 15 — 미열람 clean 거부 (#12)
// ─────────────────────────────────────────────────────────────────────────────
describe('[15] 「파일을 읽지 않은 clean」은 무효 — 명령 개수가 아니라 열람 증거로 판정한다(#12)', () => {
  const STORY = '_bmad-output/implementation-artifacts/stories/2-3.md'
  const DIFF = '_bmad-output/implementation-artifacts/auto-pipeline-logs/codex-ab12-review-diff.txt'
  const ev = (cmds) => parseCodexEvents(cmds.map((c, i) => JSON.stringify({ type: 'item.started', item: { id: `c${i}`, type: 'command_execution', command: c } })).concat(
    cmds.map((_, i) => JSON.stringify({ type: 'item.completed', item: { id: `c${i}`, type: 'command_execution', exit_code: 0 } })),
  ).join('\n'))

  it('parseCodexEvents 가 명령 문자열을 보존하고 중복 계상하지 않는다', () => {
    const e = ev(['pwd', 'cat a.md'])
    assert.deepEqual(e.commandList, ['pwd', 'cat a.md'])
    assert.equal(e.commands, 2)
  })
  it('`pwd` 한 번 + findings 0 → 무효(종전 판정은 commands>0 이라 통과했다)', () => {
    const v = validateReviewRun({ json: { findings: [] }, events: ev(['pwd']), storyFile: STORY, diffFile: DIFF, changedFiles: ['src/a.ts'] })
    assert.equal(v.ok, false)
    assert.match(v.why, /실제로 읽은 증거 없이/)
    assert.match(v.why, /pwd/)
  })
  it('스토리는 읽었지만 diff 를 안 읽었으면 무효', () => {
    const v = validateReviewRun({ json: { findings: [] }, events: ev([`cat ${STORY}`]), storyFile: STORY, diffFile: DIFF, changedFiles: ['src/a.ts'] })
    assert.equal(v.ok, false)
    assert.match(v.why, /리뷰 diff 파일/)
  })
  // (N7 · 2026-09-02 2차 리뷰) 종전에는 targets 에 changedFiles 가 통째로 들어가 **스토리 파일 한 번 읽기**로
  // 두 조건이 동시에 충족됐다(dev 가 스토리 문서를 고치므로 그 파일은 거의 항상 changedFiles 에 있다).
  // 이제 스토리는 target 에서 빠지고 **리뷰 diff 열람이 필수**다.
  // (M6 · 2026-09-02 3차 리뷰) 구현 파일 미열람은 이제 **경고가 아니라 거부**다 — 이 테스트도 강화한다
  // (완화가 아니다): 유효 판정은 스토리 + diff + 구현 파일 셋을 모두 읽었을 때만 난다.
  it('스토리 + diff + 구현 파일을 읽었으면 유효 — 경로 구분자(\\)와 대소문자를 정규화해 비교한다', () => {
    const cmds = [`type ${STORY.replace(/\//g, '\\')}`, `Get-Content ${DIFF.replace(/\//g, '\\').toUpperCase()}`]
    const noImpl = validateReviewRun({ json: { findings: [] }, events: ev(cmds), storyFile: STORY, diffFile: DIFF, changedFiles: ['src/a.ts'] })
    assert.equal(noImpl.ok, false, '구현 파일 미열람 clean 은 거부한다(M6)')
    assert.match(noImpl.why, /변경 구현 파일/)
    const both = validateReviewRun({ json: { findings: [] }, events: ev([...cmds, 'sed -n 1,80p SRC\\A.TS']), storyFile: STORY, diffFile: DIFF, changedFiles: ['src/a.ts'] })
    assert.equal(both.ok, true, both.why)
    assert.deepEqual(both.warnings, [], '셋 다 읽었으면 경고 0 — 대소문자·구분자 정규화가 살아 있다')
  })
  it('[N7] 스토리 + 구현 파일만 읽고 diff 를 안 열었으면 무효', () => {
    const v = validateReviewRun({ json: { findings: [] }, events: ev(['cd repo && cat 2-3.md', 'sed -n 1,80p src/a.ts']), storyFile: STORY, diffFile: DIFF, changedFiles: ['src/a.ts', 'src/b.ts'] })
    assert.equal(v.ok, false, '리뷰 diff 열람은 필수다')
    assert.match(v.why, /리뷰 diff 파일/)
  })
  it('[N7] 스토리 파일은 target 목록에서 제외된다 — 스토리만 읽은 clean 은 거부', () => {
    // dev 가 스토리 문서를 고쳐 changedFiles 에 그 파일이 들어간 실제 형태
    const v = validateReviewRun({ json: { findings: [] }, events: ev([`cat ${STORY}`]), storyFile: STORY, diffFile: DIFF, changedFiles: [STORY, 'src/a.ts'] })
    assert.equal(v.ok, false, '스토리 한 번 읽기로 두 조건을 채우면 안 된다')
    assert.match(v.why, /리뷰 diff 파일/)
  })
  it('findings 가 있으면 열람 증거를 요구하지 않는다(무언가 봤다는 뜻) · file_change 이벤트도 증거로 인정', () => {
    assert.equal(validateReviewRun({ json: { findings: [{ title: 'x' }] }, events: ev(['pwd']), storyFile: STORY, diffFile: DIFF }).ok, true)
    const withFile = parseCodexEvents([
      JSON.stringify({ type: 'item.started', item: { id: 'c0', type: 'command_execution', command: 'ls' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'c0', type: 'command_execution' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: STORY }, { path: DIFF }] } }),
    ].join('\n'))
    assert.equal(validateReviewRun({ json: { findings: [] }, events: withFile, storyFile: STORY, diffFile: DIFF }).ok, true)
  })

  // 2026-09-02 R4 — 한글 스토리 파일명은 git 이 `core.quotePath` 기본값에서 C-인용으로 내보낸다.
  // 그러면 changedFiles(=git 출력)와 storyFile(=엔진의 UTF-8 경로)이 문자열로 어긋나 **스토리 파일이
  // 「변경 구현 파일」로 남고**, 스토리 한 번 읽기가 impl 열람으로 오인된다. 실제 git 출력 형식으로 문다.
  describe('git C-인용 경로(비ASCII 스토리명)도 같은 경로로 대조한다', () => {
    const KSTORY = '_bmad-output/implementation-artifacts/stories/2-3-티켓-목록.md'
    /** git 의 C-인용 표기 — 비ASCII 바이트를 8진 이스케이프로. `git diff --name-only` 가 이 형태를 낸다. */
    const cQuote = (p) => `"${[...Buffer.from(p, 'utf8')].map((b) => (b < 0x80 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`)).join('')}"`

    it('C-인용 형태를 그대로 되돌린다(quotePath=false 출력은 손대지 않는다)', () => {
      assert.equal(unquoteGitPath(cQuote(KSTORY)), KSTORY)
      assert.equal(unquoteGitPath(`cat ${cQuote(KSTORY)}`), `cat ${KSTORY}`)
      assert.equal(unquoteGitPath(KSTORY), KSTORY, 'quotePath=false 출력(원문)은 그대로')
      assert.equal(unquoteGitPath('C:\\Projects\\a.ts'), 'C:\\Projects\\a.ts', 'Windows 경로를 망가뜨리지 않는다')
    })

    it('스토리는 C-인용 changedFiles 에서도 제외된다 — 스토리만 읽은 clean 은 거부', () => {
      const v = validateReviewRun({
        json: { findings: [] },
        events: ev([`cat ${cQuote(KSTORY)}`, `cat ${DIFF}`]),
        storyFile: KSTORY, diffFile: DIFF, changedFiles: [cQuote(KSTORY), 'src/a.ts'],
      })
      assert.equal(v.ok, false, '스토리 파일이 impl 로 남아 열람 판정을 채우면 안 된다')
      assert.match(v.why, /변경 구현 파일/)
      assert.ok(!/스토리 파일/.test(v.why), `스토리 열람은 인정돼야 한다: ${v.why}`)
    })

    it('스토리 + diff + 구현 파일을 C-인용 이벤트로 읽었으면 유효', () => {
      const v = validateReviewRun({
        json: { findings: [] },
        events: ev([`cat ${cQuote(KSTORY)}`, `cat ${DIFF}`, 'sed -n 1,80p src/a.ts']),
        storyFile: KSTORY, diffFile: DIFF, changedFiles: [cQuote(KSTORY), 'src/a.ts'],
      })
      assert.equal(v.ok, true, v.why)
      assert.deepEqual(v.warnings, [])
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #8 마스킹 · 민감 파일 diff 섹션 제거
// ─────────────────────────────────────────────────────────────────────────────
describe('[#8] 마스킹 강화 · 민감 파일 diff 섹션 제거 — 워커 E 가 diff 생성·로그 기록에 쓴다', () => {
  // (N3 · 2026-09-02 2차 리뷰 회귀 고정) 리뷰가 실제 호출로 확인한 **원문 유지 3형태**. 이 셋이 다시 새면 RED.
  it('[N3] 구조 인식 마스킹 — JSON key/value · Bearer 토큰 · 공백 포함 인용값이 원문 0건', () => {
    const cases = [
      ['{"api_key":"JSONSECRET123456"}', 'JSONSECRET123456'],
      ['Authorization: Bearer TOKENVALUE123456', 'TOKENVALUE123456'],
      ['PRIVATE_KEY="alpha beta gamma secret"', 'alpha beta gamma secret'],
      [`{"token": "TOKENJSON7890", "password": 'PW WITH SPACE'}`, 'TOKENJSON7890'],
      ['x-api-key: XAPIKEYVALUE9999', 'XAPIKEYVALUE9999'],
      ['Cookie: sb-access-token=COOKIEVALUE1234; other=2', 'COOKIEVALUE1234'],
      ['Set-Cookie: session=SETCOOKIEVAL999; HttpOnly', 'SETCOOKIEVAL999'],
      ["client_secret='SPACED SECRET VALUE'", 'SPACED SECRET VALUE'],
    ]
    for (const [input, leak] of cases) {
      const r = redactSecrets(input)
      assert.ok(!r.includes(leak), `마스킹 누락: ${input} → ${r}`)
      assert.match(r, /\*\*\*REDACTED\*\*\*/, input)
    }
    assert.ok(redactSecrets('PW WITH SPACE').includes('PW WITH SPACE'), '키 없는 평범한 문장까지 가리지 않는다')
    // 이름(키)은 남는다 — 무엇이 새려 했는지는 사람이 알아야 한다
    assert.match(redactSecrets('{"api_key":"JSONSECRET123456"}'), /"api_key"/)
    assert.match(redactSecrets('Authorization: Bearer TOKENVALUE123456'), /Authorization: Bearer/)
  })
  it('redactSecrets: URL credential · PEM · OAuth client secret · gh/xox/AKIA/JWT/sk- · KEY=VALUE', () => {
    const t = [
      'postgres://baro_admin:S3cr3tPass@db.example.com:5432/app',
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_ABCDEFGHIJKLMNOP',
      'client_secret: "GOCSPX-abcdefghijklmnop"',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'xoxb-1111111111-abcdefghijkl',
      'AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer eyJhbGciOiJIUzI1.abcdefghijklmn.SIGNATURE1',
      'sk-proj-ABCDEFGHIJKLMNOPQRSTUV',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----',
      'plain=ok',
    ].join('\n')
    const r = redactSecrets(t)
    for (const leak of ['S3cr3tPass', 'ABCDEFGHIJKLMNOP', 'abcdefghijklmnop', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'abcdefghijkl', 'abcdefghijklmn', 'MIIEowIBAAKCAQEA1234567890']) {
      assert.ok(!r.includes(leak), `마스킹 누락: ${leak}\n${r}`)
    }
    assert.ok(r.includes('postgres://baro_admin:***REDACTED***@db.example.com'), r)
    assert.ok(r.includes('SUPABASE_SERVICE_ROLE_KEY=***REDACTED***'))
    assert.ok(r.includes('plain=ok'), '평범한 값까지 가리지 않는다')
  })
  it('SENSITIVE_PATH_RE: env·키·인증서·시크릿 자료 파일은 민감 · 소스 파일과 .env.example 은 아니다', () => {
    for (const p of ['.env', '.env.production', 'supabase/.env.local', 'certs/server.pem', 'keys/id_rsa', 'a\\b\\auth.json', 'x/service-account-prod.json', 'conf/secrets.yaml', 'cfg/client-credentials.json', 'app.local.json', 'keys/store.p12']) {
      assert.ok(isSensitivePath(p), `민감으로 잡히지 않음: ${p}`)
    }
    for (const p of ['.env.example', 'src/lib/secretScanner.ts', 'src/credentials.tsx', 'README.md', 'package.json', 'src/token.ts']) {
      assert.ok(!isSensitivePath(p), `과잉 제외(리뷰가 눈을 잃는다): ${p}`)
    }
  })
  it('stripSensitiveFileSections: 민감 파일 섹션은 본문째 사라지고 나머지는 그대로', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-const a = 1',
      '+const a = 2',
      'diff --git a/.env.production b/.env.production',
      'index 333..444 100644',
      '--- a/.env.production',
      '+++ b/.env.production',
      '@@ -1 +1 @@',
      '+OAUTH_CLIENT_SECRET=super-secret-value-not-matched-by-regex',
      'diff --git a/docs/x.md b/docs/x.md',
      '+ok',
    ].join('\n')
    const out = stripSensitiveFileSections(diff)
    assert.ok(!out.includes('super-secret-value-not-matched-by-regex'), out)
    assert.ok(out.includes('[민감 파일 diff 제외: .env.production]'))
    assert.ok(out.includes('+const a = 2') && out.includes('+ok'), '정상 파일 섹션은 남는다')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// git-guard — 실제 임시 git 저장소에서 shim PATH 로 차단을 확인한다 (#3)
// ─────────────────────────────────────────────────────────────────────────────
const gitAvailable = (() => { try { resolveRealGit(); return true } catch { return false } })()

function makeRepo(t) {
  const dir = tmp(t, 'repo dir with space')
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'test@example.com')
  g('config', 'user.name', 'Test')
  g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  g('add', 'a.txt')
  g('commit', '-q', '-m', 'init')
  return { dir, head: () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim() }
}

describe('[git-guard] 워커의 git 상태 변경을 실행 단계에서 막는다(#3)', { skip: gitAvailable ? false : 'git 없음' }, () => {
  it('shim 본문은 진짜 git 절대경로와 허용 목록을 담고, 차단 시 exit 86 + [GIT-GUARD] blocked', () => {
    const cmd = renderCmdShim('C:\\Program Files\\Git\\cmd\\git.exe')
    assert.ok(cmd.includes('C:\\Program Files\\Git\\cmd\\git.exe'))
    assert.ok(cmd.includes('exit /b 86') && cmd.includes('[GIT-GUARD] blocked:'))
    assert.ok(cmd.includes('if /I "%SUB%"=="stash" if /I "%SUB2%"=="list" goto gg_allow'))
    // cmd 는 `if cond a & b` 를 `(if cond a) & b` 로 파싱한다 — 조건부 shift 는 반드시 괄호 안
    assert.ok(!/if [^\n]*"==[^\n]*" shift &/.test(cmd), '괄호 없는 조건부 shift 가 있다')
    const sh = renderShShim('C:\\Program Files\\Git\\cmd\\git.exe')
    assert.ok(sh.startsWith('#!/bin/sh'))
    assert.ok(sh.includes("GITGUARD_REAL='C:/Program Files/Git/cmd/git.exe'"))
    assert.ok(sh.includes('exit 86'))
  })

  const READ_OK = [['status', '--porcelain'], ['rev-parse', 'HEAD'], ['log', '--oneline', '-1'], ['diff', '--name-only'], ['stash', 'list']]
  const BLOCKED = [
    ['commit', '--allow-empty', '-m', 'sneaky'],
    ['push', 'origin', 'HEAD:main'],
    ['reset', '--hard', 'HEAD~1'],
    ['stash'],
    ['stash', 'push', '-u'],
    ['checkout', '-b', 'sneaky'],
    ['switch', '-c', 'sneaky'],
    ['branch', '-D', 'main'],
    ['merge', 'other'],
    ['rebase', 'other'],
    ['cherry-pick', 'HEAD'],
    ['tag', '-d', 'v1'],
    ['remote', 'add', 'evil', 'https://example.com/x.git'],
    ['config', '--global', 'user.email', 'x@y.z'],
    ['clean', '-fdx'],
    ['-c', 'alias.z=!sh -c "git push"', 'z'],
  ]

  it('Windows cmd 심: 읽기 전용은 통과 · 상태 변경은 exit 86 · HEAD 불변 (win32 전용)', { skip: !isWin ? 'win32 전용' : false }, (t) => {
    const repo = makeRepo(t)
    const guard = createGitGuard({ tmpRoot: tmpdir() })
    t.after(() => guard.cleanup())
    // 워커가 실제로 쓰는 경로 — 셸을 거쳐 `git …` 을 부른다(cmd 가 PATHEXT 로 shim 의 git.cmd 를 먼저 찾는다)
    const viaCmd = (args) => spawnSync('git', args, { cwd: repo.dir, env: guard.env, encoding: 'utf8', shell: true })
    const before = repo.head()
    for (const args of READ_OK) {
      const r = viaCmd(args)
      assert.equal(r.status, 0, `읽기 전용이 막혔다: git ${args.join(' ')} — ${r.stderr}`)
      assert.ok(!String(r.stderr).includes('[GIT-GUARD]'), `git ${args.join(' ')}`)
    }
    for (const args of BLOCKED) {
      const r = viaCmd(args)
      assert.equal(r.status, GIT_GUARD_EXIT, `막히지 않았다: git ${args.join(' ')} — status=${r.status} ${r.stdout}${r.stderr}`)
      assert.match(String(r.stderr), /\[GIT-GUARD\] blocked:/)
    }
    assert.equal(repo.head(), before, 'HEAD 가 움직였다 — 차단 실패')
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: repo.dir, encoding: 'utf8' }).stdout.trim(), '', '작업 트리가 변했다')
  })

  it('POSIX sh 심: 같은 판정 · HEAD 불변', { skip: SH ? false : 'sh 없음' }, (t) => {
    const repo = makeRepo(t)
    const guard = createGitGuard({ tmpRoot: tmpdir() })
    t.after(() => guard.cleanup())
    const viaSh = (args) => spawnSync(SH, ['-c', ['git', ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')], { cwd: repo.dir, env: guard.env, encoding: 'utf8' })
    const before = repo.head()
    for (const args of READ_OK) {
      const r = viaSh(args)
      assert.equal(r.status, 0, `읽기 전용이 막혔다: git ${args.join(' ')} — ${r.stderr}`)
    }
    for (const args of BLOCKED) {
      const r = viaSh(args)
      assert.equal(r.status, GIT_GUARD_EXIT, `막히지 않았다: git ${args.join(' ')} — status=${r.status} ${r.stdout}${r.stderr}`)
      assert.match(String(r.stderr), /\[GIT-GUARD\] blocked:/)
    }
    assert.equal(repo.head(), before, 'HEAD 가 움직였다 — 차단 실패')
  })

  it('2차 방어: PATH shim 을 우회당해도 GIT_ALLOW_PROTOCOL=none 이 원격 통신을 끊는다(실제 push 실패)', (t) => {
    const repo = makeRepo(t)
    const guard = createGitGuard({ tmpRoot: tmpdir() })
    t.after(() => guard.cleanup())
    const bare = join(dirname(repo.dir), 'remote.git')
    spawnSync('git', ['init', '--bare', '-q', bare], { encoding: 'utf8' })
    spawnSync('git', ['remote', 'add', 'origin', bare], { cwd: repo.dir, encoding: 'utf8' })
    // shim 을 완전히 건너뛰고 **진짜 git 절대경로**로 push 한다 — PATH 우회를 최악으로 가정한 상황
    const r = spawnSync(guard.realGit, ['push', 'origin', 'HEAD:main'], { cwd: repo.dir, env: guard.env, encoding: 'utf8' })
    assert.notEqual(r.status, 0, 'shim 우회 시 push 가 나갔다')
    assert.match(String(r.stderr), /transport .* not allowed/)
    // 가드 없이는 성공한다 = 위 실패가 가드 때문임을 증명(자기 RED)
    const ok = spawnSync(guard.realGit, ['push', 'origin', 'HEAD:main'], { cwd: repo.dir, encoding: 'utf8' })
    assert.equal(ok.status, 0, '대조군 push 가 실패했다 — 테스트가 결함 위에 서 있다')
  })

  it('알려진 우회(문서화): Git for Windows 래퍼 bash 는 PATH 앞에 /mingw64/bin 을 끼워 shim 을 지나친다', { skip: !isWin || !existsSync(SH_WRAPPER) ? 'win32 + Git bash 래퍼 전용' : false }, (t) => {
    const guard = createGitGuard({ tmpRoot: tmpdir() })
    t.after(() => guard.cleanup())
    const which = (sh) => String(spawnSync(sh, ['-c', 'command -v git'], { env: guard.env, encoding: 'utf8' }).stdout).trim()
    assert.ok(!which(SH_WRAPPER).includes('git-guard-'), '래퍼가 shim 을 탄다면 이 한계 주석을 지워야 한다')
    assert.ok(which(SH).includes('git-guard-'), '진짜 sh 는 PATH 순서를 지켜 shim 을 타야 한다')
  })

  it('cleanup() 은 shim 디렉터리를 지운다 · env 는 원본 PATH 를 보존한 채 shim 을 맨 앞에 둔다', (t) => {
    const guard = createGitGuard({ tmpRoot: tmpdir(), baseEnv: { Path: 'C:/existing', OTHER: '1' }, realGit: 'C:/git.exe' })
    assert.equal(guard.env.OTHER, '1')
    assert.ok(guard.env.Path.startsWith(guard.dir))
    assert.ok(guard.env.Path.endsWith('C:/existing'))
    assert.equal(guard.env.PATH, undefined, 'PATH 키를 중복 생성하지 않는다')
    assert.equal(guard.env.GIT_ALLOW_PROTOCOL, 'none', '2차 방어(원격 차단)가 빠졌다')
    assert.ok(existsSync(join(guard.dir, 'git.cmd')) && existsSync(join(guard.dir, 'git')))
    guard.cleanup()
    assert.equal(existsSync(guard.dir), false)
  })
})

// ── H1 — 공용 시크릿 마스커는 하나다(redact.mjs) ──────────────────────────────────────────
// 3차 리뷰 H1: 진단·보고서가 **자기 사본**을 만들어 R2 에서 이미 고친 세 형식을 다시 통과시켰다.
// 규칙 본체를 providers/redact.mjs 하나로 옮기고 codex.mjs 는 재수출만 한다.
describe('[H1] 공용 마스커 — R2 회귀 3형식 + 깊은 객체 마스킹', () => {
  const R2_CASES = [
    ['{"api_key":"JSONSECRET123456"}', 'JSONSECRET123456'],
    ['Authorization: Bearer TOKENVALUE123456', 'TOKENVALUE123456'],
    ['PRIVATE_KEY="alpha beta gamma secret"', 'alpha beta gamma secret'],
  ]

  it('R2 3형식이 redact.mjs 에서 원문으로 남지 않는다 · 키 이름은 남는다', () => {
    for (const [input, leak] of R2_CASES) {
      const out = redactSecretsShared(input)
      assert.ok(!out.includes(leak), `원문이 남았다: ${out}`)
      assert.match(out, /\*\*\*REDACTED\*\*\*/)
    }
    assert.match(redactSecretsShared(R2_CASES[0][0]), /api_key/, '무엇이 새려 했는지는 남아야 한다')
    assert.match(redactSecretsShared(R2_CASES[1][0]), /Bearer/)
  })

  it('codex.mjs 의 redactSecrets 는 재수출이다 — 같은 함수 객체(사본이 갈릴 여지 0)', () => {
    assert.equal(redactSecrets, redactSecretsShared, 'codex.mjs 가 자기 사본을 다시 만들었다')
  })

  it('deepRedact: scripts·manifests·engineState 주입을 객체 깊이에서 지운다(순환 안전)', () => {
    const snapshot = {
      scripts: { deploy: 'curl -H "Authorization: Bearer DEPLOYTOKEN123456" https://x' },
      manifests: [{ story: '2-1', review: { api_key: 'MANIFESTKEY123456' } }],
      engineState: { nested: { deep: { PRIVATE_KEY: 'alpha beta gamma secret' } }, list: ['token=PLAINTOKEN123456'] },
      keep: 'author: 박사장',
    }
    snapshot.self = snapshot // 순환
    const out = deepRedact(snapshot)
    const json = JSON.stringify(out)
    for (const leak of ['DEPLOYTOKEN123456', 'MANIFESTKEY123456', 'alpha beta gamma secret', 'PLAINTOKEN123456']) {
      assert.ok(!json.includes(leak), `${leak} 가 스냅숏에 남았다: ${json}`)
    }
    assert.equal(out.self, '[Circular]')
    assert.equal(out.keep, 'author: 박사장', '평범한 값까지 가리면 과잉 제외다')
    assert.ok(snapshot.scripts.deploy.includes('DEPLOYTOKEN123456'), '입력을 고치면 안 된다(순수)')
  })

  it('deepRedact: 배열·Map·Set·원시값을 형을 잃지 않고 옮긴다', () => {
    const m = new Map([['token', 'MAPTOKEN123456'], ['name', 'x']])
    const out = deepRedact({ arr: ['api_key=ARRAYKEY123456', 1, null, true], m, s: new Set(['sk-ABCDEFGHIJKLMNOP12']) })
    assert.equal(out.arr[1], 1)
    assert.equal(out.arr[2], null)
    assert.equal(out.arr[3], true)
    assert.ok(!out.arr[0].includes('ARRAYKEY123456'))
    assert.ok(out.m instanceof Map)
    assert.equal(out.m.get('token'), '***REDACTED***')
    assert.equal(out.m.get('name'), 'x')
    assert.ok(!JSON.stringify([...out.s]).includes('ABCDEFGHIJKLMNOP12'))
  })

  // 2026-09-02 R4 — 공용 그물이 진단(diagnose.mjs)의 덧그물 두 가지를 흡수했다. 흡수한 것이 다시 새면
  // 진단·보고서가 조용히 원문을 싣게 되므로 **공용 쪽에서** 문다.
  it('redactSecrets: 서명부가 잘린 2조각 JWT 도 헤더째 지운다(로그·diff 는 줄을 자른다)', () => {
    for (const raw of [
      'SUPABASE_SERVICE_ROLE=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.bGVha2VkLXNlY3JldA',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PAYLOADPAYLOAD123456.SIGSIGSIGSIG',
    ]) {
      const r = redactSecretsShared(raw)
      assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(r), `헤더가 남아 JWT 형태가 보인다: ${r}`)
      for (const leak of ['bGVha2VkLXNlY3JldA', 'PAYLOADPAYLOAD123456', 'SIGSIGSIGSIG']) assert.ok(!r.includes(leak), r)
    }
  })

  it('deepRedact: 자격증명 키는 배열·Set 안쪽까지 상속된다 — {"tokens":["원문"]} 도 가린다', () => {
    const out = deepRedact({ tokens: ['RAWTOKENVALUE123456'], credentials: new Set(['RAWSETVALUE123456']), files: ['src/a.ts'] })
    assert.deepEqual(out.tokens, ['***REDACTED***'], '키 이름만으로 가려야 하는 자리다(값에 패턴이 없다)')
    assert.deepEqual([...out.credentials], ['***REDACTED***'])
    assert.deepEqual(out.files, ['src/a.ts'], '평범한 키의 배열까지 가리면 과잉 제외다')
  })
})

// ── H3 — 워커 env 에서 원격 인증 수단을 완전히 제거 ────────────────────────────────────────
describe('[H3] 워커 env 원격 자격증명 제거 · 원격 URL 토큰 거부', () => {
  const DIRTY_ENV = {
    Path: 'C:/tools', HOME: '/h',
    GIT_ASKPASS: 'C:/ask.exe', SSH_ASKPASS: 'C:/sshask.exe', SSH_AUTH_SOCK: '/tmp/agent.sock', SSH_AGENT_PID: '4242',
    GIT_SSH_COMMAND: 'ssh -i C:/keys/id_rsa', GH_TOKEN: 'ghp_AAAAAAAAAAAAAAAAAAAA', GITHUB_TOKEN: 'ghp_BBBBBBBBBBBBBBBBBBBB',
    CLOUDFLARE_API_TOKEN: 'cf_token_value', OUTBOX_DISPATCH_SECRET: 's3cret', DB_PASSWORD: 'pw', SUPABASE_SERVICE_ROLE_KEY: 'x',
    HTTPS_PROXY: 'http://proxy:8080', HTTP_PROXY: 'http://proxy:8080', ALL_PROXY: 'socks5://p:1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'manager',
    ANTHROPIC_API_KEY: 'keep-me', OPENAI_API_KEY: 'keep-me-too',
  }

  it('제거 목록·이름 규칙에 걸리는 키가 env 에서 사라지고 차단 값이 심긴다', () => {
    const { env, removed } = stripRemoteCredentials(DIRTY_ENV, { platform: 'win32' })
    for (const k of ['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GH_TOKEN', 'GITHUB_TOKEN',
      'CLOUDFLARE_API_TOKEN', 'OUTBOX_DISPATCH_SECRET', 'DB_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY',
      'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
      assert.ok(removed.includes(k), `${k} 가 removed 에 안 잡혔다`)
    }
    assert.equal(env.GH_TOKEN, undefined)
    assert.equal(env.SSH_AUTH_SOCK, undefined)
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper', '무효화 config 로 덮어써진다(원본 manager 가 아니다)')
    assert.equal(env.GIT_CONFIG_VALUE_0, '')
    assert.equal(env.Path, 'C:/tools', '무관한 env 는 그대로 간다')
    // 워커 자기 인증(제공자 API)은 남긴다 — 지우면 워커가 아예 못 돈다(정직 기록)
    assert.equal(env.ANTHROPIC_API_KEY, 'keep-me')
    assert.equal(env.OPENAI_API_KEY, 'keep-me-too')
    // 차단 값
    assert.equal(env.GIT_ALLOW_PROTOCOL, 'none')
    assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/)
    assert.match(env.GIT_SSH_COMMAND, /IdentitiesOnly=yes/)
    assert.match(env.GIT_SSH_COMMAND, /-i NUL$/)
    // GIT_CONFIG_* 로 credential.helper·askpass 무효화
    const n = Number(env.GIT_CONFIG_COUNT)
    const pairs = Object.fromEntries([...Array(n).keys()].map((i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]))
    assert.equal(pairs['credential.helper'], '')
    assert.equal(pairs['core.askpass'], '')
    assert.equal(pairs['credential.useHttpPath'], 'false')
    assert.equal(pairs['http.proxy'], '')
  })

  it('실제 자식 프로세스가 받은 env 에 그 키들이 없다(스텁이 아니라 진짜 spawn)', () => {
    const basePath = process.env.Path ?? process.env.PATH ?? ''
    const { env } = stripRemoteCredentials({ ...DIRTY_ENV, Path: basePath })
    const dump = (e) => {
      const r = spawnSync(process.execPath, ['-p', 'JSON.stringify(Object.keys(process.env))'], { env: e, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(r.stdout).map((k) => k.toUpperCase())
    }
    const keys = dump(env)
    for (const k of ['GIT_ASKPASS', 'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'HTTPS_PROXY']) {
      assert.ok(!keys.includes(k), `자식 프로세스 env 에 ${k} 가 살아 있다`)
    }
    // 자기 RED — 거르지 않으면 실제로 넘어간다(테스트가 결함 위에 서 있지 않음을 증명)
    assert.ok(dump({ ...DIRTY_ENV, Path: basePath }).includes('GH_TOKEN'), '대조군에서도 안 넘어가면 이 테스트는 아무것도 증명하지 못한다')
  })

  it('remoteUrlHasCredentials: user:pass@ 와 https 토큰 삽입은 잡고, SSH 사용자명은 자격증명이 아니다', () => {
    assert.equal(remoteUrlHasCredentials('https://x:ghp_AAAAAAAAAAAAAAAA@github.com/o/r.git'), true)
    assert.equal(remoteUrlHasCredentials('https://ghp_AAAAAAAAAAAAAAAA@github.com/o/r.git'), true)
    assert.equal(remoteUrlHasCredentials('http://u:p@internal/r.git'), true)
    assert.equal(remoteUrlHasCredentials('ssh://git@github.com/o/r.git'), false)
    assert.equal(remoteUrlHasCredentials('git@github.com:o/r.git'), false)
    assert.equal(remoteUrlHasCredentials('https://github.com/o/r.git'), false)
    assert.equal(remoteUrlHasCredentials('C:/repos/origin.git'), false)
    assert.equal(remoteUrlHasCredentials(''), false)
  })

  it('findCredentialRemotes: `git remote -v` 에서 원격 **이름만** 돌려준다(URL 값이 로그로 새지 않는다)', () => {
    const out = [
      'origin\tC:/tmp/origin.git (fetch)',
      'origin\tC:/tmp/origin.git (push)',
      'tokened\thttps://x:ghp_SECRETSECRET1234@github.com/o/r.git (fetch)',
      'tokened\thttps://x:ghp_SECRETSECRET1234@github.com/o/r.git (push)',
    ].join('\n')
    const names = findCredentialRemotes(out)
    assert.deepEqual(names, ['tokened'])
    assert.ok(!names.join(' ').includes('ghp_'), '원격 이름만 나와야 한다')
    assert.deepEqual(findCredentialRemotes(''), [])
  })
})

// ── M5 — 자유형 명령의 셸 문자열 제거 ───────────────────────────────────────────────────
describe('[M5] 자유형 명령은 실행파일+argv 로 정규화된다(셸 없음)', () => {
  it('tokenizeCommand: 공백 분리 · 따옴표 처리 · 빈 인자 보존 · 불균형 따옴표 거부', () => {
    assert.deepEqual(tokenizeCommand('npm run qa'), ['npm', 'run', 'qa'])
    assert.deepEqual(tokenizeCommand('node "C:/a b/x.mjs" --flag'), ['node', 'C:/a b/x.mjs', '--flag'])
    assert.deepEqual(tokenizeCommand("node 'x y'"), ['node', 'x y'])
    assert.deepEqual(tokenizeCommand('node ""'), ['node', ''], '빈 인자도 인자다')
    assert.deepEqual(tokenizeCommand('   '), [])
    assert.throws(() => tokenizeCommand('node "unclosed'), (e) => e.code === 'UNSAFE_ARGUMENT')
  })

  it('normalizeCommand: `npm run qa` 는 npm(.cmd) run qa argv 로 · 메타문자 명령은 실행 전에 거부', () => {
    const plan = normalizeCommand('npm run qa')
    assert.deepEqual(plan.argv, ['run', 'qa'])
    assert.match(plan.file, isWin ? /npm(\.cmd|\.bat|\.exe)$/i : /^npm$/)
    const METACHAR_CMDS = [
      'npm run qa & git push origin HEAD:main',
      'npm run qa && curl https://x',
      'npm run qa | tail -1',
      'npm run qa; rm -rf .',
      'node -e x > out.txt',
      'npm run %COMSPEC%',
      'npm run $(id)',
    ]
    for (const bad of METACHAR_CMDS) {
      assert.throws(() => normalizeCommand(bad), (e) => e.code === 'UNSAFE_ARGUMENT', `거부되지 않았다: ${bad}`)
    }
    assert.throws(() => normalizeCommand('   '), (e) => e.code === 'EMPTY_COMMAND')
  })

  it('정규화한 계획을 spawnSafe 로 돌리면 실제로 shell:false 이고 인자가 셸 해석 없이 그대로 간다', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'm5-'))
    t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* OS 정리 */ } })
    const script = join(dir, 'echo-argv.mjs')
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const plan = normalizeCommand(`node "${script}" "hello world" a=b`)
    let seenOpts = null
    spawnSafe(plan.file, plan.argv, { encoding: 'utf8' }, (f, a, o) => { seenOpts = o; return { status: 0, stdout: '' } })
    assert.equal(seenOpts.shell, false, 'shell 이 false 가 아니다')
    const real = spawnSafe(plan.file, plan.argv, { encoding: 'utf8' })
    assert.equal(real.status, 0, real.stderr)
    assert.deepEqual(JSON.parse(real.stdout), ['hello world', 'a=b'], '따옴표 인자가 쪼개지거나 셸이 확장했다')
  })

  it('notify-push.mjs 는 fetch 로 실제 전송한다(curl·셸 의존 0) — 로컬 HTTP 서버로 실측', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm5-notify-'))
    const bodyFile = join(dir, 'body.txt')
    writeFileSync(bodyFile, '[auto-batch] TEST\n본문 한글')
    const received = []
    const srv = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { received.push(Buffer.concat(chunks).toString('utf8')); res.writeHead(200); res.end('ok') })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${srv.address().port}/topic`
      // ⚠ spawnSync 는 이벤트 루프를 막아 **이 테스트의 서버가 accept 를 못 한다** — 비동기 spawn 으로 돈다.
      //   실행 계획(파일+argv·셸 경유 여부)은 planSpawn 으로 따로 확인한다.
      const plan = planSpawn(process.execPath, [join(here, 'notify-push.mjs'), url, bodyFile])
      assert.equal(plan.viaCmd, false, 'cmd.exe 를 거치지 않는다')
      assert.equal(plan.argv.length, 3, 'argv 분리(셸 문자열 결합 없음)')
      const child = spawn(plan.file, plan.argv, { shell: false })
      const code = await new Promise((r) => child.on('close', r))
      assert.equal(code, 0, '전송기가 실패했다')
      assert.deepEqual(received, ['[auto-batch] TEST\n본문 한글'], '한글 본문이 그대로 도착해야 한다')
    } finally {
      srv.close()
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* OS 정리 */ }
    }
  })
})

// ── M6 — 구현 파일 미열람 clean 거부 ────────────────────────────────────────────────────
describe('[M6] clean 리뷰는 변경 구현 파일을 최소 1개 읽은 증거를 요구한다', () => {
  const base = {
    json: { findings: [] },
    storyFile: '_bmad-output/implementation-artifacts/2-1-a.md',
    diffFile: '_bmad-output/implementation-artifacts/auto-pipeline-logs/2-1-a-review.diff',
    changedFiles: ['src/alpha.ts', 'src/bravo.ts', '_bmad-output/implementation-artifacts/2-1-a.md'],
  }
  const ev = (...cmds) => ({ commands: cmds.length, commandList: cmds, filePaths: [] })

  it('스토리·diff 는 읽었지만 구현 파일을 하나도 안 열었으면 clean 을 거부한다(ok:false)', () => {
    const r = validateReviewRun({ ...base, events: ev('cat 2-1-a.md', 'cat 2-1-a-review.diff') })
    assert.equal(r.ok, false, `경고로 통과했다: ${JSON.stringify(r)}`)
    assert.match(r.why, /변경 구현 파일/)
    assert.match(r.why, /2건 중 0건/)
  })

  it('구현 파일을 하나라도 열었으면 통과한다 — 위 거부가 그 조건 때문임을 증명(자기 RED)', () => {
    const r = validateReviewRun({ ...base, events: ev('cat 2-1-a.md', 'cat 2-1-a-review.diff', 'sed -n 1,40p src/bravo.ts') })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.warnings.length, 0)
  })

  it('변경 구현 파일이 스토리 문서뿐이면(구현 변경 0) 종전대로 story+diff 만으로 통과한다', () => {
    const r = validateReviewRun({
      ...base,
      changedFiles: ['_bmad-output/implementation-artifacts/2-1-a.md'],
      events: ev('cat 2-1-a.md', 'cat 2-1-a-review.diff'),
    })
    assert.equal(r.ok, true, r.why)
  })

  it('findings 가 있으면 이 조건은 걸리지 않는다(지적을 낸 리뷰는 열람한 것으로 본다)', () => {
    const r = validateReviewRun({ ...base, json: { findings: [{ severity: 'high' }] }, events: ev('pwd') })
    assert.equal(r.ok, true)
  })
})
