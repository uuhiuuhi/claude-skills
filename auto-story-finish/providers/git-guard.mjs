// providers/git-guard.mjs — 워커 프로세스의 git 상태 변경을 **실행 단계에서** 막는다 (codex-review-r1 #3)
//
// 왜 있나: 종전 가드는 실행 **전후** 의 HEAD·브랜치·stash 만 비교했다. `git push` 는 셋 중 아무것도 바꾸지
// 않고, `commit → reset` 처럼 원상복구하는 조작도 통과한다. 사후 비교로는 이미 나간 push 를 되돌릴 수 없다.
//
// 어떻게: 임시 shim 디렉터리를 만들어 **PATH 맨 앞**에 끼운다. 그 안의 `git` 은 첫 서브명령이 읽기 전용
// 허용 목록에 있을 때만 진짜 git(절대경로)에 넘기고, 그 밖(commit·push·stash push/pop/drop·reset·checkout·
// switch·restore·merge·rebase·cherry-pick·branch -d/-D/-m·tag -d·remote add/set-url·config --global 등)은
// **exit 86 + stderr `[GIT-GUARD] blocked: …`** 로 끊는다. 허용 목록 방식이라 새 파괴 명령이 생겨도 기본이 차단이다.
//
// 2차 방어(PATH 를 우회당해도 남는 것): env 에 `GIT_ALLOW_PROTOCOL=none` 을 심는다 — 진짜 git 이라도
// push/fetch/clone 이 `fatal: transport '…' not allowed` 로 죽는다(2026-09-02 실측 · file://·https 모두).
//
// 알려진 한계(설계상 수용 · 2026-09-02 실측):
//   - Windows 의 `git.cmd` shim 은 **셸을 거치는 호출**(cmd.exe · bash · 에이전트의 셸 도구)에서만 잡힌다.
//     CreateProcess 로 `git` 을 직접 spawn 하는 코드는 PATHEXT 를 거치지 않아 진짜 `git.exe` 로 갈 수 있다.
//   - Git for Windows 의 **래퍼** `Git\bin\sh.exe`·`Git\bin\bash.exe` 는 시작할 때 `/mingw64/bin:/usr/bin` 을
//     PATH 맨 앞에 끼워 넣어 shim 을 지나친다(진짜 `Git\usr\bin\sh.exe` 는 PATH 순서를 지킨다 — 실측 확인).
//   - 절대경로로 `C:\Program Files\Git\cmd\git.exe push` 를 직접 부르면 shim 을 우회한다.
//   위 세 우회 경로에서도 `GIT_ALLOW_PROTOCOL=none`(원격 차단) · **원격 자격증명 제거**(H3 ·
//   `stripRemoteCredentials`) · 종전의 사후 HEAD/브랜치/stash 가드 · Codex 샌드박스(review=read-only ·
//   dev=workspace-write 는 네트워크 기본 차단)가 남는다.
//   **잔여 = OS 샌드박스 부재**: 진짜 차단은 네트워크 없는 job/container 안에서 워커를 돌리는 것이다.
//   여기서는 「자격증명 제거 + 사후 탐지」로 **완화**할 뿐이다(3차 리뷰 H3 · 정직 기록).
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

/** 읽기 전용 허용 목록 — 두 낱말 항목(`stash list`)은 서브명령까지 본다. */
export const GIT_GUARD_ALLOW = Object.freeze([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep',
  'cat-file', 'describe', 'symbolic-ref', 'rev-list', 'shortlog', 'var', 'stash list', 'stash show',
])
/** 차단 시 종료 코드 — 일반 git 실패(1·128)와 구분되게 고른다. */
export const GIT_GUARD_EXIT = 86
export const GIT_GUARD_PREFIX = '[GIT-GUARD] blocked:'

/** 진짜 git 절대경로 — `where git`(win) / `which git`(posix). shim 디렉터리는 아직 PATH 에 없다. */
export function resolveRealGit({ platform = process.platform, env = process.env, exec = spawnSync } = {}) {
  const finder = platform === 'win32' ? 'where' : 'which'
  const r = exec(finder, ['git'], { encoding: 'utf8', env, timeout: 15_000 })
  const lines = String(r?.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) throw Object.assign(new Error('[GIT-GUARD] 진짜 git 을 PATH 에서 찾지 못했다 — 워커 git 차단을 걸 수 없다'), { code: 'GIT_NOT_FOUND' })
  // Windows 는 git.exe 를 고른다(.cmd/.bat 심이 아니라 실행 이미지여야 shim 에서 바로 부를 수 있다)
  return lines.find((l) => /\.exe$/i.test(l)) ?? lines[0]
}

const splitAllow = (allow) => ({
  singles: allow.filter((a) => !a.includes(' ')),
  pairs: allow.filter((a) => a.includes(' ')).map((a) => a.trim().split(/\s+/)),
})

/** Windows 배치 shim 본문(순수 · 테스트 가능) */
export function renderCmdShim(realGit, allow = GIT_GUARD_ALLOW) {
  const { singles, pairs } = splitAllow(allow)
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    `set "GITGUARD_REAL=${realGit}"`,
    ':gg_scan',
    'set "SUB=%~1"',
    'set "SUB2=%~2"',
    // cmd 는 `if cond a & b` 를 `(if cond a) & b` 로 파싱한다 — 조건부 묶음은 반드시 괄호로.
    'if /I "%SUB%"=="-C" ( shift & shift & goto gg_scan )',
    'if /I "%SUB%"=="--no-pager" ( shift & goto gg_scan )',
    'if /I "%SUB%"=="-P" ( shift & goto gg_scan )',
    'if /I "%SUB%"=="--literal-pathspecs" ( shift & goto gg_scan )',
    `for %%A in (${singles.join(' ')}) do if /I "%SUB%"=="%%A" goto gg_allow`,
    ...pairs.map(([a, b]) => `if /I "%SUB%"=="${a}" if /I "%SUB2%"=="${b}" goto gg_allow`),
    `>&2 echo ${GIT_GUARD_PREFIX} git %*`,
    `exit /b ${GIT_GUARD_EXIT}`,
    ':gg_allow',
    '"%GITGUARD_REAL%" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ]
  return lines.join('\r\n') // 배치 파일은 CRLF 여야 안전하다
}

/** POSIX sh shim 본문(순수 · 테스트 가능) */
export function renderShShim(realGit, allow = GIT_GUARD_ALLOW) {
  const { singles, pairs } = splitAllow(allow)
  const real = String(realGit).replace(/\\/g, '/')
  const lines = [
    '#!/bin/sh',
    `GITGUARD_REAL='${real}'`,
    'sub=""; sub2=""; skip=0',
    'for a in "$@"; do',
    '  if [ "$skip" = "1" ]; then skip=0; continue; fi',
    '  case "$a" in',
    '    -C) skip=1; continue ;;',
    '    --no-pager|-P|--literal-pathspecs) continue ;;',
    '  esac',
    '  if [ -z "$sub" ]; then sub="$a"; continue; fi',
    '  sub2="$a"; break',
    'done',
    'allowed=0',
    `for w in ${singles.join(' ')}; do`,
    '  if [ "$sub" = "$w" ]; then allowed=1; fi',
    'done',
    ...pairs.map(([a, b]) => `if [ "$sub" = "${a}" ] && [ "$sub2" = "${b}" ]; then allowed=1; fi`),
    'if [ "$allowed" != "1" ]; then',
    `  echo "${GIT_GUARD_PREFIX} git $*" >&2`,
    `  exit ${GIT_GUARD_EXIT}`,
    'fi',
    'exec "$GITGUARD_REAL" "$@"',
    '',
  ]
  return lines.join('\n')
}

/** PATH 키의 실제 표기(Windows 는 보통 `Path`)를 찾아 그대로 유지한다 — 중복 키는 혼란을 만든다. */
export function pathKeyOf(env) {
  return Object.keys(env ?? {}).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
}

// ── 원격 자격증명 제거 (2026-09-02 3차 리뷰 H3) ─────────────────────────────────────────
//
// 왜: 절대경로 `git.exe` 는 PATH shim 을 지나친다(설계상 수용된 한계). 그때 남은 방어가
// `GIT_ALLOW_PROTOCOL=none` 과 **사후 탐지**뿐이었는데, 사후 탐지는 이미 나간 push 를 되돌리지 못한다.
// 그래서 워커 환경에서 **원격에 인증할 수단 자체**를 없앤다 — 자격증명 헬퍼·askpass·SSH 에이전트·
// 토큰 환경변수·프록시. 인증할 수 없으면 프로토콜을 되살려도 push 가 credential 단계에서 죽는다.
//
// ⚠️ 잔여 위험(정직 기록): 이것은 **OS 샌드박스가 아니다**. 워커가 저장소 안에 있는 다른 자격증명을
//    직접 읽어 `-c http.extraHeader=…` 로 조립하는 경로까지는 막지 못한다. 완전한 차단은 네트워크가
//    끊긴 job/container 안에서 워커를 돌리는 것뿐이고, 여기서는 「자격증명 제거 + 사후 탐지」로 완화한다.

/** 통째로 지우는 키(정확 일치 · 대소문자 무시) — git 원격 인증에 쓰이는 수단 전부. */
export const REMOTE_AUTH_ENV_KEYS = Object.freeze([
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_CONFIG_DIR',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_PROXY_COMMAND', 'GIT_CREDENTIAL_HELPER',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY',
])
/** 이름만으로 지우는 꼴 — `*_TOKEN` · `*_SECRET` · `*_PASSWORD` · `*_API_KEY` · `*_CREDENTIALS`. */
export const REMOTE_AUTH_ENV_RE = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|(?:API|ACCESS|PRIVATE|SIGNING|SESSION|ROLE|ENCRYPTION)[_-]?KEY)$/i
/**
 * 지우면 **워커가 아예 못 도는** 제공자 자기 인증은 남긴다(정직 기록 — 이름 규칙상 위 정규식에 걸린다).
 * 이 값들은 git 원격 인증에 쓰이지 않는다(Anthropic·OpenAI API 전용).
 */
export const WORKER_AUTH_KEEP = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY',
])
const keepSet = new Set(WORKER_AUTH_KEEP.map((k) => k.toUpperCase()))
const stripSet = new Set(REMOTE_AUTH_ENV_KEYS.map((k) => k.toUpperCase()))
/** 한 키가 제거 대상인가(순수). */
export function isRemoteAuthEnvKey(key) {
  const k = String(key ?? '').toUpperCase()
  if (keepSet.has(k)) return false
  return stripSet.has(k) || REMOTE_AUTH_ENV_RE.test(k)
}

/** null 디바이스 경로 — SSH 키 지정을 「존재하지 않는 키 하나」로 못 박는 데 쓴다. */
const nullDevice = (platform) => (platform === 'win32' ? 'NUL' : '/dev/null')

/**
 * `-c key=value` 를 env 로 강제하는 `GIT_CONFIG_*` 3종 세트(순수).
 * `credential.helper=`(빈 값)는 헬퍼 **목록을 초기화**한다 — Windows 자격 증명 관리자·osxkeychain 이
 * 끼어들지 못한다. `core.askpass=`(빈 값)는 대화형 프롬프트 경로를, `credential.useHttpPath=false` 는
 * 경로별 자격증명 조회를 닫는다. `http.proxy=`·`https.proxy=` 로 프록시 우회도 함께 막는다.
 */
export function gitConfigOverrideEnv(pairs = [
  ['credential.helper', ''],
  ['core.askpass', ''],
  ['credential.useHttpPath', 'false'],
  ['http.proxy', ''],
  ['https.proxy', ''],
]) {
  const out = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v })
  return out
}

/**
 * 워커에게 넘길 env 에서 **원격 인증 수단을 전부 제거**하고 차단 값을 심는다(순수 · 새 객체).
 * @returns {{env:object, removed:string[]}} removed 는 지운 키 이름(값은 로그에 남기지 않는다)
 */
export function stripRemoteCredentials(baseEnv = {}, { platform = process.platform } = {}) {
  const env = {}
  const removed = []
  for (const [k, v] of Object.entries(baseEnv)) {
    if (isRemoteAuthEnvKey(k)) { removed.push(k); continue }
    env[k] = v
  }
  Object.assign(env, gitConfigOverrideEnv())
  // ssh 로 나가려 해도 **에이전트·기본 키·프롬프트가 전부 닫혀** 있다(BatchMode 는 물어보지 않고 즉시 실패).
  env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -i ${nullDevice(platform)}`
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ALLOW_PROTOCOL = 'none'
  return { env, removed }
}

// ── 원격 URL 에 박힌 자격증명 (H3) ────────────────────────────────────────────────────
/** `https://x:token@host` 처럼 URL 자체에 자격증명이 박혀 있으면 env 제거가 무의미하다(순수). */
export function remoteUrlHasCredentials(url) {
  const s = String(url ?? '').trim()
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/@\s]+)@/i.exec(s)
  if (!m) return false
  const scheme = m[1].toLowerCase()
  const userinfo = m[2]
  if (userinfo.includes(':')) return true // user:pass@ — 스킴을 가리지 않고 자격증명이다
  return scheme === 'http' || scheme === 'https' // https://<token>@host — 토큰 삽입 형태
}

/** `git remote -v` 출력에서 자격증명이 박힌 원격을 골라낸다(순수 · **URL 값은 돌려주지 않는다**). */
export function findCredentialRemotes(remoteVerbose) {
  const out = []
  for (const line of String(remoteVerbose ?? '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim())
    if (!m) continue
    if (remoteUrlHasCredentials(m[2]) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * shim 디렉터리를 만들고 PATH 를 합성한 env 를 돌려준다.
 * 반환 `{ dir, env, cleanup(), realGit, exitCode, blockedPrefix }`.
 * 워커 실행부(auto-story-pipeline)가 `spawn(..., { env: guard.env })` 로 배선하고 finally 에서 cleanup().
 */
export function createGitGuard({
  tmpRoot = tmpdir(),
  allow = GIT_GUARD_ALLOW,
  baseEnv = process.env,
  realGit = null,
  platform = process.platform,
} = {}) {
  const real = realGit ?? resolveRealGit({ platform, env: baseEnv })
  mkdirSync(tmpRoot, { recursive: true })
  const dir = mkdtempSync(join(tmpRoot, 'git-guard-'))
  writeFileSync(join(dir, 'git.cmd'), renderCmdShim(real, allow), 'utf8')
  const sh = join(dir, 'git')
  writeFileSync(sh, renderShShim(real, allow), 'utf8')
  try { chmodSync(sh, 0o755) } catch { /* Windows 는 모드가 의미 없다 */ }
  const key = pathKeyOf(baseEnv)
  const env = {
    ...baseEnv,
    [key]: `${dir}${delimiter}${baseEnv[key] ?? ''}`,
    // 2차 방어 — PATH 순서를 잃어도 **원격 통신 자체**를 막는다. Git for Windows 의 `Git\bin\bash.exe` 래퍼는
    // 시작할 때 `/mingw64/bin:/usr/bin` 을 PATH 앞에 끼워 넣어 shim 을 지나쳐 버린다(2026-09-02 실측).
    // `GIT_ALLOW_PROTOCOL=none` 이면 shim 을 우회한 진짜 git 도 push/fetch/clone 이 `transport not allowed` 로 죽는다(실측).
    GIT_ALLOW_PROTOCOL: 'none',
    GIT_TERMINAL_PROMPT: '0',
  }
  return {
    dir,
    env,
    realGit: real,
    exitCode: GIT_GUARD_EXIT,
    blockedPrefix: GIT_GUARD_PREFIX,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 이미 없음 */ } },
  }
}
