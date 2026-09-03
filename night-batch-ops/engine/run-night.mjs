#!/usr/bin/env node
// 야간 무인 배치 러너 (상시) — 날짜·스토리를 **하드코딩하지 않는다**.
// 이식판: 프로젝트 고유값은 `tools/auto/auto.config.json` 이 소유한다.
//
// 실행:
//   node tools/auto/run-night.mjs                # 큐 그대로 (수동 실행 형태)
//   node tools/auto/run-night.mjs --auto-plan    # 슬롯 모드(예약 실행) — 편성→실행을 큐가 마를 때까지 반복
//   node tools/auto/run-night.mjs --dry-run      # 엔진에 --dry-run 전달(무엇을 돌릴지만 본다)
//   node tools/auto/run-night.mjs --only A       # label 이 A 로 시작하는 배치만
//   node tools/auto/run-night.mjs --queue <경로> # 다른 큐 파일
//
// ⚠️ 커밋·푸시는 큐의 `defaults.commit/push` 옵트인이며 브랜치는 **항상 `auto/<날짜>`** 다.
//    정본 main 머지는 사람 승인이다.
// ⚠️ cmd 배치 파일이 아니라 .mjs 인 이유: 한글 스토리 키가 cmd.exe 코드페이지(CP949)에서 깨진다(실측).
// 핵심 설계(원 출처: 2026-08 야간 운영 실사고와 개선 원탁 수렴):
// ① 연속 실행 루프 — 시계가 아니라 작업 종료가 다음 배치를 연다(자정엔 고정 날짜로 종료)
// ② 슬롯 한도 대기 30분 — lock 인질 방지, 이어하기는 state.json ③ 차단기에서 exit 5 제외
// ④ 알림 텔레그램 정본(공개 ntfy 폴백) ⑤ 상태 폴더 = 프로젝트별(~/.claude-auto/<이름>)
// 무정지(Non-Stop) 개편 — 「밤이 서 있는 시간」을 없앤 5가지:
// ⑥ lock v2 — **모든 모드**가 잡는다(수동도) · 원자 생성(wx) · 심박(hb)으로 죽은 lock 을 가르고
//    판정 불능은 물러나되 알린다(무음 skip 금지) · 해제는 자기 토큰일 때만(ABA 차단)
// ⑦ 선형 승계 — 미머지 auto/* 가 남아도 쉬지 않는다. 최신 미머지 tip 위에서 오늘 브랜치를 시작한다
//    (main 무접촉 = 사람 머지 원칙 불변 · 아침엔 최신 브랜치 1개만 머지하면 체인 전체가 들어온다)
// ⑧ 하향 동기 — 라운드마다 origin/main 을 작업 브랜치로 가져와, 낮의 확정·큐·승인이 밤에 보이게 한다
// ⑨ 체인 나이 기록(chain-info.json) — 편성기의 체인 게이트(신규 착수 보류) 재료
// ⑩ STOP 차단기 v2 — 「원인 서명」 단위 차단(다른 원인은 계속) · exit 5(한도)는 종전대로 날씨
// 판정 규칙은 전부 runner-rules.mjs 소유(순수 함수 — 테스트가 문다).
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './plan-queue.mjs'
import { safeGitPush } from './push-guard.mjs'
// 2026-09-02 「9점대 하네스」 배선 — 판정은 전부 순수 모듈이 소유하고 러너는 부르기만 한다.
import { assignHistoryPath, assignWorkers, parseHistory, recordAssignResult, serializeHistory, specProvider } from './assign.mjs'
import { parallelHazardsCompat } from './conflicts.mjs'
import { appendJsonl, metricsHistoryPath, parseCodexUsage, parseEngineLog, renderMetricsTable, summarizeTimeline, writeJsonAtomic } from './metrics.mjs'
import { makeClaudePlanRunner, requestPlan } from './orchestrate.mjs'
import { buildDag, parseDependsOn } from './plan-dag.mjs'
import { applyIntegrationToManifest, blockedProviderFromExit, conflictFingerprint, downSyncDecision, engineFlagsFromConfig, fileListConflicts, inheritPlan, integrationGateDecision, integrationGateInvocation, landingResolution, limitRefundKeys, lockAction, notifyChannel, parallelHazards, parallelPlanWithWorkers, parseFileList, pickRunnable, progressedStoryKeys, providerConfig, refundUnrun, roundDidRealWork, shouldContinueLoop, spendBlockNotice, stopBlocked, stopRecord, stopWindowId, stripConflictMarkers, waitAuthMin } from './runner-rules.mjs'

const ENGINE = join(homedir(), '.claude', 'skills', 'auto-story-finish', 'auto-story-pipeline.mjs')
const ART = resolve('_bmad-output/implementation-artifacts')
const LOG_DIR = join(ART, 'auto-pipeline-logs')
const SUMMARY = join(LOG_DIR, 'night-last-run.md')

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes(`--${name}`)

const manualQueuePath = resolve(opt('queue', 'tools/auto/night-queue.json'))
const only = opt('only', '')
const dryRun = has('dry-run')
const autoPlan = has('auto-plan') // 없으면 단일 실행 — 수동 경로를 깨지 않는다

/** 로컬 날짜 YYYY-MM-DD — 브랜치 이름이 실행일과 어긋나지 않게 UTC 를 쓰지 않는다 */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fail(message, code = 2) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

if (!existsSync(ENGINE)) fail(`auto-story-finish 엔진을 찾지 못했다: ${ENGINE}`)
if (!existsSync(resolve('package.json'))) fail('저장소 루트에서 실행해야 한다(package.json 없음)')
// 엔진은 nested 워커의 commit/push deny 설정이 없으면 **시작조차 하지 않는다**(2026-09-02 fail-closed · exit 6).
// 러너가 먼저 말하지 않으면 밤새 배치마다 exit 6 만 쌓인다 — 원인을 여기서 한 번에 말하고, 찾은 경로를
// **절대경로로 엔진에 넘긴다**(`--pipeline-settings`). 워크트리에서 돌 때 프로젝트 `.claude/` 가 gitignore 라
// 워크트리에 없어도, 러너가 준 경로 하나로 모든 워커가 같은 설정을 본다(사본을 흩뿌리지 않는다).
const PIPELINE_SETTINGS = [
  process.env.PIPELINE_SETTINGS_PATH ? resolve(process.env.PIPELINE_SETTINGS_PATH) : '',
  resolve('.claude/pipeline-settings.json'),
  join(homedir(), '.claude', 'pipeline-settings.json'),
].find((p) => p && existsSync(p)) || ''
if (!PIPELINE_SETTINGS) {
  fail('pipeline-settings.json 이 없다(PIPELINE_SETTINGS_PATH · .claude/ · ~/.claude/ 모두) — 엔진이 nested 워커 deny 없이는 배치를 시작하지 않는다. deny 규칙(Bash(git commit:*)·Bash(git push:*) 등)을 담아 두고 다시 실행할 것', 3)
}

// 프로젝트 식별 + 상태 폴더 — 프로젝트별 분리(lock·원장 교차 오염 방지)
const CFG = loadConfig(process.cwd())
const PROJECT = CFG.project || basename(resolve('.'))
const STATE_DIR = process.env.AUTO_BATCH_STATE_DIR || CFG.stateDir || join(homedir(), '.claude-auto', PROJECT)

// ── 다중 프로바이더(2026-09-02) — 설정이 없으면 configured=false 로 종전 동작(Claude 전용 · 엔진 명령줄 무변경) ──
const PCFG = providerConfig(CFG)
for (const w of PCFG.warnings) console.log(`⚠ ${w}`)
const QA_CMD = typeof CFG.qa === 'string' && CFG.qa.trim() ? CFG.qa : 'npm run qa' // 통합 게이트 명령(엔진 qa 게이트와 같은 정의)
// ── Fable 오케스트레이터(선택 · 기본 꺼짐 = 종전 동작) ──
// 켜면 규칙 편성(plan-queue)이 낸 큐를 지휘 모델에게 **재편성**시킨다. 후보 집합은 규칙이 정한
// 그대로이고(추가 불가), 검증(plan-dag.validatePlan)을 통과할 때만 채택한다. 하나라도 어긋나면
// 규칙 큐로 되돌아간다 — 밤이 LLM 때문에 서는 일은 없다.
// 2026-09-03 👤 「(가) 캐시 추가 후 Fable 계획을 켠다 · BaroOS 프로젝트 중에는 항상 켜 두어 최대 작업량으로」 —
// 상시로 켜니 **30분 슬롯마다 같은 질문을 다시 하는 것**이 문제가 된다. `cacheHours`(기본 12) 안에서
// 후보 지문이 같으면 지난 계획을 그대로 다시 쓴다(호출 0). 설치 템플릿의 기본값은 enabled:true 다 —
// 여기 `=== true` 는 **설정 키가 아예 없는 구판 프로젝트**의 종전 동작(꺼짐)을 지키는 자리다.
const ORCH = {
  enabled: CFG.orchestrator?.enabled === true,
  model: typeof CFG.orchestrator?.model === 'string' && CFG.orchestrator.model ? CFG.orchestrator.model : 'fable',
  timeoutMin: Math.max(1, Number(CFG.orchestrator?.timeoutMin) || 5),
  cacheHours: Number.isFinite(Number(CFG.orchestrator?.cacheHours)) && Number(CFG.orchestrator?.cacheHours) >= 0 ? Number(CFG.orchestrator.cacheHours) : 12,
}
let PLAN_SOURCE = 'deterministic' // run-summary·매니페스트에 남길 계획 출처
let PLAN_CACHE_NOTE = null // 계획 캐시 판정 한 줄(요약 전용 · 오케스트레이터가 꺼져 있으면 null)
let PLAN_VALIDATION = null // 편성기 자기 검증 요약
let codexAvailability = null // codex 가 켜졌을 때만 1회 감지 — 감지 코드는 엔진의 providers/ 계층 하나(중복 판정기 금지)
/** 능력 감지 실행기 — **셸 문자열 결합을 쓰지 않는다**(2026-09-02 hardening #6/#8).
 *  `${bin} ${args.join(' ')}` + shell:true 는 ① 공백 있는 CODEX_BIN 을 못 부르고 ② 설정값의 `&`·`|` 가
 *  두 번째 명령으로 실행된다. 여기서는 실행파일과 argv 를 분리하고, Windows 의 `.cmd`/`.bat` 심만
 *  cmd.exe 전용 경로로 부른다(그때도 메타문자가 있으면 실행 자체를 거부한다). */
const SHELL_META_RE = /[&|<>^"`$;\r\n]/
function safeExec(bin, args = []) {
  const file = String(bin ?? '')
  const argv = (args ?? []).map(String)
  if (file === '' || SHELL_META_RE.test(file) || argv.some((a) => SHELL_META_RE.test(a))) {
    return { status: 1, stdout: '', stderr: `실행 거부 — 실행파일·인자에 셸 메타문자가 있다: ${file}` }
  }
  const o = { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, shell: false }
  const r = /\.(cmd|bat)$/i.test(file) && process.platform === 'win32'
    // Node 는 shell 없이 .cmd 를 직접 spawn 하지 못한다(CVE-2024-27980 이후 차단). cmd.exe 를 명시적으로
    // 부르되 인자는 우리가 따옴표로 감싸고, 메타문자는 위에서 이미 거부했다 — 셸 해석 여지가 없다.
    // `/s` 는 **바깥 따옴표 한 쌍**을 벗기고 나머지를 그대로 쓴다 — 그래서 전체를 한 번 더 감싼다(안 감싸면 첫·끝 따옴표가 뜯겨 경로가 깨진다).
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}" ${argv.map((a) => `"${a}"`).join(' ')}"`], { ...o, windowsVerbatimArguments: true })
    : spawnSync(file, argv, o)
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
}
async function codexAvailable() {
  if (!PCFG.providers.codex.enabled) return false
  if (codexAvailability) return codexAvailability.available
  try {
    const mod = await import(pathToFileURL(join(dirname(ENGINE), 'providers', 'index.mjs')).href)
    const det = mod.detectProviders({ want: ['codex'], exec: safeExec })
    codexAvailability = { available: Boolean(det.codex?.available), reason: det.codex?.reason ?? '' }
    console.log(mod.providersLine(det))
  } catch (e) {
    codexAvailability = { available: false, reason: `엔진에 providers/ 계층이 없다(구판 auto-story-finish) — ${e?.message ?? e}` }
    console.log(`[PROVIDERS] codex=NO(${codexAvailability.reason})`)
  }
  return codexAvailability.available
}
// ── 배정 기록(assign-history.json) — **러너가 유일한 작성자**다 ─────────────────
// 왜 러너만 쓰나: 워커(엔진)가 각자 쓰면 병렬 4폭에서 마지막 쓰기가 앞의 셋을 덮는다. 러너는
// 라운드가 끝난 뒤 한 번, tmp→rename 으로 갈아 끼운다(읽는 쪽이 반쪽 JSON 을 보지 않는다).
const ASSIGN_HISTORY = assignHistoryPath(STATE_DIR)
const readAssignHistory = () => {
  try { return parseHistory(readFileSync(ASSIGN_HISTORY, 'utf8')) } catch { return parseHistory(null) }
}
/** results = [{ story, provider, role, ok, rounds }] — 라운드 1회분을 한 번에 반영한다. */
function writeAssignHistory(results = []) {
  if (results.length === 0) return
  try {
    let h = readAssignHistory()
    for (const r of results) h = recordAssignResult(h, r)
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${ASSIGN_HISTORY}.tmp-${process.pid}`
    writeFileSync(tmp, serializeHistory(h), 'utf8')
    renameSync(tmp, ASSIGN_HISTORY)
  } catch (e) { console.log(`⚠ 배정 기록 갱신 실패(무시하고 계속): ${e?.message ?? e}`) }
}

// ── 계측 재료 수집 ───────────────────────────────────────────────────────────
/** 워크트리의 엔진 로그 → 단계 이벤트 + Codex 토큰. **워크트리를 지우기 전에** 불러야 한다. */
function readWorktreeTimeline(wt) {
  const logs = join(wt.dir, '_bmad-output', 'implementation-artifacts', 'auto-pipeline-logs')
  let stages = []
  try { stages = parseEngineLog(readFileSync(join(logs, 'run-summary.log'), 'utf8'), { story: wt.story }) } catch { stages = [] }
  const tokens = {}
  try {
    for (const f of readdirSync(logs).filter((n) => n.startsWith(wt.story) && n.endsWith('.log'))) {
      const u = parseCodexUsage(readFileSync(join(logs, f), 'utf8'))
      if (u.turns === 0) continue
      const model = stages.find((e) => e.provider === 'codex')?.model || 'codex'
      tokens.codex ??= {}
      tokens.codex[model] = { total: (tokens.codex[model]?.total ?? 0) + u.total }
    }
  } catch { /* 로그가 없으면 토큰도 없다 — 계측이 배치를 세우지 않는다 */ }
  return { stages, tokens }
}

/** 순차 배치용 — 저장소 엔진 로그에서 `sinceIso` 이후·해당 스토리의 단계 이벤트만 추린다. */
function readRepoTimelineSince(sinceIso, stories = []) {
  let evs = []
  try { evs = parseEngineLog(readFileSync(join(LOG_DIR, 'run-summary.log'), 'utf8')) } catch { return [] }
  const from = Date.parse(sinceIso)
  const want = new Set(stories.map(String))
  return evs.filter((e) => Date.parse(e.start ?? '') >= from && (want.size === 0 || want.has(e.story)))
}

/** 계측 결과 2곳 기록 — 배치별 JSON(원자 쓰기) + 상태 폴더 누적 JSONL(줄 단위 append). */
function writeMetrics(batchId, label, summary, record) {
  try {
    writeJsonAtomic(join(LOG_DIR, `metrics-${batchId}.json`), { batchId, label, branch: BRANCH, planSource: PLAN_SOURCE, ...summary })
    appendJsonl(metricsHistoryPath(STATE_DIR), {
      at: new Date().toISOString(), batchId, project: PROJECT, planSource: PLAN_SOURCE,
      workers: summary.workers, wallMs: summary.wallMs, serialMs: summary.serialMs,
      idleRatio: summary.idleRatio, parallelEfficiency: summary.parallelEfficiency,
      p50Ms: summary.p50Ms, p95Ms: summary.p95Ms, retries: summary.retries,
      modelCalls: summary.modelCalls, qualityGate: summary.qualityGate,
    })
  } catch (e) { record(`⚠ 계측 기록 실패(무시하고 계속): ${e?.message ?? e}`) }
}

/** 엔진이 남긴 STOP 부기(exit-info.json) — 없으면 null */
function readExitInfo(dir) {
  try { return JSON.parse(readFileSync(join(dir, '_bmad-output', 'implementation-artifacts', 'auto-pipeline-logs', 'exit-info.json'), 'utf8')) } catch { return null }
}
// ── 실패 증거 보존(2026-09-02 hardening #9) ────────────────────────────────────────────────
// 로그만 복사하던 시절엔 「repair 가 절반쯤 고치고 exit 1」 하면 그 절반이 `worktree remove --force`
// 와 함께 사라졌다. 이제 워크트리를 지우기 **전에** 실제 코드 diff·미추적 산출물까지 복구 가능한
// 형태로 남긴다. 다만 증거 폴더는 상태 폴더(사람이 열어 보는 곳)라 **민감 파일은 애초에 담지 않고**,
// 담는 텍스트는 저장 직전 한 번 더 마스킹한다.
const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024 // 미추적 파일 1개 상한 — 큰 산출물은 목록만 남긴다
/** diff 생성 단계에서 통째로 빼는 pathspec — 「나중에 지운다」가 아니라 애초에 만들지 않는다 */
const EVIDENCE_DIFF_EXCLUDES = Object.freeze([
  ':(exclude)*.env', ':(exclude)*.env.*', ':(exclude)*.pem', ':(exclude)*.key', ':(exclude)*.p12', ':(exclude)*.pfx',
  ':(exclude)*secret*', ':(exclude)*credential*', ':(exclude)*auth.json', ':(exclude)*id_rsa*', ':(exclude)*id_ed25519*', ':(exclude)*.npmrc',
])
const SENSITIVE_PATH_RE = /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)(id_rsa|id_ed25519)|secret|credential|(^|\/)auth\.json$|(^|\/)\.npmrc$/i
const isSensitivePath = (p) => SENSITIVE_PATH_RE.test(String(p ?? '').replace(/\\/g, '/'))
const looksBinary = (buf) => buf.subarray(0, 8192).includes(0)
let redactFn = null
/** 마스킹기 — 엔진의 **단일 소스** `providers/redact.mjs` 를 읽기 전용으로 빌려 쓴다(판정기 중복 금지).
 *  `providers/codex.mjs` 는 그 재수출일 뿐이라 폴백 순서로만 남긴다(재수출이 없던 구판 엔진 대비).
 *  둘 다 없으면 최소 폴백(키=값 줄)만 적용한다 — 마스킹 없이 저장하지는 않는다. */
async function redactor() {
  if (redactFn) return redactFn
  for (const name of ['redact.mjs', 'codex.mjs']) {
    try {
      const mod = await import(pathToFileURL(join(dirname(ENGINE), 'providers', name)).href)
      if (typeof mod.redactSecrets === 'function') { redactFn = mod.redactSecrets; return redactFn }
    } catch { /* 다음 후보 — 마지막은 아래 폴백 */ }
  }
  redactFn = (t) => String(t ?? '').replace(/((?:token|secret|key|password|passwd|pwd|api[-_]?key|authorization)\s*[:=]\s*)(["']?)[^\s"'#]{6,}/gi, '$1$2***REDACTED***')
  return redactFn
}
/** 러너 전역 마스커(N3/정책 2·12) — **파일에 쓰거나 밖으로 내보내기 직전**에 반드시 통과시킨다.
 *  대상: 통합 게이트 로그 · 증거 폴더로 복사되는 엔진 로그 · 알림 본문 · `night-last-run.md` 요약.
 *  엔진 providers/codex.mjs 의 `redactSecrets` 하나를 빌려 쓴다(판정기 중복 금지 — 구판 엔진이면 폴백). */
const REDACT = await redactor()
/** 로그 폴더 복사 — `cpSync` 는 원문을 그대로 옮긴다. 텍스트는 한 줄씩이 아니라 파일째 마스킹해 옮기고,
 *  바이너리는 그대로 둔다(마스킹이 깨뜨릴 수 있다 · 증거 폴더에 바이너리 로그는 거의 없다). */
function copyLogsRedacted(from, to) {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name)
    const dst = join(to, e.name)
    if (e.isDirectory()) { copyLogsRedacted(src, dst); continue }
    let buf
    try { buf = readFileSync(src) } catch { continue }
    if (looksBinary(buf)) writeFileSync(dst, buf)
    else writeFileSync(dst, REDACT(buf.toString('utf8')), 'utf8')
  }
}
const RESTORE_MD = (story) => `# 복구 절차 — ${story}

이 폴더는 **실패한 병렬 워크트리**의 증거다(워크트리 자체는 이미 제거됐다).

1. 저장소를 \`summary.json\` 의 \`base\` 커밋으로 맞춘다: \`git switch --detach <base>\`
2. 코드 변경 복구: \`git apply /경로/code.diff\` (실패하면 \`git apply --3way code.diff\`)
3. 미추적 산출물 복구: \`untracked/\` 아래 파일을 같은 상대경로로 저장소에 복사한다.
4. \`summary.json\` 의 \`head\` 가 \`base\` 와 다르면 그 커밋 객체는 **본 저장소에 그대로 남아 있다**(워크트리는
   저장소 객체를 공유한다) — \`git cherry-pick <head>\` 로 회수한다. gc 전에 회수할 것.

주의
- 민감 경로(\`.env*\`·\`*.pem\`·\`*.key\`·\`*secret*\`·\`*credential*\`·\`auth.json\`·\`.npmrc\` 등)는 **일부러 빠졌다**.
  그 파일들의 변경은 여기 없다 — 사람이 직접 다시 만든다.
- 저장 직전 시크릿 마스킹을 한 번 더 돌렸다. 마스킹이 diff 본문을 건드렸다면 \`git apply\` 가 그 hunk 에서
  실패할 수 있다(\`summary.json.redacted\` 가 true 면 의심할 것).
`
/** 실패 워크트리의 증거(엔진 로그·코드 diff·미추적 산출물)를 상태 폴더에 보관 — `worktree remove --force` 와 함께 사라지지 않게(F39·#9) */
async function archiveEvidence(wt) {
  const dst = join(STATE_DIR, 'archive', `${today()}-${Date.now()}-evidence`, wt.story)
  const notes = []
  const g = (args) => spawnSync('git', ['-C', wt.dir, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  try {
    mkdirSync(dst, { recursive: true })
    const redact = await redactor()
    const logs = join(wt.dir, '_bmad-output', 'implementation-artifacts', 'auto-pipeline-logs')
    // ⚠️ 로그도 **마스킹해서** 옮긴다 — 종전 `cpSync` 는 원문을 그대로 증거 폴더에 복사했다(N3/정책 12).
    if (existsSync(logs)) copyLogsRedacted(logs, join(dst, 'auto-pipeline-logs'))
    else notes.push('엔진 로그 폴더 없음')

    // ① 추적 파일의 미커밋 변경 — 민감 pathspec 제외 후 생성, 저장 직전 재마스킹
    const d = g(['diff', '--binary', 'HEAD', '--', '.', ...EVIDENCE_DIFF_EXCLUDES])
    const rawDiff = d.status === 0 ? d.stdout ?? '' : ''
    if (d.status !== 0) notes.push(`git diff 실패: ${(d.stderr ?? '').trim().split('\n')[0]}`)
    const diff = redact(rawDiff)
    writeFileSync(join(dst, 'code.diff'), diff, 'utf8')

    // ② 미추적 산출물 — 민감 경로 제외 · 개별 5MB 상한 · 바이너리는 원본 복사
    const untracked = []
    const skipped = []
    const ls = g(['ls-files', '--others', '--exclude-standard'])
    for (const rel of (ls.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (isSensitivePath(rel)) { skipped.push({ path: rel, why: 'sensitive' }); continue }
      const from = join(wt.dir, rel)
      let buf
      try { buf = readFileSync(from) } catch (e) { skipped.push({ path: rel, why: `read: ${e?.code ?? e?.message ?? e}` }); continue }
      if (buf.length > EVIDENCE_MAX_BYTES) { skipped.push({ path: rel, why: `too-large(${buf.length})` }); continue }
      const to = join(dst, 'untracked', rel)
      mkdirSync(dirname(to), { recursive: true })
      const bin = looksBinary(buf)
      writeFileSync(to, bin ? buf : redact(buf.toString('utf8')), bin ? undefined : 'utf8')
      untracked.push({ path: rel, bytes: buf.length, binary: bin })
    }

    // ③ 요약 — 무엇이 얼마나 바뀌었나 · 어디서 이어가나
    const head = (g(['rev-parse', 'HEAD']).stdout ?? '').trim()
    writeFileSync(join(dst, 'summary.json'), JSON.stringify({
      schema: 'night-batch-ops/evidence/1',
      story: wt.story, at: new Date().toISOString(), worktree: wt.dir,
      base: wt.base ?? '', head,
      diffStat: redact((g(['diff', '--stat', 'HEAD', '--', '.', ...EVIDENCE_DIFF_EXCLUDES]).stdout ?? '').trim()),
      status: redact((g(['status', '--porcelain']).stdout ?? '').trim()),
      diffBytes: Buffer.byteLength(diff), redacted: diff !== rawDiff,
      untracked, skipped, notes,
    }, null, 2) + '\n', 'utf8')
    writeFileSync(join(dst, 'RESTORE.md'), RESTORE_MD(wt.story), 'utf8')
    return dst
  } catch (e) {
    try { writeFileSync(join(dst, 'ARCHIVE-ERROR.txt'), String(e?.stack ?? e), 'utf8') } catch { /* 상태 폴더 자체가 막힌 경우 */ }
    return existsSync(dst) ? dst : null
  }
}

/** 알림 — 텔레그램(비공개) 정본, 공개 ntfy 폴백, 둘 다 없으면 무음.
 *  토큰·chat_id 는 저장소 밖: 프로젝트 상태 폴더 → 공용(~/.claude-auto/) 순으로 찾는다.
 *
 *  전송은 Node 빌트인 `fetch` 다(외부 의존성 0). 예전 `curl` + `shell:true` 경로는 두 가지가
 *  잘못돼 있었다 — ① 봇 토큰이 **명령줄 인자**에 실려 프로세스 목록(ps·작업 관리자)에 노출됐고
 *  ② title·chat_id·프로젝트명이 이스케이프 없이 셸 문자열에 보간됐다.
 *
 *  ⚠️ 공개 ntfy 는 **토픽만 알면 누구나 읽는다** — 폴백으로 나갈 때는 제목·건수·exit 코드 수준의
 *  `brief` 만 싣는다(브랜치명·파일 경로·배치 라벨 금지). 상세 본문은 텔레그램에만 간다.
 *
 *  fetch 는 비동기라, 알림 직후 종료하는 자리(lock 후퇴·휴면·차단·마지막 exit)에서는
 *  `await flushNotify()` 로 배출을 기다린다 — 안 그러면 종료가 전송을 잘라먹는다. */
const NTFY_BRIEF = '상세는 상태 폴더 로그를 확인한다.'
const pendingNotifies = new Set()
const flushNotify = () => Promise.allSettled([...pendingNotifies])
const notify = (rawTitle, rawBody, rawBrief) => {
  // 본문은 배치 로그·git 오류 문장을 그대로 인용하는 자리다 — 밖으로 나가기 전에 마스킹한다(N3/정책 2).
  const title = REDACT(rawTitle)
  const body = REDACT(rawBody)
  const brief = rawBrief === undefined ? undefined : REDACT(rawBrief)
  const send = async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    try { await res.arrayBuffer() } catch { /* 응답 본문은 쓰지 않는다 — 소켓만 비운다 */ }
  }
  const task = (async () => {
    try {
      const findFile = (name) => [join(STATE_DIR, name), join(homedir(), '.claude-auto', name)].find((p) => existsSync(p))
      const tokenPath = findFile('telegram-token.txt')
      const chatPath = findFile('telegram-chat.json')
      const token = tokenPath ? readFileSync(tokenPath, 'utf8').trim() : ''
      // 토큰에 URL 구조를 바꾸는 문자가 섞였으면 보내지 않는다(경로 주입 차단). 정상 토큰엔 없다.
      const tokenOk = token !== '' && !/[/?#\s]/.test(token)
      // BOM 내성 — PowerShell 저장 JSON 은 EF BB BF 로 시작해 parse 가 죽고, 이 catch 는
      // 무음이라 알림이 조용히 증발한다(실기 테스트에서 실발생).
      const chatId = chatPath ? JSON.parse(readFileSync(chatPath, 'utf8').replace(/^\uFEFF/, '')).chat_id : null
      const topicPath = join(homedir(), '.claude', 'ntfy-topic.txt')
      const topic = existsSync(topicPath) ? readFileSync(topicPath, 'utf8').trim() : ''
      const channel = notifyChannel({ telegramReady: Boolean(tokenOk && chatId), ntfyReady: Boolean(topic) })
      if (channel === 'telegram') {
        await send(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `[${PROJECT}] ${title}\n${body}` }),
        })
      } else if (channel === 'ntfy') {
        // 제목은 헤더(Title)가 아니라 본문에 넣는다 — HTTP 헤더는 한글을 그대로 실을 수 없다.
        await send(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
          method: 'POST',
          body: `[${PROJECT}] ${title}\n${brief ?? NTFY_BRIEF}`,
        })
      }
    } catch { /* 무음 — 알림 실패는 배치에 영향 없음 */ }
  })()
  pendingNotifies.add(task)
  task.finally(() => pendingNotifies.delete(task))
  return task
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const loadState = () => {
  const p = join(STATE_DIR, 'auto-plan-state.json')
  const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  s.days ??= {}
  s.consumed ??= {} // 수동 큐 소비 표식은 **전역**이다 — 날짜별로 두면 자정이 지나는 순간 어제 큐가
  // "새 큐"로 보여 통째로 재실행된다(실사고 — 7커밋 중복)
  s.days[today()] ??= { planned: [], stops: 0, consumed: {} }
  // 차단기는 달력일이 아니라 낮/밤 창 단위 — 낮 사고가 밤 몫을 잠그지 않게(stopWindowId 소유).
  s.windows ??= {}
  s.windows[stopWindowId(new Date())] ??= { stops: 0 }
  return { s, day: s.days[today()], win: s.windows[stopWindowId(new Date())], save: () => writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8') }
}

// 자정 가드: 루프·브랜치는 시작 시점 날짜에 고정된다. 자정을 넘기면 루프를 끝내고
// 다음 슬롯의 새 프로세스가 (하루 몫 브랜치 판정부터) 이어받는다.
const START_DATE = today()
const BRANCH = `auto/${START_DATE}`

// ── ① lock v2 ─────────────────────────────────────────────────────────────────────────
// **모든 모드**가 lock 을 잡는다 — 「수동 실행은 lock 밖」이 이중 기동 실사고의 한 축이었다.
// 판정: ESRCH(pid 사망)만 사망 · EPERM 등 권한 오류와 JSON 손상은 「판정 불능」이며 심박(6h)으로만
// 보조 탈취한다(살아 있는 러너를 남이 죽었다고 밀어내지 않는다).
// 획득은 wx(원자 생성) · 해제는 자기 토큰 확인 후에만 — 탈취당한 구 프로세스가 종료하면서 새 lock 을
// 지우는 ABA 를 막는다. 연속 루프가 도는 동안 lock 이 유지되므로 다음 정시 슬롯은 자동으로 겹침 회피.
const lockPath = join(STATE_DIR, 'runner.lock')
const LOCK_TOKEN = randomUUID()
function readLockInfo() {
  if (!existsSync(lockPath)) return { exists: false }
  let parsed = null
  try { parsed = JSON.parse(readFileSync(lockPath, 'utf8')) } catch { /* 손상 */ }
  if (!parsed) return { exists: true, parseOk: false, hbAgeMs: Infinity }
  let pidAlive
  try { process.kill(parsed.pid, 0); pidAlive = true } catch (e) { pidAlive = e?.code === 'ESRCH' ? false : 'unknown' }
  const hb = Date.parse(parsed.hb ?? parsed.at ?? '') || 0
  return { exists: true, parseOk: true, pidAlive, hbAgeMs: hb ? Date.now() - hb : Infinity, parsed }
}
function touchLock() { // 심박 — 라운드 시작·배치 경계마다. 자기 토큰일 때만 쓴다.
  // ⚠️ 제자리 덮어쓰기 금지 — 쓰는 순간 다른 슬롯이 **잘린 JSON** 을 읽으면 readLockInfo 가
  // parseOk:false → hbAgeMs Infinity 로 판정해 살아 있는 러너를 takeover 로 밟는다.
  // tmp 파일에 다 쓴 뒤 rename(원자 교체) — 읽는 쪽은 언제 읽어도 완전한 JSON 만 본다.
  const tmp = `${lockPath}.${process.pid}.tmp`
  try {
    const cur = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (cur.token !== LOCK_TOKEN) return
    writeFileSync(tmp, JSON.stringify({ ...cur, hb: new Date().toISOString() }))
    renameSync(tmp, lockPath)
  } catch { /* lock 이 사라졌으면 다음 라운드 판정이 잡는다 */
    try { unlinkSync(tmp) } catch { /* tmp 잔재 없음 */ }
  }
}
{
  mkdirSync(STATE_DIR, { recursive: true })
  const info = readLockInfo()
  const action = lockAction(info)
  if (action === 'skip-alive') {
    console.log('이미 실행 중 — ' + (autoPlan ? '이 슬롯은 건너뛴다(lock)' : '수동 실행을 중단한다(lock — 동시 실행은 같은 트리를 오염시킨다)'))
    process.exit(autoPlan ? 0 : 1)
  }
  if (action === 'skip-unknown') {
    // 판정 불능 + 심박 신선 — 보수적으로 물러나되 **무음 금지**. 죽은 lock 이 「생존」으로 굳으면
    // 밤새 아무 알림 없이 skip 만 반복된다. 하루 1회 알린다.
    const { day, save } = loadState()
    day.notified ??= {}
    console.log('lock 판정 불능(권한/손상) — 이 슬롯은 물러난다. 심박이 6시간 지나면 자동 교체된다')
    if (!day.notified.lockUnknown && !dryRun) {
      notify('lock 판정 불능', `runner.lock 을 판정할 수 없다(권한/손상). 심박 6h 초과 시 자동 교체 — 계속되면 ${lockPath} 확인`)
      day.notified.lockUnknown = true
      save()
    }
    await flushNotify()
    process.exit(autoPlan ? 0 : 1)
  }
  if (action === 'takeover') {
    console.log('죽은 lock 교체(pid ' + (info.parsed?.pid ?? '?') + ' 사망/심박 초과)')
    try { unlinkSync(lockPath) } catch { /* 경합 — wx 가 잡는다 */ }
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: LOCK_TOKEN, at: new Date().toISOString(), hb: new Date().toISOString() }), { flag: 'wx' })
  } catch {
    console.log('lock 원자 획득 실패(동시 기동 경합) — 이 프로세스는 물러난다')
    process.exit(autoPlan ? 0 : 1)
  }
  process.on('exit', () => {
    try {
      const cur = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (cur.token === LOCK_TOKEN) unlinkSync(lockPath) // 자기 lock 만 지운다(ABA 차단)
    } catch { /* 이미 없음/손상 */ }
  })
}

if (autoPlan) {
  // ② 전용 워크트리 새로고침(marker 있을 때만) — 본 트리(대화 세션)의 발밑을 절대 바꾸지 않는다.
  //    기준 ref = 오늘 auto 브랜치가 원격에 있으면 그것(같은 날 앞 슬롯의 연속), 없으면 origin/main.
  if (existsSync(resolve('.auto-batch-worktree'))) {
    // 미커밋 로그(run-summary.log 등)는 checkout -f 에 쓸리므로 먼저 보관한다(정직 기록 보존)
    const st = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    const floating = (st.stdout ?? '').split('\n').map((l) => l.slice(3).trim()).filter((f) => f.includes('auto-pipeline-logs/'))
    if (floating.length > 0) {
      const arc = join(STATE_DIR, 'archive', today() + '-' + Date.now())
      mkdirSync(arc, { recursive: true })
      for (const f of floating) { try { cpSync(resolve(f), join(arc, basename(f))) } catch { /* 삭제분 */ } }
    }
    // 미커밋 작업 보존 — checkout -f/clean 은 앞 배치가 STOP 으로 커밋 못 한 소스·테스트
    // 수정을 지운다(실사고: dev 산출물이 리셋에 유실돼 원인 분석 물증까지 소실). 로그·marker·
    // 잔재 로그를 뺀 변경이 있으면 stash 로 보관한다.
    const valuable = (st.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
      .filter((l) => !l.includes('auto-pipeline-logs/'))
      .filter((l) => !l.includes('.auto-batch-worktree'))
      .filter((l) => !/_qa-[^/]*\.log/.test(l))
    if (valuable.length > 0) {
      const stashed = spawnSync('git', ['stash', 'push', '-u', '-m', `slot-preserve ${new Date().toISOString()}`,
        '--', '.', ':(exclude).auto-batch-worktree', ':(exclude)_bmad-output/implementation-artifacts/auto-pipeline-logs'], { encoding: 'utf8' })
      if (stashed.status === 0) {
        console.log(`미커밋 변경 ${valuable.length}건 stash 보관(slot-preserve) — 아침에 사람이 확인 후 pop/drop`)
        notify('미커밋 작업 stash 보관', `앞 배치가 커밋 못 한 변경 ${valuable.length}건을 stash 에 보관했다.\n${valuable.slice(0, 10).join('\n')}`,
          `미커밋 변경 ${valuable.length}건 보관. ${NTFY_BRIEF}`)
      } else {
        console.log(`⚠ stash 보관 실패(${(stashed.stderr ?? '').trim().split('\n')[0]}) — 종전대로 리셋 진행(유실 가능)`)
      }
    }
    // 엔진이 저장소 루트에 남기는 _qa-*.log 류 미추적 잔재를 치운다 — 안 치우면 다음 슬롯의
    // dirty 검사가 exit 4 로 멈춘다. ⚠️ 이 아래 checkout -f 는 이 파일 자신의 미커밋 수정도
    // 지운다 — 러너 수정은 반드시 커밋을 먼저 하고 실행한다(실측).
    spawnSync('git', ['clean', '-fdq', '-e', '.auto-batch-worktree'])
    spawnSync('git', ['fetch', 'origin'], { stdio: 'inherit' })
    const hasToday = spawnSync('git', ['ls-remote', '--exit-code', 'origin', BRANCH], { encoding: 'utf8' }).status === 0
    let ref = `origin/${BRANCH}`
    if (!hasToday) {
      // 오늘 몫 브랜치가 없다 — 미머지 auto/* 를 먼저 실측한다. 원격만 보면 안 된다:
      // 같은 PC 의 대화 세션이 **푸시 전** 로컬 브랜치에서 작업 중일 수 있다(실측). 로컬+원격을 다 본다.
      const list = spawnSync('git', ['for-each-ref', 'refs/heads/auto', 'refs/remotes/origin/auto', '--format=%(refname:short)'], { encoding: 'utf8' })
      const unmerged = [...new Set((list.stdout ?? '').split('\n').filter(Boolean))].filter((b) => {
        const n = spawnSync('git', ['rev-list', '--count', `origin/main..${b}`], { encoding: 'utf8' })
        return Number((n.stdout ?? '0').trim()) > 0
      })
      if (unmerged.length > 0) {
        // ── 선형 승계 — 종전 「휴면」의 대체 ──
        // 미머지 브랜치가 남았다고 쉬면 밤이 통째로 빈다(실측: 하룻밤 9.5시간 유휴). 최신 미머지
        // auto/<날짜> tip 위에서 오늘 브랜치를 시작한다 — main 은 무접촉(사람 머지 원칙 불변)이고,
        // 아침 머지는 최신 브랜치 1개만 합치면 체인 전체가 포함된다(선형). 자정 롤오버 중복 실행
        // 사고는 「안 보이는 베이스(main)로 재시작」이 원인이었으므로, 승계는 그 반대 방향이다.
        // 체인이 길어지는 위험은 편성기의 체인 게이트(신규 착수 보류)가 본다.
        const inh = inheritPlan(unmerged, START_DATE)
        if (inh) {
          ref = inh.ref
          const { day, save } = loadState()
          day.notified ??= {}
          console.log(`선형 승계 — ${inh.ref} 위에서 ${BRANCH} 시작(체인 ${inh.chainAgeDays}일 · 미머지 ${inh.branches.length}브랜치)`)
          if (!day.notified.inherit && !dryRun) {
            notify('선형 승계로 밤 계속', `미머지 ${inh.branches.join(', ')} 위에서 ${BRANCH} 시작.\n체인 ${inh.chainAgeDays}일차${inh.chainAgeDays >= 2 ? ' — 신규 착수는 보류(회수·재검수만). /merge 로 체인을 비우면 전부 재개' : ''}.\n아침 /merge 는 최신 브랜치 1개면 된다(선형)`,
              `미머지 ${inh.branches.length}건 위에서 계속(체인 ${inh.chainAgeDays}일차). ${NTFY_BRIEF}`)
            day.notified.inherit = true
          }
          save()
        } else {
          // 날짜형 이름이 하나도 없다(비정형 브랜치) — 승계 기준을 정할 수 없으니 종전대로 휴면
          const { day, save } = loadState()
          day.notified ??= {}
          console.log(`미머지 비정형 auto 브랜치(${unmerged.join(', ')}) — 승계 기준 불명, 슬롯 휴면`)
          if (!day.notified.unmerged && !dryRun) {
            notify('슬롯 휴면 — 비정형 브랜치', `미머지: ${unmerged.join(', ')} — 사람 확인 필요`,
              `미머지 ${unmerged.length}건 — 사람 확인 필요. ${NTFY_BRIEF}`)
            day.notified.unmerged = true
          }
          save()
          await flushNotify()
          process.exit(0)
        }
      } else {
        ref = 'origin/main'
      }
    }
    const co = spawnSync('git', ['checkout', '-f', '--detach', ref], { stdio: 'inherit' })
    if (co.status !== 0) fail(`워크트리 새로고침 실패(${ref}) — 이 슬롯 중단`, 3)
    console.log(`워크트리 기준: ${ref}`)
  }

  // ③ 연속 중단 차단기 v2 — 「원인 서명」(exit 코드 + 배치 라벨) 2회만 차단하고 **다른 원인은
  //    계속**한다. 종전 단순 카운터는 서로 무관한 STOP 2건에도 밤 전체를 잠갔다. 창 누적 4회는
  //    폭주 백스톱. exit 5(한도)는 종전대로 세지 않는다(고장이 아니라 날씨).
  //    창(낮/밤) 단위로 센다 — 낮 사고가 밤 몫을 잠그지 않게(stopWindowId).
  const { day, win, save } = loadState()
  const winId = stopWindowId(new Date())
  if (stopBlocked(win)) {
    console.log(`이 창(${winId}) 차단 — 같은 원인 STOP 2회 또는 창 누적 4회(아침에 사람이 본다 · /resume 으로 열 수 있다)`)
    // ⚠️ 30분 슬롯이 무기한 반복하므로, 차단이 하루 유지되면 알림 없는 억제가 없을 때 같은 문구가
    // 수십 번 나간다(4시간 슬롯 시절엔 드러나지 않던 결함). 창당 1회로 묶고 리허설은 무발신.
    day.notified ??= {}
    if (day.notified.stopBlocked !== winId && !dryRun) {
      notify('슬롯 중단', `같은 원인 STOP 반복(창 ${winId}) — 자동 편성을 멈췄다. run-summary.log 확인 · /resume 으로 재개 가능.`)
      day.notified.stopBlocked = winId
      save()
    }
    await flushNotify()
    process.exit(0)
  }
}

/** 미머지 auto 체인 실측 → chain-info.json — 편성기의 체인 게이트(신규 착수 보류) 재료.
 *  오늘 것만 미머지면 ageDays=0 이라 게이트는 열린 상태다. */
function writeChainInfo() {
  try {
    const list = spawnSync('git', ['for-each-ref', 'refs/heads/auto', 'refs/remotes/origin/auto', '--format=%(refname:short)'], { encoding: 'utf8' })
    const unmerged = [...new Set((list.stdout ?? '').split('\n').filter(Boolean))].filter((b) => {
      const n = spawnSync('git', ['rev-list', '--count', `origin/main..${b}`], { encoding: 'utf8' })
      return Number((n.stdout ?? '0').trim()) > 0
    })
    const inh = inheritPlan(unmerged, START_DATE)
    writeFileSync(join(STATE_DIR, 'chain-info.json'), JSON.stringify({ ageDays: inh?.chainAgeDays ?? 0, branches: inh?.branches ?? [], at: new Date().toISOString() }) + '\n')
  } catch { /* 체인 실측 실패 = 게이트 0일(신규 허용) — 밤을 세우지 않는다 */ }
}

/** 하향 동기 — 라운드 시작마다 origin/main 을 오늘 브랜치로 가져온다. 낮에 확정·머지된 결정과
 *  큐·승인이 밤 배치에 보이게 하는 통로다. main 은 **무접촉**(가져오기만 · 사람 머지 원칙 불변).
 *  충돌 처분은 runner-rules.downSyncDecision 이 정한다:
 *  resolve(로그·장부 클래스 자동 해소) · defer(문서 충돌 — 동기 없이 라운드 계속, 아침 정식 머지가
 *  합침) · halt(코드 충돌 — 이 라운드 휴면). 같은 지문 2회면 그날은 동기 재시도를 멈춘다(반복 백스톱). */
function doDownSync() {
  if (!existsSync(resolve('.auto-batch-worktree'))) return { ok: true, note: null } // 실행 전용 클론에서만
  spawnSync('git', ['fetch', 'origin', '--quiet'])
  // 브랜치 확립 — detach 상태면 로컬 BRANCH 로(있으면 승계 — 미푸시 커밋 보존, 없으면 HEAD 에서 생성)
  const cur = (spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim()
  if (cur !== BRANCH) {
    const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status === 0
    const sw = spawnSync('git', exists ? ['switch', BRANCH] : ['switch', '-c', BRANCH], { encoding: 'utf8' })
    if (sw.status !== 0) return { ok: true, note: `하향 동기 보류 — 브랜치 전환 실패(${(sw.stderr ?? '').trim().split('\n')[0]})` }
  }
  const behind = Number((spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], { encoding: 'utf8' }).stdout ?? '0').trim())
  if (behind === 0) return { ok: true, note: null }
  const { day, save } = loadState()
  if (day.d2halt) return { ok: true, note: '하향 동기 중단 상태(오늘 반복 충돌) — pre-merge 베이스로 계속' }
  const mg = spawnSync('git', ['-c', 'core.editor=true', 'merge', '--no-edit', '-m', `sync: main→${BRANCH} 하향 동기(낮 확정·큐 반영)`, 'origin/main'], { encoding: 'utf8' })
  if (mg.status === 0) return { ok: true, note: `하향 동기 — origin/main ${behind}커밋 반영` }
  // core.quotePath=false — 기본값이면 한글 경로가 8진 이스케이프 + 따옴표로 나와 `_bmad-output/` 접두
  // 판정이 빗나가고, 문서 충돌(defer)이 코드 충돌(halt)로 오분류돼 라운드가 불필요하게 선다.
  const conflicted = (spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).stdout ?? '')
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  // merge 가 **충돌이 아닌 사유**로 거부될 수 있다(작업 트리 dirty·untracked 덮어쓰기 등). 그때 충돌
  // 목록은 비고, downSyncDecision([]) 은 「해소할 것 없음」으로 resolve + 빈 plan 을 준다 —
  // 그대로 두면 아무것도 안 고친 채 `commit --no-edit` 을 때리는 헛된 경로로 들어간다.
  if (conflicted.length === 0) {
    spawnSync('git', ['merge', '--abort'])
    return { ok: true, note: `하향 동기 보류 — merge 거부(충돌 아님): ${(mg.stderr ?? '').trim().split('\n')[0]}` }
  }
  const dec = downSyncDecision(conflicted)
  if (dec.mode === 'resolve') {
    let landed = true
    for (const [file, how] of Object.entries(dec.plan)) {
      if (how === 'ours') { if (spawnSync('git', ['checkout', '--ours', '--', file]).status !== 0) { landed = false; break } }
      else {
        let merged
        try { merged = stripConflictMarkers(readFileSync(file, 'utf8')) } catch { merged = null }
        if (merged == null) { landed = false; break }
        writeFileSync(file, merged)
      }
      if (spawnSync('git', ['add', '--', file]).status !== 0) { landed = false; break }
    }
    if (landed && spawnSync('git', ['-c', 'core.editor=true', 'commit', '--no-edit'], { encoding: 'utf8' }).status === 0) {
      return { ok: true, note: `하향 동기 — 충돌 ${conflicted.length}파일 자동 해소(로그·장부 클래스)` }
    }
    spawnSync('git', ['merge', '--abort'])
    // 자동 해소 실패는 defer 로 강등 — 밤을 막지 않는다
  } else {
    spawnSync('git', ['merge', '--abort'])
  }
  const fp = conflictFingerprint(conflicted)
  day.d2fp ??= {}
  // 2026-09-02 개정: 백스톱은 halt(코드 충돌)만 센다 — defer/문서 해소 실패까지 세면
  // 무해한 문서 충돌 2회 만에 하루치 동기를 통째로 끈다(19시간 38분 미동기 실사고).
  if (dec.mode === 'halt') {
    day.d2fp[fp] = (day.d2fp[fp] ?? 0) + 1
    if (day.d2fp[fp] >= 2) day.d2halt = true // 같은 코드 충돌 2회 — 오늘 동기 재시도 중단
  }
  day.notified ??= {}
  const first = !day.notified.d2conflict
  day.notified.d2conflict = true
  save()
  if (dec.mode === 'halt') {
    if (first && !dryRun) notify('하향 동기 충돌(코드) — 이 라운드 휴면', `충돌: ${conflicted.slice(0, 6).join(', ')}\n아침 사람 머지가 정식으로 합친다. 밤당 이 알림 1회.`,
      `충돌 ${conflicted.length}파일. ${NTFY_BRIEF}`)
    return { ok: false, note: `하향 동기 코드 충돌(${conflicted.length}파일) — 이 라운드 휴면` }
  }
  if (first && !dryRun) notify('하향 동기 보류(문서 충돌)', `충돌: ${conflicted.slice(0, 6).join(', ')}\n동기 없이 계속 — 아침 사람 머지가 정식으로 합친다.`,
    `충돌 ${conflicted.length}파일. ${NTFY_BRIEF}`)
  return { ok: true, note: `하향 동기 보류 — 문서 충돌 ${conflicted.length}파일(아침 정식 머지 몫), pre-merge 베이스로 계속` }
}

// ── Fable 오케스트레이터 배선 ─────────────────────────────────────────────────
/** 계획 실행기 — 테스트·리허설은 `AUTO_PLAN_RUNNER_STUB`(실제 프로세스 · LLM 아님) 로 주입한다. */
function makePlanRunner() {
  const stub = process.env.AUTO_PLAN_RUNNER_STUB
  const timeoutMs = ORCH.timeoutMin * 60_000
  if (stub) {
    return (prompt) => {
      const r = spawnSync(process.execPath, [stub], { input: prompt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
      if (r.error) throw r.error
      if (r.status !== 0) throw new Error(`계획 스텁 exit ${r.status}`)
      return r.stdout ?? ''
    }
  }
  return makeClaudePlanRunner({ bin: process.env.CLAUDE_BIN || 'claude', model: ORCH.model, cwd: process.cwd(), timeoutMs })
}

// ── 계획 캐시 (2026-09-03 👤 「(가)」) ────────────────────────────────────────
// 무엇을 캐시하나: **후보 지문 → 채택된 계획**. 지문 = 정렬된 후보(키·kind·상태) · 봉쇄 목록 ·
// 남은 상한 · parallel · 미머지 체인 나이 · 모델 가용성(codex 감지 결과)의 sha256. 이 중 하나라도
// 바뀌면 밤의 판단 재료가 바뀐 것이니 다시 묻는다. 안 바뀌었으면 30분마다 같은 답을 사느라
// 한도를 태우지 않는다.
// 안전판 3개: ① 캐시된 계획도 **지금 다시 검증**해야 쓰인다(부분집합 + validatePlan — requestPlan 이
// 캐시 replay 실행기로 같은 관문을 다시 통과시킨다) ② 나이가 `cacheHours` 를 넘으면 버린다
// ③ 폴백(규칙 큐로 되돌아간 결과)은 **캐시하지 않는다** — 다음 슬롯에 다시 시도한다.
// 예외 하나: 실행기 오류가 **연속 3회**면 그 뒤 `cacheHours` 동안은 부르지 않는다(cooldown).
// claude CLI 가 죽어 있는 밤에 슬롯마다 3분씩 타임아웃을 사는 것을 막는 자리다.
const ORCH_CACHE_PATH = join(STATE_DIR, 'orchestrator-cache.json')
const ORCH_RUNNER_ERROR_RE = /^deterministic-fallback\((runner-error|runner-timeout|runner-nonzero|runner-reject)/
const ORCH_COOLDOWN_AFTER = 3

function readOrchCache() {
  try {
    const o = JSON.parse(readFileSync(ORCH_CACHE_PATH, 'utf8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch { return null }
}
/** 원자 쓰기(tmp→rename) — 다음 슬롯이 반쪽 JSON 을 읽지 않는다. 실패해도 밤은 계속 간다. */
function writeOrchCache(obj) {
  try { writeJsonAtomic(ORCH_CACHE_PATH, obj) } catch (e) {
    console.log(`⚠ [ORCHESTRATOR] 계획 캐시 기록 실패(무시하고 계속): ${e?.message ?? e}`)
  }
}
/** 후보 지문 — 순서·서식이 아니라 **내용**만 본다(정렬 후 sha256). */
function orchFingerprint({ stories = [], blocked = [], capLeft = null, parallel = null, chainAgeDays = 0, models = {} }) {
  const payload = {
    v: 1,
    candidates: stories.map((s) => [String(s.key), String(s.kind ?? ''), String(s.status ?? '')]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    blocked: [...blocked].map(String).sort(),
    capLeft, parallel, chainAgeDays, models,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * 규칙 큐를 지휘 모델에게 **재편성**시킨다(선택 · 설정 키가 없으면 꺼짐).
 * 후보는 규칙 큐가 이미 고른 스토리뿐이다 — 지휘는 **묶고 나누는 순서**만 바꾼다. 계획이
 * 검증을 통과하면 큐 파일을 갈아 끼우고, 아니면 규칙 큐 그대로 간다(사유를 로그에 남긴다).
 * 같은 후보 지문이면 지난 계획을 재사용한다(캐시 — 실행기 호출 0).
 */
async function applyOrchestrator(q, outPath) {
  PLAN_SOURCE = 'deterministic'
  PLAN_CACHE_NOTE = null
  if (!ORCH.enabled) return
  const batches = q.batches ?? []
  const keys = batches.flatMap((b) => b.stories ?? [])
  if (keys.length === 0) { console.log('[ORCHESTRATOR] source=deterministic(빈 큐)'); return }

  const metaFor = (key) => {
    const f = readdirSync(ART).find((n) => n.startsWith(key) && n.endsWith('.md'))
    const text = f ? readFileSync(join(ART, f), 'utf8') : ''
    const b = batches.find((x) => (x.stories ?? []).includes(key)) ?? {}
    return {
      key,
      epic: Number(String(key).split('-')[0]) || null,
      kind: /회수/.test(b.label ?? '') ? 'recovery' : /마감/.test(b.label ?? '') ? 'closeout' : 'new',
      files: text ? parseFileList(text) : [],
      deps: text ? parseDependsOn(text) : [],
      stages: b.stages ?? [],
      status: /^Status:\s*(\S+)/m.exec(text)?.[1] ?? '', // 지문 재료 — 같은 후보라도 상태가 바뀌면 다시 묻는다
    }
  }
  const stories = keys.map(metaFor)
  const inSet = new Set(keys.map(String))
  // 후보 밖 선행은 규칙 편성기가 이미 「해소됨」으로 판정한 것이다(그래서 편성됐다).
  // 여기서 다시 미해소로 세면 어떤 계획도 통과하지 못한다 — done 으로 넘겨 **후보 안 순서**만 검증한다.
  const externalDeps = [...new Set(stories.flatMap((s) => s.deps).filter((d) => !inSet.has(d) && ![...inSet].some((k) => k.startsWith(`${d}-`) || k === d)))]
  const dag = buildDag({ stories, epicOrder: Array.isArray(CFG.epicOrder) ? CFG.epicOrder : [] })

  const planArgs = {
    context: { date: today(), candidates: stories },
    dag,
    constraints: { knownKeys: keys, doneKeys: externalDeps, batchMax: PCFG.workers.batchSize },
    deterministic: q,
  }

  /** 채택 — 배치만 갈아 끼운다(defaults·_편성·validation 은 규칙 큐의 것을 유지한다). */
  const adopt = (plan, source, cacheState) => {
    PLAN_SOURCE = source
    PLAN_CACHE_NOTE = cacheState
    console.log(`[ORCHESTRATOR] source=${PLAN_SOURCE} (${cacheState})`)
    q.batches = plan.batches.map((b, i) => ({
      label: b.label || `FABLE-${i + 1}: ${(b.stories ?? []).join(' · ')}`,
      enabled: true,
      stories: b.stories ?? [],
      stages: b.stages ?? (batches.find((x) => (x.stories ?? []).includes(b.stories?.[0]))?.stages ?? ['dev']),
      ...(b.models ? { models: b.models } : {}),
    }))
    q._orchestrator = { source, model: ORCH.model, at: new Date().toISOString(), rationale: plan.rationale ?? '' }
    try { writeFileSync(outPath, JSON.stringify(q, null, 2) + '\n', 'utf8'); return true } catch (e) {
      console.log(`⚠ [ORCHESTRATOR] 채택 계획 기록 실패 — 규칙 큐로 계속: ${e?.message ?? e}`)
      PLAN_SOURCE = 'deterministic-fallback(write-error)'
      return false
    }
  }

  // ── 지문 ──
  const meta = q._편성 ?? {}
  const capNum = Number(meta.cap)
  const fingerprint = orchFingerprint({
    stories,
    blocked: (meta.excluded ?? []).map((e) => `${e?.key ?? ''}|${e?.why ?? ''}`),
    capLeft: Number.isFinite(capNum) ? Math.max(0, capNum - Number(meta.alreadyPlannedToday ?? 0)) : null,
    parallel: Number(q.defaults?.parallel) || null,
    chainAgeDays: Number(meta.chainAgeDays ?? 0),
    models: { codex: PCFG.providers.codex.enabled ? await codexAvailable() : false },
  })
  const cache = readOrchCache()
  const ageH = cache?.at ? (Date.now() - Date.parse(cache.at)) / 3_600_000 : NaN

  // ① 캐시 적중 — 실행기를 부르지 않는다. 단 **지금 규칙으로 다시 검증**해서 통과할 때만 쓴다.
  if (cache?.plan && cache.fingerprint === fingerprint && Number.isFinite(ageH) && ageH >= 0 && ageH <= ORCH.cacheHours) {
    const hit = await requestPlan({ ...planArgs, runner: () => JSON.stringify(cache.plan) })
    if (hit.source === 'fable') { adopt(hit.plan, 'fable(cache)', 'cache hit'); return }
    console.log(`⚠ [ORCHESTRATOR] 캐시 계획이 지금 규칙을 통과하지 못한다(${hit.source}) — 다시 묻는다`)
  }

  // ② 쿨다운 — 실행기가 연속으로 죽은 뒤에는 `cacheHours` 동안 부르지 않는다(밤을 세우지 않는 쪽이 이긴다).
  if (cache?.cooldownUntil && Date.parse(cache.cooldownUntil) > Date.now()) {
    PLAN_SOURCE = 'deterministic-fallback(runner-cooldown)'
    PLAN_CACHE_NOTE = 'cache cooldown'
    console.log(`[ORCHESTRATOR] source=${PLAN_SOURCE} (cache cooldown)`)
    return
  }

  /** 실행기 오류 누적 — 3회째에 쿨다운을 건다. 캐시된 계획(plan·fingerprint)은 건드리지 않는다. */
  const noteRunnerError = () => {
    const errors = Number(cache?.runnerErrors ?? 0) + 1
    const next = { ...(cache ?? {}), runnerErrors: errors }
    if (errors >= ORCH_COOLDOWN_AFTER) next.cooldownUntil = new Date(Date.now() + ORCH.cacheHours * 3_600_000).toISOString()
    writeOrchCache(next)
  }
  /** 실행기는 살아 있었다(형식 불량·검증 거부) — 연속 오류 계수를 지운다. */
  const clearRunnerErrors = () => {
    if (!cache || !Number(cache.runnerErrors ?? 0)) return
    writeOrchCache({ ...cache, runnerErrors: 0, cooldownUntil: null })
  }

  let runner
  try { runner = makePlanRunner() } catch (e) {
    PLAN_SOURCE = 'deterministic-fallback(runner-reject)'
    PLAN_CACHE_NOTE = 'cache miss'
    console.log(`[ORCHESTRATOR] source=${PLAN_SOURCE} (cache miss)`)
    console.log(`⚠ [ORCHESTRATOR] 계획 실행기 거부: ${e?.message ?? e}`)
    noteRunnerError()
    return
  }
  const res = await requestPlan({ ...planArgs, runner })
  if (res.source === 'fable') {
    if (!adopt(res.plan, 'fable', 'cache miss')) return
    const plan = { ...res.plan } // 캐시에는 계획 본문만 — 출처·오류 상세는 그때그때 다시 붙인다
    delete plan.source
    delete plan.errorDetail
    writeOrchCache({ fingerprint, at: new Date().toISOString(), plan, source: 'fable', model: ORCH.model, runnerErrors: 0, cooldownUntil: null })
    return
  }
  // 폴백은 **캐시하지 않는다** — 다음 슬롯에 다시 시도한다(실행기 오류만 계수한다).
  PLAN_SOURCE = res.source
  PLAN_CACHE_NOTE = 'cache miss'
  console.log(`[ORCHESTRATOR] source=${PLAN_SOURCE} (cache miss)`)
  if (ORCH_RUNNER_ERROR_RE.test(res.source)) noteRunnerError()
  else clearRunnerErrors()
}

// ④ 큐 선택 — 사람이 쓴 큐(planned!=='auto')가 항상 이긴다. 단 하루 1회(소비 표식).
//    반환: 큐 경로(자동 편성 0건이면 null — 오늘 몫 소진).
async function selectQueue() {
  const { s, save } = loadState()
  if (existsSync(manualQueuePath)) {
    try {
      const q = JSON.parse(readFileSync(manualQueuePath, 'utf8'))
      const h = sha(manualQueuePath)
      const consumedBefore = s.consumed[h] || Object.values(s.days).some((d) => d.consumed?.[h])
      if (q.planned !== 'auto' && !consumedBefore) {
        // 리허설은 큐를 **소모하지 않는다** — 같은 함수의 `--no-ledger`(하루 상한 원장 불소모)와
        // 같은 규율이다. 표식을 남기면 리허설 한 번이 그날 수동 큐를 통째로 삼킨다.
        if (!dryRun) {
          s.consumed[h] = new Date().toISOString()
          save()
        }
        return { path: manualQueuePath, meta: null }
      }
    } catch { /* 깨진 큐는 수동으로 안 친다 */ }
  }
  const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '')
  const autoOut = join(STATE_DIR, `auto-queue-${today()}-${hhmm}.json`)
  const planArgs = [resolve('tools/auto/plan-queue.mjs'), '--out', autoOut, '--state', STATE_DIR]
  if (dryRun) planArgs.push('--no-ledger') // 리허설이 하루 상한 원장을 소모하지 않는다
  const planRun = spawnSync(process.execPath, planArgs, { stdio: 'inherit' })
  if (planRun.status !== 0) fail('편성기 실패 — 이 슬롯 중단(빈 큐를 정상인 척 돌리지 않는다)', 3)
  const q = JSON.parse(readFileSync(autoOut, 'utf8'))
  const meta = q._편성 ?? null
  PLAN_VALIDATION = q.validation ?? null // 편성기 자기 검증 — 요약·알림이 「왜 빠졌나」를 근거로 읽는다
  if (PLAN_VALIDATION && !PLAN_VALIDATION.ok) {
    console.log(`[PLAN][VALIDATION] RED — 오류 ${PLAN_VALIDATION.errors.length}건: ${PLAN_VALIDATION.errors.slice(0, 3).map((e) => `${e.code}${e.key ? `[${e.key}]` : ''}`).join(', ')}`)
  }
  await applyOrchestrator(q, autoOut)
  if ((q.batches ?? []).length === 0) {
    console.log('편성 결과 0건 — 이 슬롯은 할 일이 없다')
    const blocked = (meta?.excluded ?? []).filter((e) => e.why.includes('결정 대기')).length
    if (blocked > 0 && !dryRun) notify('할 일 0 · 결정 대기', `결정 대기가 스토리 ${blocked}개를 막고 있다 — DECISIONS-INBOX.md`,
      `결정 대기가 스토리 ${blocked}개를 막는 중. ${NTFY_BRIEF}`)
    return null
  }
  return { path: autoOut, meta }
}

// ── 워크트리 워커 환경 (2026-09-02 codex-review-r2 N2 보조) ────────────────────────────
// 워크트리는 본 트리의 `.git/config` 를 **공유**한다 — `git -C <워크트리> config credential.helper ""` 는
// 공유 config 를 고쳐 본 트리(대화 세션·landing·push)의 자격증명까지 끈다. `git config --worktree` 는
// `extensions.worktreeConfig=true` 라는 저장소 설정을 켜야 하는데, 그건 사람 저장소의 영구 상태 변경이다.
// 그래서 **프로세스 환경**으로 끈다: `GIT_CONFIG_COUNT/KEY_0/VALUE_0` 는 그 프로세스와 자식에게만
// 적용되는 in-flight config 라, 워커(엔진 → nested 워커)가 부르는 git 은 credential.helper 가 빈 값이 된다
// (= 저장된 원격 자격증명이 워크트리 쪽으로 상속되지 않는다). landing·push 는 러너 본 트리에서만 하므로
// 이 환경은 그쪽에 닿지 않는다. 완전한 경계는 아니다(워커가 스스로 GIT_CONFIG_* 를 덮어쓸 수 있다) —
// N2 의 근본 해결은 워커 OS 샌드박스이고, 이것은 그 전까지의 얕은 방어다.
const WORKTREE_ENV = Object.freeze({
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
})

// ── 통합 게이트 · push · 배치 매니페스트 (병렬·순차 **공통**) ─────────────────────────────
// 2026-09-02 codex-review-r2 N1: 종전에는 이 세 가지가 병렬 경로 안에만 있었고, 순차 경로는
// 엔진에 `--push` 를 그대로 넘겨 **스토리마다 즉시 push** 했다. 두 스토리가 각자 qa GREEN 으로
// 원격에 올라간 뒤 합쳐진 트리가 RED 여도, 원격에는 이미 RED 조합이 남는다(프로세스만 exit 1).
// 이제 두 경로 모두 「전 스토리 → 통합 게이트 → GREEN 일 때만 러너가 1회 push」다.
//
/** 통합 게이트 실행 — RED 는 **설정으로 우회되지 않는다**(hardening #5). 되돌리고 STOP·push 금지.
 *  @returns {{integration: object, skipPush: boolean, worst: number}} */
function runIntegrationGate({ landedStories, landingBase, batchId, timeoutMin, record }) {
  let skipPush = false
  let worst = 0
  /** 통합 결과를 각 스토리 검증 매니페스트에 병합 — **없으면 만들지 않고 경고**한다(빈 껍데기 매니페스트는 거짓 증거다) */
  const applyStoryManifests = (result) => {
    const touched = [], missing = []
    for (const l of landedStories) {
      const p = join(LOG_DIR, `${l.story}-verification.json`)
      if (!existsSync(p)) { missing.push(l.story); continue }
      try {
        writeFileSync(p, JSON.stringify(applyIntegrationToManifest(JSON.parse(readFileSync(p, 'utf8')), result), null, 2) + '\n', 'utf8')
        touched.push(p)
      } catch (e) { missing.push(`${l.story}(${e?.message ?? e})`) }
    }
    if (missing.length) record(`⚠ [INTEGRATION] 검증 매니페스트 없음/갱신 실패 — ${missing.join(', ')}(새로 만들지 않는다)`)
    return touched
  }
  const gate0 = integrationGateDecision({ enabled: PCFG.integrationGate.enabled, landedCount: landedStories.length, qaExit: null })
  let integration = { result: 'pass', qaExit: null, landingBase, at: new Date().toISOString(), ran: false, batchId }
  if (gate0.run && !dryRun) {
    // (BRIEF 정책 8 · codex-review-r3 M5) 셸 문자열 결합 제거 — `npm(.cmd) run <이름>` argv 경로다.
    // 게이트 이름에 셸 메타문자가 있으면 **실행 전에** 거부하고, 그 라운드는 RED 로 본다(우회 금지).
    let inv = null
    try { inv = integrationGateInvocation(QA_CMD) } catch (e) {
      record(`[INTEGRATION][REJECT] ${e?.message ?? e}`)
      const bad = { result: 'fail', qaExit: 2, landingBase, at: new Date().toISOString(), ran: false, batchId, why: '게이트 명령 거부' }
      return { integration: bad, skipPush: true, worst: 7 }
    }
    record(`[INTEGRATION][RUN] landing ${landedStories.length}건 뒤 통합 게이트: ${inv.display}`)
    const g = spawnSync(inv.file, inv.argv, { shell: false, windowsVerbatimArguments: inv.verbatim, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMin * 60 * 1000, windowsHide: true })
    mkdirSync(LOG_DIR, { recursive: true })
    // (N3/정책 2) 통합 로그도 마스킹해서 적는다 — 종전엔 qa stdout/stderr 원문이 그대로 남았다.
    writeFileSync(join(LOG_DIR, 'integration-gate.log'), REDACT(`# ${inv.display}\n\n## stdout\n${g.stdout ?? ''}\n\n## stderr\n${g.stderr ?? ''}\n`), 'utf8')
    const qaExit = g.status ?? 1
    const gate = integrationGateDecision({ enabled: true, landedCount: landedStories.length, qaExit })
    if (gate.action === 'push') {
      record(`[INTEGRATION][PASS] ${gate.why} (log=auto-pipeline-logs/integration-gate.log)`)
      integration = { result: 'pass', qaExit, landingBase, at: new Date().toISOString(), ran: true, batchId }
      const touched = applyStoryManifests(integration)
      // 매니페스트 갱신분은 **커밋해 둔다** — 남겨 두면 작업 트리가 dirty 로 남아 다음 라운드의 cherry-pick 이
      // 같은 파일에서 거부된다(landing 실패로 둔갑). ignore 대상이면 add 가 아무것도 안 하고 commit 이 조용히 실패한다.
      if (touched.length) {
        spawnSync('git', ['add', '--', ...touched])
        if (spawnSync('git', ['-c', 'core.editor=true', 'commit', '-m', 'chore(batch): 통합 게이트 결과 매니페스트 반영', '--', ...touched], { encoding: 'utf8' }).status === 0) {
          record(`- 매니페스트 커밋: 통합 결과 pass ${touched.length}건`)
        }
      }
    } else {
      // ⛔ 유일한 RED 경로다. `pushOnFail` 같은 설정 우회는 없다(hardening #5) — 되돌리고 STOP·push 금지.
      for (const l of landedStories) spawnSync('git', ['tag', `archive/integration-fail-${l.story}-${Date.now()}`, l.head])
      // (N6/정책 16) reset 은 이 라운드의 스토리 매니페스트까지 되돌린다 — **되돌리기 전에** 원본을 읽어 둔다.
      // 여기서 안 읽으면 「rollback 됐다」는 사실이 story 단위 도구에는 영영 남지 않는다(배치 매니페스트만 안다).
      const snapshots = []
      for (const l of landedStories) {
        const p = join(LOG_DIR, `${l.story}-verification.json`)
        if (!existsSync(p)) continue
        try { snapshots.push({ story: l.story, json: JSON.parse(readFileSync(p, 'utf8')) }) } catch { /* 손상 매니페스트는 건너뛴다 */ }
      }
      skipPush = true // reset 성공 여부와 무관하게 **먼저** 막는다
      const rs = spawnSync('git', ['reset', '--hard', landingBase], { encoding: 'utf8' })
      const nowHead = headSha() // 「reset 을 불렀다」가 아니라 「되돌아갔다」를 확인한다
      const reverted = rs.status === 0 && nowHead === landingBase
      integration = { result: reverted ? 'rollback' : 'fail', qaExit, landingBase, at: new Date().toISOString(), ran: true, head: nowHead, batchId }
      if (reverted) {
        record(`[INTEGRATION][FAIL] ${gate.why} — landing ${landedStories.length}건 되돌림(${landingBase.slice(0, 7)}) · 산출물 archive/integration-fail-* 태그 · log=auto-pipeline-logs/integration-gate.log`)
        notify('통합 게이트 RED', `landing ${landedStories.length}건이 합쳐진 트리에서 qa RED — 되돌리고 STOP. archive/integration-fail-* 태그와 integration-gate.log 확인`,
          `통합 게이트 RED · landing ${landedStories.length}건 되돌림. ${NTFY_BRIEF}`)
        worst ||= 1
      } else {
        record(`[INTEGRATION][ROLLBACK-FAIL] ${gate.why} — **되돌림 실패**(HEAD ${nowHead.slice(0, 7)} ≠ ${landingBase.slice(0, 7)}${rs.status !== 0 ? ` · git reset exit ${rs.status}: ${(rs.stderr ?? '').trim().split('\n')[0]}` : ''}) · push 는 막았다 · 사람이 브랜치를 직접 확인해야 한다`)
        notify('통합 게이트 RED + 되돌림 실패 — 사람 확인 필요', `qa RED 뒤 \`git reset --hard ${landingBase}\` 가 듣지 않았다(HEAD=${nowHead}). push 는 막았고 배치는 STOP.\n브랜치 ${BRANCH} 를 사람이 직접 정리해야 한다. archive/integration-fail-* 태그에 산출물 보존.`,
          `통합 RED 되돌림 실패 · push 차단 · 사람 확인. ${NTFY_BRIEF}`)
        worst = 7 // 되돌림 실패는 일반 실패보다 위 — 아침에 반드시 눈에 걸리게
      }
      // 추적 매니페스트 자체는 **되돌린 그대로 둔다** — 지금 결과를 덮어쓰면 ① 남아 있는 것이 이전 라운드
      // 산출물일 때 남의 기록을 고치고 ② 추적 파일이 수정된 채 남아 다음 라운드 cherry-pick 이 거부된다.
      // 대신 (N6) 스냅샷에 rollback 을 새겨 ⓐ 상태 폴더 증거 영역과 ⓑ 미추적 sidecar 두 곳에 남긴다.
      Object.assign(integration, writeRollbackManifests({ snapshots, integration, batchId, record }))
      const stale = landedStories.filter((l) => existsSync(join(LOG_DIR, `${l.story}-verification.json`))).map((l) => l.story)
      record(`⚠ [INTEGRATION] 검증 매니페스트 없음/갱신 생략 — 되돌림과 함께 사라졌다(통합 결과 ${integration.result} 는 배치 매니페스트·rollback sidecar 가 보관)${stale.length ? ` · 남아 있는 ${stale.join(', ')} 는 이전 라운드 것이라 건드리지 않는다` : ''}`)
    }
  } else if (gate0.run && dryRun) record(`[INTEGRATION][DRY] ${QA_CMD} (리허설 — 실행 안 함)`)
  return { integration, skipPush, worst }
}

/** (N6/정책 16) rollback 결과를 스토리 단위로 남긴다 — 증거 폴더 사본 + 워크트리 미추적 sidecar.
 *  sidecar 이름에 batchId 를 넣어 **이전 라운드 파일을 덮지 않는다**. 추적 파일은 건드리지 않는다. */
function writeRollbackManifests({ snapshots, integration, batchId, record }) {
  if (snapshots.length === 0) return { storyManifests: [], evidenceDir: null }
  const evidenceDir = join(STATE_DIR, 'archive', `${today()}-${Date.now()}-evidence`)
  const storyManifests = []
  for (const s of snapshots) {
    const merged = applyIntegrationToManifest(s.json, integration)
    const body = REDACT(JSON.stringify(merged, null, 2)) + '\n'
    let evidence = null, sidecar = null
    try {
      mkdirSync(join(evidenceDir, s.story), { recursive: true })
      evidence = join(evidenceDir, s.story, 'verification.json')
      writeFileSync(evidence, body, 'utf8')
    } catch (e) { record(`⚠ [INTEGRATION] rollback 증거 기록 실패 — ${s.story}: ${e?.message ?? e}`); evidence = null }
    try {
      const p = join(LOG_DIR, `${s.story}-verification.rollback-${batchId}.json`)
      if (!existsSync(p)) writeFileSync(p, body, 'utf8') // 같은 batchId 재실행이어도 앞 기록을 덮지 않는다
      sidecar = p
    } catch (e) { record(`⚠ [INTEGRATION] rollback sidecar 기록 실패 — ${s.story}: ${e?.message ?? e}`) }
    storyManifests.push({ story: s.story, result: merged.integration.result, evidence, sidecar })
  }
  record(`- [INTEGRATION] rollback 기재 ${storyManifests.length}건 — 증거 ${evidenceDir} · sidecar auto-pipeline-logs/<story>-verification.rollback-${batchId}.json`)
  return { storyManifests, evidenceDir }
}

/** 브랜치 push 1회 — 게이트가 막았으면(`skipPush`) 어떤 설정으로도 나가지 않는다.
 *  (2026-09-03 👤 「무료 운영 안전장치 ②④」) 실제 push 는 `safeGitPush` 가 소유한다 — ref 가 `auto/*` 가 아니거나
 *  현재 브랜치와 다르면(설정 오류·승계 사고) 밀지 않고, 미는 몫의 diff 에 금지 경로·시크릿이 있어도 밀지 않는다
 *  (러너가 cherry-pick·매니페스트 커밋을 직접 만들므로 엔진의 스테이징 검사만으로는 빈틈이 남는다). */
function pushBranchOnce({ enabled, skipPush, record }) {
  let pushed = false
  if (enabled && !dryRun && !skipPush) {
    const r = safeGitPush({ ref: BRANCH })
    if (r.verdict) {
      record(`✖ PUSH GUARD STOP — ${r.verdict}. push 하지 않았다(로컬 커밋은 그대로) — 사람 확인 필요.`)
      notify('PUSH GUARD STOP', `${r.verdict}\npush 를 멈췄다 — 로컬 커밋은 남아 있다.`, `PUSH GUARD STOP — ${r.verdict}`)
      return false
    }
    if (!r.ok) record(`⚠ push 실패(계속): ${r.out.trim().split('\n').slice(-1)[0]} — 아침에 사람 재시도`)
    else pushed = true
  }
  return pushed
}

/** 배치 매니페스트 — 「무엇을 어떤 순서로 landing 했고 통합 결과가 무엇이며 push 했는가」 한 장(아침 브리핑·사후 추적 재료). */
function writeBatchManifest({ batchId, label, stories, stages, workers, mode, landedStories, failed, integration, pushed, worst, record }) {
  if (dryRun) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const mp = join(LOG_DIR, `batch-${batchId}-manifest.json`)
    writeFileSync(mp, JSON.stringify({
      schema: 'night-batch-ops/batch-manifest/1',
      batchId, label, branch: BRANCH, at: new Date().toISOString(), mode,
      stories, stages, workers,
      landing: landedStories.map((l, i) => ({ order: i + 1, story: l.story, head: l.head })),
      failed,
      integration, pushed, worst,
    }, null, 2) + '\n', 'utf8')
    record(`- 배치 매니페스트: auto-pipeline-logs/${basename(mp)} (통합 ${integration.result}${integration.ran ? '' : '(미실행)'} · push ${pushed ? '함' : '안 함'})`)
  } catch (e) { record(`⚠ 배치 매니페스트 기록 실패: ${e?.message ?? e}`) }
}

/** 순차 경로의 landing 목록 — 엔진이 스토리마다 남긴 `auto(<story>): …` 커밋을 시간순으로 읽는다.
 *  통합 게이트가 「무엇을 되돌리고 무엇을 태그로 보존할지」 알려면 병렬과 같은 모양의 목록이 필요하다. */
function landedStoriesFromCommits(baseSha, stories = []) {
  if (!baseSha) return []
  const rev = spawnSync('git', ['rev-list', '--reverse', `${baseSha}..HEAD`], { encoding: 'utf8' })
  if (rev.status !== 0) return []
  const want = new Set(stories.map(String))
  const out = []
  for (const sha of (rev.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    const subject = (spawnSync('git', ['log', '-1', '--format=%s', sha], { encoding: 'utf8' }).stdout ?? '').trim()
    const m = /^auto\((.+?)\):/.exec(subject)
    if (!m) continue
    if (want.size > 0 && !want.has(m[1])) continue
    out.push({ story: m[1], head: sha })
  }
  return out
}

// 병렬 실행 — File List 가 겹치지 않는 dev 전용 배치를 워크트리 분리로 동시 실행한다.
// 흐름: ① 실측 File List 대조(수동 큐 방어) ② 스토리별 임시 워크트리(detached · node_modules
// junction · env 복사) ③ 엔진을 워크트리 cwd 로 병렬 spawn — `--commit` 만 켜서 **엔진 가드
// (화이트리스트·시크릿 스캔) 그대로 detached HEAD 에 커밋** ④ landing = 러너가 배치 트리에서
// cherry-pick 직렬(공유 장부는 3-way 가 합침 · 충돌 = 그 스토리만 실패 + archive/parallel-* 태그
// 보존) ⑤ push 1회 ⑥ 워크트리 제거. 엔진 무수정. 점화 = 큐 defaults.parallel ≥ 2.
// 반환: { code } 또는 null(병렬 조건 미충족 — 호출부가 순차 폴백).
async function runBatchParallel({ batch, defaults, workers, record }) {
  const storyList = batch.stories
  const batchStarted = new Date().toISOString() // 계측 벽시계 시작(폴백으로 끝나면 쓰이지 않는다)
  const storyText = storyList.map((s) => {
    const f = readdirSync(ART).find((n) => n.startsWith(s) && n.endsWith('.md'))
    return f ? readFileSync(join(ART, f), 'utf8') : null
  })
  const lists = storyText.map((t) => (t == null ? null : parseFileList(t)))
  // 빈 목록(절은 있는데 항목 0 — 아직 dev 안 돈 스펙)도 「모르는 것」이다 — 파일을 모르는 채
  // 병렬로 돌리면 겹침 판정이 무의미하다. 신규 스토리를 병렬로 돌리려면 지시서에 예상 File List 를 채운다.
  if (lists.some((l) => l == null || l.length === 0)) { record('· 병렬 폴백 — File List 부재/빈 목록 스토리 존재(모르는 채 병렬 금지)'); return null }
  if (fileListConflicts(lists)) { record('· 병렬 폴백 — File List 실측 겹침'); return null }
  // 내장 toolchain 검사 + **확장 충돌 판정기 주입**(conflicts.parallelHazardsCompat).
  // 마이그레이션 번호 경합·생성물 스키마·API 계약·공유 설정·테스트 환경은 File List 가 겹치지 않아도
  // 병렬이 깨진다 — 걸리면 자동으로 뭉개지 않고 **순차로 내려간다**(사유를 로그에 남긴다).
  const hz = parallelHazards(lists, { judges: [parallelHazardsCompat] })
  if (!hz.ok) { record(`· 병렬 폴백 — [PARALLEL][HAZARD] ${hz.why}`); return null }

  // 배치 트리를 오늘 브랜치로(순차 경로에선 엔진 ensureBranch 몫 — 병렬은 러너가 선다)
  const cur = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  if (cur !== BRANCH) {
    const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status === 0
    const sw = spawnSync('git', exists ? ['switch', BRANCH] : ['switch', '-c', BRANCH], { encoding: 'utf8' })
    if (sw.status !== 0) { record(`· 병렬 폴백 — 브랜치 전환 실패: ${(sw.stderr ?? '').trim().split('\n')[0]}`); return null }
  }

  const wtBase = resolve('..')
  const myName = basename(process.cwd())
  const wts = []
  const cleanup = () => {
    for (const w of wts) {
      spawnSync('git', ['worktree', 'remove', '--force', w.dir])
      // node_modules junction(대상 부재 시)·잠긴 파일로 git 이 폴더를 못 지우면 직접 지운다 — 남은 폴더는 다음 라운드의
      // `worktree add` 를 막지는 않지만(remove --force 선행) 디스크와 혼란을 남긴다(2026-09-02 e2e 실측).
      if (existsSync(w.dir)) { try { rmSync(w.dir, { recursive: true, force: true }) } catch { /* 잠긴 파일 — 다음 라운드가 재시도 */ } }
    }
    spawnSync('git', ['worktree', 'prune'])
  }
  for (let i = 0; i < storyList.length; i++) {
    const dir = join(wtBase, `${myName}-wt${i}`)
    spawnSync('git', ['worktree', 'remove', '--force', dir]) // 잔재 정리(없으면 무해)
    const add = spawnSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { encoding: 'utf8' })
    if (add.status !== 0) { record(`· 병렬 폴백 — worktree 생성 실패: ${(add.stderr ?? '').trim().split('\n')[0]}`); cleanup(); return null }
    wts.push({ story: storyList[i], dir, base: spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() })
    try {
      symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'junction') // 워크트리별 npm ci 회피
    } catch (e) {
      record(`· 병렬 폴백 — node_modules 연결 실패: ${e?.message ?? e}`); cleanup(); return null
    }
    for (const f of ['.env.local', '.env.production']) if (existsSync(resolve(f))) cpSync(resolve(f), join(dir, f)) // qa 스모크·배포 가드용(gitignore)
    // nested 워커 deny 설정(pipeline-settings.json)은 **사본을 흩뿌리지 않는다** — 러너가 시작 시 실측한
    // 절대경로를 `--pipeline-settings` 로 넘긴다(engineArgsFor). 워크트리에 그 파일이 없어도 워커가 본다.
  }
  record(`· 병렬 실행 ${workers}폭 — dev 만 병렬, 커밋 가드는 엔진 그대로, landing·push 는 직렬`)

  // ── 워커 배정(assign.assignWorkers) + 프로바이더별 동시 상한 ──
  // 종전 홀짝 분할(runner-rules.assignProviders)을 대체한다: 난이도·위험도·역할·슬롯 상한·과거
  // 성적으로 나눈다. 불변식 = 고위험 dev 는 Codex 에 주지 않는다 / review 는 dev 와 다른 눈 /
  // 같은 프로바이더가 그 스토리에서 연속 2회 실패했으면 회피. 설정이 없으면 배치 models 그대로다.
  const codexOk = await codexAvailable()
  const blocked = [] // exit-info 로 한도·인증이 확인된 프로바이더 — 남은 스토리는 다른 레인으로(08-29 「한도 = 레인 전환 신호」)
  const history = readAssignHistory()
  const kindOf = /회수/.test(batch.label ?? '') ? 'recovery' : /마감/.test(batch.label ?? '') ? 'closeout' : 'new'
  const storyInput = (key) => {
    const i = storyList.indexOf(key)
    return { key, kind: kindOf, files: i >= 0 ? (lists[i] ?? []) : [], text: i >= 0 ? (storyText[i] ?? '') : '' }
  }
  const reassign = (list) => {
    const assigned = assignWorkers({
      stories: list.map((w) => storyInput(w.story)),
      roles: (batch.stages ?? ['dev']).filter((s) => s === 'dev' || s === 'review'),
      providers: {
        claude: { enabled: !blocked.includes('claude'), available: !blocked.includes('claude'), max: PCFG.providers.claude.max },
        codex: {
          enabled: Boolean(PCFG.providers.codex.enabled) && !blocked.includes('codex'),
          available: codexOk && !blocked.includes('codex'),
          max: PCFG.providers.codex.max,
          roles: PCFG.providers.codex.roles,
          split: Boolean(PCFG.providers.codex.split),
        },
      },
      history,
      config: { models: batch.models ?? {}, split: Boolean(PCFG.providers.codex.split) },
    })
    for (const a of assigned) {
      const w = list.find((x) => x.story === a.story)
      if (!w) continue
      let { dev, review, why } = a
      // claude 레인이 막혔고 codex 가 dev 를 맡을 수 있으면 그쪽으로 넘긴다(한도 = 레인 전환 신호).
      // assignWorkers 는 「codex 를 줄지」만 판단하므로 이 방향은 러너가 붙인다.
      if (blocked.includes('claude') && codexOk && (PCFG.providers.codex.roles ?? []).includes('dev') && specProvider(dev) === 'claude') {
        dev = 'codex'
        why = `${why} · claude 레인 차단 — codex dev 로 전환`
      }
      w.dev = dev
      w.review = review
      w.devProvider = specProvider(dev)
      w.reviewProvider = specProvider(review)
      w.assignWhy = why
      if (PCFG.configured) record(`· [ASSIGN] ${w.story} dev=${dev || '(기본)'}(${w.devProvider}) review=${review || '(없음)'}(${w.reviewProvider}) — 난이도 ${a.difficulty}·위험 ${a.risk}${a.flags.length ? `(${a.flags.join(',')})` : ''} · ${why}`)
    }
  }
  reassign(wts)
  const caps = { total: workers, claude: PCFG.providers.claude.max, codex: PCFG.providers.codex.max }
  if (PCFG.configured) record(`· 워커 풀 — 총 ${caps.total} · claude ${caps.claude} · codex ${caps.codex}${codexOk ? '' : '(불가 → claude)'} · 배정: ${wts.map((w) => `${w.story.split('-').slice(0, 2).join('-')}=${w.devProvider}`).join(' ')}`)

  const engineArgsFor = (wt) => {
    // 배치의 stages 그대로 — dev 전용(회수)뿐 아니라 dev+review(신규)도 워크트리 안에서 완주하고
    // 커밋 1개로 landing 한다(리뷰 findings 도 그 커밋의 스토리 md 에 실린다).
    const a = [ENGINE, '--stories', wt.story, '--stages', (batch.stages ?? ['dev']).join(','),
      '--pipeline-settings', PIPELINE_SETTINGS, // 워크트리에 `.claude/` 가 없어도 nested deny 가 적용되게(절대경로)
      '--stage-timeout-min', String(batch.stageTimeoutMin ?? defaults.stageTimeoutMin ?? 120),
      '--wait-auth-min', String(waitAuthMin(autoPlan, batch.waitAuthMin, defaults.waitAuthMin))]
    for (const [stage, model] of Object.entries(batch.models ?? {})) if (model && stage !== 'dev' && stage !== 'review') a.push(`--${stage}-model`, model)
    if (wt.dev) a.push('--dev-model', wt.dev)
    if (wt.review) a.push('--review-model', wt.review)
    if (batch.force) a.push('--force')
    a.push('--commit') // 브랜치·푸시 없음 — detached HEAD 커밋(엔진 기존 지원 경로). landing 은 아래 직렬.
    a.push(...engineFlagsFromConfig(PCFG)) // 설정 없으면 [] — 종전 명령줄 그대로
    return a
  }
  const runOne = (wt) => new Promise((done) => {
    const started = new Date().toISOString()
    const finishOne = (c) => {
      // 워커 슬롯 점유 구간 — 계측의 「유휴시간·병렬 효율」이 이 값 위에 선다.
      wt.metrics = { kind: 'story', story: wt.story, provider: wt.devProvider, model: wt.dev ?? '', start: started, end: new Date().toISOString(), exit: c }
      done({ story: wt.story, code: c })
    }
    const child = spawn(process.execPath, engineArgsFor(wt), { cwd: wt.dir, stdio: 'inherit', env: WORKTREE_ENV })
    child.on('close', (c) => finishOne(c ?? 1))
    child.on('error', () => finishOne(1))
  })
  // 워커 풀 — 프로바이더별 상한(codex 기본 1)·총 상한을 지키며 순서대로 시작한다. 한 워커의 실패는 그 스토리만의 것이다.
  const pending = [...wts]
  const running = new Map()
  const outs = []
  await new Promise((finish) => {
    const tick = () => {
      for (const wt of pickRunnable(pending, [...running.values()], caps)) {
        pending.splice(pending.indexOf(wt), 1)
        running.set(wt.story, wt)
        console.log(`[${wt.story}][${wt.devProvider.toUpperCase()}][DEV] spawn wt=${wt.dir} · 동시 ${running.size}/${caps.total}${wt.review ? ` · review=${wt.review}` : ''}`)
        runOne(wt).then((o) => {
          running.delete(wt.story)
          outs.push(o)
          // 워크트리 로그는 **제거 전에** 읽는다(cleanup 뒤엔 없다) — 단계 타임라인·Codex 토큰의 유일한 원본.
          wt.stageEvents = readWorktreeTimeline(wt)
          console.log(`[${wt.story}][${wt.devProvider.toUpperCase()}][DEV] exit=${o.code} · 남은 대기 ${pending.length} · 실행 중 ${running.size}`)
          const info = readExitInfo(wt.dir)
          const bp = blockedProviderFromExit(info)
          if (bp && !blocked.includes(bp) && pending.length > 0) {
            blocked.push(bp)
            reassign(pending)
            record(`- ⚠ ${bp} 레인 ${info.kind}(${info.why ?? ''}) — 남은 병렬 스토리 ${pending.length}건은 ${pending.map((p) => p.devProvider).join('/')} 레인으로 재배정`)
          }
          tick()
        })
      }
      if (pending.length === 0 && running.size === 0) finish()
    }
    tick()
  })

  // landing — 원래 배치 순서 그대로 직렬(같은 브랜치 커밋 경합 방지). 실패 스토리는 건너뛰되
  // 나머지는 마저 반영한다(성공분을 버리지 않는다), 끝에 배치 STOP 으로 보고.
  let worst = 0
  const landingBase = headSha() // 통합 게이트 RED 시 여기로 되돌린다
  const landedStories = [] // { story, head } — 통합 게이트 대상(아래 충돌 분기의 boolean `landed` 와 다른 변수)
  const evidence = {} // story → 증거 폴더 경로(배치 매니페스트가 가리킨다)
  for (const wt of wts) {
    const r = outs.find((o) => o.story === wt.story)
    if (!r || r.code !== 0) {
      const ev = await archiveEvidence(wt)
      if (ev) evidence[wt.story] = ev
      record(`- **중단(exit ${r?.code ?? '?'}): ${wt.story} (병렬 dev)** — 성공분 landing 후 배치 STOP${ev ? ` · 증거 보관 ${ev}` : ''}`); worst ||= r?.code ?? 1; continue
    }
    const head = spawnSync('git', ['-C', wt.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    if (head === wt.base) { record(`- 완주(커밋 없음): ${wt.story}`); continue }
    const pick = spawnSync('git', ['cherry-pick', head], { encoding: 'utf8' })
    if (pick.status !== 0) {
      // 자동 해소 가능한 충돌 클래스(엔진 자기 로그 append·state.json·공유 장부 append)만 풀어 landing 을
      // 살린다 — 그 외 파일이 섞이면 손대지 않고 종전 보존 폴백(archive 태그).
      // core.quotePath=false — 하향 동기·라운드 커밋과 같은 이유다. 기본값이면 한글 경로가 8진
      // 이스케이프 + 따옴표로 나와 landingResolution 의 클래스 판정이 통째로 빗나가고, 자동 해소
      // 가능한 충돌까지 「해소 불가」로 떨어져 산출물이 archive 태그로 밀린다.
      const conflicted = (spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).stdout ?? '')
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const plan = landingResolution(conflicted)
      let landed = plan != null
      if (landed) {
        for (const [file, how] of Object.entries(plan)) {
          if (how === 'ours') {
            if (spawnSync('git', ['checkout', '--ours', '--', file]).status !== 0) { landed = false; break }
          } else {
            let merged
            try { merged = stripConflictMarkers(readFileSync(file, 'utf8')) } catch { merged = null }
            if (merged == null) { landed = false; break }
            writeFileSync(file, merged)
          }
          if (spawnSync('git', ['add', '--', file]).status !== 0) { landed = false; break }
        }
        if (landed) landed = spawnSync('git', ['-c', 'core.editor=true', 'cherry-pick', '--continue'], { encoding: 'utf8' }).status === 0
      }
      if (!landed) {
        spawnSync('git', ['cherry-pick', '--abort'])
        spawnSync('git', ['tag', `archive/parallel-${wt.story}-${Date.now()}`, head]) // 산출물 보존 — 유실 금지
        record(`- **landing 실패(자동 해소 불가 충돌): ${wt.story}** — 산출물은 archive/parallel-* 태그 보존 · 다음 순차 라운드가 회수`)
        worst ||= 1
        continue
      }
      record(`- 완주: ${wt.story} (병렬 dev → landing · 충돌 자동 해소 ${Object.keys(plan).length}파일)`)
      landedStories.push({ story: wt.story, head })
      continue
    }
    record(`- 완주: ${wt.story} (병렬 dev → landing)`)
    landedStories.push({ story: wt.story, head })
  }

  // ── 통합 게이트 · push · 배치 매니페스트 — 순차 경로와 **같은 함수**를 쓴다(N1). ──
  const batchId = `${START_DATE}-${Date.now()}`
  const gateOut = runIntegrationGate({
    landedStories, landingBase, batchId, record,
    timeoutMin: batch.stageTimeoutMin ?? defaults.stageTimeoutMin ?? 120,
  })
  const integration = gateOut.integration
  // 되돌림 실패(7)는 다른 실패보다 위다 — 앞선 워커 실패로 worst 가 이미 1이어도 7 로 올린다.
  worst = gateOut.worst === 7 ? 7 : (worst || gateOut.worst)
  const pushed = pushBranchOnce({ enabled: Boolean(defaults.push), skipPush: gateOut.skipPush, record })
  writeBatchManifest({
    batchId, label: batch.label ?? '', stories: storyList, stages: batch.stages ?? ['dev'], workers, mode: 'parallel',
    landedStories, integration, pushed, worst, record,
    failed: outs.filter((o) => o.code !== 0).map((o) => ({ story: o.story, exit: o.code, evidence: evidence[o.story] ?? null })),
  })

  // ── 계측 — 「무엇이 빨라졌나」를 숫자로. 품질 게이트를 함께 실어 **통과한 실행끼리만** 비교한다. ──
  const tokens = {}
  for (const wt of wts) {
    for (const [p, models] of Object.entries(wt.stageEvents?.tokens ?? {})) {
      tokens[p] ??= {}
      for (const [m, t] of Object.entries(models)) tokens[p][m] = { total: (tokens[p][m]?.total ?? 0) + (t.total ?? 0) }
    }
  }
  const events = [
    { kind: 'batch', start: batchStarted, end: new Date().toISOString() },
    ...wts.map((w) => w.metrics).filter(Boolean),
    ...wts.flatMap((w) => w.stageEvents?.stages ?? []),
  ]
  // 파일 기록은 **라운드 끝에 한 번**(runQueue) — 배치마다 쓰면 아침에 읽을 표가 여러 장이 된다.
  const quality = { integration: integration.result }

  // ── 배정 기록 — 라운드가 끝난 뒤 한 번. 연속 실패가 쌓이면 다음 편성이 그 프로바이더를 피한다. ──
  if (!dryRun) {
    writeAssignHistory(wts.flatMap((wt) => {
      const okStory = (outs.find((o) => o.story === wt.story)?.code ?? 1) === 0
      const rows = [{ story: wt.story, provider: wt.devProvider ?? 'claude', role: 'dev', ok: okStory, rounds: 1 }]
      if (wt.review) rows.push({ story: wt.story, provider: wt.reviewProvider ?? specProvider(wt.review), role: 'review', ok: okStory, rounds: 1 })
      return rows
    }))
  }
  cleanup()
  return { code: worst, metrics: { events, workers, quality, tokens } }
}

// ⑤ 큐 1개 실행 = 1라운드 — 엔진 배치를 순차로 돌리고 요약을 남긴다.
//    roundBaseShaForLedger = 라운드 시작 HEAD(진전 원장 재료 — 이 라운드 커밋이 만진 스토리를 센다).
async function runQueue(queuePath, autoQueueMeta, round, roundBaseShaForLedger = '') {
  let queue
  try {
    queue = JSON.parse(readFileSync(queuePath, 'utf8'))
  } catch (error) {
    fail(`큐 파일 JSON 을 읽지 못했다: ${error.message}`)
  }

  const defaults = queue.defaults ?? {}
  const batches = (queue.batches ?? [])
    .filter((batch) => batch.enabled !== false)
    .filter((batch) => (only === '' ? true : String(batch.label ?? '').startsWith(only)))

  const lines = []
  const record = (message) => {
    // 요약 줄은 git stderr·엔진 로그 문장을 그대로 인용한다 — 화면과 `night-last-run.md` 양쪽에
    // 남기 **전에** 한 번 마스킹한다(N3/정책 2). 마스킹은 평범한 문장에 대해 항등이라 종전 회귀 없음.
    const line = REDACT(message)
    console.log(line)
    lines.push(line)
  }
  const writeSummary = () => {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(SUMMARY, lines.join('\n') + '\n', 'utf8')
  }

  record(`# 야간 배치 ${START_DATE}${autoPlan ? ` — 라운드 ${round}` : ''}`)
  record('')
  record(`- 큐: \`${queuePath}\``)
  record(`- 브랜치: \`${BRANCH}\`${defaults.push ? ' (푸시 켬)' : ' (푸시 끔)'}`)
  record(`- 실행 대상 배치: ${batches.length}건${only ? ` (--only ${only})` : ''}`)

  if (batches.length === 0) {
    record('')
    record('**돌릴 배치가 없다** — 큐가 비었거나 전부 `enabled: false` 다. 아침 브리핑에서 큐를 채운다.')
    writeSummary()
    return { worstCode: null, ranCount: 0, note: (message) => { record(message); writeSummary() } }
  }

  // 엔진은 시작 시 작업 트리 clean 을 요구한다(커밋 가드) — 먼저 확인해 원인을 분명히 남긴다.
  if (defaults.commit || defaults.push) {
    const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    const dirty = (status.stdout ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !line.includes('auto-pipeline-logs/'))
      .filter((line) => !line.includes('.auto-batch-worktree'))
    if (dirty.length > 0) {
      record('')
      record('**중단: 작업 트리가 clean 이 아니다** — 커밋 배치는 남의 변경을 자기 커밋에 쓸어 담는다.')
      dirty.slice(0, 20).forEach((line) => record(`  ${line}`))
      writeSummary()
      await flushNotify()
      process.exit(4)
    }
  }

  const results = []
  const ranStories = new Set() // 실행을 **시작한** 배치의 스토리 — 원장 환불 판정 재료
  // 라운드 계측 — 배치마다 재료를 모아 **마지막에 표 1개**로 낸다(요약의 종전 절은 건드리지 않는다).
  const metricsEvents = []
  const metricsTokens = {}
  let metricsWorkers = 1
  let metricsIntegration = 'pass'
  const addMetrics = (m) => {
    if (!m) return
    metricsEvents.push(...(m.events ?? []))
    metricsWorkers = Math.max(metricsWorkers, Number(m.workers) || 1)
    if (m.quality?.integration && m.quality.integration !== 'pass') metricsIntegration = m.quality.integration
    for (const [p, models] of Object.entries(m.tokens ?? {})) {
      metricsTokens[p] ??= {}
      for (const [mo, t] of Object.entries(models)) metricsTokens[p][mo] = { total: (metricsTokens[p][mo]?.total ?? 0) + (t.total ?? 0) }
    }
  }
  for (const batch of batches) {
    const label = batch.label ?? '(무제)'
    const stories = (batch.stories ?? []).join(',')
    if (stories === '') {
      record(`- 건너뜀: ${label} — stories 비어 있음`)
      continue
    }
    for (const k of batch.stories) ranStories.add(k)

    // 병렬 경로 — 큐가 parallel 을 켠 dev 전용 다스토리 배치만. 조건 미달·리허설은 순차 그대로.
    const par = parallelPlanWithWorkers({
      storyCount: (batch.stories ?? []).length,
      stages: batch.stages ?? ['create', 'dev', 'review'],
      parallel: batch.parallel ?? defaults.parallel,
      maxWorkers: PCFG.workers.max, // 설정 없으면 종전 하드캡 3 — parallelPlan 과 같은 값
    })
    if (par > 1 && !dryRun) {
      console.log(`\n==== ${label} (병렬 ${par}폭 시도) ====`)
      if (autoPlan) touchLock()
      const started = new Date().toISOString()
      const batchBase = headSha()
      const pr = await runBatchParallel({ batch, defaults, workers: par, record })
      if (pr !== null) {
        addMetrics(pr.metrics)
        results.push({ label, code: pr.code, started, batchBase, stories: batch.stories ?? [] })
        record(`- ${pr.code === 0 ? '완주' : `**중단(exit ${pr.code})**`}: ${label} (병렬)`)
        if (pr.code !== 0) {
          record(`- 남은 배치는 실행하지 않았다 — \`auto-pipeline-logs/run-summary.log\` 확인`)
          break
        }
        continue
      }
      // null = 조건 미충족 — 아래 순차 경로로 그대로 진행(폴백 사유는 record 됨)
    }

    const args = [
      ENGINE,
      '--stories',
      stories,
      '--stages',
      (batch.stages ?? ['create', 'dev', 'review']).join(','),
      '--stage-timeout-min',
      String(batch.stageTimeoutMin ?? defaults.stageTimeoutMin ?? 120),
      '--wait-auth-min',
      String(waitAuthMin(autoPlan, batch.waitAuthMin, defaults.waitAuthMin)),
      '--pipeline-settings',
      PIPELINE_SETTINGS,
    ]
    for (const [stage, model] of Object.entries(batch.models ?? {})) {
      if (model) args.push(`--${stage}-model`, model)
    }
    if (batch.force) args.push('--force')
    if (defaults.commit || defaults.push) args.push('--commit', '--branch', BRANCH)
    // (N1) 배치 통합 게이트가 켜져 있으면 **엔진의 스토리별 push 를 보류시킨다**(`--defer-push`) —
    // 엔진이 스토리마다 즉시 밀면 합쳐진 트리가 RED 여도 원격에는 이미 RED 조합이 남는다.
    // 커밋은 로컬 `auto/*` 에 그대로 쌓이고, 게이트 GREEN 을 본 뒤 **러너가 1회** push 한다
    // (병렬 경로와 같은 규칙). 게이트가 꺼져 있으면 종전 명령줄 그대로다.
    const seqGate = PCFG.integrationGate.enabled && (defaults.commit || defaults.push)
    if (defaults.push) args.push('--push', ...(seqGate ? ['--defer-push'] : []))
    if (dryRun) args.push('--dry-run')
    args.push(...engineFlagsFromConfig(PCFG)) // 설정 없으면 [] — 종전 명령줄 그대로(하위 호환)

    console.log(`\n==== ${label} ====`)
    if (autoPlan) touchLock() // 심박 — 라운드가 아니라 **배치 경계**여야 6h 판정 창과 정합한다
    const batchBase = headSha() // exit 5 환불 판정 재료(이 배치가 실제로 무엇을 커밋했나)
    const started = new Date().toISOString()
    const run = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() })
    let code = run.status ?? 1
    let seqIntegration = 'pass'
    // ── 순차 경로의 통합 게이트 · push · 배치 매니페스트 (N1 · 병렬과 같은 함수) ──
    if (seqGate && !dryRun) {
      const seqBatchId = `${START_DATE}-${Date.now()}`
      const landedStories = landedStoriesFromCommits(batchBase, batch.stories ?? [])
      const gateOut = runIntegrationGate({
        landedStories, landingBase: batchBase, batchId: seqBatchId, record,
        timeoutMin: batch.stageTimeoutMin ?? defaults.stageTimeoutMin ?? 120,
      })
      code = gateOut.worst === 7 ? 7 : (code || gateOut.worst)
      seqIntegration = gateOut.integration.result
      // landing 0건이면 push 할 것이 없다 — 엔진이 커밋 전에 STOP 한 자리에서 없는 브랜치를 밀지 않는다.
      const pushed = pushBranchOnce({ enabled: Boolean(defaults.push) && landedStories.length > 0, skipPush: gateOut.skipPush, record })
      writeBatchManifest({
        batchId: seqBatchId, label, stories: batch.stories ?? [], stages: batch.stages ?? ['create', 'dev', 'review'],
        workers: 1, mode: 'sequential', landedStories, failed: [], integration: gateOut.integration, pushed, worst: code, record,
      })
    }
    // 순차 배치의 계측 — 워크트리가 없으니 저장소의 엔진 로그에서 **이 배치가 시작한 뒤의 구간**만 읽는다.
    if (!dryRun) {
      addMetrics({
        events: [{ kind: 'batch', start: started, end: new Date().toISOString() }, ...readRepoTimelineSince(started, batch.stories ?? [])],
        workers: 1, quality: { integration: seqIntegration }, tokens: {},
      })
    }
    results.push({ label, code, started, batchBase, stories: batch.stories ?? [] })
    record(`- ${code === 0 ? '완주' : `**중단(exit ${code})**`}: ${label}`)
    if (code !== 0) {
      // 앞 배치가 멈췄는데 뒤를 돌리면 원인이 섞인다.
      record(`- 남은 배치는 실행하지 않았다 — \`auto-pipeline-logs/run-summary.log\` 확인`)
      break
    }
  }

  // 자동 편성이면 근거를 아침 브리핑이 읽는 그 파일에 남긴다
  if (autoQueueMeta) {
    record('')
    record('## 편성 (자동 — plan-queue)')
    record(`- 계획 출처: \`${PLAN_SOURCE}\``)
    // 캐시 판정 — 아침 브리핑이 「오늘 Fable 을 몇 번 불렀나」를 이 줄로 센다(hit = 호출 0).
    if (PLAN_CACHE_NOTE) record(`- 계획 캐시: ${PLAN_CACHE_NOTE} (유효 ${ORCH.cacheHours}시간)`)
    if (PLAN_VALIDATION) {
      const v = PLAN_VALIDATION
      record(`- 계획 자기 검증: ${v.ok ? 'GREEN' : `RED — 오류 ${v.errors.length}건`}${v.warnings?.length ? ` · 경고 ${v.warnings.length}건` : ''}`)
      for (const e of (v.errors ?? []).slice(0, 5)) record(`  - ✖ ${e.code}${e.key ? ` [${e.key}]` : ''} — ${e.msg}`)
    }
    for (const p of autoQueueMeta.picked ?? []) record(`- ✔ ${p.key} — ${p.why}`)
    for (const e of autoQueueMeta.excluded ?? []) record(`- ✖ ${e.key} — ${e.why}`)
  }

  record('')
  record('## 아침에 할 일')
  record('- 아침 브리핑: 배치 결과 → 현황판 → **결정 인박스** 순으로 읽는다.')
  record(`- 이 배치의 커밋은 \`${BRANCH}\` 에 있다. **main 머지는 사람 승인**이다.`)

  // 계측 표 — **요약의 맨 뒤에 덧붙인다**. 종전 절을 밀어내지 않으므로 기존 독자(아침 브리핑)가 깨지지 않는다.
  if (metricsEvents.length > 0) {
    const roundSummary = summarizeTimeline(metricsEvents, { workers: metricsWorkers, quality: { integration: metricsIntegration }, tokens: metricsTokens })
    if (!dryRun) writeMetrics(`${START_DATE}-${Date.now()}`, `라운드 ${round}`, roundSummary, record)
    record('')
    record(renderMetricsTable(roundSummary))
  }
  writeSummary()

  const worst = results.find((entry) => entry.code !== 0)

  // 조기 종료(STOP) 시 하루 상한 원장 환불 — 미실행 배치가 기록만 남아 이후 슬롯의
  // remaining 을 0 으로 만드는 결함 봉쇄(실사고 2026-08-27). 자동 편성 라운드에만 의미가 있다.
  if (worst && autoPlan && !dryRun && autoQueueMeta) {
    const unrun = batches.flatMap((b) => b.stories ?? []).filter((k) => !ranStories.has(k))
    // exit 5(한도) 환불 확장: 멈춘 배치의 스토리 중 라운드 커밋이 그 스토리 md 를 한 번도 안 만졌으면
    // 실작업 0 이다 — 한도가 원장·비수렴 상한을 공짜로 소모하지 않게 환불한다.
    // 그 외 exit 코드는 종전대로 보수적으로 남긴다(일부라도 실행됐을 수 있다).
    if (worst.code === 5 && worst.batchBase) {
      unrun.push(...limitRefundKeys(worst.stories ?? [], roundCommitFileLists(worst.batchBase)))
    }
    if (unrun.length > 0) {
      const { s, save } = loadState()
      const day = s.days[START_DATE]
      if (day && Array.isArray(day.planned)) {
        const before = day.planned.length
        day.planned = refundUnrun(day.planned, unrun)
        save()
        record(`- 원장 환불: 미실행/한도 무작업 ${unrun.length}건을 하루 상한 기록에서 제외(${before} → ${day.planned.length}) — 다음 슬롯이 다시 집는다`)
        writeSummary()
      }
    }
  }
  const done = results.filter((r) => r.code === 0).length

  // 차단기 v2 갱신 + 진전 원장 + 슬롯 요약 푸시 — 리허설(dry-run)은 무음·무기록
  if (autoPlan && !dryRun) {
    const { s, win, save } = loadState()
    // 차단기 v2: 원인 서명(exit 코드 + 배치 라벨) 단위. stops 필드는 원격 명령 /status·/resume 호환용으로 유지된다.
    Object.assign(win, stopRecord(win, worst ? worst.code : null, worst?.label))
    // 진전 원장 — 이 라운드 커밋이 만진 스토리 md 키를 남긴다. 편성기의 「무진전 편성 연속」 상한 재료다
    // (같은 스토리를 몇 번 편성했나가 아니라, 편성하고도 아무것도 못 만졌나를 센다).
    const day = s.days[START_DATE]
    if (day) {
      day.progressed ??= []
      for (const k of progressedStoryKeys(roundCommitFileLists(roundBaseShaForLedger))) {
        if (!day.progressed.includes(k)) day.progressed.push(k)
      }
    }
    save()
    const blocked = (autoQueueMeta?.excluded ?? []).filter((e) => e.why.includes('결정 대기')).length
    const exhausted = (autoQueueMeta?.excluded ?? []).filter((e) => e.why.includes('소진')).length
    // 지출 한도 차단(2026-08-30 회수) — 한 건도 못 한 exit 5 라운드는 **원인을 이름으로** 말하고
    // 매 라운드 같은 말을 반복하지 않는다. 성공 라운드가 나오면 연속 카운트를 0 으로 되돌린다.
    const nowIso = new Date().toISOString()
    const spendBlocked = worst?.code === 5 && done === 0
    s.spendBlock = spendBlocked
      ? { streak: (s.spendBlock?.streak ?? 0) + 1, firstIso: s.spendBlock?.firstIso ?? nowIso }
      : { streak: 0, firstIso: null }
    save()
    const spend = spendBlocked ? spendBlockNotice({ streak: s.spendBlock.streak, firstIso: s.spendBlock.firstIso, nowIso }) : { speak: false }
    // ⚠️ writeSummary() 는 위에서 이미 한 번 돌았다 — 여기서 다시 쓰지 않으면 이 줄이 화면에만 남고
    //    아침 브리핑이 읽는 `night-last-run.md` 에는 원인이 빠진다(환불 분기가 이미 같은 규율을 쓴다).
    if (spendBlocked) {
      record(`- 무인 실행 지출 한도 차단 — 연속 ${s.spendBlock.streak}회 무작업(최초 ${s.spendBlock.firstIso})${spend.speak ? ' · 알림 발신' : ' · 알림 억제(반복)'}`)
      writeSummary()
    }
    if (spend.speak) notify(spend.title, spend.body)
    else if (!spendBlocked) notify(worst ? `슬롯 STOP(exit ${worst.code}) · 라운드 ${round}` : `슬롯 완주 ${done}배치 · 라운드 ${round}`,
      `${results.map((r) => `${r.code === 0 ? 'OK' : 'STOP'} ${r.label}`).join('\n')}${blocked ? `\n결정 대기가 스토리 ${blocked}개를 막는 중 — DECISIONS-INBOX.md` : ''}${exhausted ? `\n무인 소진 ${exhausted}건 — 사람 판단 필요(아침 브리핑)` : ''}`,
      // 공개 폴백에는 배치 라벨을 싣지 않는다 — 건수·exit 코드까지만.
      `완주 ${done}건${worst ? ` · STOP exit ${worst.code}` : ''}${blocked ? ` · 결정 대기 ${blocked}건` : ''}. ${NTFY_BRIEF}`)
  }

  return {
    worstCode: worst ? worst.code : null,
    ranCount: results.length,
    // 라운드가 끝난 뒤에도 요약에 한 줄 더 남길 수 있게 열어 둔다(공회전 종료 사유).
    note: (message) => { record(message); writeSummary() },
  }
}

/** 라운드(또는 배치)가 만든 새 커밋들의 변경 파일을 커밋당 배열로 모은다 — 판정은 runner-rules 몫.
 *  기준 SHA 를 못 잡았거나 rev-list 가 실패하면 빈 배열 = 실작업 0(보수 방향).
 *  ⚠️ core.quotePath=false 필수 — git 은 기본값에서 비ASCII 경로를 `"…\354\212\244…"` 로 8진 이스케이프해
 *  내보낸다. 스토리 키에 한글을 쓰면 스토리 md 정규식이 전부 빗나가고, 그 결과 ① 진전 원장이 늘 비어
 *  무진전 연속 상한이 리셋되지 않으며(정상 진행 스토리가 영구 제외) ② exit 5 환불이 실작업분까지
 *  돌려준다. 실측으로 확인한 결함이다. */
function roundCommitFileLists(baseSha) {
  if (!baseSha) return []
  const rev = spawnSync('git', ['rev-list', `${baseSha}..HEAD`], { encoding: 'utf8' })
  if (rev.status !== 0) return []
  const shas = (rev.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean)
  return shas.map((x) => (spawnSync('git', ['-c', 'core.quotePath=false', 'show', '--name-only', '--format=', x], { encoding: 'utf8' }).stdout ?? '')
    .split('\n').map((l) => l.trim()).filter(Boolean))
}

const headSha = () => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout ?? '').trim() : ''
}

// ⑥ 실행 — 수동은 단일 실행, 슬롯 모드는 큐가 마를 때까지 연속.
if (!autoPlan) {
  const r = await runQueue(manualQueuePath, null, 1)
  console.log(`\n==== 야간 배치 종료 — ${SUMMARY} ====`)
  await flushNotify()
  process.exit(r.worstCode ?? 0)
}

let lastWorst = null
for (let round = 1; ; round++) {
  touchLock() // 심박 — 라운드 경계
  writeChainInfo() // 체인 게이트 재료 — 편성 전에 최신 실측
  const ds = doDownSync() // 하향 동기 — 낮의 결정·큐·목업 승인이 밤에 보인다
  if (ds.note) console.log(`· ${ds.note}`)
  if (!ds.ok) break // 코드 충돌 — 이 라운드 휴면(다음 슬롯이 재판정 · 같은 지문 2회면 오늘 동기 중단)
  const sel = await selectQueue()
  if (!sel) break // 오늘 몫 소진(편성 0) — 다음 정시 슬롯이 새로 판단한다
  const baseSha = headSha() // 라운드 전 HEAD — 끝나고 새 커밋이 만진 스토리를 본다(진전 원장)
  const r = await runQueue(sel.path, sel.meta, round, baseSha)
  lastWorst = r.worstCode
  // 공회전 가드 — 라운드가 만든 커밋이 자기 로그뿐이면(또는 커밋 0) 실작업 0 이다. 엔진이
  // state.json skip 으로 전 단계를 건너뛰고 로그만 커밋한 뒤 exit 0 을 내면, 러너는 그걸 「완주」로
  // 세어 같은 편성을 밤새 반복한다(커밋 오염 + 알림 폭주). 모르면 멈추는 쪽이 싸다 — 다음 정시
  // 슬롯이 새 프로세스로 이어받는다.
  const didRealWork = roundDidRealWork(roundCommitFileLists(baseSha))
  const contArgs = {
    autoPlan, dryRun, worstCode: r.worstCode, ranCount: r.ranCount,
    startDate: START_DATE, nowDate: today(),
  }
  const cont = shouldContinueLoop({ ...contArgs, roundDidRealWork: didRealWork })
  if (!cont) {
    // 공회전(다른 조건은 전부 계속인데 실작업만 0)일 때만 그 사유를 적는다 — STOP·자정·편성 0
    // 종료에 엉뚱한 사유를 덧씌우지 않는다. 알림은 종료와 함께 1회뿐이다.
    if (!didRealWork && shouldContinueLoop({ ...contArgs, roundDidRealWork: true })) {
      const why = '라운드 실작업 0 — 공회전 종료(같은 편성이 반복되면 원장·편성 규칙을 사람이 확인)'
      r.note(`- **${why}**`)
      if (!dryRun) notify(`공회전 종료 · 라운드 ${round}`, why)
    } else if (r.worstCode == null && r.ranCount > 0 && START_DATE !== today()) {
      console.log('자정 경과 — 루프를 끝내고 다음 슬롯에 넘긴다(날짜 고정 가드)')
    }
    break
  }
  console.log(`\n──── 라운드 ${round} 완주 — 남은 일이 있는지 다시 편성한다(연속 실행) ────`)
}

console.log(`\n==== 야간 배치 종료 — ${SUMMARY} ====`)
await flushNotify() // fetch 알림 배출 — process.exit 이 전송을 잘라먹지 않게
process.exit(lastWorst ?? 0)
