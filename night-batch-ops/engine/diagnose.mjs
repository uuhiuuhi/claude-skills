// diagnose.mjs — 프로젝트 자동 진단(SPEC §1 · 설계 §1-1·§2).
//
// 두 단계로 갈라 둔다:
//   ① `readProject(root)`  = **읽기 전용 IO**. 대상 저장소에 단 1바이트도 쓰지 않는다.
//      (테스트가 소스 앵커로 문다 — 이 파일은 `node:fs` 에서 **읽기 API 만** import 한다.)
//   ② `diagnose(snapshot)` = **순수 함수**. 프로세스 실행 0 · 파일 접근 0.
//   ③ `runGateProbe(...)`  = 유일한 실행부. spawn 을 주입받고 1회만 돌린다(로그 쓰기는 호출부 몫).
//
// 왜 이렇게 가르나: SPEC §1 은 「문서의 완료 표시를 불신하라」고 요구한다. 그러려면 판정이
// **재현 가능**해야 한다 — 같은 스냅숏을 넣으면 같은 진단이 나와야 사람이 다툴 수 있다.
// 실행 결과(게이트)는 비싸고 흔들리므로 스냅숏 밖에서 주입한다(`diagnose(snap, {gates})`).
//
// 판정 우선순위(SPEC §1): 실제 실행 결과(1) → 테스트(2) → 코드(3) → BMAD 스토리(4) → 계획 문서(5).
// **문서의 `done` 은 단독으로 verified-done 이 못 된다** — rank 1 증거(qa exit 0)가 있어야 한다.
// 2026-08-30·08-31 실사고(굵은 findings 16건이 0으로 · 👤 인용이 사람 게이트로 오판)를 그대로
// 물려받지 않으려고 원장 해석은 전부 `story-ledger.mjs`(단일 소스)에 위임한다.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, basename, extname } from 'node:path'
import { parseSprint, epicSection, readStorySignals } from './story-ledger.mjs'
import { parseFileList } from './runner-rules.mjs'
import { detectGates, parseQaChain, classifyQaFailure, TEST_FILE_RE } from '../../auto-story-finish/quality-rules.mjs'
// 시크릿 마스킹 단일 소스 — 진단·보고서·자율 마무리가 **같은 마스커**를 쓴다(codex-review-r3 H1).
// 값 그물(`redactSecrets`)과 깊은 마스킹(`deepRedact`) 둘 다 여기서 온다 — 사본은 하나도 두지 않는다.
import { deepRedact, redactSecrets } from '../../auto-story-finish/providers/redact.mjs'
// 게이트 실행의 기본 spawn — 마감 시 **프로세스 트리 전체**를 끊는다(codex-review-r6 Medium).
import { spawnWithDeadline } from './spawn-deadline.mjs'

export const SNAPSHOT_SCHEMA = 'night-batch-ops/snapshot/1'
export const DIAGNOSIS_SCHEMA = 'night-batch-ops/diagnosis/1'

// ── 정규식 SoT (설계 §2-2) ────────────────────────────────────────────────────
/** 설계 §2-2 원문 그물 — **1차 선별용**. 이것만으로 판정하면 오탐이 실측으로 터진다(아래 3분할). */
export const TEMP_CODE_RE = /(TODO|FIXME|HACK|XXX)\b|임시\s*(구현|처리|값|코드)|나중에\s*(고침|구현)|placeholder|dummy/i
// jng-os 실측(2026-09-02)으로 갈라 놓은 3단계 — 원문 그물을 그대로 쓰면 143건 중 **143건이 오탐**이었다:
//   · `placeholder` 65건이 전부 JSX `placeholder="…"` 속성(= 정상 UI 코드)
//   · 소문자 `todo` 가 객체 키(`todo: []`)·CSS 클래스(`.dchip.todo`)·상태값 문자열(`'todo'`)에 걸림
// 그래서 ① ASCII 마커는 **대문자만**(관례) ② 한국어 표현은 그대로 ③ placeholder/dummy 는 **주석 안일 때만**.
export const TEMP_CODE_MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b/
export const TEMP_CODE_KO_RE = /임시\s*(구현|처리|값|코드)|나중에\s*(고침|구현)/
export const TEMP_CODE_WEAK_RE = /\b(placeholder|dummy)\b/i
export const SKIP_RE = /\b(it|test|describe|suite)\.(skip|todo)\s*\(/
export const ONLY_RE = /\b(it|test|describe)\.only\s*\(/
export const SECRET_PATH_RE = /(^|\/)\.env(\.|$)|(^|\/)(secrets?|credentials?)\//i
/** `.env.example`·`.sample`·`.template` 는 **이름만 적는 공개 견본**이라 추적이 정상이다
 *  (프로젝트 규약 5: 프런트 공개값만 · secret 은 이름조차 두지 않는다). 값 스캔은 그대로 돌린다 —
 *  견본에 실제 값이 들어가면 `secret-value` 로 걸린다. */
export const SECRET_PATH_EXAMPLE_RE = /(^|\/)\.env\.(example|sample|template)$/i
export const SECRET_VALUE_RE = /(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|service_role)/
/** `service_role` **단독 낱말**은 Postgres 역할 이름이라 비밀이 아니다 — jng-os 실측에서 값 히트
 *  120건 중 **119건**이 주석·테스트 문장의 낱말이었다(전부 tier 1 로 올라가 진짜 1건을 덮었다).
 *  비밀로 치는 것은 **값이 붙은 대입 형태**뿐이다. */
export const SECRET_ASSIGN_RE = /((?:service[_-]?role|api[_-]?key|secret|token|password|passwd|pwd)[A-Za-z_]*)\s*[:=]\s*(['"`]?)([A-Za-z0-9._\-/+]{16,})\2/i
/** 에픽 헤더 — jng-os 는 `## Epic 2:` 와 `### Epic 3:` 가 **혼재**한다(설계 §0). */
export const EPIC_HEADER_RE = /^#{2,3} Epic (\d+):\s*(.*)$/
/** epics.md 의 스토리 절 — `### Story 11.3: …` */
export const EPIC_STORY_RE = /^#{3} Story (\d+)\.(\d+):\s*(.*)$/
/** 스토리 형태의 문서 이름 — `11-5-관리팀-질의서-….md` 같은 **고아 문서**도 이 형태다. */
export const STORY_DOC_RE = /^(\d+)-(\d+)-.+$/

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.vite', '.review-tmp', '.wrangler'])
const MAX_FILE_BYTES = 1024 * 1024

export const DEFAULT_PATHS = Object.freeze({
  epics: '_bmad-output/planning-artifacts/epics.md',
  impl: '_bmad-output/implementation-artifacts',
  logs: '_bmad-output/implementation-artifacts/auto-pipeline-logs',
  inbox: '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md',
  deferred: '_bmad-output/implementation-artifacts/deferred-work.md',
  dbDrift: '_bmad-output/implementation-artifacts/DB-DRIFT-LEDGER.md',
  config: 'tools/auto/auto.config.json',
  migrations: 'supabase/migrations',
  srcDirs: ['src'],
  codeDirs: ['src', 'tests', 'tools', 'supabase/functions'],
})

// ── 시크릿 마스킹 ────────────────────────────────────────────────────────────
// 2026-09-02 codex-review-r3 H1: 여기 있던 **자체 정규식**은 R2 에서 이미 고친 대표 형식 셋
// (`{"api_key":"…"}` · `Authorization: Bearer …` · `PRIVATE_KEY="a b c"`)을 전부 놓쳤다.
// 이제 마스커는 **공용 단 하나**다 — 2026-09-02 R4 에서 공용 그물이 2조각 JWT 와 「키가 배열 원소까지
// 상속되는」 깊은 마스킹을 모두 흡수했으므로, 여기 있던 덧그물(`EXTRA_REDACTIONS`)과 사본 구현을 지우고
// `providers/redact.mjs` 를 **그대로 재수출**한다. 사본이 갈릴 여지를 0 으로 둔다.
/** 값 원문은 스냅숏·진단·보고서 **어디에도** 남기지 않는다(BRIEF 정책 1·2 · SPEC §8).
 *  단일 소스 = `providers/redact.mjs:redactSecrets`(Codex 입력·워커 로그·archive 와 같은 그물). */
const maskSecrets = redactSecrets
/** 객체 전체를 깊이 마스킹 — 스냅숏·보고서처럼 **구조를 그대로 내보내는** 산출물용.
 *  `scripts`·`manifests`·`engineState` 처럼 원문 JSON 을 그대로 담는 가지가 유출 경로였다(H1). */
export { maskSecrets, deepRedact }
const maskLine = (line) => maskSecrets(String(line ?? '')).trim().slice(0, 200)

// ── 작은 도구 ────────────────────────────────────────────────────────────────
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex')
const shortId = (prefix, parts) => `${prefix}-${sha(parts.join('|')).slice(0, 10)}`
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
const uniq = (a) => [...new Set(a)]
const storyId = (key) => String(key ?? '').split('-').slice(0, 2).join('-')

function readTextSafe(p, max = MAX_FILE_BYTES) {
  try {
    const st = statSync(p)
    if (!st.isFile()) return null
    if (st.size > max) return readFileSync(p, 'utf8').slice(0, max)
    return readFileSync(p, 'utf8')
  } catch { return null }
}
function readJsonSafe(p) {
  const t = readTextSafe(p)
  if (t === null) return null
  try { return JSON.parse(t) } catch { return null }
}
function listDir(p) {
  try { return readdirSync(p, { withFileTypes: true }) } catch { return [] }
}
function walkCode(root, rel, out, budget) {
  for (const e of listDir(join(root, rel))) {
    if (out.length >= budget) return
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walkCode(root, child, out, budget)
    } else if (e.isFile() && CODE_EXT.has(extname(e.name))) {
      out.push(child)
    }
  }
}

// ── 증거 등급 (설계 §2-1) ────────────────────────────────────────────────────
export const EVIDENCE_RANKS = Object.freeze({ gate: 1, test: 2, code: 3, story: 4, plan: 5 })
export function evidenceRank(kind) {
  return EVIDENCE_RANKS[String(kind)] ?? 5
}
const confidenceOf = (rank) => (rank <= 2 ? 'high' : rank === 3 ? 'medium' : 'low')

// ── finding → 7단계 tier (SPEC §2 · 설계 §6) ─────────────────────────────────
/** **배타 매핑** — 하나의 kind 는 정확히 한 tier 로만 간다(중복 계상 금지). */
export const FINDING_TIER = Object.freeze({
  'secret-value': 1,
  'secret-path-tracked': 1,
  'temp-code-in-secret-path': 1,
  'data-loss-risk': 1,
  'gate-red': 2,
  'story-defect': 2,
  'build-missing': 2,
  'db-drift-pending': 3,
  'deploy-preflight-missing': 3,
  'deploy-env-missing': 3,
  'open-patch': 4,
  'open-decision': 4,
  'unfinished-task': 4,
  'story-missing': 4,
  'story-partial': 4,
  'file-list-missing': 5,
  'file-list-file-missing': 5,
  'untested-files': 5,
  'test-only': 5,
  'test-skip': 5,
  'test-integrity': 5,
  'gate-not-run': 5,
  'perf-risk': 6,
  'a11y-risk': 6,
  'test-only-needs-review': 7,
  'test-skip-justified': 7,
  'temp-code': 7,
  'orphan-doc': 7,
  'plan-only-story': 7,
  'sprint-only-story': 7,
  'status-drift': 7,
  'stale-installed-parser': 7,
})
export function tierOfFinding(finding) {
  return FINDING_TIER[finding?.kind] ?? 7
}

// ═══════════════════════════════════════════════════════════════════════════
// ① readProject — 읽기 전용 IO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 대상 저장소를 **읽기만** 해서 스냅숏을 만든다.
 * @param {string} root 프로젝트 루트(절대 경로 권장)
 * @param {{config?:object|null, maxLogBytes?:number, now?:Date, paths?:object, maxCodeFiles?:number, git?:boolean}} opts
 * @returns {object} Snapshot (SNAPSHOT_SCHEMA)
 */
export function readProject(root, { config = null, maxLogBytes = 262144, now = new Date(), paths = {}, maxCodeFiles = 6000, git = true } = {}) {
  const P = { ...DEFAULT_PATHS, ...(paths ?? {}) }
  const abs = (rel) => join(root, rel)
  const existsRel = (rel) => existsSync(abs(rel))

  // ── 설정 ──────────────────────────────────────────────────────────────────
  const rawCfg = config ?? readJsonSafe(abs(P.config)) ?? {}
  const cfg = {
    epicOrder: Array.isArray(rawCfg.epicOrder) ? rawCfg.epicOrder : (rawCfg.plan?.epicOrder ?? null),
    dailyCap: rawCfg.dailyCap ?? rawCfg.plan?.dailyCap ?? null,
    parallel: rawCfg.parallel ?? rawCfg.defaults?.parallel ?? null,
    mockupGate: rawCfg.mockupGate ?? null,
    providers: rawCfg.providers ?? null,
    source: config ? 'injected' : existsRel(P.config) ? P.config : 'defaults',
  }

  // ── package.json scripts / 게이트 ─────────────────────────────────────────
  const pkg = readJsonSafe(abs('package.json')) ?? {}
  const scriptsRaw = pkg.scripts ?? {}
  const gateMap = detectGates(scriptsRaw)
  const chain = parseQaChain(scriptsRaw.qa ?? '')
  const scripts = {
    all: scriptsRaw,
    qa: scriptsRaw.qa ?? null,
    build: scriptsRaw.build ?? null,
    test: scriptsRaw.test ?? null,
    chain,
    gates: gateMap,
    missing: Object.entries(gateMap).filter(([, v]) => !v.available).map(([k]) => k),
  }

  // ── epics.md ──────────────────────────────────────────────────────────────
  const epicsText = readTextSafe(abs(P.epics)) ?? ''
  const epicHeaders = []
  const epicStories = []
  epicsText.split('\n').forEach((line, i) => {
    const h = EPIC_HEADER_RE.exec(line)
    if (h) { epicHeaders.push({ epic: Number(h[1]), title: h[2].trim(), line: i + 1 }); return }
    const s = EPIC_STORY_RE.exec(line)
    if (s) epicStories.push({ id: `${s[1]}-${s[2]}`, epic: Number(s[1]), num: Number(s[2]), title: s[3].trim(), line: i + 1 })
  })

  // ── sprint-status.yaml ────────────────────────────────────────────────────
  const sprintPath = `${P.impl}/sprint-status.yaml`
  const sprintText = readTextSafe(abs(sprintPath)) ?? ''
  const sprintRows = parseSprint(sprintText) // 단일 소스 — 2칸 들여쓰기 스토리 행만
  const sprintLines = []
  sprintText.split('\n').forEach((line, i) => {
    const m = /^ {2}(\d+-\d+[^:]*): *(backlog|ready-for-dev|in-progress|review|done)\b(.*)$/.exec(line)
    if (m) sprintLines.push({ key: m[1], line: i + 1, note: (m[3] ?? '').replace(/^\s*#\s?/, '').trim() })
  })
  const sprint = sprintRows.map((r, i) => ({
    ...r,
    line: sprintLines[i]?.key === r.key ? sprintLines[i].line : (sprintLines.find((l) => l.key === r.key)?.line ?? 0),
    note: maskLine(sprintLines.find((l) => l.key === r.key)?.note ?? ''),
  }))
  const sprintKeys = sprint.map((r) => r.key)
  const sprintIds = uniq(sprint.map((r) => storyId(r.key)))

  // ── 구현 폴더의 md 목록 ───────────────────────────────────────────────────
  const implFiles = listDir(abs(P.impl)).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
  const implStoryDocs = implFiles.map((n) => n.replace(/\.md$/, '')).filter((n) => STORY_DOC_RE.test(n))
  const orphanStoryDocs = implStoryDocs
    .filter((n) => !sprintKeys.includes(n))
    .map((n) => ({ name: n, path: `${P.impl}/${n}.md`, id: storyId(n), why: 'sprint-status 에 같은 키가 없다 — 스토리가 아니라 참고 문서일 가능성' }))

  // ── 코드·테스트 스캔 ──────────────────────────────────────────────────────
  const codePaths = []
  for (const d of P.codeDirs) if (existsRel(d)) walkCode(root, d, codePaths, maxCodeFiles)
  const codeFiles = []
  for (const rel of codePaths) {
    const text = readTextSafe(abs(rel))
    if (text !== null) codeFiles.push({ path: rel, text })
  }
  const testPaths = codePaths.filter((p) => TEST_FILE_RE.test(p))
  const srcPaths = codePaths.filter((p) => P.srcDirs.some((d) => p === d || p.startsWith(`${d}/`)))

  const tempCode = detectTempCode(codeFiles)
  const disabled = detectDisabledTests(codeFiles)

  // ── 스토리 파일 ───────────────────────────────────────────────────────────
  const stories = sprint.map((row) => readStory({ root, implDir: P.impl, row, testPaths, existsRel }))
  const epicSections = {}
  for (const row of sprint) epicSections[row.key] = sectionOfStory(epicsText, storyId(row.key), epicStories, epicHeaders)
  const epicOnly = epicStories
    .filter((s) => !sprintIds.includes(s.id))
    .map((s) => {
      const section = sectionOfStory(epicsText, s.id, epicStories, epicHeaders)
      return { ...s, origin: 'epics', section: maskSecrets(section).slice(0, 4000), files: uniq([...section.matchAll(/`([^`\n]+)`/g)].map((m) => norm(m[1])).filter((p) => p.includes('/'))) }
    })

  // ── git (읽기 명령만) ─────────────────────────────────────────────────────
  const g = (args) => (git ? spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }) : { status: 1, stdout: '' })
  const gOut = (args) => { const r = g(args); return (r.status ?? 1) === 0 ? String(r.stdout ?? '') : '' }
  const branch = gOut(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const head = gOut(['rev-parse', 'HEAD']).trim()
  const dirty = gOut(['status', '--porcelain']).split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 200)
  const recent = gOut(['log', '-n', '10', '--pretty=%h %ad %s', '--date=short']).split('\n').filter(Boolean).map(maskLine)
  const trackedEnv = gOut(['ls-files', '--', '.env*', '*/.env*']).split('\n').map((s) => norm(s.trim())).filter(Boolean)

  // 시크릿 스캔은 **추적 여부를 안 뒤에** 돈다(미추적 .env 는 정상이라 findings 로 올리지 않는다).
  const security = scanSecretValues(codeFiles, root, P, existsRel, trackedEnv)

  // ── 원장 ──────────────────────────────────────────────────────────────────
  const ledgers = {
    inbox: readInbox(abs(P.inbox), P.inbox),
    deferred: readDeferred(abs(P.deferred), P.deferred),
    dbDrift: readDbDrift(abs(P.dbDrift), P.dbDrift),
  }

  // ── 엔진 산출물 ───────────────────────────────────────────────────────────
  const logEntries = listDir(abs(P.logs)).filter((e) => e.isFile()).map((e) => e.name)
  const manifests = {}
  for (const n of logEntries.filter((n) => n.endsWith('-verification.json'))) {
    const j = readJsonSafe(join(abs(P.logs), n))
    if (j) manifests[n.replace(/-verification\.json$/, '')] = j
  }
  const engineState = readJsonSafe(join(abs(P.logs), 'state.json')) ?? null
  const lastRun = readTextSafe(join(abs(P.logs), 'night-last-run.md'), maxLogBytes)

  // ── 배포 ──────────────────────────────────────────────────────────────────
  const migrationFiles = listDir(abs(P.migrations)).filter((e) => e.isFile() && e.name.endsWith('.sql')).map((e) => e.name)
  const wranglerName = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((n) => existsRel(n)) ?? null
  const wranglerText = wranglerName ? readTextSafe(abs(wranglerName)) ?? '' : ''
  const preflightRef = /node\s+(\S*preflight\S*)/.exec(scriptsRaw['deploy:prod'] ?? scriptsRaw['deploy:dev'] ?? '')?.[1] ?? null
  const envFilePaths = uniq([
    ...['.env', '.env.local', '.env.production', '.env.development'].filter((n) => existsRel(n)),
    ...trackedEnv,
  ])
  const deploy = {
    migrations: migrationFiles.length,
    migrationFiles: migrationFiles.slice(-20),
    wrangler: wranglerName ? { path: wranglerName, exists: true, envs: uniq([...wranglerText.matchAll(/"([a-zA-Z0-9_-]+)"\s*:\s*\{/g)].map((m) => m[1])).slice(0, 20) } : { path: null, exists: false, envs: [] },
    preflight: preflightRef ? { ref: preflightRef, exists: existsRel(norm(preflightRef)) } : { ref: null, exists: null },
    envFiles: envFilePaths.map((p) => ({ path: p, tracked: trackedEnv.includes(p), secretPath: SECRET_PATH_RE.test(p), example: SECRET_PATH_EXAMPLE_RE.test(p) })),
  }

  // ── 설치본 낡음(프로젝트가 복사본 파서를 들고 있는가) ─────────────────────
  const localParser = 'tools/lib/story-ledger.mjs'
  const installedParser = existsRel(localParser)
    ? { path: localParser, bytes: (readTextSafe(abs(localParser)) ?? '').length }
    : null

  // 반환 직전 **스냅숏 전체**를 deep-redact 한다(H1). 지금까지는 `lastRun`·일부 줄만 마스킹해서
  // `scripts.all`(package.json) · `manifests`(과거 verification.json) · `engineState`(state.json) ·
  // `stories[].snippet` 에 박힌 토큰이 snapshot.json 에 원문으로 남았다. 탐지(security)는 **원문 기준**으로
  // 이미 끝난 뒤라 마스킹이 판정을 흐리지 않는다 — 여기서 가리는 것은 내보내는 값뿐이다.
  return deepRedact({
    schema: SNAPSHOT_SCHEMA,
    at: now.toISOString(),
    root: norm(root),
    paths: P,
    config: cfg,
    scripts,
    sprint,
    epicHeaders,
    epicStories,
    epicSections,
    epicOnly,
    stories,
    orphanStoryDocs,
    git: { branch, head, dirty, protected: ['main', 'master', 'release'].includes(branch), recent, enabled: git },
    ledgers,
    manifests,
    engineState,
    lastRun: lastRun ? maskSecrets(lastRun).slice(0, maxLogBytes) : null,
    code: {
      srcCount: srcPaths.length,
      testCount: testPaths.length,
      scanned: codePaths.length,
      testPaths: testPaths.slice(0, 4000),
      tempCode,
      disabledTests: disabled.skips,
      onlyHits: disabled.onlys,
    },
    security,
    deploy,
    installedParser,
  })
}

/** 스토리 md 1건 → 스냅숏 항목. 원장 해석은 전부 `story-ledger` 에 위임한다. */
function readStory({ root, implDir, row, testPaths, existsRel }) {
  const rel = `${implDir}/${row.key}.md`
  const text = readTextSafe(join(root, rel))
  if (text === null) {
    return {
      key: row.key, id: storyId(row.key), epic: row.epic, path: rel, exists: false,
      hash: null, bytes: 0, mtime: null, baselineCommit: null,
      statusInFile: null, statusInSprint: row.status, sections: {}, acIds: [],
      signals: { openDecision: false, openPatches: 0, banPresent: false, unfinishedTasks: 0, files: [] },
      fileList: { sectionPresent: false, declared: [], missing: [], untested: [] },
      qaClaims: [],
    }
  }
  const st = (() => { try { return statSync(join(root, rel)) } catch { return null } })()
  const sections = {}
  text.split('\n').forEach((line, i) => {
    const m = /^(#{1,6}) (.+?)\s*$/.exec(line)
    if (m) sections[m[2]] = i + 1
  })
  const acBlock = /## Acceptance Criteria\n([\s\S]*?)(?=\n## )/.exec(text)?.[1] ?? ''
  const acIds = uniq([...acBlock.matchAll(/\*\*(AC-\d+)/g)].map((m) => m[1]))
  const signals = readStorySignals(text)
  const parsed = parseFileList(text)
  const declared = uniq([...(parsed ?? []), ...signals.files].map(norm).filter((p) => p.includes('/')))
  const missing = declared.filter((p) => !existsRel(p))
  const untested = declared.filter((p) => CODE_EXT.has(extname(p)) && !TEST_FILE_RE.test(p) && !missing.includes(p) && !hasTestFor(p, testPaths))
  const qaClaims = text.split('\n').filter((l) => /qa[^\n]{0,60}exit\s*0/i.test(l)).slice(0, 5).map(maskLine)

  return {
    key: row.key, id: storyId(row.key), epic: row.epic, path: rel, exists: true,
    hash: sha(text), bytes: text.length, mtime: st ? new Date(st.mtimeMs).toISOString() : null,
    baselineCommit: /^baseline_commit:\s*(\S+)/m.exec(text.slice(0, 400))?.[1] ?? null,
    statusInFile: /^Status:\s*(\S+)/m.exec(text)?.[1] ?? null,
    statusInSprint: row.status,
    sections, acIds, signals,
    fileList: { sectionPresent: parsed !== null, declared, missing, untested },
    qaClaims,
  }
}

/**
 * epics.md 의 스토리 절 본문. `story-ledger.epicSection` 을 먼저 쓰되, **마지막 절**은 종결 헤더가
 * 없어 그 정규식이 빈 문자열을 돌려준다(실물 함정 — 마지막 스토리만 통째로 안 읽힌다).
 * 그럴 때만 기록해 둔 줄 번호로 잘라 낸다.
 */
export function sectionOfStory(epicsText, id, epicStories = [], epicHeaders = []) {
  const s = epicSection(epicsText, id)
  if (s) return s
  const me = epicStories.find((e) => e.id === id)
  if (!me) return ''
  const lines = String(epicsText).split('\n')
  const stops = [...epicStories.map((e) => e.line), ...epicHeaders.map((h) => h.line)].filter((n) => n > me.line).sort((a, b) => a - b)
  return lines.slice(me.line, stops.length ? stops[0] - 1 : lines.length).join('\n')
}

/** D3 대응 테스트 매칭 — `basename.test.*`/`.spec.*` 또는 `tests/<도메인 폴더>/` 관례(설계 §2-1). */
export function hasTestFor(path, testPaths) {
  const p = norm(path)
  const stem = basename(p).replace(/\.[cm]?[jt]sx?$/, '')
  for (const t of testPaths) {
    const b = basename(t)
    if (b.startsWith(`${stem}.test.`) || b.startsWith(`${stem}.spec.`)) return true
  }
  const segs = p.split('/')
  const domain = segs.length >= 2 ? segs[segs.length - 2] : null
  if (domain && domain !== 'src' && testPaths.some((t) => norm(t).includes(`/${domain}/`) || norm(t).startsWith(`tests/${domain}/`))) return true
  return false
}

// ── 원장 파서(작게) ──────────────────────────────────────────────────────────
function readInbox(absPath, rel) {
  const text = readTextSafe(absPath)
  if (text === null) return { path: rel, exists: false, pending: [], confirmed: 0 }
  const pending = text.split('\n')
    .filter((l) => /^#{3} .*🟠/.test(l))
    .map((l) => ({ title: maskLine(l.replace(/^#+\s*/, '')), severity: /\((low|medium|high)\)/.exec(l)?.[1] ?? 'medium' }))
  return { path: rel, exists: true, bytes: text.length, hash: sha(text), pending, confirmed: (text.match(/^#{2,3} ✅/gm) ?? []).length }
}
function readDeferred(absPath, rel) {
  const text = readTextSafe(absPath)
  if (text === null) return { path: rel, exists: false, sections: [], items: 0 }
  const sections = [...text.matchAll(/^## Deferred from: code review of (\S+)\s*(?:\(([^)]*)\))?/gm)].map((m) => ({ story: m[1], note: m[2] ?? '' }))
  return { path: rel, exists: true, bytes: text.length, hash: sha(text), sections, items: (text.match(/^- \*\*\[[^\]]+\]\[Defer\]/gm) ?? []).length }
}
function readDbDrift(absPath, rel) {
  const text = readTextSafe(absPath)
  if (text === null) return { path: rel, exists: false, pendingCount: 0, queueAdds: 0 }
  const pending = /운영 적용 대기\s*—\s*\*\*(\d+)건\*\*/.exec(text)?.[1]
  const queue = [...text.matchAll(/🚨\s*적용 큐\s*\+(\d+)\s*파일/g)].reduce((a, m) => a + Number(m[1]), 0)
  return { path: rel, exists: true, bytes: text.length, hash: sha(text), pendingCount: pending === undefined ? 0 : Number(pending), queueAdds: queue }
}

// ── 코드 휴리스틱 (설계 §2-2) ────────────────────────────────────────────────

/** 소스 한 줄에서 위치 idx 가 문자열 리터럴 / 주석 / 실코드 중 어디인가. */
export function lineContextAt(line, idx) {
  const s = String(line ?? '')
  let quote = null
  for (let i = 0; i < idx && i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) return 'comment'
  }
  if (quote) return 'string'
  return /^\s*(\/\/|\/\*|\*)/.test(s) ? 'comment' : 'code'
}

const isGuardTestFile = (p) => /guard/i.test(basename(p)) && /\.(test|spec)\./.test(basename(p))

/**
 * 임시 코드 탐지. `files` = `[{path,text}]`.
 * tests/**·mockups/**·*.md 는 제외한다 — 테스트의 TODO 는 다른 갈래다.
 */
export function detectTempCode(files, { cap = 400 } = {}) {
  const out = []
  for (const f of files ?? []) {
    const p = norm(f.path)
    if (/(^|\/)(tests?|__tests__|spec)\//.test(p) || /(^|\/)mockups\//.test(p) || p.endsWith('.md')) continue
    const lines = String(f.text ?? '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!TEMP_CODE_RE.test(line)) continue // 1차 그물(싸다)
      let why = null
      if (TEMP_CODE_MARKER_RE.test(line)) why = 'TODO/FIXME/HACK 표시가 출고 코드에 남아 있다'
      else if (TEMP_CODE_KO_RE.test(line)) why = '「임시 구현·나중에 고침」 표시가 출고 코드에 남아 있다'
      else {
        const w = TEMP_CODE_WEAK_RE.exec(line)
        // placeholder/dummy 는 **주석 안일 때만** 임시 표시다 — JSX `placeholder="…"` 는 정상 UI 코드다.
        if (w && lineContextAt(line, w.index) === 'comment') why = '주석의 placeholder/dummy 표시 — 미완성 흔적'
      }
      if (!why) continue
      const secret = SECRET_PATH_RE.test(p)
      out.push({
        kind: secret ? 'temp-code-in-secret-path' : 'temp-code',
        severity: secret ? 'high' : 'low',
        path: p, line: i + 1, snippet: maskLine(line), why,
      })
      if (out.length >= cap) return out
    }
  }
  return out
}

/**
 * 비활성 테스트 탐지 — `.only` 는 나머지를 조용히 끄고, `.skip` 은 사유가 있어야 한다.
 * **오탐 봉합**: 문자열/주석 안이거나 `*guard*.test.*` 파일이면 `needs-review`(low) 로 내린다 —
 * 가드 테스트가 자기 금지 규칙을 인용하는 것을 위반으로 세면 규칙이 자기 자신을 잡는다.
 */
export function detectDisabledTests(files, { cap = 400 } = {}) {
  const onlys = []
  const skips = []
  for (const f of files ?? []) {
    const p = norm(f.path)
    const lines = String(f.text ?? '').split('\n')
    const guard = isGuardTestFile(p)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const om = ONLY_RE.exec(line)
      if (om) {
        const ctx = lineContextAt(line, om.index)
        const soft = guard || ctx !== 'code'
        onlys.push({
          kind: soft ? 'test-only-needs-review' : 'test-only',
          severity: soft ? 'low' : 'high',
          path: p, line: i + 1, snippet: maskLine(line), context: ctx, guardFile: guard,
          why: soft
            ? `\`.only(\` 가 ${guard ? '가드 테스트' : ctx === 'string' ? '문자열 리터럴' : '주석'} 안이다 — 사람이 한 번 본다`
            : '`.only(` 가 나머지 테스트를 조용히 끈다',
        })
      }
      const sm = SKIP_RE.exec(line)
      if (sm && lineContextAt(line, sm.index) === 'code') {
        const before = lines.slice(Math.max(0, i - 3), i).join('\n')
        const justified = /(사유|why|because|reason|이유|TODO\(|@see)/i.test(before) && /(\/\/|\/\*|\*)/.test(before)
        skips.push({
          kind: justified ? 'test-skip-justified' : 'test-skip',
          severity: justified ? 'low' : 'medium',
          path: p, line: i + 1, snippet: maskLine(line), justified,
          why: justified ? 'skip 에 사유 주석이 붙어 있다' : 'skip/todo 에 사유가 없다 — 조용히 꺼진 검사',
        })
      }
      if (onlys.length + skips.length >= cap) return { onlys, skips }
    }
  }
  return { onlys, skips }
}

/**
 * 시크릿 **값** 스캔 — 경로:줄 + 마스킹만 남기고 원문은 어디에도 두지 않는다.
 *
 * 무엇을 위험으로 보나: 비밀정보는 **`.env` 에 있는 것이 정상**이다(모든 개발자 PC 에 있다).
 * 위험은 ① 코드에 박히거나 ② git 에 추적되는 것이다. 그래서 미추적 `.env*` 의 값 히트는
 * `envValueHits`(집계만)로 빼고 findings 로 올리지 않는다 — 안 그러면 P2 가 영원히 fail 이다.
 */
function scanSecretValues(codeFiles, root, P, existsRel, trackedEnv = []) {
  const valueHits = []
  const envValueHits = []
  const classify = (m) => (m.startsWith('sk-') ? 'api-key' : m.startsWith('eyJ') ? 'jwt' : m.startsWith('-----') ? 'private-key' : 'assigned-secret')
  const scan = (p, text, sink) => {
    const lines = String(text ?? '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = SECRET_VALUE_RE.exec(lines[i])
      if (!m) continue
      // `service_role` 단독 낱말은 역할 이름이다 — **값 대입 형태**일 때만 비밀로 친다.
      if (m[1] === 'service_role' && !SECRET_ASSIGN_RE.test(lines[i])) continue
      sink.push({ path: norm(p), line: i + 1, pattern: classify(m[1]), masked: maskLine(lines[i]) })
      if (valueHits.length + envValueHits.length >= 300) return
    }
  }
  for (const f of codeFiles) scan(f.path, f.text, valueHits)
  for (const n of ['.env', '.env.local', '.env.production', '.env.development', '.env.example']) {
    if (!existsRel(n)) continue
    scan(n, readTextSafe(join(root, n)) ?? '', trackedEnv.includes(n) ? valueHits : envValueHits)
  }
  const pathHits = []
  for (const f of codeFiles) if (SECRET_PATH_RE.test(norm(f.path)) && !SECRET_PATH_EXAMPLE_RE.test(norm(f.path))) pathHits.push(norm(f.path))
  return { valueHits, envValueHits, pathHits: uniq(pathHits) }
}

// ═══════════════════════════════════════════════════════════════════════════
// ② diagnose — 순수 판정
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 스토리 1건의 완료 판정 — 설계 §2-1 강등표 D1~D11 을 **위에서부터 첫 일치**로 적용한다.
 * `gates` 는 실제 실행 결과(rank 1)다. 없으면 어떤 문서도 `verified-done` 을 만들지 못한다.
 */
export function classifyStoryCompletion(story, snapshot, gates = {}) {
  const ev = []
  const gaps = []
  const qa = gates?.qa ?? null
  const qaRan = qa && qa.exit !== null && qa.exit !== undefined
  const declared = story.statusInSprint ?? story.statusInFile ?? null
  const addGap = (code, n = 1) => { if (n > 0) gaps.push({ code, n }) }
  const done = (verdict, rank, kind, what) => {
    ev.push({ rank, kind, what })
    return { verdict, confidence: confidenceOf(rank), evidence: ev, gaps, declared }
  }

  if (declared) ev.push({ rank: evidenceRank('story'), kind: 'story', what: `문서 선언 상태 = ${declared}` })

  // 스토리 파일 자체가 없다 — 다른 신호는 전부 빈 값이라 먼저 처리한다(D8/D9).
  if (story.origin === 'epics') {
    addGap('epics-only')
    return done('missing', evidenceRank('plan'), 'plan', 'epics.md 에만 있고 sprint-status 에 없다')
  }
  if (!story.exists) {
    addGap('story-file-missing')
    return done('missing', evidenceRank('story'), 'story', 'sprint 키는 있는데 스토리 md 가 없다')
  }

  const s = story.signals ?? {}
  // D1 — qa RED 가 이 스토리의 File List 파일을 가리킨다
  if (qaRan && qa.exit !== 0) {
    const hay = `${qa.failure?.signature ?? ''}\n${qa.log ?? ''}`
    const hit = (story.fileList?.declared ?? []).find((p) => p && hay.includes(p))
    if (hit) {
      addGap('qa-red-in-file-list')
      return done('defect', evidenceRank('gate'), 'gate', `qa RED 가 이 스토리의 파일을 가리킨다(${hit})`)
    }
  }
  const isDone = declared === 'done'
  // ── D2~D7 강등 — **전부 수집한 뒤 rank 최소값(=가장 센 증거)으로 판정**한다(codex-review-r3 L1).
  // 종전에는 선언 순서대로 첫 일치를 반환해서, File List 부재(D2 = code · rank 3)와 테스트 부재
  // (D3 = test · rank 2)가 **동시에** 있을 때 상수표(`gate > test > code > story > plan`)와 반대로
  // 약한 code 증거로 조기 반환했다. 동점이면 선언 순서를 지킨다(D4 → D5 → D6 → D7).
  const cands = []
  const cand = (verdict, kind, what, gapsToAdd) => cands.push({ verdict, rank: evidenceRank(kind), kind, what, gapsToAdd })
  // D2 — 선언 done + File List 부재(절 자체가 없거나 선언 파일이 실재하지 않음)
  if (isDone && (!story.fileList?.sectionPresent || (story.fileList?.missing ?? []).length > 0)) {
    const missing = (story.fileList?.missing ?? []).length
    cand('partial', 'code', story.fileList?.sectionPresent ? `File List 의 파일 ${missing}건이 실재하지 않는다` : 'File List 절이 없다 — 무엇을 만졌는지 증거가 없다',
      [...(story.fileList?.sectionPresent ? [] : [['file-list-missing', 1]]), ['file-list-file-missing', missing]])
  }
  // D3 — 선언 done + 비테스트 파일에 대응 테스트 0
  if (isDone && (story.fileList?.untested ?? []).length > 0) {
    cand('partial', 'test', `대응 테스트가 없는 파일 ${story.fileList.untested.length}건`, [['untested-files', story.fileList.untested.length]])
  }
  // D4 — 열린 [Review][Patch]
  if ((s.openPatches ?? 0) > 0) cand('partial', 'story', `열린 [Review][Patch] ${s.openPatches}건`, [['open-patch', s.openPatches]])
  // D5 — 열린 [Review][Decision]
  if (s.openDecision) cand('blocked', 'story', '열린 [Review][Decision] — 사람 판단 대기', [['open-decision', 1]])
  // D6 — 미완 Task(사람 게이트 줄 제외 · story-ledger 가 이미 걸렀다)
  if ((s.unfinishedTasks ?? 0) > 0) cand('partial', 'story', `미완 Task ${s.unfinishedTasks}건`, [['unfinished-task', s.unfinishedTasks]])
  // D7 — 파일 Status ≠ sprint 상태
  if (story.statusInFile && story.statusInSprint && story.statusInFile !== story.statusInSprint) {
    cand('partial', 'story', `Status 헤더(${story.statusInFile}) ≠ sprint(${story.statusInSprint})`, [['status-drift', 1]])
  }
  if (cands.length > 0) {
    const win = cands.reduce((a, b) => (b.rank < a.rank ? b : a))
    for (const [code, n] of win.gapsToAdd) addGap(code, n)
    return done(win.verdict, win.rank, win.kind, win.what)
  }
  // D10 — 위 전부 아님 + qa GREEN
  if (qaRan && qa.exit === 0) {
    if (isDone) return done('verified-done', evidenceRank('gate'), 'gate', 'qa exit 0 + 열린 지적 0 + File List 실재')
    addGap('not-yet-declared-done')
    return done('partial', evidenceRank('gate'), 'gate', `qa GREEN 이지만 선언 상태가 ${declared} 다`)
  }
  // D11 — qa 미실행
  addGap('qa-not-run')
  return done('not-verified', evidenceRank('story'), 'story', 'qa 를 실행하지 않았다 — 문서의 done 만으로는 완료를 증명하지 못한다')
}

/** 배포 차단 요인(설계 §2-2). 순수. */
export function detectDeployBlockers(snapshot) {
  const out = []
  const d = snapshot?.deploy ?? {}
  const drift = snapshot?.ledgers?.dbDrift ?? {}
  if ((drift.pendingCount ?? 0) > 0) {
    out.push({ kind: 'db-drift-pending', severity: 'high', path: drift.path, count: drift.pendingCount, why: `운영 적용 대기 마이그레이션 ${drift.pendingCount}건 — 코드만 먼저 나가면 기존 화면이 깨진다`, userImpact: '배포 직후 화면이 오류를 낸다' })
  }
  if (d.preflight?.ref && d.preflight.exists === false) {
    out.push({ kind: 'deploy-preflight-missing', severity: 'high', path: d.preflight.ref, why: 'deploy 스크립트가 참조하는 preflight 파일이 없다 — 배포 명령이 즉시 실패한다', userImpact: '배포가 아예 되지 않는다' })
  }
  if (d.wrangler?.exists && (d.wrangler.envs ?? []).length === 0) {
    out.push({ kind: 'deploy-env-missing', severity: 'medium', path: d.wrangler.path, why: '배포 설정에서 환경 키를 찾지 못했다', userImpact: '어느 환경으로 나가는지 확정할 수 없다' })
  }
  for (const f of d.envFiles ?? []) {
    if (f.tracked && !f.example) out.push({ kind: 'secret-path-tracked', severity: 'high', path: f.path, why: '비밀정보 파일이 git 에 추적되고 있다', userImpact: '저장소를 받은 누구나 열쇠를 갖는다' })
  }
  return out
}

/** 문서-구현 불일치(설계 §2-2 A/B/C 집합). 순수. */
export function detectDocMismatch(snapshot) {
  const out = []
  const A = uniq((snapshot?.epicStories ?? []).map((s) => s.id)) // 계획(epics.md)
  const B = uniq((snapshot?.sprint ?? []).map((r) => storyId(r.key))) // 원장(sprint)
  for (const id of A.filter((x) => !B.includes(x))) {
    const s = snapshot.epicStories.find((e) => e.id === id)
    out.push({ kind: 'plan-only-story', severity: 'medium', path: snapshot.paths?.epics ?? null, story: id, why: `epics.md 의 Story ${id.replace('-', '.')} 가 sprint-status 에 없다 — 계획만 있고 원장에 안 올랐다`, userImpact: '이 기능은 아무도 만들고 있지 않다' })
  }
  for (const r of snapshot?.sprint ?? []) {
    if (!A.includes(storyId(r.key))) out.push({ kind: 'sprint-only-story', severity: 'low', path: `${snapshot.paths?.impl}/sprint-status.yaml`, story: r.key, why: 'sprint 키가 epics.md 에 없다 — 목록 SoT 밖의 스토리', userImpact: '계획 문서만 읽는 사람은 이 일을 모른다' })
  }
  for (const o of snapshot?.orphanStoryDocs ?? []) {
    out.push({ kind: 'orphan-doc', severity: 'low', path: o.path, story: o.name, why: o.why, userImpact: '문서를 스토리로 착각해 배치가 헛돈다' })
  }
  for (const st of snapshot?.stories ?? []) {
    if (!st.exists) continue
    if (!st.fileList?.sectionPresent) out.push({ kind: 'file-list-missing', severity: 'medium', path: st.path, story: st.key, why: 'File List 절이 없다 — 무엇을 만졌는지 추적할 수 없다', userImpact: '문제가 생겨도 어디를 되돌릴지 모른다' })
    for (const m of st.fileList?.missing ?? []) out.push({ kind: 'file-list-file-missing', severity: 'medium', path: m, story: st.key, why: 'File List 가 선언한 파일이 실재하지 않는다', userImpact: '완료 기록이 실제 코드와 다르다' })
    if (st.statusInFile && st.statusInSprint && st.statusInFile !== st.statusInSprint) {
      out.push({ kind: 'status-drift', severity: 'low', path: st.path, story: st.key, why: `Status 헤더(${st.statusInFile}) ≠ sprint(${st.statusInSprint})`, userImpact: '현황판이 실제와 다른 진행률을 보여 준다' })
    }
  }
  if (snapshot?.installedParser) {
    out.push({ kind: 'stale-installed-parser', severity: 'low', path: snapshot.installedParser.path, why: '프로젝트가 원장 해석기 복사본을 들고 있다 — 스킬 본체와 갈리면 판정이 갈린다', userImpact: '같은 원장을 두 도구가 다르게 읽는다' })
  }
  return out
}

/** 보안 위험(설계 §2-2). 값 원문은 절대 싣지 않는다. 순수. */
export function detectSecurityRisks(snapshot) {
  const out = []
  for (const h of snapshot?.security?.valueHits ?? []) {
    out.push({ kind: 'secret-value', severity: 'high', path: h.path, line: h.line, why: `비밀정보로 보이는 값(${h.pattern})이 파일에 들어 있다`, snippet: h.masked, userImpact: '열쇠가 새면 남이 우리 데이터를 읽는다' })
  }
  for (const p of snapshot?.security?.pathHits ?? []) {
    out.push({ kind: 'secret-path-tracked', severity: 'high', path: p, why: '비밀정보 경로의 파일이 코드 스캔 범위 안에 있다', userImpact: '모델 입력·로그로 새어 나갈 수 있다' })
  }
  return out
}

/**
 * 스냅숏 → 진단. **순수**(실행 0 · 파일 접근 0).
 * @param {object} snapshot readProject 결과
 * @param {{gates?:object, prevDiagnosis?:object|null, round?:number, now?:Date}} opts
 */
export function diagnose(snapshot, { gates = {}, prevDiagnosis = null, round = 0, now = null } = {}) {
  const findings = []
  const push = (f) => {
    const kind = f.kind
    const tier = tierOfFinding(f)
    findings.push({
      id: shortId('F', [kind, f.path ?? '', f.story ?? '', f.line ?? '', f.why ?? '']),
      fingerprint: sha([kind, norm(f.path ?? ''), f.story ?? '', String(f.line ?? ''), String(f.count ?? '')].join('|')).slice(0, 16),
      kind, severity: f.severity ?? 'medium', tier,
      path: f.path ? norm(f.path) : null, line: f.line ?? null, story: f.story ?? null,
      why: maskSecrets(f.why ?? ''), snippet: f.snippet ? maskSecrets(f.snippet) : null,
      evidence: f.evidence ?? [{ rank: evidenceRank(f.evidenceKind ?? 'code'), kind: f.evidenceKind ?? 'code', what: maskSecrets(f.why ?? '') }],
      userImpact: f.userImpact ?? '',
    })
  }

  // ── 스토리 판정 ───────────────────────────────────────────────────────────
  const all = [...(snapshot?.stories ?? []), ...(snapshot?.epicOnly ?? []).map((e) => ({ key: e.id, id: e.id, epic: e.epic, path: snapshot?.paths?.epics ?? null, exists: false, origin: 'epics', statusInFile: null, statusInSprint: null, signals: {}, fileList: { sectionPresent: false, declared: e.files ?? [], missing: [], untested: [] }, title: e.title }))]
  const stories = all.map((st) => {
    const r = classifyStoryCompletion(st, snapshot, gates)
    return { key: st.key, id: st.id, epic: st.epic, origin: st.origin ?? 'sprint', path: st.path, declared: r.declared, verdict: r.verdict, confidence: r.confidence, evidence: r.evidence, gaps: r.gaps }
  })

  const GAP_KIND = {
    'open-patch': ['open-patch', 'high'],
    'open-decision': ['open-decision', 'high'],
    'unfinished-task': ['unfinished-task', 'medium'],
    'untested-files': ['untested-files', 'medium'],
    'qa-red-in-file-list': ['story-defect', 'high'],
    'story-file-missing': ['story-missing', 'medium'],
    'epics-only': ['story-missing', 'medium'],
    'not-yet-declared-done': ['story-partial', 'low'],
  }
  for (const st of stories) {
    for (const g of st.gaps) {
      const m = GAP_KIND[g.code]
      if (!m) continue // file-list-*·status-drift·qa-not-run 은 아래 전용 탐지기가 낸다(중복 금지)
      push({ kind: m[0], severity: m[1], story: st.key, path: st.path, count: g.n, evidenceKind: 'story', why: `${st.key}: ${g.code} ${g.n}건`, userImpact: '이 스토리는 아직 사용자가 쓸 수 있는 상태가 아니다' })
    }
  }

  // ── 게이트 ────────────────────────────────────────────────────────────────
  const gateOut = {}
  for (const [name, g] of Object.entries(gates ?? {})) {
    gateOut[name] = { exit: g?.exit ?? null, ms: g?.ms ?? null, source: g?.source ?? 'gate', log: g?.logPath ?? null, available: g?.available !== false, failure: g?.failure ?? null }
    if (g && g.available === false) continue
    if (g && g.exit !== null && g.exit !== undefined && g.exit !== 0) {
      push({ kind: 'gate-red', severity: 'high', path: null, evidenceKind: 'gate', why: `게이트 ${name} 이 실패했다(exit ${g.exit}${g.failure?.kind ? ` · ${g.failure.kind}` : ''})`, userImpact: '지금 상태로는 배포할 수 없다' })
    }
  }
  const notVerified = []
  if (!gates?.qa || gates.qa.exit === null || gates.qa.exit === undefined) {
    push({ kind: 'gate-not-run', severity: 'medium', path: null, evidenceKind: 'plan', why: 'qa 게이트를 실행하지 않았다 — 문서 증거만으로는 통과를 주장할 수 없다', userImpact: '“된다”는 말의 근거가 없다' })
    notVerified.push({ what: 'qa 게이트', why: '이번 진단에서 실행하지 않았다(--no-gates 이거나 아직 실행 전)' })
  }
  for (const name of ['security', 'performance']) {
    if (!snapshot?.scripts?.gates?.[name]?.available) notVerified.push({ what: `${name} 게이트`, why: `n/a(package.json scripts 에 ${name} 없음) — 없는 것은 GREEN 이 아니다` })
  }
  if (!snapshot?.scripts?.gates?.build?.available) push({ kind: 'build-missing', severity: 'medium', path: 'package.json', evidenceKind: 'code', why: 'build 스크립트가 없다 — 빌드 가능 여부를 확인할 방법이 없다', userImpact: '배포본이 실제로 만들어지는지 모른다' })

  // ── 전용 탐지기 ───────────────────────────────────────────────────────────
  for (const f of snapshot?.code?.tempCode ?? []) push({ ...f, evidenceKind: 'code', userImpact: f.kind === 'temp-code-in-secret-path' ? '보안 경로에 미완성 코드가 남아 있다' : '나중에 고치기로 한 것이 그대로 나갔다' })
  for (const f of [...(snapshot?.code?.onlyHits ?? []), ...(snapshot?.code?.disabledTests ?? [])]) push({ ...f, evidenceKind: 'test', userImpact: f.severity === 'high' ? '다른 검사가 조용히 꺼져 있다 — 통과가 통과가 아니다' : '검사 일부가 꺼져 있다' })
  for (const f of detectSecurityRisks(snapshot)) push({ ...f, evidenceKind: 'code' })
  for (const f of detectDeployBlockers(snapshot)) push({ ...f, evidenceKind: 'code' })
  for (const f of detectDocMismatch(snapshot)) push({ ...f, evidenceKind: 'story' })

  // ── 집계 ──────────────────────────────────────────────────────────────────
  const byTier = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }
  for (const f of findings) byTier[f.tier] = (byTier[f.tier] ?? 0) + 1
  const count = (v) => stories.filter((s) => s.verdict === v).length
  const counts = {
    storiesTotal: (snapshot?.stories ?? []).length,
    epicOnly: (snapshot?.epicOnly ?? []).length,
    declaredDone: (snapshot?.stories ?? []).filter((s) => s.statusInSprint === 'done').length,
    verifiedDone: count('verified-done'),
    partial: count('partial'),
    missing: count('missing'),
    blocked: count('blocked'),
    defect: count('defect'),
    notVerified: count('not-verified'),
    findings: byTier,
    findingsTotal: findings.length,
  }
  for (const s of stories) {
    if (s.verdict === 'not-verified') notVerified.push({ what: `스토리 ${s.key}`, why: 'qa 실행 증거가 없어 완료를 확인하지 못했다' })
  }

  // 진전 비교(loopDecision 재료) — 이전 진단 대비 tier≤3 증감
  const prevLow = prevDiagnosis ? (prevDiagnosis.counts?.findings?.[1] ?? 0) + (prevDiagnosis.counts?.findings?.[2] ?? 0) + (prevDiagnosis.counts?.findings?.[3] ?? 0) : null
  const nowLow = byTier[1] + byTier[2] + byTier[3]

  return {
    schema: DIAGNOSIS_SCHEMA,
    at: now ? now.toISOString() : (snapshot?.at ?? null),
    round,
    root: snapshot?.root ?? null,
    gates: gateOut,
    stories,
    findings,
    counts,
    notVerified: notVerified.slice(0, 300),
    progress: prevLow === null ? null : { prevCritical: prevLow, critical: nowLow, delta: nowLow - prevLow },
    fingerprint: sha(findings.map((f) => f.fingerprint).sort().join(',')).slice(0, 16),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ runGateProbe — 유일한 실행부(spawn 주입 · 1회 · 타임아웃)
// ═══════════════════════════════════════════════════════════════════════════

/** 게이트가 **출력 과다**(`maxBuffer` 초과)로 접혔을 때의 exit 코드. 124(timeout)와 갈라 적는다. */
export const GATE_EXIT_OVERFLOW = 125

/** 셸 메타문자 거부(BRIEF 정책 8) — 값이 셸로 재해석될 여지를 애초에 없앤다. */
export const SHELL_META_RE = /[;&|<>^`$()!*?"'\n\r]/
export function assertNoShellMeta(label, value) {
  if (SHELL_META_RE.test(String(value ?? ''))) throw new Error(`${label} 에 셸 메타문자가 있다 — 거부한다: ${String(value).slice(0, 60)}`)
}

/** npm 실행 경로 — Windows 는 `.cmd` 심이라 셸 문자열이 아니라 **argv 분리된 전용 경로**로 간다. */
export function npmInvocation(script) {
  assertNoShellMeta('npm script', script)
  if (process.platform === 'win32') return { bin: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'run', script] }
  return { bin: 'npm', args: ['run', script] }
}

/**
 * 게이트 1회 실행. **로그를 파일에 쓰지 않는다** — 결과 객체와 권장 경로만 돌려주고
 * 기록은 호출부(autofinish)가 한다(이 모듈이 쓰기를 갖지 않게 하려는 것).
 *
 * **async 다**(codex-review-r6 Medium): 기본 실행기가 `spawnWithDeadline` 이라 마감이 걸리면
 * `npm.cmd` 뒤에 붙은 손자(node·vitest)까지 트리째 끊고 즉시 돌아온다. 동기 스텁을 주입해도
 * 그대로 산다 — `await` 는 값도 통과시킨다.
 * @param {{root:string,name:string,script:string|null,exec?:Function,timeoutMs?:number,env?:object,logDir?:string|null,now?:Function}} o
 */
export async function runGateProbe({ root, name, script, exec = spawnWithDeadline, timeoutMs = 20 * 60_000, env = process.env, logDir = null, now = () => Date.now() }) {
  const logPath = logDir ? `${String(logDir).replace(/[/\\]+$/, '')}/gate-${name}.log` : null
  if (!script) {
    return { name, script: null, cmd: null, available: false, exit: null, ms: 0, timedOut: false, source: 'gate', log: '', logPath, failure: null, why: `n/a(package.json scripts 에 ${name} 없음)` }
  }
  const { bin, args } = npmInvocation(script)
  const t0 = now()
  const r = await exec(bin, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, shell: false, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const ms = now() - t0
  const raw = `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`
  const log = maskSecrets(raw)
  // 분류 **순서**는 계획 실행기(orchestrate.mjs)와 같다(2026-09-03 codex-review-r7 Low).
  //   ① `timedOut`/ETIMEDOUT      → 진짜 예산 초과 = exit 124
  //   ② 그 밖의 error(ENOBUFS 등) → 별도 exit 코드 · 사유 「출력 과다」
  //   ③ 원인 없는 signal          → 안전 폴백으로 timeout(종전 동작 보존)
  // `signal === 'SIGTERM'` 을 먼저 보면 64MB 출력 초과가 exit 124 로 둔갑해, 운영자가
  // 예산(`--budget-min`)을 늘리며 헛발질한다 — 실제로 늘려야 하는 건 출력이지 시간이 아니다.
  const deadline = r?.timedOut === true || r?.error?.code === 'ETIMEDOUT'
  const overflowed = !deadline && r?.error?.code === 'ENOBUFS'
  const signalOnly = !deadline && !r?.error && Boolean(r?.signal)
  const timedOut = deadline || signalOnly
  const noStatus = r?.status === null || r?.status === undefined
  const exit = !noStatus ? r.status : (timedOut ? 124 : overflowed ? GATE_EXIT_OVERFLOW : 1)
  return {
    name, script, cmd: `npm run ${script}`, available: true,
    exit, ms, timedOut, source: 'gate', log, logPath,
    failure: exit === 0 ? null : classifyQaFailure(log),
    why: exit === 0
      ? `${name} GREEN`
      : overflowed
        ? `${name} RED(exit ${exit} · 출력 과다 — maxBuffer 초과라 예산이 아니라 출력을 줄여야 한다)`
        : `${name} RED(exit ${exit})`,
  }
}
