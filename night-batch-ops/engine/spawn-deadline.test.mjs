// codex-review-r6 Medium — 프로세스 트리 hard stop (실제 프로세스로만 검증한다)
//
// 무는 것 셋:
//   ① `.cmd` 심 뒤에 숨은 **손자 node** 가 stdout 파이프를 30초 쥐고 있어도, 0.5초 마감이면
//      **1초 안에** 반환한다(예전 `spawnSync` 는 파이프 EOF 까지 = 30초 블록).
//   ② 그 손자 프로세스가 **실제로 죽는다**(pid 를 파일로 받아 `process.kill(pid,0)` 로 확인).
//   ③ `maxBuffer` 초과는 timeout 이 아니라 **ENOBUFS** 로 접힌다(분류 오독의 원인 제거).
//
// 스텁 함수를 주입하면 이 셋 중 어느 것도 보이지 않는다 — 그래서 전부 실제 spawn 이다.
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnWithDeadline, killTree, windowsSweepScript } from './spawn-deadline.mjs'

const temps = []
after(() => { for (const t of temps) { try { rmSync(t, { recursive: true, force: true }) } catch { /* 잠긴 파일은 OS 가 정리 */ } } })
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d }

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `.cmd`(win32) / `.sh`(POSIX) 심 → **손자** node 를 띄운다.
 * POSIX 는 `exec` 를 쓰지 않는다 — 써 버리면 sh 가 node 로 **치환**돼 손자가 사라지고,
 * 「트리 종료」를 검증할 대상 자체가 없어진다.
 */
function grandchildShim(dir, scriptBody) {
  const script = join(dir, 'holder.mjs')
  writeFileSync(script, scriptBody)
  if (process.platform === 'win32') {
    const p = join(dir, 'shim.cmd')
    writeFileSync(p, `@echo off\r\nnode "${script}" %*\r\n`)
    return p
  }
  const p = join(dir, 'shim.sh')
  writeFileSync(p, `#!/bin/sh\nnode "${script}" "$@"\n`)
  chmodSync(p, 0o755)
  return p
}

describe('spawnWithDeadline — 마감은 프로세스 트리 전체에 걸린다', () => {
  it('손자가 파이프를 30초 쥐고 있어도 0.5초 마감이면 1초 안에 반환하고 · 손자 pid 가 죽는다', async () => {
    const dir = tmp('sd-tree-')
    const pidFile = join(dir, 'grandchild.pid')
    // 손자: pid 를 남기고 한 줄 뱉은 뒤 **30초 동안 상속받은 stdout 을 쥔 채** 산다.
    const shim = grandchildShim(dir, [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      "process.stdout.write('시작\\n')",
      'setTimeout(() => process.exit(0), 30_000)',
      '',
    ].join('\n'))

    // 실사용 경로 그대로 — win32 는 `.cmd` 를 직접 못 돌리므로 `cmd.exe /d /s /c` 로 지난다
    // (makeClaudePlanRunner·npmInvocation 이 쓰는 바로 그 형태다). 그래서 손자가 생긴다.
    const [file, args] = process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', shim]]
      : [shim, []]

    const t0 = Date.now()
    const r = await spawnWithDeadline(file, args, { timeout: 500, encoding: 'utf8' })
    const spent = Date.now() - t0

    assert.equal(r.timedOut, true, `마감으로 접히지 않았다: ${JSON.stringify(r)}`)
    assert.equal(r.error?.code, 'ETIMEDOUT')
    assert.equal(r.status, null)
    assert.ok(spent < 1000, `${spent}ms 걸렸다 — 손자가 파이프를 쥐면 마감이 지켜지지 않는다(1초 계약)`)
    // 마감 전까지 모은 출력은 버리지 않는다
    assert.match(String(r.stdout), /시작/, `수집된 stdout 이 사라졌다: ${JSON.stringify(r.stdout)}`)

    // 손자가 실제로 떴는지 확인한 뒤(안 떴으면 이 시나리오가 성립하지 않는다) 죽었는지 본다
    assert.ok(existsSync(pidFile), '손자가 뜨지 않았다 — 이 시나리오가 성립하지 않는다')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(Number.isInteger(pid) && pid > 0, `손자 pid 를 읽지 못했다: ${pid}`)
    // taskkill/그룹 SIGKILL 은 비동기다 — 반환을 막지 않는 대신 잠깐 기다려 확인한다.
    for (let i = 0; i < 60 && alive(pid); i++) await wait(100)
    assert.equal(alive(pid), false, `손자 pid ${pid} 가 살아남았다 — cmd.exe 만 죽었다(트리 종료 실패)`)
  })

  it('wrapper 가 먼저 죽어 **고아가 된 손자**도 마감에 죽는다(재귀 스윕)', async () => {
    // 이게 원래 사고 모양이다(2026-09-03 codex-review-r7 Medium): wrapper(`cmd.exe`/`sh`)가 즉시
    // 끝나 손자가 고아가 되면 `taskkill /T` 는 그 트리를 **찾지 못한다** — 부모가 이미 없다.
    // 그래서 마감 뒤에도 손자가 30초를 마저 살았다. 「마감이면 트리가 hard-stop 된다」가
    // 성립하려면 ① 마감에 즉시 반환하고 ② 고아 손자까지 실제로 죽어야 한다. 둘 다 문다.
    const dir = tmp('sd-orphan-')
    const pidFile = join(dir, 'orphan.pid')
    const script = join(dir, 'orphan.mjs')
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      'setTimeout(() => process.exit(0), 30_000)',
      '',
    ].join('\n'))
    let file, args
    if (process.platform === 'win32') {
      const cmd = join(dir, 'detach.cmd')
      writeFileSync(cmd, `@echo off\r\nstart /b "" node "${script}"\r\n`) // cmd 는 즉시 끝난다
      file = process.env.ComSpec || 'cmd.exe'
      args = ['/d', '/s', '/c', cmd]
    } else {
      const sh = join(dir, 'detach.sh')
      writeFileSync(sh, `#!/bin/sh\nnode "${script}" &\n`) // sh 는 즉시 끝난다
      chmodSync(sh, 0o755)
      file = sh
      args = []
    }

    const t0 = Date.now()
    const r = await spawnWithDeadline(file, args, { timeout: 500, encoding: 'utf8' })
    const spent = Date.now() - t0
    assert.ok(spent < 1000, `${spent}ms 걸렸다 — 떨어져 나간 손자의 파이프를 기다렸다(마감이 종이 약속이 된 자리)`)
    assert.equal(r.timedOut, true, `마감으로 접히지 않았다: ${JSON.stringify(r)}`)

    // 손자가 실제로 떴는지 먼저 확인한다 — 안 떴으면 이 시나리오 자체가 성립하지 않는다.
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await wait(100)
    assert.ok(existsSync(pidFile), '고아 손자가 뜨지 않았다 — 이 시나리오가 성립하지 않는다')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(Number.isInteger(pid) && pid > 0, `고아 손자 pid 를 읽지 못했다: ${pid}`)
    // 스윕은 비동기다(PowerShell 기동 + CIM 조회). 반환을 막지 않는 대신 넉넉히 기다려 확인한다.
    for (let i = 0; i < 200 && alive(pid); i++) await wait(100)
    const survived = alive(pid)
    if (survived) { try { process.kill(pid) } catch { /* 이미 죽음 */ } } // 다음 테스트에 얹어 두지 않는다
    assert.equal(survived, false, `고아 손자 pid ${pid} 가 마감 뒤에도 살아남았다 — wrapper 가 먼저 죽으면 taskkill /T 가 트리를 못 찾는다(재귀 스윕이 있어야 한다)`)
  })

  it('정상 종료는 종전대로 status·stdout·stderr 를 그대로 준다(회귀 없음)', async () => {
    const dir = tmp('sd-ok-')
    const script = join(dir, 'ok.mjs')
    writeFileSync(script, "process.stdout.write('OUT'); process.stderr.write('ERR'); process.exit(3)\n")
    const r = await spawnWithDeadline(process.execPath, [script], { timeout: 30_000, encoding: 'utf8' })
    assert.equal(r.status, 3)
    assert.equal(r.timedOut, false)
    assert.equal(r.error, null)
    assert.equal(String(r.stdout), 'OUT')
    assert.equal(String(r.stderr), 'ERR')
  })

  it('stdin 으로 준 input 이 자식에게 실제로 들어간다', async () => {
    const dir = tmp('sd-in-')
    const script = join(dir, 'echo.mjs')
    writeFileSync(script, "import { readFileSync } from 'node:fs'\nprocess.stdout.write(readFileSync(0, 'utf8').toUpperCase())\n")
    const r = await spawnWithDeadline(process.execPath, [script], { input: '프롬프트-abc', timeout: 30_000, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match(String(r.stdout), /프롬프트-ABC/)
  })

  it('maxBuffer 초과는 timeout 이 아니라 ENOBUFS 다(진단 사유가 뒤바뀌면 안 된다)', async () => {
    const dir = tmp('sd-buf-')
    const script = join(dir, 'flood.mjs')
    // 4MB 를 뱉는다 — 64KB 상한을 확실히 넘긴다.
    writeFileSync(script, "const line = 'x'.repeat(64 * 1024) + '\\n'\nfor (let i = 0; i < 64; i++) process.stdout.write(line)\n")
    const r = await spawnWithDeadline(process.execPath, [script], { timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8' })
    assert.equal(r.error?.code, 'ENOBUFS', `ENOBUFS 가 아니다: ${r.error?.code} · ${JSON.stringify(r).slice(0, 200)}`)
    assert.equal(r.timedOut, false, 'ENOBUFS 를 timeout 으로 표시했다 — 운영자가 예산을 늘리며 헛발질한다')
    assert.equal(r.signal, 'SIGTERM', 'spawnSync 와 같은 조합(error + signal)이어야 분류기가 실제 상황을 본다')
  })

  it('없는 실행 파일은 던지지 않고 error 로 접힌다(spawnSync 와 같은 계약)', async () => {
    const r = await spawnWithDeadline(join(tmp('sd-none-'), 'no-such-binary-xyz'), [], { timeout: 5_000 })
    assert.ok(r.error, '없는 실행 파일인데 error 가 없다')
    assert.equal(r.timedOut, false)
    assert.equal(r.status, null)
  })
})

describe('killTree — 플랫폼별 종료 경로를 골라 쓴다', () => {
  it('win32 는 taskkill /T /F **와** 고아 재귀 스윕을 같이 던진다 · POSIX 는 프로세스 그룹 SIGKILL', () => {
    const seen = []
    const spawn = (file, args) => { seen.push([file, args]); return { on() {}, unref() {} } }
    assert.equal(killTree(1234, { platform: 'win32', spawn, spawnedAt: 1_700_000_000_000, token: 'abc-123' }), true)
    assert.equal(seen.length, 2, `win32 는 그물 둘을 던져야 한다(taskkill + 스윕): ${JSON.stringify(seen.map((x) => x[0]))}`)
    assert.deepEqual(seen[0], ['taskkill', ['/PID', '1234', '/T', '/F']])
    // ② 고아 스윕 — 인코딩된 명령이라 셸 메타문자가 재해석될 자리가 없다
    assert.match(seen[1][0], /powershell\.exe$/i, `PowerShell 스윕이 없다: ${seen[1][0]}`)
    const enc = seen[1][1]
    assert.ok(enc.includes('-NoProfile') && enc.includes('-NonInteractive'), '프로필·대화형이 스윕에 끼면 느려지거나 멈춘다')
    const script = Buffer.from(enc[enc.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
    assert.match(script, /ParentProcessId/, '재귀 탐색의 뿌리(ParentProcessId)가 없다 — 고아를 못 찾는다')
    assert.match(script, /while\(\$frontier\.Count/, '재귀(BFS) 없이 한 겹만 보면 손자의 손자가 남는다')
    assert.match(script, /CreationDate/, 'PID 재사용 오탐을 막는 생성시각 필터가 없다')
    assert.match(script, /Stop-Process/, '찾기만 하고 죽이지 않는다')
    // spawn 시각 −1초 이후로만 자른다(PID 재사용 창을 좁힌다)
    assert.match(script, /FromUnixTimeMilliseconds\(\[long\]1699999999000\)/, `생성시각 하한이 spawn−1s 가 아니다: ${script}`)

    const killed = []
    assert.equal(killTree(1234, { platform: 'linux', kill: (p, s2) => killed.push([p, s2]) }), true)
    assert.deepEqual(killed, [[-1234, 'SIGKILL']], 'POSIX 는 **그룹**(음수 pid)을 끊어야 손자가 같이 죽는다')
  })

  it('pid 가 없거나 종료 수단이 실패하면 자식 핸들로 직접 끊는다', () => {
    let direct = 0
    const child = { kill: () => { direct++ } }
    assert.equal(killTree(null, { platform: 'win32', child }), true)
    assert.equal(killTree(1234, { platform: 'linux', child, kill: () => { throw new Error('ESRCH') } }), true)
    assert.equal(direct, 2)
  })

  it('스윕 스크립트는 정수 pid 만 받고 · 표식은 안전 문자만 싣는다(셸/PS 재해석 차단)', () => {
    assert.throws(() => windowsSweepScript('1234; rm', 0), /정수/)
    assert.throws(() => windowsSweepScript(-1, 0), /정수/)
    // 위험한 표식은 통째로 버린다 — 스크립트에 실리지 않는다
    const dirty = windowsSweepScript(10, 0, "x'; Stop-Process -Id 4 #")
    assert.ok(!dirty.includes('Stop-Process -Id 4 #'), '표식이 스크립트로 주입됐다')
    assert.match(dirty, /'' -ne ''/, '위험한 표식은 빈 값으로 접혀야 한다')
  })
})
