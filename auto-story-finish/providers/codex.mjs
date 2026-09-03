// providers/codex.mjs — OpenAI Codex CLI 워커 어댑터 (2026-09-02 실측 기반 · codex-cli 0.152.1)
//
// 실측된 계약(추측 금지 — 바뀌면 여기와 SKILL 을 함께 고친다):
//   codex exec [OPTIONS] [PROMPT]   `-` = stdin 프롬프트 · -C <dir> 작업 루트 · -m <model> · -s <sandbox>
//   --json (JSONL 이벤트: thread.started · turn.started · item.started/completed{agent_message|command_execution|file_change}
//           · turn.completed{usage} · 실패 turn.failed / error) · -o <file>(마지막 메시지) · --output-schema <json>
//   --ephemeral(세션 미보존) · -c key=value(config 덮어쓰기) · **-a/--ask-for-approval 없음**(비대화형은 묻지 않는다)
//   샌드박스: read-only 는 파일 쓰기 불가 · workspace-write 는 -C 폴더 안 쓰기 가능 · 네트워크는
//   `-c sandbox_workspace_write.network_access=true` 로만 열린다(기본 닫힘 — 열면 push·외부 전송이 가능해지므로 옵트인).
//
// 역할별 샌드박스 규율:
//   review = read-only (코드 수정 0 · findings 는 JSON 으로 받아 **엔진이** 스토리 파일에 기재)
//   dev/repair = workspace-write (스토리 파일·코드 편집 — 커밋 금지는 프롬프트 + 엔진의 HEAD/브랜치/stash 가드가 막는다)
//
// 프라이버시 가드(👤 2026-08-29 설계 §2-1): Codex 는 **배치 워크트리에서만** 돈다. 본 트리에는 gitignore 된
// 고객 실데이터가 있어 외부 벤더로 나가면 안 된다. marker 파일 또는 linked worktree(.git 이 파일)일 때만 허용.
// 추가 방어(2026-09-02 적대 검토 F19): 실행 중 `.env*` 를 작업 루트 밖으로 잠시 치우고(복원 보장), 로그에 남는
// 명령 출력은 시크릿 패턴을 가린다 — 배치 워크트리에도 `.env.local`(실자격증명)이 복사돼 있기 때문이다.
// 동시 실행(F17/F28): 같은 auth.json 을 여러 프로세스가 동시에 쓰면 안 된다(OpenAI 문서) → 머신 전역 슬롯 잠금.
//
// 2026-09-02 하드닝(codex-review-r1): #6 셸 문자열 결합 제거(실행파일+argv 분리) · #2 슬롯을 고정 파일 `wx`
// 원자 선점으로 · #11 `.env` 격리·복원 fail-closed(중첩 디렉터리 포함) · #12 「미열람 clean」을 실제 열람 증거로
// 판정 · #8 마스킹 강화 + 민감 파일 diff 섹션 제거.
import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertSafeConfig, assertSafeModel, assertSafePath, spawnSafe } from './spawn-safe.mjs'

export const CODEX_MARKERS = Object.freeze(['.auto-batch-worktree', '.baroos-auto-worktree'])

/** cwd 허용 판정(순수) — marker · linked worktree · 명시 env 중 하나. */
export function codexCwdAllowed({ markerPresent = false, gitIsFile = false, envOverride = '' } = {}) {
  if (markerPresent) return { ok: true, why: 'marker' }
  if (gitIsFile) return { ok: true, why: 'linked worktree' }
  if (String(envOverride) === '1') return { ok: true, why: 'AUTO_CODEX_ALLOW_CWD=1(명시 허용 — 본 트리에 실데이터가 없음을 사람이 보증)' }
  return { ok: false, why: 'Codex 는 배치 워크트리(marker 또는 linked worktree)에서만 실행한다 — 본 트리의 gitignore 실데이터 반출 방지(AUTO_CODEX_ALLOW_CWD=1 로 명시 허용 가능)' }
}

/** 실측 재료를 모아 codexCwdAllowed 에 넣는다 */
export function inspectCwdForCodex(cwd, { markers = CODEX_MARKERS, env = process.env, extraMarker = '' } = {}) {
  const list = extraMarker ? [...markers, extraMarker] : [...markers]
  const markerPresent = list.some((m) => existsSync(join(cwd, m)))
  let gitIsFile = false
  try { gitIsFile = statSync(join(cwd, '.git')).isFile() } catch { /* .git 없음 */ }
  return codexCwdAllowed({ markerPresent, gitIsFile, envOverride: env.AUTO_CODEX_ALLOW_CWD ?? '' })
}

// ── 실패 분류(순수) — auth > spend > limit > other. 엔진의 classifyFailure 와 같은 순서 규율. ──
// 문구는 codex.exe 바이너리 실측(2026-09-02). "purchase more credits" 는 Plus 사용량 한도 안내에 섞여
// 나오므로 spend 로 보지 않는다(5시간 창이 지나면 풀리는 사용량 한도다). spend 는 조직 크레딧 소진뿐.
// "codex slot busy" 는 이 어댑터의 동시 실행 슬롯 대기 초과 — 한도 레인과 같은 처분(전환/대기)이 맞다.
export const CODEX_AUTH_RE = /(not logged in|re-run codex login|run codex login|login is required|login required|\b401\b|unauthorized|auth(entication)? (error|failed)|token.{0,20}expired|refresh token|auth tokens are missing)/i
export const CODEX_SPEND_RE = /(out of credits|workspace credit limit|credits? (are|is) depleted)/i
export const CODEX_LIMIT_RE = /(usage limit|rate.?limit|\b429\b|quota exceeded|too many requests|limit reached|reached your (usage|plan|weekly|daily)|codex slot busy)/i
export function classifyCodexFailure(out) {
  const s = String(out ?? '')
  if (CODEX_AUTH_RE.test(s)) return 'auth'
  if (CODEX_SPEND_RE.test(s)) return 'spend'
  if (CODEX_LIMIT_RE.test(s)) return 'limit'
  return 'other'
}

/** 분류에 넣을 텍스트 — 도구 출력(stdout JSONL) 속 401/429 가 오판을 만들지 않게 **오류 이벤트 + stderr** 를
 *  먼저 쓰고, 둘 다 비었을 때만 stdout 꼬리 4KB 로 보조한다(F21). */
export function codexFailureText(res) {
  const errors = (res?.events?.errors ?? []).join('\n')
  const stderr = String(res?.stderr ?? '')
  if (errors.trim() || stderr.trim()) return `${errors}\n${stderr}`
  return String(res?.stdout ?? '').slice(-4000)
}

/** JSONL 이벤트 파서(순수) — 마지막 agent_message · usage · 오류 · 명령/파일 변경 수.
 *  #12: **명령 문자열과 건드린 파일 경로도 보존**한다 — 「무엇을 읽었는지」를 봐야 미열람 clean 을 가려낼 수 있다.
 *  command_execution 은 item.started 에 command 가 실리고 item.completed 에는 없다(실측) → id 로 합친다. */
export function parseCodexEvents(text) {
  const out = { threadId: null, messages: [], lastMessage: '', usage: null, errors: [], failed: false, commands: 0, fileChanges: 0, parsed: 0, commandList: [], filePaths: [] }
  const cmdById = new Map()
  const addCmd = (it) => {
    const c = String(it.command ?? it.cmd ?? '').trim()
    if (!c) return
    const id = String(it.id ?? '')
    if (id && cmdById.has(id)) return
    if (id) cmdById.set(id, c)
    out.commandList.push(c)
  }
  const addPaths = (it) => {
    const cands = []
    if (it.path) cands.push(it.path)
    for (const c of Array.isArray(it.changes) ? it.changes : []) if (c?.path) cands.push(c.path)
    for (const p of cands) { const s = String(p).trim(); if (s && !out.filePaths.includes(s)) out.filePaths.push(s) }
  }
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    out.parsed++
    const type = ev.type
    const it = ev.item ?? {}
    if (type === 'thread.started') out.threadId = ev.thread_id ?? null
    else if (type === 'item.started') { if (it.type === 'command_execution') addCmd(it); else if (it.type === 'file_change') addPaths(it) }
    else if (type === 'item.completed') {
      if (it.type === 'agent_message') { out.messages.push(String(it.text ?? '')); out.lastMessage = String(it.text ?? '') }
      else if (it.type === 'command_execution') { out.commands++; addCmd(it) }
      else if (it.type === 'file_change') { out.fileChanges++; addPaths(it) }
    } else if (type === 'turn.completed') out.usage = ev.usage ?? null
    else if (type === 'turn.failed') { out.failed = true; out.errors.push(String(ev.error?.message ?? ev.message ?? JSON.stringify(ev))) }
    else if (type === 'error') out.errors.push(String(ev.message ?? ev.error?.message ?? JSON.stringify(ev)))
  }
  return out
}

/** 명령 — **실행파일과 argv 를 분리**한다(#6 · 셸 문자열 결합 없음). 역할이 샌드박스를 정한다.
 *  반환 `{ file, argv, display, sandbox }` — display 는 로그 전용. 네트워크는 기본 닫힘(옵트인).
 *  bin·cwd·model·config 가 허용 문자집합을 벗어나면 여기서 throw(부작용 0). */
export function buildCodexCommand({ bin = 'codex', role = 'review', cwd, model = '', schemaPath = null, outFile = null, networkAccess = false, ephemeral = true, skipGitCheck = false, extraConfig = [] } = {}) {
  const sandbox = role === 'review' ? 'read-only' : 'workspace-write'
  const file = assertSafePath(bin, 'CODEX_BIN')
  const argv = ['exec', '-C', assertSafePath(cwd, 'cwd'), '-s', sandbox, '--json']
  if (skipGitCheck) argv.push('--skip-git-repo-check')
  if (ephemeral) argv.push('--ephemeral')
  if (model) argv.push('-m', assertSafeModel(model, '모델'))
  if (sandbox === 'workspace-write' && networkAccess) argv.push('-c', 'sandbox_workspace_write.network_access=true')
  for (const c of extraConfig ?? []) argv.push('-c', assertSafeConfig(c, 'config'))
  if (schemaPath) argv.push('--output-schema', assertSafePath(schemaPath, 'schema 경로'))
  if (outFile) argv.push('-o', assertSafePath(outFile, '-o 경로'))
  argv.push('-')
  const display = [file, ...argv].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  return { file, argv, display, sandbox }
}

/** 실행 — 반환 계약은 claude 어댑터와 동일 + events/lastMessage. -o 파일은 실행 전에 지운다(낡은 JSON 재사용 방지 · F25).
 *  `cmd` 에 buildCodexCommand 의 반환값을 통째로 넘겨도 되고 file/argv 를 직접 줘도 된다. `env` = git-guard PATH 배선용. */
export function runCodexWorker({ cmd = null, file = null, argv = null, prompt, timeoutMs, outFile = null, env = undefined, spawn = spawnSync }) {
  if (outFile) { try { unlinkSync(outFile) } catch { /* 없음 */ } }
  const f = file ?? cmd?.file
  const a = argv ?? cmd?.argv ?? []
  const res = spawnSafe(f, a, { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, ...(env ? { env } : {}) }, spawn)
  const stdout = res.stdout || ''
  const events = parseCodexEvents(stdout)
  let lastMessage = events.lastMessage
  if (outFile && existsSync(outFile)) { try { lastMessage = readFileSync(outFile, 'utf8') } catch { /* 이벤트의 마지막 메시지로 대체 */ } }
  return {
    provider: 'codex',
    code: res.status ?? 1,
    stdout,
    stderr: res.stderr || '',
    timedOut: Boolean(res.error && res.error.code === 'ETIMEDOUT'),
    events,
    lastMessage,
  }
}

// ── 시크릿 가리기 — **공용 마스커 재수출** (2026-09-02 3차 리뷰 H1) ──
// 규칙 본체는 `providers/redact.mjs` 하나로 옮겼다. 진단(diagnose.mjs)·보고서(report.mjs)가 자기 사본을
// 만들어 R2 에서 이미 고친 세 형식을 다시 흘렸기 때문이다(마스커가 둘이면 하나는 반드시 뒤처진다).
// 여기서는 **재수출만** 한다 — 기존 `from './providers/codex.mjs'` import 경로를 깨지 않기 위해서다.
export { REDACTED, deepRedact, isSecretFieldName, redactSecrets } from './redact.mjs'

/** 민감 파일 경로 판정 — diff 본문·파일 목록 양쪽에서 같은 기준을 쓴다(#1·#8).
 *  `*secret*`·`*credential*` 은 **자료 파일 확장자일 때만** 잡는다 — `src/lib/secretScanner.ts` 같은 소스까지
 *  들어내면 리뷰가 조용히 눈을 잃는다(과잉 제외도 결함이다). `.env.example` 은 값이 없는 견본이라 제외 대상이 아니다. */
export const SENSITIVE_PATH_RE = new RegExp([
  '(^|/)\\.env(\\.(?!example$).*)?$',
  '\\.(pem|key|p12|pfx|keystore|jks|asc|gpg)$',
  '(^|/)id_(rsa|dsa|ecdsa|ed25519)([^/]*)$',
  '(^|/)auth\\.json$',
  '(^|/)service-account[^/]*\\.json$',
  '(^|/)[^/]*secrets?\\.(json|ya?ml|txt|ini|conf|cfg|properties|xml)$',
  '(^|/)[^/]*(secret|credential)[^/]*\\.(json|ya?ml|txt|ini|conf|cfg|properties|xml|env)$',
  '(^|/)[^/]*\\.local\\.[^/]+$',
].join('|'), 'i')
export const isSensitivePath = (p) => SENSITIVE_PATH_RE.test(String(p ?? '').replace(/\\/g, '/'))

/** unified diff 를 **파일 단위로** 걸러 낸다 — 민감 파일 섹션은 본문째 들어내고 표식만 남긴다.
 *  `git diff HEAD` 본문에는 pathspec 제외가 적용되지 않아, 실수로 추적된 `.env.production` 이 그대로 실렸다(#1). */
export function stripSensitiveFileSections(diff, sensitive = isSensitivePath) {
  const text = String(diff ?? '')
  if (!text) return text
  const unwrap = (s) => s.replace(/^"|"$/g, '').replace(/^[ab]\//, '')
  const out = []
  let drop = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length)
      const i = rest.lastIndexOf(' b/')
      const j = rest.lastIndexOf(' "b/')
      const cut = Math.max(i, j)
      const a = unwrap(cut >= 0 ? rest.slice(0, cut) : rest)
      const b = unwrap(cut >= 0 ? rest.slice(cut + 1) : rest)
      drop = sensitive(a) || sensitive(b)
      out.push(drop ? `[민감 파일 diff 제외: ${b || a}]` : line)
      continue
    }
    if (drop) continue
    out.push(line)
  }
  return out.join('\n')
}

// ── 민감 파일 임시 격리 — Codex 실행 동안 작업 루트 밖으로 옮겼다가 반드시 복원한다 ──
//
// 정책(👤 2026-09-02 필수 결정 3 · 리뷰 #11 · 2차 리뷰 N4·N5) — **fail-closed**:
//   · 대상 = 작업 루트와 **모든 하위 디렉터리**의 `isSensitivePath` 파일(`.env*` · pem/key/p12 · id_rsa ·
//     auth.json · service-account*.json · *secret*/*credential* 자료 파일 · `*.local.*`). 깊이 제한 없음.
//     `node_modules`·`.git`·`.venv`·`dist`·`build`·`.next` 는 탐색에서 제외한다.
//     `.env.example` 은 값이 없는 견본이라 제외한다(종전과 같음).
//   · 탐색 중 `readdir` 이 한 건이라도 실패하면 → `ENV_ISOLATION_FAILED`(못 본 곳을 「없다」로 세지 않는다).
//   · 하나라도 격리(rename)에 실패하면 → 이미 옮긴 것을 **되돌린 뒤** `ENV_ISOLATION_FAILED` 로 throw.
//     Codex 는 실행되지 않는다(옮기지 못한 `.env` 를 벤더가 읽을 수 있는 상태로 두지 않는다).
//   · 복원에 실패하거나 **같은 이름의 새 파일이 생겨 충돌**하면 → `ENV_RESTORE_FAILED` 로 throw.
//     원본은 holdDir 에 남는다(덮어쓰지 않는다 — 자격증명 원본을 잃는 것이 더 큰 사고다).
export const ENV_SCAN_SKIP_DIRS = Object.freeze(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.turbo', 'coverage'])

export function envFilesToHide(names) {
  return (names ?? []).filter((n) => /^\.env(\..+)?$/.test(n) && n !== '.env.example')
}

const failed = (code, msg, extra = {}) => Object.assign(new Error(msg), { code, ...extra })

/** 작업 루트 기준 상대경로(슬래시 표기) 목록 — **깊이 제한 없음** · 제외 디렉터리 밖 전체.
 *
 *  2026-09-02 2차 리뷰 N4·N5·정책 3:
 *   · 대상이 `.env*` 만이 아니라 **isSensitivePath 에 걸리는 모든 파일**이다(pem·key·p12·id_rsa·auth.json·
 *     service-account*.json · *secret* · *credential* 자료 파일 · `*.local.*`). diff 에서 뺀 파일을 Codex 가
 *     작업 디렉터리에서 그냥 `cat` 하면 아무 의미가 없다(N4).
 *   · 깊이 4 제한을 없앤다 — `packages/a/services/api/config/.env.production` 이 그대로 남았다(N5).
 *   · `readdir` 실패를 **빈 디렉터리처럼 삼키지 않는다** — 한 건이라도 실패하면 `ENV_ISOLATION_FAILED`
 *     로 던져 Codex 실행 자체를 막는다(fail-open 금지 · 정책 3).
 *   · `git ls-files -co --exclude-standard` 를 **병행**해 walk 가 놓친 것(심볼릭 링크 등)을 보탠다 —
 *     git 이 없거나 저장소가 아니면 조용히 건너뛴다(walk 가 정본이라 이쪽 실패는 치명적이지 않다).
 */
export function collectSensitiveFiles(cwd, { skipDirs = ENV_SCAN_SKIP_DIRS, sensitive = isSensitivePath, readdir = readdirSync, git = spawnSync } = {}) {
  const found = new Set()
  const errors = []
  const walk = (absDir, relDir) => {
    let entries = []
    try { entries = readdir(absDir, { withFileTypes: true }) } catch (e) { errors.push(`${relDir || '.'}: ${e?.code ?? e?.message}`); return }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) { if (!skipDirs.includes(e.name)) walk(join(absDir, e.name), rel) }
      else if (sensitive(rel)) found.add(rel)
    }
  }
  walk(cwd, '')
  if (errors.length) {
    throw failed('ENV_ISOLATION_FAILED',
      `[민감 파일 탐색 실패] ${errors.length}개 디렉터리를 읽지 못했다(${errors.slice(0, 5).join(' · ')}) — 못 본 곳에 자격증명이 남아 있을 수 있어 Codex 실행을 중단한다.`,
      { errors })
  }
  try {
    const r = git('git', ['ls-files', '-co', '--exclude-standard'], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 })
    if ((r?.status ?? 1) === 0) {
      for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
        const rel = line.trim().replace(/^"|"$/g, '')
        if (!rel || found.has(rel)) continue
        if (rel.split('/').some((seg) => skipDirs.includes(seg))) continue
        if (!sensitive(rel)) continue
        try { if (statSync(join(cwd, ...rel.split('/'))).isFile()) found.add(rel) } catch { /* 목록에만 있고 실물이 없다 */ }
      }
    }
  } catch { /* git 부재·비저장소 — walk 가 정본이다 */ }
  return [...found].sort()
}

/** 하위 호환 별칭 — 종전 이름(`.env` 전용 시절)을 쓰는 호출부를 깨지 않는다. */
export const collectEnvFiles = collectSensitiveFiles

export function hideSensitiveFiles(cwd, { holdRoot = join(tmpdir(), 'auto-story-codex-env-hold'), files = null } = {}) {
  const names = files ?? collectSensitiveFiles(cwd)
  if (names.length === 0) return { moved: [], holdDir: null }
  const holdDir = join(holdRoot, `${process.pid}-${Date.now()}`)
  mkdirSync(holdDir, { recursive: true })
  const moved = []
  for (const n of names) {
    const dest = join(holdDir, ...n.split('/'))
    try {
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(join(cwd, ...n.split('/')), dest)
      moved.push(n)
    } catch (e) {
      // fail-closed — 여기서 멈춘다. 이미 옮긴 것은 되돌리고 던진다.
      const rollbackErrors = []
      for (const m of moved) {
        try { renameSync(join(holdDir, ...m.split('/')), join(cwd, ...m.split('/'))) } catch (r) { rollbackErrors.push(`${m}: ${r?.code ?? r?.message}`) }
      }
      if (!rollbackErrors.length) { try { rmSync(holdDir, { recursive: true, force: true }) } catch { /* 남아도 무해 */ } }
      throw failed('ENV_ISOLATION_FAILED',
        `[민감 파일 격리 실패] ${n} 를 작업 루트 밖으로 옮기지 못했다(${e?.code ?? e?.message}) — Codex 실행을 중단한다.` +
        (rollbackErrors.length ? ` ⚠ 되돌리기도 실패: ${rollbackErrors.join(' · ')} (보관 폴더 ${holdDir})` : ''),
        { file: n, holdDir, moved, rollbackErrors })
    }
  }
  return { moved, holdDir }
}

/** 하위 호환 별칭 — 종전 이름. */
export const hideEnvFiles = hideSensitiveFiles

export function restoreEnvFiles(cwd, { moved = [], holdDir = null } = {}) {
  const restored = []
  const errors = []
  for (const n of moved) {
    const src = join(holdDir, ...n.split('/'))
    const dst = join(cwd, ...n.split('/'))
    if (existsSync(dst)) { errors.push(`${n}: 같은 이름의 새 파일이 생겨 복원 충돌(원본은 보관 폴더에 그대로 둔다)`); continue }
    try { mkdirSync(dirname(dst), { recursive: true }); renameSync(src, dst); restored.push(n) } catch (e) { errors.push(`${n}: ${e?.code ?? e?.message}`) }
  }
  if (errors.length) {
    throw failed('ENV_RESTORE_FAILED',
      `[민감 파일 복원 실패] ${errors.length}/${moved.length}건 — 원본은 보관 폴더에 있다: ${holdDir} · ${errors.join(' · ')}`,
      { holdDir, restored, errors })
  }
  if (holdDir) { try { rmSync(holdDir, { recursive: true, force: true }) } catch { /* 남아도 무해 */ } }
  return restored
}
/** 하위 호환 별칭 — 이름만 일반화했다. */
export const restoreSensitiveFiles = restoreEnvFiles

// ── 머신 전역 동시 실행 슬롯 — 같은 auth.json 을 여러 프로세스가 동시에 쓰지 않는다 ──
export const CODEX_SLOT_STALE_MS = 3 * 60 * 60 * 1000 // 심박 없이 3시간 = 죽은 슬롯(스테이지 타임아웃 기본 2h 보다 길다)
// `openSync(path,'wx')` 로 파일이 생긴 순간과 내용(pid·hb)이 기록되는 순간 사이에는 아주 짧은 틈이 있다.
// 그 틈에 다른 프로세스가 lock 을 읽으면 **빈 파일**을 보고 「손상 = stale」로 오판해 회수해 버린다 —
// 2026-09-02 배리어 동시 테스트에서 실제로 두 프로세스가 같은 슬롯 0 을 쥐었다. 그래서 내용이 없는 lock 은
// 이 유예 시간 안에서는 「기록 중(살아 있음)」으로 본다.
export const CODEX_SLOT_WRITE_GRACE_MS = 10_000

// 획득 규율(👤 2026-09-02 필수 결정 4 · 리뷰 #2) — **고정 슬롯 파일을 `wx` 로 원자 선점**한다.
// 종전에는 「디렉터리를 읽어 빈자리를 세고 → 고유 이름의 lock 을 만드는」 check-then-create 였다. 두 러너가
// 동시에 빈 디렉터리를 읽으면 둘 다 free=1 을 얻고 둘 다 성공했다(max=1 인데 codex 두 개 · 같은 auth.json).
// 이제 `codex-slot-0.lock … codex-slot-<max-1>.lock` 을 순서대로 `openSync(path,'wx')` 로 열어 **성공한 하나만**
// 소유한다. `wx` 는 OS 수준의 원자적 배타 생성이라 경쟁이 성립하지 않는다.
export function defaultCodexLockDir() { return join(homedir(), '.claude-auto', 'locks') }
export const slotPath = (dir, i) => join(dir, `codex-slot-${i}.lock`)

/** 죽은 슬롯 판정(순수) — pid 가 없거나(ESRCH) 심박이 staleMs 를 넘겼으면 stale. */
export function isSlotStale({ pid = null, hb = null, staleMs = CODEX_SLOT_STALE_MS, now = Date.now(), killProbe = null } = {}) {
  const probe = killProbe ?? ((p) => { try { process.kill(p, 0); return true } catch (e) { return e?.code === 'ESRCH' ? false : 'unknown' } })
  if (pid) { const alive = probe(pid); if (alive === false) return true; if (alive === true) return false }
  const t = Date.parse(hb ?? '') || 0
  return !t || now - t > staleMs
}

/** stale 슬롯을 **rename 으로 원자적으로** 치운다 — 여러 프로세스가 동시에 시도해도 하나만 성공한다. */
function evictStaleSlot(path) {
  const away = `${path}.stale-${process.pid}-${Date.now()}`
  try { renameSync(path, away) } catch { return false } // 다른 프로세스가 먼저 치웠거나 살아 있다
  try { unlinkSync(away) } catch { /* 남아도 무해 */ }
  return true
}

/** 슬롯 하나를 원자 선점한다. 성공하면 `{ index, path }`, 전부 차 있으면 null. */
export function acquireCodexSlot({ dir = defaultCodexLockDir(), max = 1, staleMs = CODEX_SLOT_STALE_MS } = {}) {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < max; i++) {
    const path = slotPath(dir, i)
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd = null
      try { fd = openSync(path, 'wx') } catch (e) {
        if (e?.code !== 'EEXIST') break
        // 이미 누가 쥐고 있다 — 죽은 슬롯이면 치우고 이 인덱스를 한 번만 재시도한다.
        let parsed = null
        try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { /* 손상 또는 기록 중 */ }
        if (!parsed) {
          let ageMs = Infinity
          try { ageMs = Date.now() - statSync(path).mtimeMs } catch { /* 그 사이 사라짐 */ }
          if (ageMs < CODEX_SLOT_WRITE_GRACE_MS) break // 방금 생긴 빈 lock = 다른 프로세스가 기록 중이다
        }
        if (attempt === 0 && isSlotStale({ pid: parsed?.pid ?? null, hb: parsed?.hb ?? parsed?.at ?? null, staleMs }) && evictStaleSlot(path)) continue
        break
      }
      try { writeSync(fd, JSON.stringify({ pid: process.pid, slot: i, at: new Date().toISOString(), hb: new Date().toISOString() })) } finally { closeSync(fd) }
      return { index: i, path }
    }
  }
  return null
}

export function releaseCodexSlot(slot) {
  if (!slot?.path) return
  try { unlinkSync(slot.path) } catch { /* 이미 없음 */ }
}

// ── 슬롯 심박(N9) ────────────────────────────────────────────────────────────────────────
// 종전 lock 에는 **획득 시각만** 있었다. `process.kill(pid,0)` 이 EPERM 등으로 「unknown」인 환경에서는
// 오직 hb 만이 생존 근거인데, 그 값이 영원히 고정이라 3시간짜리 stage 하나가 도는 동안 다른 러너가
// 「죽었다」고 판정해 회수할 수 있었다(= 같은 auth.json 을 codex 두 개가 동시에 쓴다).
// 엔진은 `spawnSync` 로 워커를 기다리며 **이벤트 루프를 막고** 있어 타이머가 돌지 않는다 → 심박은
// **별도 자식 프로세스**가 찍는다. 기록은 tmp→rename 원자 교체라 읽는 쪽이 반쪽 파일을 보지 않는다.
export const CODEX_SLOT_HB_MS = 60_000
const HB_CHILD_SRC = `
const { readFileSync, writeFileSync, renameSync, unlinkSync } = require('fs')
const p = process.env.HB_PATH, owner = String(process.env.HB_PID), ms = Number(process.env.HB_MS || 60000)
setInterval(() => {
  let j
  try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { process.exit(0) }
  if (String(j.pid) !== owner) process.exit(0)
  j.hb = new Date().toISOString()
  const t = p + '.hb-' + process.pid
  try { writeFileSync(t, JSON.stringify(j)); renameSync(t, p) } catch { try { unlinkSync(t) } catch {} }
}, ms)
`
/** 슬롯 lock 의 `hb` 를 주기 갱신하는 자식을 띄운다. 반환 `{ stop() }`(idempotent). */
export function startSlotHeartbeat(slot, { intervalMs = CODEX_SLOT_HB_MS, spawn = spawnChild } = {}) {
  if (!slot?.path || !(intervalMs > 0)) return { stop() {}, child: null }
  let child = null
  try {
    child = spawn(process.execPath, ['-e', HB_CHILD_SRC], {
      env: { ...process.env, HB_PATH: slot.path, HB_PID: String(process.pid), HB_MS: String(intervalMs) },
      stdio: 'ignore', windowsHide: true,
    })
    child.unref?.()
  } catch { child = null }
  let stopped = false
  return {
    child,
    stop() { if (stopped) return; stopped = true; try { child?.kill() } catch { /* 이미 끝났다 */ } },
  }
}

/** stale 판정 기준 — 고정 3시간과 「stage 타임아웃 × 1.5」 중 큰 값(긴 stage 를 도는 슬롯을 뺏지 않는다). */
export const slotStaleMsFor = (stageTimeoutMs = 0) => Math.max(CODEX_SLOT_STALE_MS, Math.round((Number(stageTimeoutMs) || 0) * 1.5))

/** 슬롯을 잡고 fn 을 실행한다. 대기 초과면 `codex slot busy` 실패(한도 레인 처분)를 돌려준다. */
export function withCodexSlot({ dir = defaultCodexLockDir(), max = 1, waitMs = 60 * 60 * 1000, pollMs = 15_000, staleMs = null, hbMs = CODEX_SLOT_HB_MS, note = () => {} } = {}, fn) {
  staleMs ??= slotStaleMsFor(waitMs) // waitMs = stage 타임아웃 — 심박 없이 그보다 오래 조용하면 죽은 것이다
  const deadline = Date.now() + waitMs
  let waited = false
  let slot = null
  for (;;) {
    slot = acquireCodexSlot({ dir, max, staleMs })
    if (slot) break
    if (Date.now() >= deadline) {
      note(`[CODEX][SLOT] 동시 실행 슬롯(${max}) 대기 초과 — 다른 프로바이더 전환/다음 슬롯으로 넘긴다`)
      return { provider: 'codex', code: 1, stdout: '', stderr: 'codex slot busy — concurrent codex workers reached max', timedOut: false, events: parseCodexEvents(''), lastMessage: '' }
    }
    if (!waited) { note(`[CODEX][SLOT] 다른 codex 워커 실행 중(슬롯 ${max}개 소진) — 최대 ${Math.round(waitMs / 60000)}분 대기`); waited = true }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
  const hb = startSlotHeartbeat(slot, { intervalMs: hbMs })
  try {
    return fn()
  } finally {
    hb.stop() // 먼저 심박을 끊고 나서 지운다 — 순서가 반대면 자식이 지워진 lock 을 되살릴 수 있다
    releaseCodexSlot(slot)
  }
}

/** 구조화 응답 파싱 — 스키마 강제(--output-schema)라 정상이면 JSON 하나다. 코드펜스 포함 변형은 벗겨 본다. */
export function parseReviewJson(text) {
  const s = String(text ?? '').trim()
  const tryParse = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' && Array.isArray(v.findings) ? v : null } catch { return null } }
  const direct = tryParse(s)
  if (direct) return direct
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fence) { const v = tryParse(fence[1].trim()); if (v) return v }
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) return tryParse(s.slice(a, b + 1))
  return null
}

// ── 리뷰 실행의 신뢰 판정 ─────────────────────────────────────────────────────────────
/** git 의 C-인용 경로(`"_bmad-output/…\355\214\214…md"`)를 UTF-8 원문으로 되돌린다(2026-09-02 R4).
 *  git 은 `core.quotePath` 기본값에서 비ASCII 경로를 이렇게 내보낸다 — 한글 스토리 파일명이 그대로다.
 *  그러면 `changedFiles`(git 출력)와 `storyFile`(엔진이 만든 UTF-8 경로)이 문자열로 어긋나, 스토리 파일이
 *  「변경 구현 파일」로 남아 열람 판정이 통째로 빗나간다. `core.quotePath=false` 출력(=원문)은 그대로 통과한다.
 *  문자열 안에 박힌 조각(`cat "…\355\214…"`)도 그 자리만 되돌린다 — 명령 이벤트가 그 형태로 오기 때문이다. */
export function unquoteGitPath(input) {
  const s = String(input ?? '')
  if (!s.includes('\\')) return s
  const decode = (body) => {
    const bytes = []
    const ESC = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34 }
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
      const oct = body.slice(i + 1, i + 4)
      if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue }
      const nxt = body[i + 1]
      if (nxt in ESC) { bytes.push(ESC[nxt]); i += 1; continue }
      bytes.push(92)
    }
    return Buffer.from(bytes).toString('utf8')
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) return decode(s.slice(1, -1))
  return s.replace(/"((?:[^"\\]|\\.)*\\[0-7]{3}(?:[^"\\]|\\.)*)"/g, (_, body) => decode(body))
}

/** 경로 비교용 정규화 — C-인용 해제 + 구분자 통일 + 소문자(Windows 대소문자 무시). */
export const normPath = (p) => unquoteGitPath(String(p ?? '')).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

/** 명령 문자열·파일 이벤트에 그 경로를 읽은 흔적이 있는가(순수).
 *  전체 경로 일치가 원칙이되, `cd` 후 상대경로로 여는 흔한 형태 때문에 **파일명 단독 일치**도 증거로 인정한다. */
export function readEvidenceFor(path, { commands = [], filePaths = [] } = {}) {
  const p = normPath(path)
  if (!p) return false
  const base = p.split('/').pop()
  const hay = [...commands.map(normPath), ...filePaths.map(normPath)]
  return hay.some((h) => h.includes(p) || (base.length >= 4 && h.includes(base)))
}

/** 「파일을 하나도 안 읽고 clean」은 리뷰가 아니다(F10 · 리뷰 #12).
 *  종전에는 `commands > 0` 만 봤다 — `pwd` 한 번이면 clean 이 통과했다. 이제 **findings 0건일 때**
 *  스토리 파일과 **리뷰 diff 파일**을 둘 다 실제로 읽은 증거를 요구한다(N7 — 스토리는 target 에서 제외).
 *  storyFile 을 주지 않으면 종전 판정 + 경고로 물러선다(호출부 배선 누락을 조용히 통과시키지 않기 위해 경고를 남긴다). */
export function validateReviewRun({ json, events, diffEmpty = false, storyFile = '', diffFile = '', changedFiles = [] } = {}) {
  if (!json) return { ok: false, why: '구조화 JSON 응답을 읽지 못했다(스키마 불량 또는 빈 응답)', warnings: [] }
  const warnings = []
  const commands = events?.commands ?? 0
  const n = Array.isArray(json.findings) ? json.findings.length : 0
  if (diffEmpty) return { ok: false, why: '리뷰 대상 diff 가 비어 있다 — 볼 것이 없는 리뷰는 무효', warnings }
  if (commands === 0 && n === 0) return { ok: false, why: 'Codex 가 명령을 하나도 실행하지 않고(파일 미열람) clean 을 냈다 — 리뷰 무효', warnings }
  if (n === 0) {
    if (!storyFile) warnings.push('열람 증거 판정 재료(storyFile/diffFile/changedFiles) 미제공 — 명령 개수만으로 통과시켰다')
    else {
      const ev = { commands: events?.commandList ?? [], filePaths: events?.filePaths ?? [] }
      const readStory = readEvidenceFor(storyFile, ev)
      // (N7) 종전에는 targets 에 changedFiles 가 통째로 들어가 **스토리 파일이 두 조건을 동시에** 만족했다 —
      // dev 가 스토리 문서를 고치므로 그 파일은 거의 항상 changedFiles 에 있고, 「스토리 한 번 읽기」로
      // clean 이 통과했다. 이제 ① 스토리 파일은 target 목록에서 빼고 ② **리뷰 diff 열람을 필수**로 한다.
      const storyN = normPath(storyFile)
      const impl = (changedFiles ?? []).filter((f) => f && normPath(f) !== storyN)
      const readDiff = Boolean(diffFile) && readEvidenceFor(diffFile, ev)
      const readImpl = impl.some((t) => readEvidenceFor(t, ev))
      // (M6 · 2026-09-02 3차 리뷰) 구현 파일 미열람은 종전에 **경고뿐**이었다 — BRIEF 정책 14 는 story ·
      // review diff · **변경 파일**의 실제 열람 증거를 모두 요구한다. 변경 구현 파일이 하나라도 있으면
      // 그중 최소 1개를 연 증거가 없는 clean 은 거부한다(diff 텍스트만 읽고 낸 「문제 없음」은 리뷰가 아니다).
      if (!readStory || !readDiff || (impl.length > 0 && !readImpl)) {
        const miss = [
          !readStory ? '스토리 파일' : '',
          !readDiff ? '리뷰 diff 파일' : '',
          impl.length > 0 && !readImpl ? `변경 구현 파일(${impl.length}건 중 0건 열람)` : '',
        ].filter(Boolean).join('·')
        return { ok: false, why: `Codex 가 ${miss}을(를) 실제로 읽은 증거 없이 clean 을 냈다 — 리뷰 무효(실행 명령 ${commands}건: ${(ev.commands.slice(0, 5)).join(' | ') || '기록 없음'})`, warnings }
      }
    }
  }
  if (commands === 0) warnings.push('명령 실행 0건(파일 미열람 의심) — findings 는 diff 텍스트만으로 낸 것일 수 있다')
  return { ok: true, why: '', warnings }
}

// ── 프롬프트(자립형 — Codex 는 /bmad-* 슬래시 스킬을 모른다) ────────────────────────────────
const COMMON_RULES = [
  '[비대화형] 승인/질문 없이 합리적 기본값으로 끝까지 진행하고 마지막에 결과를 보고하라.',
  '작업 루트의 CLAUDE.md 와 AGENTS.md 가 있으면 먼저 읽고 거기 적힌 절대 제약(보호 파일·보수성 규칙·마스킹)을 최우선으로 지켜라.',
  '⚠️ git commit · git push · git stash · git reset · git checkout · git clean · 브랜치 조작 절대 금지. 파괴적 명령(rm -rf 등) 금지. 엔진이 이를 감지하면 즉시 중단·사람 호출이다.',
  '`.env*` 파일과 자격증명(토큰·비밀번호·키)은 읽지도 출력하지도 마라.',
  '저장소 루트에 임시 파일을 만들지 마라 — 임시 산출물은 _bmad-output/implementation-artifacts/auto-pipeline-logs/ 아래에만.',
  '작업 루트 밖의 파일을 읽거나 쓰지 마라.',
]

export function codexReviewPrompt({ story, storyFile, diffFile, changedFiles = [], targetRef = '', extraContext = '' }) {
  const files = changedFiles.length ? changedFiles.map((f) => `  - ${f}`).join('\n') : '  (diff 파일 참조)'
  return [
    `# 적대적 코드 리뷰 — 스토리 ${story}`,
    '',
    '너는 이 스토리를 구현한 것과 **다른** 모델이다. 목적은 구현 모델이 못 본 결함을 찾는 것이다.',
    ...COMMON_RULES.map((r) => `- ${r}`),
    '- 이 세션은 읽기 전용 샌드박스다 — 코드를 고치지 말고 findings 만 낸다.',
    '- **반드시 파일을 실제로 열어 읽어라**(스토리 파일 · diff 파일 · 지적하는 코드의 주변). 읽지 않고 낸 판정은 엔진이 무효 처리한다.',
    '',
    '## 입력',
    `- 스토리 파일(AC · Tasks · Dev Notes · Dev Agent Record · File List): \`${storyFile}\``,
    `- 리뷰 대상 diff(통합 diff 파일 · ${targetRef || '이번 라운드 변경'}): \`${diffFile}\``,
    '- 변경 파일:',
    files,
    extraContext ? `- 추가 맥락: ${extraContext}` : '',
    '',
    '## 방법 — 세 렌즈를 순서대로, 각각 독립적으로',
    '1. **Blind Hunter(냉소적 적대 리뷰)**: 스토리 문맥 없이 diff 만 보고 문제가 있다고 가정하고 찾는다 — 빠진 것(누락된 처리·검증·경계)까지.',
    '2. **Edge Case Hunter(경로 열거)**: diff 가 만든 모든 분기·경계·암묵 분기(enum/상태값의 나머지 케이스)를 기계적으로 걷고 **처리되지 않은** 경로만 남긴다. 좋고 나쁨을 말하지 말고 누락만 적는다.',
    '3. **Acceptance Auditor**: 스토리의 Acceptance Criteria 각 항목을 diff 와 대조한다 — 위반·누락·모순. AC 마다 pass/fail/unknown 과 근거(파일:줄 또는 테스트 이름)를 acVerdicts 에 적는다.',
    '',
    '## 판정 규율',
    '- 심각도를 매기기 전에 **해당 위치의 코드를 실제로 열어** 호출처·가드·검증을 확인한다. diff 조각만 보고 평가하지 않는다.',
    '- **정확성이나 명시된 요구사항(AC·Dev Notes 제약)에 영향을 주는 것만** kind=patch(고칠 것) 또는 decision(사람이 정해야 함)으로 낸다. 취향·스타일·과잉 방어는 kind=optional 로 분리한다.',
    '- 이번 diff 가 만든 회귀가 **아닌** 기존 문제는 kind=defer + preExisting=true 로 분리한다(이 스토리의 findings 가 아니다).',
    '- 테스트가 결함 위에 서 있는 패턴(결함을 재현하지 못하는 테스트 · 같은 인스턴스만 rerender · 항상 통과하는 단언)을 특히 의심하라.',
    '- 보안·권한 / 개인정보 / 데이터 손실·복구 / 결제·청구 / 외부 발송·배포 안전장치에 닿는 문제는 심각도와 무관하게 patch 또는 decision 으로 낸다(이월 금지 5범주 — defer/optional 로 내면 엔진이 patch 로 승격한다).',
    '- 발견 0건이면 verdict=clean 이고 findings 는 빈 배열이다 — 억지로 만들지 마라. 확실하지 않으면 severity=low + kind=optional.',
    '- 각 finding 의 detail 은 재현 조건 → 결과 → 왜 문제인지 순으로 한 단락. evidence 는 코드 인용(짧게). 한국어로 쓴다.',
    '',
    '## 출력',
    '지정된 JSON 스키마 하나만 출력한다(설명문·코드펜스 없이). summary 는 두 문장 이내.',
  ].filter((l) => l !== null && l !== undefined).join('\n')
}

export function codexDevPrompt({ story, storyFile, sprintStatusFile, qaCmd = 'npm run qa', guard = '' }) {
  return [
    `# 스토리 구현 — ${story}`,
    '',
    '너는 이 스토리를 구현하는 개발자다. 아래 계약은 BMad dev-story 워크플로와 같다.',
    ...COMMON_RULES.map((r) => `- ${r}`),
    guard ? `- ${guard}` : '',
    '',
    '## 절차',
    `1. 스토리 파일 \`${storyFile}\` 을 **전부** 읽는다(Story · Acceptance Criteria · Tasks/Subtasks · Dev Notes · Dev Agent Record · File List · Change Log · Status). Dev Notes 의 아키텍처 제약·선행 교훈·테스트 표준을 구현 지침으로 삼는다.`,
    `2. \`${sprintStatusFile}\` 에서 이 스토리 키의 상태를 찾아 ready-for-dev 면 in-progress 로 바꾼다 — 그 줄의 상태값만 바꾸고 파일의 주석·다른 줄·들여쓰기는 그대로. 스토리 frontmatter 에 baseline_commit 이 없으면 \`git rev-parse HEAD\` 값을 적는다(있으면 보존).`,
    '3. Tasks/Subtasks 의 **미완([ ]) 항목을 위에서부터 순서대로** 구현한다. 사람 게이트로 표시된 항목(사람만 풀 수 있는 것)은 건드리지 말고 정직하게 남긴다.',
    '   - 각 작업은 실패하는 테스트를 먼저 쓰고(RED) → 최소 구현(GREEN) → 정리(REFACTOR). 스토리에 없는 기능을 만들지 마라.',
    '   - 새 의존성이 필요하면 추가하지 말고 Dev Agent Record 에 「의존성 필요 — 사람 승인 대기」로 적고 다음 작업으로 간다.',
    '   - `### Review Findings` 절의 열린 지적(`- [ ] [Review][Patch] …`)을 고쳤으면 그 줄을 `- [x] ~~원문~~ — ✅ 해소(날짜 · Task N)` 형식으로 닫는다(기호 없는 [x] 는 금지 — 거짓 신호로 가드에 걸린다).',
    `4. 검증: \`${qaCmd}\` 를 **파이프 없이** 실행해 exit 0 을 확인한다(네트워크가 막혀 실패하는 검사가 있으면 그 사실만 Dev Agent Record 에 적고, 나머지는 통과시킨다 — 엔진이 게이트를 다시 돈다). 실패하면 근본 원인을 고친다 — 테스트 삭제·단언 약화·skip·.only·ts-ignore·eslint-disable·규칙 비활성화·게이트 설정(package.json scripts·tsconfig·eslint/vite 설정) 변경으로 통과시키는 것은 금지다. 테스트 자체가 틀렸다고 판단해 고치면 Dev Agent Record 에 사유를 적는다.`,
    '5. 작업이 실제로 검증됐을 때만 체크박스를 [x] 로 바꾼다(거짓 완료 금지). 미실행 검증은 「미실행(사람 검증 IOU)」로 정직하게 적는다.',
    '6. 스토리 파일은 **다음 절만** 수정한다: frontmatter baseline_commit · Tasks/Subtasks 체크박스 · Dev Agent Record(Debug Log · Completion Notes · Agent Model Used) · File List · Change Log · Status.',
    '   - File List 는 `### File List` 소제목 아래 `- \\`src/path/file.ts\\`` 처럼 **백틱으로 감싼 저장소 루트 기준 경로** 한 줄씩(새로 만들거나 고치거나 지운 파일 전부 · 슬래시 경로). 편성기가 이 형식만 읽는다.',
    `7. 모든 Task 가 [x] 이고 \`${qaCmd}\` 가 통과하면 스토리 \`Status:\` 줄을 review 로, \`${sprintStatusFile}\` 의 키 상태를 review 로 바꾼다. 미완 Task 가 남으면 in-progress 로 둔다.`,
    '8. 임의로 정한 기본값이 있으면 스토리 파일에 「⚠️ 무인 기본값 결정」 마커와 함께 근거를 남긴다.',
    '',
    '## 완료 보고',
    '마지막 메시지에 한국어로: 완료한 Task 번호 · 남은 Task 와 이유 · 실행한 검증 명령과 결과 · 바꾼 파일 수.',
  ].filter(Boolean).join('\n')
}

export function codexRepairPrompt({ story, storyFile, qaCmd = 'npm run qa', attempt = 1, maxAttempts = 5, failure = {}, integrity = [], guard = '' }) {
  const integ = integrity.length ? integrity.map((f) => `  - [${f.level}] ${f.rule}: ${f.file}${f.line ? ':' + f.line : ''} — ${f.detail}`).join('\n') : '  (없음)'
  return [
    `# 자동 수리 ${attempt}/${maxAttempts} — 스토리 ${story}`,
    '',
    '직전 구현이 프로젝트 품질 게이트를 통과하지 못했다. 근본 원인을 고치고 다시 검증하라.',
    ...COMMON_RULES.map((r) => `- ${r}`),
    guard ? `- ${guard}` : '',
    '',
    '## 실패 정보',
    `- 게이트 명령: \`${qaCmd}\``,
    `- 분류: ${failure.kind ?? 'unknown'} · 서명: ${failure.signature ?? '-'}`,
    '- 로그 발췌:',
    '```',
    String(failure.excerpt ?? '').slice(0, 6000),
    '```',
    '- 테스트 무결성 검사 결과(block 은 반드시 해소):',
    integ,
    '',
    '## 규칙',
    '- 실패하는 테스트를 지우거나 단언을 약화하거나 skip/.only/ts-ignore/eslint-disable/커버리지 제외/게이트 설정 변경으로 통과시키는 것은 금지다 — 수리 중에 새로 생긴 이런 흔적은 엔진이 차단으로 승격한다.',
    '- 테스트 자체가 잘못됐다고 판단하면 고칠 수 있으나, 스토리 파일 Dev Agent Record 에 「테스트 수정 사유: …」를 반드시 적는다.',
    `- 고친 뒤 \`${qaCmd}\` 를 파이프 없이 실행해 exit 0 을 확인한다.`,
    `- 스토리 파일 \`${storyFile}\` 의 Dev Agent Record 에 「자동 수리 ${attempt}차: 원인 → 조치」 한 줄을 남긴다. 다른 절은 File List·Change Log 외에 만지지 마라.`,
    '',
    '## 완료 보고',
    '마지막 메시지에 한국어로: 원인 · 조치 · 검증 명령 결과.',
  ].filter(Boolean).join('\n')
}

// ── 결과 렌더 — 엔진이 스토리 원장 형식으로 기재한다 ────────────────────────────────────
// 형식 계약(bmad-code-review step-04 + story-ledger 파서 + story-ledger-guard 래칫):
//   decision: `- [ ] [Review][Decision] <제목> — <상세> [file:line]`
//   patch:    `- [ ] [Review][Patch][<sev>] <제목> [file:line] — <상세>`
//   defer:    `- [x] [Review][Defer] <제목> [file:line] — ⏭️ deferred, pre-existing`   (닫힘 기호 ⏭️ 필수)
//   optional: `- [x] [Review][Optional] <제목> — ⏭️ optional(정확성·명시 요구사항 영향 없음)`
//   0건:      `- ✅ Clean review — 발견 0건 …` (체크박스 아님 · 라운드 기록은 반드시 남긴다 — NO-OP 방지)
// 이월 금지 5범주(보안·권한 / 개인정보 / 데이터 손실·복구 / 결제·청구 / 외부 발송·배포 안전장치)는 심각도·kind 와
// 무관하게 patch 로 승격한다 — 리뷰어가 defer/optional 로 내도 엔진이 되돌린다(👤 2026-09-01 P0-④).
export const NO_DEFER_RE = /(보안|권한|인가|인증|RLS|policy|정책 우회|세션|토큰|비밀번호|개인정보|마스킹|연락처|주민|데이터 손실|유실|삭제 복구|복구 불가|백업|결제|청구|금액|과금|외부 발송|발송|배포|deploy|마이그레이션 롤백|security|privacy|PII|data loss|billing|payment)/i
const oneLine = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
const loc = (f) => (f.file ? ` [${oneLine(f.file)}${f.line > 0 ? ':' + f.line : ''}]` : '')

export function renderReviewFindings({ story, model = '', date, result, targetRef = '', round = 0 }) {
  const all = Array.isArray(result?.findings) ? result.findings : []
  const norm = (f) => {
    let kind = f.preExisting && f.kind !== 'decision' ? 'defer' : f.kind
    let promoted = false
    if ((kind === 'defer' || kind === 'optional') && NO_DEFER_RE.test(`${f.title} ${f.detail}`)) { kind = 'patch'; promoted = true }
    return { ...f, kind, promoted }
  }
  const fs = all.map(norm)
  const decision = fs.filter((f) => f.kind === 'decision')
  const patch = fs.filter((f) => f.kind === 'patch')
  const defer = fs.filter((f) => f.kind === 'defer')
  const optional = fs.filter((f) => f.kind === 'optional')
  const ac = Array.isArray(result?.acVerdicts) ? result.acVerdicts : []
  const acLine = ac.length
    ? `- AC 판정: pass ${ac.filter((a) => a.status === 'pass').length} · fail ${ac.filter((a) => a.status === 'fail').length} · unknown ${ac.filter((a) => a.status === 'unknown').length}` +
      (ac.some((a) => a.status !== 'pass') ? ' — ' + ac.filter((a) => a.status !== 'pass').map((a) => `${a.ac}=${a.status}(${oneLine(a.evidence)})`).join(' · ') : '')
    : ''
  const lines = []
  lines.push(`### Review Findings — Codex 교차리뷰 (${date}${round ? ` · ${round}차` : ''} · codex exec · ${model || 'default model'})`)
  lines.push('')
  lines.push(`> 출처 = OpenAI Codex(\`codex exec\` · read-only 샌드박스 · 3렌즈: Blind Hunter · Edge Case Hunter · Acceptance Auditor) · 대상 = ${targetRef || '이번 라운드 변경'} · 엔진(node)이 JSON 결과를 이 형식으로 기재했다(코드 수정 0 · 커밋 0). ${oneLine(result?.summary ?? '')}`)
  lines.push('')
  for (const f of decision) lines.push(`- [ ] [Review][Decision] ${oneLine(f.title)} — ${oneLine(f.detail)}${loc(f)}`)
  for (const f of patch) lines.push(`- [ ] [Review][Patch][${f.severity || 'medium'}] ${oneLine(f.title)}${loc(f)} — ${oneLine(f.detail)}${f.evidence ? ' (근거: ' + oneLine(f.evidence) + ')' : ''}${f.promoted ? ' (이월 금지 5범주 — 엔진 승격)' : ''}`)
  for (const f of defer) lines.push(`- [x] [Review][Defer] ${oneLine(f.title)}${loc(f)} — ⏭️ deferred, pre-existing — ${oneLine(f.detail)}`)
  for (const f of optional) lines.push(`- [x] [Review][Optional] ${oneLine(f.title)}${loc(f)} — ⏭️ optional(정확성·명시 요구사항 영향 없음) — ${oneLine(f.detail)}`)
  if (decision.length + patch.length + defer.length + optional.length === 0) lines.push('- ✅ Clean review — 발견 0건(3렌즈 통과 · 재오픈 불요)')
  if (acLine) lines.push(acLine)
  const counts = { decision: decision.length, patch: patch.length, defer: defer.length, optional: optional.length, high: patch.filter((f) => f.severity === 'high').length, promoted: patch.filter((f) => f.promoted).length }
  const newStatus = decision.length + patch.length > 0 ? 'in-progress' : 'done'
  const deferred = defer.map((f) => `${oneLine(f.title)}${loc(f)} — ${oneLine(f.detail)}`)
  const decisions = decision.map((f) => `${oneLine(f.title)} — ${oneLine(f.detail)}${loc(f)}`)
  return { block: lines.join('\n'), counts, newStatus, deferred, decisions }
}
