// providers/spawn-safe.mjs — 실행파일 + argv 분리 spawn (2026-09-02 하네스 하드닝 · codex-review-r1 #6)
//
// 왜 있나: 종전 어댑터들이 `${bin} ${args.join(' ')}` 로 **셸 문자열을 조립**해 `shell:true` 로 돌렸다.
// 저장소 안 큐/설정의 모델 값이 `opus & git push origin HEAD:main` 이면 cmd.exe 가 두 번째 명령을 실행하고,
// 반대로 공백이 든 `CODEX_BIN=C:\Program Files\...\codex.cmd` 는 정상 실행조차 되지 않았다.
//
// 정책(fail-closed):
//   ① 모든 실행은 `spawnSync(file, argv, { shell:false })` 다 — 셸 문자열 결합은 이 파일 밖에 존재하지 않는다.
//   ② Windows 의 npm `.cmd`/`.bat` 심은 CreateProcess 가 직접 못 돈다 → **전용 경로**: `cmd.exe /d /s /c "<line>"`.
//      line 은 여기서 직접 구현한 인용 규칙(quoteWindowsArg)으로 만든다. `/s` 규칙에 따라 바깥 따옴표 한 쌍은
//      cmd 가 벗겨 내고 나머지는 그대로 넘어간다.
//   ③ 그 전에 **실행파일·인자·모델·config 값이 허용 문자집합을 벗어나면 거부(throw)** 한다. 큰따옴표 안이라도
//      cmd 는 `%VAR%` 를 확장하므로 `%` 를 포함해 `&|;<>^%$\`"'` 등 메타문자는 전부 거부 대상이다.
//   ④ 거부는 예외다 — 실행 전에 던지므로 프로세스도, 부작용 파일도 생기지 않는다.
import { spawnSync } from 'node:child_process'

/** 경로용 — 공백·괄호(`Program Files (x86)`)·`~`(8.3 단축명) 허용. 메타문자는 전부 불허. */
export const SAFE_PATH_RE = /^[A-Za-z0-9._:/\\ ()~@+-]+$/
/** 일반 인자용 — 경로 문자집합 + `=`(`-c key=value`)·`,`. */
export const SAFE_ARG_RE = /^[A-Za-z0-9._:/\\ ()~@+=,-]+$/
/** 모델 스펙용 — 공백조차 없다(`codex:gpt-5.6-sol` · `us.anthropic.claude-opus-4-5`). */
export const SAFE_MODEL_RE = /^[A-Za-z0-9._:/@-]*$/
/** `-c key=value` config 용 — 키는 점 표기, 값은 경로/불리언/숫자. */
export const SAFE_CONFIG_RE = /^[A-Za-z0-9._-]+=[A-Za-z0-9._:/\\ ()~@+-]*$/

/** 거부 사유를 사람 말로 담은 예외 — 호출부가 code 로 분기한다. */
export class UnsafeArgumentError extends Error {
  constructor(label, value) {
    super(`[SPAWN-SAFE] 거부: ${label} 에 셸 메타문자 또는 허용되지 않은 문자가 있다 — ${JSON.stringify(String(value))}`)
    this.name = 'UnsafeArgumentError'
    this.code = 'UNSAFE_ARGUMENT'
    this.label = label
    this.value = String(value)
  }
}

/** 검증기 — 통과하면 값을 그대로 돌려주고, 아니면 throw. */
export function assertSafe(value, label, re = SAFE_ARG_RE) {
  const s = String(value ?? '')
  if (!re.test(s)) throw new UnsafeArgumentError(label, s)
  return s
}
export const assertSafePath = (v, label = '경로') => assertSafe(v, label, SAFE_PATH_RE)
export const assertSafeModel = (v, label = '모델') => assertSafe(v, label, SAFE_MODEL_RE)
export const assertSafeConfig = (v, label = 'config') => assertSafe(v, label, SAFE_CONFIG_RE)

/** cmd.exe `/s /c` 용 한 인자 인용 — MS C 런타임 규칙(백슬래시는 따옴표 앞에서만 이스케이프 대상). */
export function quoteWindowsArg(arg) {
  const s = String(arg)
  let out = '"'
  let slashes = 0
  for (const ch of s) {
    if (ch === '\\') { slashes++; out += ch; continue }
    if (ch === '"') { out += '\\'.repeat(slashes + 1) + '"'; slashes = 0; continue }
    slashes = 0
    out += ch
  }
  out += '\\'.repeat(slashes) + '"'
  return out
}

const isCmdShim = (file) => /\.(cmd|bat)$/i.test(String(file))

const isBareName = (file) => !String(file).includes('/') && !String(file).includes('\\')

/** 실행 계획(순수는 아니다 — bare `.cmd` 이름일 때만 PATH 조회 1회). { file, argv, verbatim, display }.
 *  display 는 로그용이며 실행에 쓰이지 않는다.
 *
 *  ⚠️ bare `.cmd`(`npm.cmd`)를 그대로 인용하면 안 된다: `cmd /s /c ""npm.cmd" …"` 는 따옴표 때문에 PATH 검색
 *  결과가 심 자신이 아닌 것으로 잡혀 심 안의 `%~dp0`(=자기 폴더)가 어긋난다 — npm 심처럼 `%~dp0` 로 옆 파일을
 *  찾는 배치는 그 자리에서 깨진다(2026-09-02 R3-N 실측). 그래서 **먼저 절대경로로 바꾼 뒤** 인용하고,
 *  못 찾으면 인용 없이 넘기지 않고 **실행 전에 던진다**(부작용 0). */
export function planSpawn(file, argv = [], { platform = process.platform, comspec = process.env.ComSpec || 'cmd.exe', exec = spawnSync, env = process.env } = {}) {
  let exe = assertSafePath(file, '실행파일')
  const args = argv.map((a, i) => assertSafe(a, `인자[${i}]`))
  if (platform === 'win32' && isCmdShim(exe) && isBareName(exe)) {
    const resolved = assertSafePath(resolveExecutable(exe, { platform, exec, env }), '실행파일')
    if (isBareName(resolved)) {
      throw Object.assign(new Error(
        `[SPAWN-SAFE] 실행파일을 PATH 에서 찾지 못했다 — ${JSON.stringify(exe)}. ` +
        'Windows 의 `.cmd` 심은 절대경로로 실행해야 심 안의 `%~dp0` 가 자기 폴더를 가리킨다. ' +
        '전체 경로를 주거나 PATH 를 고쳐라(인용만 한 채 넘기면 심이 조용히 깨진다).',
      ), { code: 'EXECUTABLE_NOT_FOUND', value: exe })
    }
    exe = resolved
  }
  const display = [exe, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  if (platform === 'win32' && isCmdShim(exe)) {
    // cmd /s /c "…" — 바깥 따옴표 한 쌍만 벗겨 내고 안쪽은 그대로. windowsVerbatimArguments 로 node 의 재인용을 막는다.
    const line = `"${[exe, ...args].map(quoteWindowsArg).join(' ')}"`
    return { file: comspec, argv: ['/d', '/s', '/c', line], verbatim: true, display, viaCmd: true }
  }
  return { file: exe, argv: args, verbatim: false, display, viaCmd: false }
}

// ── 자유형 명령 문자열 → 실행파일 + argv (2026-09-02 3차 리뷰 M5) ─────────────────────────
//
// 왜: qa(`npm run qa`) · 조건부 게이트 · 배치 e2e 는 사람이 설정에 적는 **한 줄 문자열**이라 종전에는
// `spawnSync(cmd, { shell:true })` 로 돌았다. 저장소 안 설정 한 줄이 `npm run qa & git push …` 이면
// 두 번째 명령이 그대로 돈다. 이제 여기서 **토큰으로 자른 뒤 argv 로만** 실행한다.
//
// 형식(문서 계약): `<실행파일> <인자>…` — 공백 구분 · `"` `'` 로 감싼 인자 허용 · 셸 연산자
// (`&&` `||` `;` `|` `>` `<` 백틱 `$` `%`)는 **거부**한다. 사슬이 필요하면 npm script 안에서 하라(그건 npm 의 셸이다).

/** 셸 인용 규칙만 흉내 낸 토크나이저(순수) — 따옴표 불균형은 거부. 이스케이프·변수 확장은 지원하지 않는다. */
export function tokenizeCommand(line) {
  const s = String(line ?? '')
  const out = []
  let cur = '', quote = null, started = false
  for (const ch of s) {
    if (quote) {
      if (ch === quote) { quote = null; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) { if (started) { out.push(cur); cur = ''; started = false } continue }
    cur += ch
    started = true
  }
  if (quote) throw new UnsafeArgumentError('명령(따옴표가 닫히지 않았다)', s)
  if (started) out.push(cur)
  return out
}

/** Windows 에서 **경로가 아닌 이름**을 실제 실행 이미지/심의 절대경로로 바꾼다 — CreateProcess 는 PATHEXT 를 모른다.
 *  확장자 없는 이름(`npm`)뿐 아니라 확장자가 붙은 bare 이름(`npm.cmd`)도 조회 대상이다: `.cmd` 심은 절대경로로
 *  실행해야 심 안의 `%~dp0` 가 자기 폴더를 가리킨다(planSpawn 주석 참조).
 *  못 찾으면 **입력을 그대로** 돌려준다(확장자가 없을 때만 종전대로 `.cmd` 를 붙인다) — 호출부가 실패를 판정한다. */
export function resolveExecutable(file, { platform = process.platform, exec = spawnSync, env = process.env } = {}) {
  const f = String(file ?? '')
  if (platform !== 'win32' || !f) return f
  if (f.includes('/') || f.includes('\\')) return f
  const hasExt = /\.[A-Za-z0-9]{1,4}$/.test(f)
  const r = exec('where', [f], { encoding: 'utf8', env, timeout: 15_000 })
  const lines = String(r?.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) ?? (hasExt ? f : `${f}.cmd`)
}

/**
 * 자유형 한 줄 → `{ file, argv, display }`. 셸 메타문자가 있으면 **실행 전에 throw**(부작용 0).
 * `spawnSafe(plan.file, plan.argv, …)` 로 그대로 넘길 수 있다.
 */
export function normalizeCommand(line, { platform = process.platform, exec = spawnSync, env = process.env } = {}) {
  const tokens = tokenizeCommand(line)
  if (!tokens.length) throw Object.assign(new Error('[SPAWN-SAFE] 빈 명령 — 실행할 것이 없다'), { code: 'EMPTY_COMMAND' })
  const [raw, ...rest] = tokens
  const file = assertSafePath(resolveExecutable(raw, { platform, exec, env }), '실행파일')
  rest.forEach((a, i) => assertSafe(a, `인자[${i}]`))
  return { file, argv: rest, display: [raw, ...rest].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') }
}

/** npm script 전용 경로 — `npm(.cmd) run <name>` argv 고정(스크립트 이름은 npm 이름 규칙으로 좁힌다). */
export function npmRunCommand(script, opts = {}) {
  const name = assertSafe(script, 'npm script', /^[A-Za-z0-9:._-]+$/)
  const file = assertSafePath(resolveExecutable('npm', opts), '실행파일')
  return { file, argv: ['run', name], display: `npm run ${name}` }
}

/** 실행 — `shell:false` 고정. 검증 실패는 spawn 전에 throw(부작용 0). */
export function spawnSafe(file, argv = [], options = {}, spawn = spawnSync) {
  if (!file) {
    throw Object.assign(new Error(
      '[SPAWN-SAFE] 실행파일이 비었다 — build*Command 는 이제 문자열이 아니라 `{ file, argv, display }` 를 돌려준다. ' +
      '호출부에서 `const { cmd } = build…()` 대신 반환값 전체를 `run*Worker({ cmd: built, … })` 로 넘겨라(로그는 `built.display`).',
    ), { code: 'MISSING_EXECUTABLE' })
  }
  // bare `.cmd` 이름의 PATH 조회는 **호출부가 준 env** 로 한다 — 워커마다 PATH 가 다르면 다른 심이 잡힌다.
  const plan = planSpawn(file, argv, { platform: options.platform ?? process.platform, env: options.env ?? process.env })
  const opts = { ...options, shell: false }
  delete opts.platform
  if (plan.verbatim) opts.windowsVerbatimArguments = true
  const res = spawn(plan.file, plan.argv, opts)
  return { ...res, plan }
}
