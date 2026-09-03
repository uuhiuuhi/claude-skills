// spawn-deadline.mjs — 벽시계 기준 **hard stop** 을 지키는 단일 spawn 헬퍼 (codex-review-r6 Medium)
//
// 무엇이 문제였나: `spawnSync(..., { timeout })` 는 **직접 자식**에게만 신호를 보낸다. Windows 에서
// `claude.cmd`·`npm.cmd` 심을 돌리면 실제 계산은 `cmd.exe` 의 **손자**(node)가 하고, 그 손자가
// 상속받은 stdout 파이프를 쥐고 있으면 `spawnSync` 는 파이프가 EOF 될 때까지 돌아오지 않는다.
// 즉 timeout 이 걸려도 마감 뒤까지 블록된다 — 「예산 deadline」이 종이 약속이 되는 자리다.
// (2026-09-03 codex-review-r6: 「Windows 프로세스 트리 hard stop 이 보장되지 않는다」)
//
// 어떻게 고쳤나:
//   ① 동기 `spawnSync` 대신 **비동기 `spawn` + 자기 타이머**를 쓴다.
//   ② 마감이 되면 **프로세스 트리 전체**를 끊는다 — win32 는 `taskkill /PID <pid> /T /F` **와**
//      PowerShell 재귀 스윕(고아 손자 · 2026-09-03 codex-review-r7 Medium)을 같이 던지고,
//      POSIX 는 `detached:true` 로 만든 프로세스 **그룹**에 `process.kill(-pid, 'SIGKILL')`.
//   ③ 파이프가 닫히기를 **기다리지 않고 즉시 반환**한다(그때까지 모은 stdout/stderr 는 유지).
//      손자가 파이프를 놓지 않아도 호출부는 마감 직후에 결과를 받는다.
//
// 반환값은 `spawnSync` 와 **같은 모양**이라 호출부 코드가 그대로 산다(다만 Promise 다):
//   { status, signal, stdout, stderr, error, timedOut, pid }
//   · timeout   → status:null · signal:'SIGTERM' · error.code:'ETIMEDOUT' · timedOut:true
//   · maxBuffer → status:null · signal:'SIGTERM' · error.code:'ENOBUFS'  · timedOut:false
//     (spawnSync 와 같은 조합이다 — 그래서 분류기가 「error + signal」을 timeout 으로 오독하면
//      ENOBUFS 가 `runner-timeout` 으로 둔갑한다. 분류 순서는 orchestrate.mjs 가 문다.)

import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** win32 재귀 스윕에 넣어도 되는 표식인지 — 셸/PS 로 재해석될 문자는 애초에 거부한다. */
const SAFE_TOKEN_RE = /^[A-Za-z0-9-]{0,64}$/

/** win32 PowerShell 실행 파일. `PATH` 에 기대지 않고 `SystemRoot` 절대경로를 먼저 쓴다. */
export function powershellBin(env = process.env) {
  const root = env?.SystemRoot || env?.windir
  return root ? `${String(root).replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

/**
 * win32 **고아 손자 스윕** 스크립트를 만든다(2026-09-03 codex-review-r7 Medium).
 *
 * 왜 `taskkill /T` 로 부족한가: `/T` 는 **살아 있는 부모**의 트리만 걷는다. wrapper(`cmd.exe`)가
 * 먼저 끝나 손자가 고아가 되면 트리가 끊겨 `/T` 가 그 손자를 못 찾는다 — 그런데 Windows 는
 * `Win32_Process.ParentProcessId` 에 **죽은 부모의 PID 를 그대로 남긴다**. 그래서 원래 wrapper PID 를
 * 뿌리로 ParentProcessId 를 **재귀 탐색**하면(손자의 손자까지) 고아도 전부 걸린다.
 *
 * PID 재사용 오탐 방지: `CreationDate` 가 **spawn 시각 −1초 이후**인 프로세스만 대상으로 한다.
 * 죽은 PID 를 OS 가 재활용해 무관한 프로세스가 그 PID 를 부모로 갖게 되는 창을 좁힌다.
 *
 * 표식(`AUTO_SPAWN_TOKEN`) 폴백: 재귀 결과가 0 건이면 `CommandLine` 에 표식이 있는 프로세스를
 * 마지막 그물로 쓴다. **한계** — WMI 는 프로세스 env 를 못 읽으므로, 표식이 argv 로도 흘러간
 * 경우에만 걸린다(우리는 자식 argv 를 바꾸지 않으므로 보통 0 건이다).
 */
export function windowsSweepScript(pid, sinceMs = 0, token = '') {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`sweep 뿌리 pid 가 정수가 아니다: ${pid}`)
  const n = Number(sinceMs)
  const since = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  const tok = SAFE_TOKEN_RE.test(String(token ?? '')) ? String(token ?? '') : ''
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$root=${pid}`,
    `$since=[DateTimeOffset]::FromUnixTimeMilliseconds([long]${since}).UtcDateTime`,
    '$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)',
    '$targets=New-Object System.Collections.Generic.HashSet[int]',
    '$frontier=@([int]$root)',
    'while($frontier.Count -gt 0){',
    '  $next=@()',
    '  foreach($parent in $frontier){',
    '    foreach($p in $all){',
    '      if($p.ParentProcessId -eq $parent -and $p.ProcessId -ne $parent -and $p.ProcessId -gt 4){',
    '        $born = if($null -eq $p.CreationDate){$true}else{$p.CreationDate.ToUniversalTime() -ge $since}',
    '        if($born -and $targets.Add([int]$p.ProcessId)){ $next+=[int]$p.ProcessId }',
    '      }',
    '    }',
    '  }',
    '  $frontier=$next',
    '}',
    `if($targets.Count -eq 0 -and '${tok}' -ne ''){`,
    `  foreach($p in $all){ if($p.CommandLine -and $p.CommandLine.Contains('${tok}') -and $p.ProcessId -ne $PID){ [void]$targets.Add([int]$p.ProcessId) } }`,
    '}',
    'foreach($id in $targets){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
    'Stop-Process -Id $root -Force -ErrorAction SilentlyContinue',
    '',
  ].join('\n')
}

/**
 * 자식이 남긴 것까지 포함해 **트리 전체**를 끊는다. 종료를 **기다리지 않는다** — 끊으라고
 * 시켰으면 true 다. 기다리면 안 되는 이유: win32 의 `taskkill` 은 실측 250ms 가 걸려
 * (2026-09-03), 「마감 즉시 반환」이라는 약속을 그 자리에서 깎아먹는다.
 *
 * win32 는 **두 그물을 같이 던진다**: ① `taskkill /T /F`(살아 있는 wrapper 트리 · 빠르다)
 * ② PowerShell 재귀 스윕(**고아가 된 손자** · wrapper 가 이미 죽어도 PID 로 찾는다).
 */
export function killTree(pid, {
  platform = process.platform,
  spawn = nodeSpawn,
  kill = process.kill,
  child = null,
  spawnedAt = 0,
  token = '',
  env = process.env,
} = {}) {
  const direct = () => { try { child?.kill('SIGKILL'); return true } catch { return false } }
  if (!Number.isInteger(pid) || pid <= 0) return direct()
  if (platform === 'win32') {
    let any = false
    // ① `/T` = 자손까지 · `/F` = 강제. cmd.exe 만 죽이면 손자 node 가 파이프를 계속 쥔다.
    // **비동기**로 띄운다 — 부모는 기다리지 않고, 순서상 taskkill 이 먼저 트리를 본다.
    try {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', detached: false })
      // unref 하지 않는다 — 250ms 짜리 taskkill 이 뜨기도 전에 프로세스가 끝나면 트리가 살아남는다.
      k.on('error', () => direct()) // taskkill 이 없거나 막혔을 때만 직접 종료로 내려간다
      any = true
    } catch { /* ② 로 내려간다 */ }
    // ② 고아 스윕. `-EncodedCommand`(UTF-16LE base64)라 따옴표·메타문자가 셸로 재해석될 자리가 없다.
    try {
      const since = Number(spawnedAt) > 0 ? Math.floor(Number(spawnedAt)) - 1000 : 0
      const b64 = Buffer.from(windowsSweepScript(pid, since, token), 'utf16le').toString('base64')
      const s = spawn(powershellBin(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], { windowsHide: true, stdio: 'ignore', detached: false })
      s.on('error', () => { if (!any) direct() }) // PowerShell 이 없으면 ① 이 이미 최선이다
      any = true
    } catch { /* 아래에서 직접 종료로 내려간다 */ }
    return any ? true : direct()
  }
  // POSIX — `detached:true` 로 띄웠으므로 자식이 **프로세스 그룹 리더**다. 음수 pid = 그룹 전체.
  // 고아 손자도 같은 그룹에 남아 있어 한 번에 끊긴다(그래서 POSIX 엔 스윕이 필요 없다).
  try { kill(-pid, 'SIGKILL'); return true } catch { /* 그룹이 없으면(이미 죽음) 직접 종료 */ }
  return direct()
}

const decode = (chunks, encoding) => {
  const buf = Buffer.concat(chunks)
  return encoding && encoding !== 'buffer' ? buf.toString(encoding) : buf
}

/**
 * `spawnSync` 자리를 그대로 대신하는 **비동기 + 트리 종료** 실행기.
 * @param {string} file 실행 파일(셸을 쓰지 않는다 — argv 는 배열로 분리해 넘긴다)
 * @param {string[]} args
 * @param {object} opts { input, encoding, cwd, env, timeout, maxBuffer, windowsHide, spawn, platform, killTree }
 * @returns {Promise<{status:number|null, signal:string|null, stdout:string|Buffer, stderr:string|Buffer, error:Error|null, timedOut:boolean, pid:number|null}>}
 */
export function spawnWithDeadline(file, args = [], opts = {}) {
  const {
    input = undefined,
    encoding = 'utf8',
    cwd = undefined,
    env = process.env,
    timeout = 0,
    maxBuffer = 8 * 1024 * 1024,
    windowsHide = true,
    spawn = nodeSpawn,
    platform = process.platform,
    killTree: killer = killTree,
  } = opts

  return new Promise((resolve) => {
    const out = []
    const err = []
    let outLen = 0
    let errLen = 0
    let settled = false
    let timer = null
    let exited = { status: null, signal: null }
    let child = null
    // 고아 스윕이 쓰는 두 값(codex-review-r7 Medium): spawn 시각(PID 재사용 오탐 차단) ·
    // 고유 표식(재귀 탐색이 0 건일 때의 마지막 그물 — argv 로 흘러간 경우에만 걸린다).
    const token = randomUUID()
    const spawnedAt = Date.now()

    const finish = (extra) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // 파이프를 놓지 않는 손자가 있어도 여기서 끊는다 — 이벤트 루프를 붙잡지 않게.
      try { child?.stdin?.destroy() } catch { /* 이미 닫힘 */ }
      try { child?.stdout?.destroy() } catch { /* 이미 닫힘 */ }
      try { child?.stderr?.destroy() } catch { /* 이미 닫힘 */ }
      try { child?.unref() } catch { /* 이미 정리됨 */ }
      resolve({
        status: null, signal: null, error: null, timedOut: false,
        pid: child?.pid ?? null,
        stdout: decode(out, encoding),
        stderr: decode(err, encoding),
        ...extra,
      })
    }

    try {
      child = spawn(file, args, {
        cwd, env: { ...env, AUTO_SPAWN_TOKEN: token }, windowsHide, shell: false,
        // POSIX 는 **프로세스 그룹**을 만들어 둬야 손자까지 한 번에 끊을 수 있다.
        detached: platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      // spawn 자체가 던지면 spawnSync 와 같은 모양(`error` 필드)으로 접는다.
      resolve({ status: null, signal: null, stdout: decode([], encoding), stderr: decode([], encoding), error: e, timedOut: false, pid: null })
      return
    }

    const overflow = (which) => {
      const e = new Error(`${which} maxBuffer length exceeded`)
      e.code = 'ENOBUFS'
      killer(child.pid, { platform, child, spawnedAt, token, env })
      // spawnSync 와 같은 조합으로 접는다 — error(ENOBUFS) + signal(SIGTERM).
      finish({ status: null, signal: 'SIGTERM', error: e, timedOut: false })
    }

    child.stdout?.on('data', (c) => {
      outLen += c.length
      if (outLen > maxBuffer) return overflow('stdout')
      out.push(c)
    })
    child.stderr?.on('data', (c) => {
      errLen += c.length
      if (errLen > maxBuffer) return overflow('stderr')
      err.push(c)
    })
    for (const s of [child.stdout, child.stderr]) s?.on('error', () => { /* 강제 종료 뒤의 파이프 오류는 결과가 아니다 */ })

    child.stdin?.on('error', () => { /* 자식이 stdin 을 안 읽고 죽으면 EPIPE — 결과가 아니다 */ })
    try {
      if (input !== undefined && input !== null) child.stdin?.end(input, typeof input === 'string' ? (encoding === 'buffer' ? 'utf8' : encoding) : undefined)
      else child.stdin?.end()
    } catch { /* 이미 닫힌 stdin */ }

    child.on('error', (e) => finish({ status: null, signal: null, error: e, timedOut: false }))
    child.on('exit', (code, signal) => { exited = { status: code, signal } })
    child.on('close', (code, signal) => finish({ status: code ?? exited.status, signal: signal ?? exited.signal, error: null, timedOut: false }))

    const ms = Number(timeout)
    if (Number.isFinite(ms) && ms > 0) {
      timer = setTimeout(() => {
        const e = new Error('spawn timeout')
        e.code = 'ETIMEDOUT'
        killer(child.pid, { platform, child, spawnedAt, token, env })
        // **기다리지 않는다** — 손자가 파이프를 쥐고 있어도 마감 직후 반환한다.
        finish({ status: null, signal: 'SIGTERM', error: e, timedOut: true })
      }, ms)
    }
  })
}
