// dev-status — BMad 프로젝트 개발 현황판: 데이터 수집기 (읽기 전용)
// 원천: epics.md(목록 SoT) + sprint-status.yaml(상태 SoT) + 스토리 .md + auto-pipeline-logs/
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assignByStory, collectBatchSources, lastNightManifests,
  parseBatchManifest, parseMetrics, parseVerification, resolveStateDir,
} from './batch-sources.mjs'
import { batchWarnings, deployVerdict, lastRelease, parseOpsEpics } from './verdict.mjs'
import { dailyMetrics } from './daily-metrics.mjs'

// ── 원천 계약 — BMad v6 에픽·스토리 템플릿의 구조 패턴 ──────────
// 문서 언어가 한국어여도 이 구조 키워드는 영어로 남는다. SKILL.md "원천 계약" 참조.
// **제목 단계(#의 개수)로 자르지 않는다** — 실제 문서가 한 규격이 아니기 때문이다
// (원 프로젝트 2026-09-21 실측): 에픽 절이 `## Epic N:` 과 `### Epic N:`(「## Epic List」 요약 절
// 안)에 나뉘고, 스토리 절도 `### Story N.M:` 94건 + `#### Story N.M:` 19건이 섞였다.
// 단계만 보던 종전 규칙은 스토리 30건을 「에픽 문서에 없습니다」로 오탐했다.
const PATTERNS = {
  epic: /^#{2,3} Epic (\d+): (.+?)\s*$/,          // epics.md 의 에픽 절(## · ### 둘 다)
  story: /^#{3,4} Story (\d+)\.(\d+): (.+?)\s*$/, // epics.md 의 스토리 절(### · #### 둘 다)
  ac: /^\*\*Given\*\*/gm,                         // 수용기준 개수 = **Given** 개수
  goal: /^\s*So that (.+)$/m,                     // 스토리 목표 문장
  deferred: /^## Deferred from:/,                 // 이 사본에서는 미사용 — 원천 계약 문서화용
}

// ── 안전 읽기 ────────────────────────────────────────────────────────────────
// `existsSync()` 뒤의 `readFileSync()` 는 경합에서 던진다 — 그 사이에 파일이 지워지거나(ENOENT),
// 다른 프로세스가 잠그거나(EBUSY·EPERM), 같은 이름의 폴더로 바뀌면(EISDIR) 화면 전체가 죽었다
// (2026-09-02 교차리뷰 M4). 이제 **모든 읽기는 `{value,error}`** 이고, 실패한 파일은 그 블록만
// 빈 값이 되며 사유가 READ_ERRORS 에 남아 화면 하단에 공시된다.
export const READ_ERRORS = []

/**
 * @param {string} p 파일 경로
 * @param {{required?:boolean}} [opt] required=true 면 「없음(ENOENT)」도 오류로 기록한다.
 * @returns {{value:string, error:null|{file:string,code:string,message:string}}}
 */
export function readSafe(p, { required = false } = {}) {
  try {
    return { value: readFileSync(p, 'utf8'), error: null }
  } catch (err) {
    const code = err?.code || 'EUNKNOWN'
    const e = { file: String(p), code, message: String(err?.message || err) }
    // 선택 원천의 단순 부재는 종전대로 조용한 빈 값이다(state.json·inbox 는 없는 것이 정상).
    if (!required && (code === 'ENOENT' || code === 'ENOTDIR')) return { value: '', error: null }
    READ_ERRORS.push(e)
    return { value: '', error: e }
  }
}
const read = (p, opt) => readSafe(p, opt).value

/** 폴더 읽기도 같다 — 없거나 못 읽으면 빈 목록 + (부재가 아닌 실패만) 사유 기록. */
function readdirSafe(p) {
  try {
    return readdirSync(p)
  } catch (err) {
    const code = err?.code || 'EUNKNOWN'
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      READ_ERRORS.push({ file: String(p), code, message: String(err?.message || err) })
    }
    return []
  }
}

/** mtime(ms). 못 읽으면 null — 호출부가 「모름」으로 그린다. */
function mtimeSafe(p) {
  try { return statSync(p).mtimeMs } catch { return null }
}

// ── 경로 탐지: --root 인자(없으면 cwd) → 상위 최대 6단 → BMad config ──────────
// 실패는 **CLI 로 실행했을 때만** exit 2 다. 라이브러리로 import 되었을 때 process.exit 하면
// 이 모듈을 읽기만 한 상위 도구(build.mjs·테스트·아침 브리핑)가 통째로 죽는다.
function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) out.root = argv[i + 1]
    else if (argv[i].startsWith('--root=')) out.root = argv[i].slice('--root='.length)
  }
  return out
}

// 모듈 적재 단계에서 굳은 초기화 오류(원천을 못 찾음). scan() 이 구조화 오류로 돌려준다.
const INIT_ERRORS = []
function fail(checkedLines, code = 'bmad-sources-missing') {
  INIT_ERRORS.push({
    code,
    message: 'BMad 산출물을 찾지 못했습니다 — BMad v6 프로젝트가 아니거나 산출물 경로가 다릅니다.',
    checked: checkedLines.slice(),
  })
}

const IS_CLI = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href } catch { return false }
})()

const argRoot = parseArgs(process.argv).root
const startDir = resolve(argRoot || process.cwd())
if (!existsSync(startDir)) fail(['--root 경로가 없습니다: ' + startDir], 'root-missing')

// 프로젝트 루트 = _bmad/ 또는 .git/ 를 만날 때까지 상위로 최대 6단(둘 다 있으면 _bmad/ 우선).
// 모노레포에서 cwd 가 패키지 폴더인 경우를 위한 것이다.
const climbed = []
let rootDir = null
{
  let dir = startDir
  for (let i = 0; i <= 6; i += 1) {
    climbed.push(dir)
    if (existsSync(join(dir, '_bmad')) || existsSync(join(dir, '.git'))) { rootDir = dir; break }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
}
if (!rootDir) {
  fail(['(상위 탐색) ' + climbed.join(' → ') + '   _bmad/ 또는 .git/ 없음'])
  rootDir = startDir // 이후 경로 조립이 던지지 않게만 채운다 — 판정은 INIT_ERRORS 가 한다
}

// 산출물 경로 = _bmad/bmm/config.yaml 의 두 키(단순 `키: "값"` — YAML 파서 불필요),
// 없으면 _bmad/config.toml [modules.bmm] 의 같은 두 키. 둘 다 실패면 exit 2 —
// 기본 이름 폴백·글롭 탐색·mtime 최신 선택은 하지 않는다.
function artifactDirs(root) {
  const checked = []
  const subst = (v) => resolve(root, v.replace('{project-root}', root))

  const ymlTxt = read(join(root, '_bmad', 'bmm', 'config.yaml'))
  if (ymlTxt) {
    const p = /^planning_artifacts:\s*"?([^"\r\n]+?)"?\s*$/m.exec(ymlTxt)
    const i = /^implementation_artifacts:\s*"?([^"\r\n]+?)"?\s*$/m.exec(ymlTxt)
    if (p && i) return { plan: subst(p[1]), impl: subst(i[1]), checked }
    checked.push('_bmad/bmm/config.yaml   planning_artifacts·implementation_artifacts 키 없음')
  } else checked.push('_bmad/bmm/config.yaml   없음')

  const tomlTxt = read(join(root, '_bmad', 'config.toml'))
  const sec = tomlTxt.split(/^\[modules\.bmm\]\s*$/m)[1]
  if (sec != null) {
    const body = sec.split(/^\[/m)[0]
    const p = /^planning_artifacts\s*=\s*"([^"]+)"/m.exec(body)
    const i = /^implementation_artifacts\s*=\s*"([^"]+)"/m.exec(body)
    if (p && i) return { plan: subst(p[1]), impl: subst(i[1]), checked }
    checked.push('_bmad/config.toml [modules.bmm]   두 키 없음')
  } else checked.push('_bmad/config.toml [modules.bmm]   없음')
  return { plan: null, impl: null, checked }
}

const found = artifactDirs(rootDir)
if (!found.plan) {
  fail(['(상위 탐색) ' + climbed.join(' → ') + '   루트: ' + rootDir].concat(found.checked))
  found.plan = rootDir
  found.impl = rootDir
}

// 끝 구분자 포함 — startsWith 경로 비교가 형제 폴더(예: …-secret)로 새지 않게 한다(serve.mjs 참조)
export const ROOT = rootDir + sep
// 출력 폴더는 상수 — 여기 한 곳에서 정의하고 build.mjs(OUT_DIR)·serve.mjs(PAGE)가 공유한다
export const OUT_DIR = join(rootDir, '_bmad-output', 'dev-status')

// 무인 배치 엔진(auto-story-finish)은 BMad config 를 읽지 않고 아래 리터럴 경로를 하드코딩한다.
// 그래서 state.json·run-summary.log·스토리 파일은 리터럴 1순위 → config 값 2순위로 찾고,
// 두 경로가 다르면 화면 상단에 배너를 띄운다(단계 배지·배치 중 쓰기 차단이 성립하지 않는다).
const ENGINE_IMPL = join(rootDir, '_bmad-output', 'implementation-artifacts')
const ENGINE_MISMATCH = resolve(ENGINE_IMPL) !== resolve(found.impl)
const engineDir = existsSync(ENGINE_IMPL) ? ENGINE_IMPL : found.impl
// 두 경로가 다른데 리터럴 쪽을 채택했다면 그 로그는 옛 레이아웃의 잔해이거나 다른 프로젝트 것일 수 있다.
// 배지가 조금 틀리는 것과 실행 버튼이 사라지는 것은 피해가 다르므로, 이 경우 게이팅 근거로는 쓰지 않는다.
const RUNLOG_FOREIGN = ENGINE_MISMATCH && engineDir === ENGINE_IMPL

const sprintPath = join(found.impl, 'sprint-status.yaml')

// story_location 은 YAML 키가 아니라 주석줄이다(# story_location: …) — 주석·비주석 모두 읽되,
// 그 폴더가 실제로 존재하고 *.md 가 1개 이상일 때만 쓰고 아니면 config 값으로 폴백한다.
let storiesDir = found.impl
{
  const m = /^#?\s*story_location:\s*(\S+)/m.exec(read(sprintPath))
  if (m) {
    const cand = resolve(rootDir, m[1].replace('{project-root}', rootDir))
    try {
      if (readdirSync(cand).some((n) => n.endsWith('.md'))) storiesDir = cand
    } catch { /* 없는 폴더면 config 값 유지 */ }
  }
}
const STORY_DIRS = [...new Set([ENGINE_IMPL, storiesDir, found.impl].map((p) => resolve(p)))].filter((p) => existsSync(p))

const LOG_DIR = join(engineDir, 'auto-pipeline-logs')
// 프로젝트가 두는 현황판 전용 설정(이 스킬 폴더에는 두지 않는다 — 계층화 정책).
const SOURCES_PATH = join(rootDir, 'tools', 'dev-status', 'sources.json')

/**
 * `tools/dev-status/sources.json` — **프로젝트가 소유하는** 현황판 설정. 없거나 깨지면 빈 객체다
 * (추측하지 않는다). 키는 전부 **선택**이고, 값이 없으면 그 기능은 꺼지거나(접기·덮어 읽기)
 * 「판정 불가」로 적힌다 — 설정이 없다고 「이상 없음」이 되는 경로는 없다. 키 목록·기본값 =
 * SKILL.md 「새 프로젝트에 붙이는 법」.
 *   · opsLineEpics · devLineBranches · integrationGateSince · qualityGatesSince — 접기 기준선
 *   · releaseLinesFile   운영선 에픽을 적은 문서(기본 <implementation_artifacts>/RELEASE-LINES.md)
 *   · runnerClone        러너가 도는 별도 클론 폴더(개발선 덮어 읽기 · 배치 재료 합치기)
 *   · mainBranch         정본 갈래 이름(기본 main)
 *   · migrationsDir · migrationProbeFile · migrationBaselineSince · devProjectRef · prodProjectRef · projectLabels
 *                        DB 마이그레이션 실측 카드·F6
 */
function readSources() {
  try {
    const v = JSON.parse(read(SOURCES_PATH) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}
const CFG = readSources()
const cfgStr = (k) => (typeof CFG[k] === 'string' ? CFG[k].trim() : '')
/** 설정의 경로 값 — 상대 경로는 프로젝트 루트 기준. */
const cfgPath = (k, def) => {
  const v = cfgStr(k)
  if (!v) return def
  return isAbsolute(v) ? v : resolve(rootDir, v)
}
// 정본 갈래 이름 — 신선도 F1(원격과 견주기)·미머지 갈래 판정이 쓴다.
const MAIN = cfgStr('mainBranch') || 'main'

const P = {
  epics: join(found.plan, 'epics.md'),
  sprint: sprintPath,
  state: join(LOG_DIR, 'state.json'),
  runLog: join(LOG_DIR, 'run-summary.log'),
  inbox: join(found.impl, 'DECISIONS-INBOX.md'),
  // 있으면 읽고 없으면 그만 — 「마지막 릴리스 이후만 센다」의 기준선이다(없으면 아무것도 접지 않는다).
  releaseLog: join(found.impl, 'RELEASE-LOG.md'),
  // 있으면 읽고 없으면 그만 — 「운영선 … Epic 1·2·3」 줄이 운영선 에픽 목록의 1순위 근거다.
  releaseLines: cfgPath('releaseLinesFile', join(found.impl, 'RELEASE-LINES.md')),
  sources: SOURCES_PATH,
  // DB 마이그레이션 — 폴더가 없으면 카드·F6 이 「해당 없음」이 된다.
  migDir: cfgPath('migrationsDir', join(rootDir, 'supabase', 'migrations')),
  // 실측 산출물 — probe-migrations.mjs(사람 실행)만 쓰고 화면은 읽기만 한다.
  probe: cfgPath('migrationProbeFile', join(rootDir, 'tools', 'dev-status', 'migration-probe.json')),
}
// 새 배치 하네스 산출물의 상태 폴더 — 러너·편성기와 같은 순서(환경변수 → auto.config.json → 기본값).
const STATE = resolveStateDir(rootDir)

// BMad 없는 프로젝트의 저하는 2단뿐 — 두 원천이 다 있으면 정상 화면, 아니면 구조화 오류
// (CLI 는 exit 2 · 라이브러리는 scan().error). 대체 원천(git 커밋·TODO 주석)은 만들지 않는다.
if (!existsSync(P.epics) || !existsSync(P.sprint)) {
  fail([
    '(상위 탐색) ' + climbed.join(' → ') + '   루트: ' + rootDir,
    P.epics + '   ' + (existsSync(P.epics) ? '있음' : '없음'),
    P.sprint + '   ' + (existsSync(P.sprint) ? '있음' : '없음'),
  ])
}

// 출력 HTML 안의 경로 조립은 이 두 함수로 통일한다(§ 링크 실존 확인은 build.mjs)
const relFromOut = (abs) => relative(OUT_DIR, abs).split(sep).join('/')
const relFromRoot = (abs) => relative(rootDir, abs).split(sep).join('/')

// 스토리 .md 탐색 — 엔진 리터럴 경로 1순위 → story_location/config 2순위
function localStoryPath(slug) {
  if (!slug) return ''
  for (const d of STORY_DIRS) {
    const p = join(d, slug + '.md')
    if (existsSync(p)) return p
  }
  return ''
}
// 이번 화면이 러너 클론(개발선)에서 읽은 스토리 문서(slug → 절대 경로). scanInner 가 채운다.
let DEVLINE_STORIES = new Map()
// 개발선 사본의 화면 폴더 안 자리(build.mjs 가 복사한다 — 클론에는 쓰지 않는다)
const DEVLINE_STORY_REL = (slug) => 'devline/stories/' + slug + '.md'
/** 내용을 읽을 문서 — 개발선 사본이 있으면 그것(더 최신), 없으면 이 폴더의 것. */
function storyPathOf(slug) {
  if (!slug) return ''
  return DEVLINE_STORIES.get(slug) ?? localStoryPath(slug)
}
/** 화면 폴더(OUT_DIR) 기준 링크 · 없으면 빈 문자열. */
function storyLinkOf(slug) {
  if (DEVLINE_STORIES.has(slug)) return DEVLINE_STORY_REL(slug)
  const p = localStoryPath(slug)
  return p ? relFromOut(p) : ''
}
/** 프로젝트 루트 기준 경로(지시문에 적는 것) · 없으면 빈 문자열. */
function storyRootRelOf(slug) {
  if (DEVLINE_STORIES.has(slug)) return relFromRoot(join(OUT_DIR, DEVLINE_STORY_REL(slug)))
  const p = localStoryPath(slug)
  return p ? relFromRoot(p) : ''
}

const norm = (s) => s.replace(/[\s·\-—()[\]{}/,.:]/g, '').toLowerCase()

// ── epics.md: 에픽 본문 절과 스토리 ─────────────────────────────
// 같은 에픽 번호가 두 절(요약 목록 + 본문)로 나뉘어 각각 다른 스토리를 들고 있을 수 있다.
// 그래서 **단계가 아니라 머리말 종류**로 가르고, 같은 번호의 절은 스토리를 합친다.
// epics.md 자체는 절대 고치지 않는다 — 이 스킬은 읽기 전용이다.
function parseEpics() {
  const lines = read(P.epics, { required: true }).split(/\r?\n/)
  const sections = []                       // 문서에 나온 순서대로의 에픽 절(번호 중복 가능)
  let epic = null
  let story = null
  let buf = []
  const flush = () => {
    if (story) {
      story.body = buf.join('\n')
      buf = []
    }
  }

  for (const line of lines) {
    const em = PATTERNS.epic.exec(line)
    if (em) {
      flush()
      story = null
      epic = { num: Number(em[1]), title: em[2], desc: '', stories: [] }
      sections.push(epic)
      continue
    }
    // 에픽이 아닌 `## ` 머리말만 절을 닫는다(`### `·`#### `는 본문으로 본다).
    if (/^## /.test(line)) {
      flush()
      story = null
      epic = null
      continue
    }
    if (!epic) continue

    const sm = PATTERNS.story.exec(line)
    if (sm) {
      flush()
      story = { id: sm[1] + '.' + sm[2], epic: Number(sm[1]), num: Number(sm[2]), title: sm[3], body: '',
        deep: line.startsWith('#### ') }
      epic.stories.push(story)
      continue
    }
    if (story) buf.push(line)
    else if (!epic.desc && line.trim()) epic.desc = line.trim()
  }
  flush()

  // 같은 에픽 번호의 절을 하나로 합친다. 제목·설명은 **스토리가 더 많은 절**(동점이면 뒤의 것)이
  // 맡고, 스토리는 번호 기준 합집합이다(먼저 나온 절의 본문이 이긴다).
  // 자리(진행 순서)는 그 번호가 **처음 나온** 자리다 — 요약 절의 차례가 곧 사람이 정한 진행 순서다.
  const byNum = new Map()
  for (const sec of sections) {
    if (!byNum.has(sec.num)) byNum.set(sec.num, [])
    byNum.get(sec.num).push(sec)
  }
  const duplicateEpics = [...byNum.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([num, list]) => ({ num, sections: list.length }))
  const seenNum = new Set()
  const epics = []
  for (const sec of sections) {
    if (seenNum.has(sec.num)) continue
    seenNum.add(sec.num)
    const list = byNum.get(sec.num)
    if (list.length === 1) { epics.push(sec); continue }
    const head = list.reduce((a, b) => (b.stories.length >= a.stories.length ? b : a))
    const stories = []
    const ids = new Set()
    for (const part of list) {
      for (const st of part.stories) {
        if (ids.has(st.id)) continue
        ids.add(st.id)
        stories.push(st)
      }
    }
    stories.sort((a, b) => a.num - b.num)   // 두 절에서 합쳤으니 번호 순으로 다시 세운다
    epics.push({ num: sec.num, title: head.title, desc: head.desc || sec.desc, stories, merged: list.length })
  }
  epics.forEach((e) => { e.deepStories = e.stories.filter((s) => s.deep).length })

  // 진행 순서 = epics.md 에 적힌 차례. 나중에 끼어든 에픽이 있으면 번호와 다를 수 있다.
  epics.forEach((e, i) => { e.order = i + 1 })
  // 강조할 것은 "순서≠번호"가 아니라 번호 흐름이 튀는 자리 하나다 —
  // 뒤 에픽보다 번호가 큰 지점 = 끼어든 에픽 하나만 표시한다.
  epics.forEach((e, i) => { e.jump = !!(epics[i + 1] && e.num > epics[i + 1].num) })

  for (const e of epics) {
    for (const s of e.stories) {
      const goal = PATTERNS.goal.exec(s.body)
      s.goal = goal ? goal[1].replace(/[.,]$/, '') : ''
      s.acCount = (s.body.match(PATTERNS.ac) || []).length
    }
  }
  return { epics, duplicateEpics }
}

// ── sprint-status.yaml: development_status 블록 ─────────────────
function parseSprint() {
  return parseSprintText(read(P.sprint, { required: true }))
}
/** sprint-status.yaml 본문을 해석한다 — 러너 클론(개발선) 사본에도 같은 해석기를 쓴다. */
export function parseSprintText(txt) {
  txt = String(txt ?? '')
  const block = txt.split(/^development_status:\s*$/m)[1] || ''
  const epicStatus = {}
  const storyStatus = {}
  const extra = []

  for (const raw of block.split(/\r?\n/)) {
    // 값 뒤에 꼬리 주석(`epic-1: done  # …`)이 붙은 줄도 읽는다 —
    // 안 읽으면 그 항목이 "상태 파일에 없음" 오경보로 잡힌다
    const m = /^ {2}([^\s#][^:]*):\s*(\S+)\s*(?:#.*)?$/.exec(raw)
    if (!m) continue
    const key = m[1]
    const value = m[2]
    if (/-retrospective$/.test(key)) continue

    const ek = /^epic-(\d+)$/.exec(key)
    if (ek) {
      epicStatus[ek[1]] = value
      continue
    }
    const sk = /^(\d+)-(\d+)-(.+)$/.exec(key)
    if (sk) {
      storyStatus[sk[1] + '.' + sk[2]] = { status: value, slug: key, slugTitle: sk[3] }
      continue
    }
    extra.push(key)
  }

  // 「상태 파일 날짜」의 근거는 이 파일이 스스로 적은 값이라 낡을 수 있다 — 같은 키
  // (`# last_updated:`)가 머리에 여러 줄 쌓이고 맨 위가 최신도 아니다(원 프로젝트 2026-09-21 실측).
  // 주석·평문 어느 쪽이든 **날짜가 가장 최근인 것**을 고르고, 화면의 진짜 근거는
  // 파일 시각·커밋 시각이 맡는다(freshness F2).
  const stamps = (txt.match(/^#?\s*last_updated:\s*(\d{4}-\d{2}-\d{2})/gm) || [])
    .map((l) => /(\d{4}-\d{2}-\d{2})/.exec(l)[1])
    .sort()
  // 날짜가 아닌 서식(버전 문자열 등)도 종전대로 받는다 — 날짜가 하나도 없을 때만 첫 줄을 쓴다.
  const any = /^#?\s*last_updated:\s*(\S+)/m.exec(txt)
  return {
    epicStatus, storyStatus, extra,
    updated: stamps.length ? stamps[stamps.length - 1] : (any ? any[1] : ''),
    updatedLines: stamps.length,
  }
}

// ── 개발선(러너 클론) 덮어 읽기 ──────────────────────────────────
// 러너가 별도 클론에서 도는 프로젝트에서는 그 클론의 스토리 상태·문서가 머지 전까지 이 폴더에 없다.
// 그래서 이 폴더만 읽는 화면은 「그 에픽 전부 backlog」처럼 며칠씩 낡는다.
// 규칙: 클론 항목이 이 폴더보다 **앞선 상태**(backlog<ready-for-dev<in-progress<review<done)일 때만 덮는다 —
// 뒤로 가는 값은 덮지 않는다(이 폴더에서 정정한 것을 클론의 낡은 값으로 되돌리지 않는다).
// 읽기만 하며 클론에는 아무것도 쓰지 않는다(git 명령 포함).
export const STATUS_RANK = Object.freeze({ backlog: 0, 'ready-for-dev': 1, 'in-progress': 2, review: 3, done: 4 })
const rankOf = (v) => (Object.prototype.hasOwnProperty.call(STATUS_RANK, v) ? STATUS_RANK[v] : -1)

/**
 * 상태 파일 두 벌(이 폴더 · 러너 클론)을 합친다.
 * @returns {{storyStatus:object, epicStatus:object, overridden:string[]}}
 */
export function mergeDevLineSprint(main, chain) {
  const storyStatus = { ...(main?.storyStatus ?? {}) }
  const epicStatus = { ...(main?.epicStatus ?? {}) }
  const overridden = []
  for (const [id, rec] of Object.entries(chain?.storyStatus ?? {})) {
    const cur = storyStatus[id]
    // 이 폴더(에픽 문서·상태 파일)에 없는 키는 더하지 않는다 — 목록의 기준은 이 폴더이고,
    // 낯선 키는 「에픽 문서에 없음」 오탐이 된다.
    if (!cur) continue
    if (rankOf(rec?.status) > rankOf(cur.status)) { storyStatus[id] = rec; overridden.push(id) }
  }
  for (const [num, st] of Object.entries(chain?.epicStatus ?? {})) {
    if (num in epicStatus && rankOf(st) > rankOf(epicStatus[num])) epicStatus[num] = st
  }
  return { storyStatus, epicStatus, overridden }
}

/**
 * 목업 목록 두 벌을 합친다(플러그인용 순수 함수 — 이 스킬 자체는 목업을 스캔하지 않는다).
 * 항목 모양 = `{ rel, abs, href, verdict, explicit, note, story }`.
 * 클론에만 있는 파일은 더하고(`copies` = 화면 폴더 `devline/` 로 복사할 대상), 양쪽에 있는 파일은
 * 클론 쪽 판정이 **명시**돼 있을 때만 그 판정을 쓴다.
 * @returns {{mockups:object[], added:string[], updated:string[], copies:{from:string,to:string}[]}}
 */
export function mergeDevLineMockups(main, chain) {
  const byRel = new Map((main ?? []).map((m) => [m.rel, { ...m }]))
  const added = []
  const updated = []
  const copies = []
  for (const c of chain ?? []) {
    const cur = byRel.get(c.rel)
    if (!cur) {
      byRel.set(c.rel, { ...c, fromDevLine: true })
      added.push(c.rel)
      copies.push({ from: c.abs, to: 'devline/' + c.rel })
      continue
    }
    if (c.explicit && (c.verdict !== cur.verdict || c.note !== cur.note || c.story !== cur.story)) {
      byRel.set(c.rel, { ...cur, verdict: c.verdict, note: c.note, story: c.story, explicit: true })
      updated.push(c.rel)
    }
  }
  return { mockups: [...byRel.values()], added, updated, copies }
}

// ── 러너 클론(별도 폴더) 찾기 ──────────────────────────────────
// 경로는 **적혀 있을 때만** 읽는다 — 추측해서 남의 폴더를 뒤지지 않는다.
// 찾는 차례 = 상태 폴더의 chain-info.json → tools/auto/auto.config.json → tools/dev-status/sources.json.
// 앞의 둘은 배치 엔진이 소유하는 파일이라 현황판 쪽 설정은 마지막 자리다.
const CLONE_KEYS = ['runnerClone', 'runnerRoot', 'runnerRepo', 'chainRepo', 'clonePath']
function pickClonePath(obj) {
  if (!obj || typeof obj !== 'object') return ''
  for (const k of CLONE_KEYS) if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim()
  return ''
}
/**
 * @returns {{dir:string|null, why:string, tried:string[], configured:boolean}}
 *   configured = 어느 한 곳에라도 경로 키가 적혀 있었나(적혀 있는데 폴더가 없으면 dir=null · configured=true).
 */
export function resolveRunnerClone(stateDir, root) {
  const tried = []
  let configured = false
  const cands = [
    [join(stateDir, 'chain-info.json'), '상태 폴더의 chain-info.json'],
    [join(root, 'tools', 'auto', 'auto.config.json'), 'tools/auto/auto.config.json'],
    [join(root, 'tools', 'dev-status', 'sources.json'), 'tools/dev-status/sources.json'],
  ]
  for (const [file, why] of cands) {
    const txt = read(file)
    if (!txt) { tried.push(why + ' 없음'); continue }
    let p
    try { p = pickClonePath(JSON.parse(txt)) } catch { tried.push(why + ' JSON 손상'); continue }
    if (!p) { tried.push(why + ' 에 runnerClone 키 없음'); continue }
    configured = true
    const abs = isAbsolute(p) ? p : resolve(root, p)
    if (!existsSync(abs)) { tried.push(why + ' 의 경로가 실존하지 않음(' + abs + ')'); continue }
    // 같은 폴더를 가리키면 덮어 읽을 것이 없다 — 러너가 이 폴더에서 도는 것이다.
    if (resolve(abs) === resolve(root)) { tried.push(why + ' 의 경로가 이 폴더 자신'); configured = false; continue }
    return { dir: abs, why, tried, configured: true }
  }
  return { dir: null, why: tried.join(' · '), tried, configured }
}

/** 러너 클론의 auto-pipeline-logs — 매니페스트·검증·계측만 읽는다(읽기 전용). */
function readCloneLogs(cloneRoot) {
  const dir = join(cloneRoot, relative(rootDir, LOG_DIR))
  if (!existsSync(dir)) return { dir: null, manifests: [], verifications: [], metrics: [] }
  const manifests = []
  const verifications = []
  const metrics = []
  for (const name of readdirSafe(dir)) {
    const full = join(dir, name)
    if (/^batch-.+-manifest\.json$/.test(name)) {
      const r = parseBatchManifest(full)
      // 출처 표식 — 두 갈래 운영(opsLineEpics 설정)에서 러너 클론 재료는 개발선으로 센다(verdict.releaseLineOf).
      if (!r.error) manifests.push({ ...r.value, fromRunnerClone: true })
    } else if (/-verification\.json$/.test(name)) {
      const r = parseVerification(full)
      if (!r.error) verifications.push(r.value)
    } else if (/^metrics-.+\.json$/.test(name)) {
      const r = parseMetrics(full)
      if (!r.error) metrics.push({ ...r.value, fromRunnerClone: true })
    }
  }
  return { dir, manifests, verifications, metrics }
}

/** 두 자리에서 온 기록을 키 하나당 **가장 최근 것 하나**로 합친다(내림차순). */
function mergeByKey(lists, keyOf, atOf) {
  const best = new Map()
  for (const item of lists.flat()) {
    const k = keyOf(item)
    if (k == null) continue
    const cur = best.get(k)
    if (!cur || String(atOf(item) ?? '') > String(atOf(cur) ?? '')) best.set(k, item)
  }
  return [...best.values()].sort((a, b) => String(atOf(b) ?? '').localeCompare(String(atOf(a) ?? '')))
}

// ── DB 마이그레이션 실측 산출물 읽기 ────────────────────────────
// 실측은 probe-migrations.mjs(사람 실행)가 하고, 화면은 그 산출물 + 측정 시각만 읽는다 —
// 새로고침 경로에 네트워크·인증을 넣지 않는다. 측정 안 함은 0 이 아니라 결측으로 표현한다.
// 무엇을 쟀는지는 sources.json 의 devProjectRef 와 견준다 — 설정이 없으면 「확인 못 함」이다.
const HERE = dirname(fileURLToPath(import.meta.url))
function parseMigrationProbe() {
  const applicable = existsSync(P.migDir) || existsSync(P.probe)
  const j = (() => { try { return JSON.parse(read(P.probe) || '{}') || {} } catch { return {} } })()
  const files = existsSync(P.migDir)
    ? readdirSafe(P.migDir).filter((n) => n.endsWith('.sql')).sort() : []
  const hash = createHash('md5').update(files.join('\n')).digest('hex').slice(0, 12)
  const devRef = cfgStr('devProjectRef')
  const prodRef = cfgStr('prodProjectRef')
  const labels = CFG.projectLabels && typeof CFG.projectLabels === 'object' ? CFG.projectLabels : {}
  let s = j.lastSuccess || null
  const a = j.lastAttempt || null
  // 산출물이 반쯤 깨진 것(측정 시각·개수 결측)을 「신선한 측정」으로 믿지 않는다 —
  // Date.parse(undefined)=NaN 은 어떤 비교에도 false 라 낡음 판정이 무력화되고 화면에 NaN 이 샌다.
  const int = (v) => Number.isInteger(v)
  const wrongProject = !!(s && devRef && s.projectRef !== devRef)
  const projectUnverified = !!(s && !devRef)
  const malformed = !!(s && !wrongProject &&
    (!Number.isFinite(Date.parse(s.measuredAt)) || !(int(s.total) && int(s.applied) && int(s.localOnly) && int(s.remoteOnly))))
  if (malformed) s = null
  // 신선도 1차 = 사건(파일 목록 변화) · 2차 = 시계(7일). 색이 아니라 상태 문자열로 낸다.
  let fresh = 'none'
  if (s) {
    const days = (Date.now() - Date.parse(s.measuredAt)) / 86400000
    fresh = (s.localFilesHash !== hash) ? 'changed' : days > 7 ? 'stale' : 'fresh'
  }
  const refOf = (j.lastSuccess || {}).projectRef || ''
  const labelOf = (ref) => labels[ref] || (devRef && ref === devRef ? '개발' : prodRef && ref === prodRef ? '운영' : '알 수 없는 프로젝트')
  return {
    applicable,
    dir: relFromRoot(P.migDir),
    probeFile: relFromRoot(P.probe),
    probeCommand: 'node "' + join(HERE, 'probe-migrations.mjs') + '" --root "' + rootDir + '"',
    success: s, attempt: a, localFilesCount: files.length, localLatest: files[files.length - 1] || '',
    fresh, malformed, wrongProject, projectUnverified,
    projectRef: refOf,
    projectLabel: s ? labelOf(s.projectRef) : '',
    prodProjectRef: prodRef,
    prodLabel: prodRef ? (labels[prodRef] || '운영') : '',
  }
}

/** 마이그레이션 파일명·버전 문자열에서 버전(앞머리 숫자 8~14자리)만 뽑는다. */
const migVersion = (name) => (/^(\d{8,14})/.exec(String(name || '')) || ['', ''])[1]

/** 폴더 하나의 마이그레이션 버전 집합(없는 폴더는 빈 집합). */
function migVersionsIn(dir) {
  const out = new Set()
  if (!dir || !existsSync(dir)) return out
  for (const n of readdirSafe(dir)) {
    if (!n.endsWith('.sql')) continue
    const v = migVersion(n)
    if (v) out.add(v)
  }
  return out
}

/**
 * 「마이그레이션 파일 없이 적용된 DDL」(원격에만 있는 버전)의 성격 분류.
 *
 * 개수만 세면 전부 「DDL 은 파일로만」 규칙 위반으로 보이지만 실제는 세 갈래다:
 *   ① 개발선 파일 있음 — 러너 클론의 마이그레이션 폴더에 파일이 있다(아직 이 폴더로 안 들어온 체인분).
 *   ② 번호표만 다른 과거 적용분 — 기준일(migrationBaselineSince) 이전 버전. 같은 DDL 이 다른 번호로 적용됐다.
 *   ③ 현재 위반 — 로컬·러너 **어디에도 파일이 없고** 기준일 이후에 적용된 것. 이것만 센다.
 * 버전 목록이 측정에 없으면 `known=false` — 접지 않고 「가르지 못했습니다」로 적는다.
 * 기준일을 모르면 ②로 접지 않는다(전건을 ③으로 센다 — 보수적).
 *
 * @returns {{known:boolean, devLine:string[], oldNumbering:string[], violations:string[]}}
 */
export function classifyRemoteOnly({ versions = null, localDir = '', runnerDir = '', baselineSince = '' } = {}) {
  if (!Array.isArray(versions)) return { known: false, devLine: [], oldNumbering: [], violations: [] }
  const local = migVersionsIn(localDir)
  const runner = migVersionsIn(runnerDir)
  const digits = String(baselineSince || '').replace(/\D/g, '')
  const cut = digits.length >= 8 ? digits.padEnd(14, '0') : ''
  const devLine = []
  const oldNumbering = []
  const violations = []
  for (const raw of versions) {
    const v = migVersion(raw)
    if (!v) continue
    if (local.has(v) || runner.has(v)) devLine.push(v)
    else if (!cut || v.padEnd(14, '0') >= cut) violations.push(v)
    else oldNumbering.push(v)
  }
  return { known: true, devLine, oldNumbering, violations }
}

// ── 무인 러너 실황 — 상태 폴더의 slots.log 실측 ─────────────────
// 러너가 별도 클론에서 돌아도 로그·잠금은 상태 폴더 하나를 쓴다 — 저장소가 아니라 그 로그를 읽어야
// 「지금」이 보인다. 판정 재료: runner.lock(실행 중 주장) + 마지막 배치 헤더(==== … ====)가 완료 표식
// 없이 열려 있는가 + 로그 mtime(심박 — 45분 넘게 조용하면 잠금이 있어도 「심박 없음」).
// 45분 = 배치 엔진 기본 30분 슬롯의 1.5배(batch-sources.slotHeartbeat 와 같은 값).
export function parseRunner(stateDir = STATE.dir) {
  const lockPath = join(stateDir, 'runner.lock')
  const logPath = join(stateDir, 'slots.log')
  if (!existsSync(logPath)) return { available: false }
  const mt = mtimeSafe(logPath)
  if (mt == null) return { available: false } // 로그를 못 읽으면 「러너 로그 없음」 — 추측하지 않는다
  const ageMin = Math.round((Date.now() - mt) / 60000)
  const lines = read(logPath).split(/\r?\n/).filter(Boolean).slice(-400)
  let today = null
  let queueSize = null
  let batch = null
  let stories = new Map()
  let lastDone = ''
  for (const l of lines) {
    let m
    if ((m = /오늘 누계 (\d+)/.exec(l))) today = Number(m[1])
    if ((m = /실행 대상 배치: (\d+)건/.exec(l))) queueSize = Number(m[1])
    if ((m = /^==== (.+?)(?: \(병렬 (\d+)폭 시도\))? ====$/.exec(l))) {
      if (m[1].startsWith('야간 배치 종료')) { if (batch) batch.open = false; continue }
      batch = { label: m[1], parallel: m[2] ? Number(m[2]) : 1, open: true }
      stories = new Map() // 새 배치 헤더 = 이전 배치 표시 재료 폐기
    }
    if (batch && (m = /^→ \[(.+?)\] (\S+) \(model=([^,)]+)/.exec(l))) {
      stories.set(m[1], { stage: m[2], model: m[3] }) // 병렬이면 같은 배치에 스토리 줄이 여럿 쌓인다
    }
    if (batch && /배치 완료|배치 실패|배치 종료|BATCH DONE|BATCH STOP/.test(l)) batch.open = false
    if ((m = /^- 완주: (.+)$/.exec(l))) lastDone = m[1]
  }
  const lock = existsSync(lockPath)
  return {
    available: true,
    lock,
    running: lock && !!batch?.open && ageMin < 45,
    stale: lock && ageMin >= 45,
    ageMin,
    batch: batch ? { label: batch.label, parallel: batch.parallel, open: batch.open } : null,
    stories: [...stories.entries()].map(([key, v]) => ({ key, stage: v.stage, model: v.model })),
    queueSize,
    today,
    lastDone,
  }
}

// ── auto-pipeline-logs/state.json: 단계별 통과 시각 ──────────────
function parsePipeline() {
  const out = {}
  try {
    const done = (JSON.parse(read(P.state) || '{}') || {}).done || {}
    for (const [key, ts] of Object.entries(done)) {
      const [slug, stage] = key.split('::')
      if (!out[slug]) out[slug] = {}
      out[slug][stage] = ts
    }
  } catch {
    // state.json 손상 시 배지 없이 진행
  }
  return out
}

// ── 무인 배치가 지금 도는가 ─────────────────────────────────────
// sprint-planning·correct-course 는 sprint-status.yaml 을 쓴다 —
// 배치가 도는 중에 같이 쓰면 나중 것이 앞을 덮는다.
function parseBatch() {
  const lines = read(P.runLog).split(/\r?\n/).filter(Boolean)
  let start = -1
  let end = -1
  lines.forEach((l, i) => {
    if (/BATCH START/.test(l)) start = i
    // 종료 태그 — 정상 종료 문구 외에 실패 중단(✖ … STOP —)도 잡는다(BATCH 접두 태그는 로그에 안 남는 경로가 있다)
    if (/(BATCH (DONE|STOP)|배치 완료|✖ .* STOP —)/.test(l)) end = i
  })
  const lastTs = /^\[([^\]]+)\]/.exec(lines[lines.length - 1] || '')
  let running = start >= 0 && start > end
  // 구조적 판정 1순위 — state.json 이 30분 이상 무변화면 배치가 죽은 것으로 본다
  // (로그 태그만 믿으면 실패 종료 시 running 이 영구히 남아 스킬 버튼이 계속 잠긴다)
  if (running) {
    try {
      if (Date.now() - statSync(P.state).mtimeMs > 30 * 60 * 1000) running = false
    } catch {
      running = false // state.json 이 없으면 가동 근거가 없다
    }
  }
  return { running, line: start >= 0 ? (lines[start] || '').slice(0, 200) : '', lastAt: lastTs ? lastTs[1] : '' }
}

// ── 엔진이 이 스토리에 리뷰를 몇 번 "끝냈는가" ──────────────────
// 원천은 위 parseBatch 와 같은 run-summary.log 하나다(새 원천 파일을 늘리지 않는다).
// 스테이지 시작 줄 `[ISO] → [슬러그] review (…)` **다음에 `[ISO]    exit=0` 이 따라온 것만** 센다.
// 시작 줄만 세면 안 된다 — 엔진은 --dry-run 예행연습에서도 시작 줄을 먼저 찍고 즉시 반환하고
// (auto-story-pipeline.mjs 의 runClaude: note() → if (dryRun) return), 인증 만료로 죽은 실행도
// 시작 줄을 남긴다. 그러면 리뷰를 한 번도 받지 않은 스토리의 버튼을 지우면서 화면에는
// "리뷰를 N회 돌렸다"는 거짓 문장이 뜬다. 줄 서식은 엔진이 찍는 것이라 프로젝트 문서 서식과 무관하다.
// 로그가 없거나 매치가 0이면 빈 표 → 아래 게이팅이 아무 것도 하지 않는다(종전 동작).
function reviewRuns() {
  const out = {}
  let pending = ''
  for (const l of read(P.runLog).split(/\r?\n/)) {
    const m = /^\[[^\]]+\]\s*→\s*\[([^\]]+)\]\s+(\S+)/.exec(l)
    // 스테이지 이름이 정확히 review 일 때만 — `review-fix` 같은 파생 이름은 세지 않는다
    if (m) { pending = m[2] === 'review' ? m[1] : ''; continue }
    const e = pending && /^\[[^\]]+\]\s+exit=(\S+)/.exec(l)
    if (e) {
      if (e[1] === '0') out[pending] = (out[pending] || 0) + 1
      pending = ''
    }
  }
  return out
}
const RUNS = reviewRuns()

// BMad v6 정본 code-review 는 라운드가 끝나면 상태를 done 또는 in-progress 로 옮긴다.
// 리뷰를 여러 번 끝냈는데 상태가 아직 review 면 자동 리뷰 루프가 수렴하지 않는다는 신호이고,
// 여기서 또 자동 리뷰를 추천하면 무한 반복이 된다. 설정 파일·환경변수로 빼지 않는다(과설계 금지).
// 임계값 6의 근거 — 실측(2026-08-21, 내부 프로젝트 run-summary.log · 슬러그 38종): 정상 완료(done)한
// 스토리 27건의 완료 리뷰 횟수 분포가 6,5,5,4,4,4,4,3×15,2×4,1 로 **최빈값·중앙값이 3**이었다.
// 즉 3은 "건강한 완료"의 한복판이라 임계값으로 쓸 수 없다(3이면 done 22건이 correct-course 등으로
// review 로 되돌아오는 순간 첫 라운드부터 잠긴다). 6이면 같은 표본에서 오탐이 1건으로 줄고,
// 실제 비수렴 전례(2-10 8회 · 2-16 6회 · 3-5 6회)는 그대로 잡힌다.
const REVIEW_GATE_RUNS = 6

// ── 스토리별 File List → 파일 겹침 판정 ────────────────────────
// 무인 배치는 독립 스토리를 워크트리 분리로 "병렬" 실행하는 것이 기본이다(스킬 계약).
// 같은 파일을 건드리는 스토리를 병렬로 돌리면 서로의 변경을 덮으므로,
// 겹치지 않는 것끼리 묶어 "이 묶음은 병렬 안전"을 알려 준다. 묶음끼리는 순차.
function fileListOf(slug) {
  const p = storyPathOf(slug)
  if (!p) return null
  const txt = read(p) // 경합(삭제·잠금)이면 빈 문자열 — 겹침 판정만 비고 화면은 산다
  const m = /^#{2,4} +File List\s*$/m.exec(txt)
  if (!m) return null
  const rest = txt.slice(m.index + m[0].length)
  const end = /^#{2,4} /m.exec(rest)
  const body = end ? rest.slice(0, end.index) : rest
  const out = new Set()
  for (const t of body.match(/`[^`]+`/g) || []) {
    const f = t.slice(1, -1).trim().replace(/^\.\//, '')
    if (!f.includes('/') && !/\.[a-z]{2,5}$/.test(f)) continue
    if (/\s/.test(f)) continue
    // 진행 기록 문서는 스토리마다 붙는다 — 엔진이 스토리 단위로 순차 기록하므로 겹침에서 뺀다
    if (f.startsWith('_bmad-output/') || f.endsWith('sprint-status.yaml') || f.endsWith('deferred-work.md')) continue
    out.add(f)
  }
  return out
}

// 겹치지 않는 것끼리 그리디로 묶는다(그래프 색칠). 파일 목록이 없는 스토리는 단독 묶음.
function splitByOverlap(list) {
  const info = list.map((n) => ({ story: n.story, title: n.title, slug: n.slug, fl: fileListOf(n.slug) }))
  const groups = []
  for (const it of info) {
    if (!it.fl || it.fl.size === 0) {
      groups.push({ items: [it], files: new Set(), unknown: true })
      continue
    }
    let placed = false
    for (const g of groups) {
      if (g.unknown) continue
      if ([...it.fl].some((f) => g.files.has(f))) continue
      g.items.push(it)
      it.fl.forEach((f) => g.files.add(f))
      placed = true
      break
    }
    if (!placed) groups.push({ items: [it], files: new Set(it.fl) })
  }
  const conflicts = []
  for (let i = 0; i < info.length; i += 1) {
    for (let j = i + 1; j < info.length; j += 1) {
      const A = info[i]
      const B = info[j]
      if (!A.fl || !B.fl) continue
      const inter = [...A.fl].filter((f) => B.fl.has(f))
      if (inter.length) conflicts.push({ a: A.story, b: B.story, n: inter.length, sample: inter.slice(0, 2) })
    }
  }
  conflicts.sort((x, y) => y.n - x.n)
  return {
    groups: groups.map((g) => ({
      unknown: !!g.unknown,
      stories: g.items.map((x) => ({ story: x.story, title: x.title, slug: x.slug })),
    })),
    conflicts: conflicts.slice(0, 8),
    unknownCount: info.filter((x) => !x.fl || x.fl.size === 0).length,
  }
}

// ── 화면 분류: ①다음 작업 ②불일치 — 판정은 전부 규칙이다 ────────
// 새로고침마다 LLM 을 부르지 않는다(느리고·한도를 먹고·추천이 매번 달라져 신뢰가
// 무너지고·한도/인증이 막히면 화면이 죽는다). 스킬도 판단이 아니라 항목 종류 → 스킬 고정표다.
const SKILL = {
  review: { skill: 'bmad-code-review', why: '리뷰 라운드를 진행하거나 남은 지적을 회수합니다' },
  // 스킬이 빈 문자열이면 build.mjs 가 [지시문 복사] 버튼 자체를 그리지 않는다 —
  // "버튼이 있으면 나는 누른다"를 코드로 막는 것이 이 항목의 본체다.
  'review-gated': { skill: '', why: '리뷰 라운드가 이미 여러 번 돌았습니다 — 여기서 자동 리뷰를 또 돌리면 끝나지 않는 반복이 됩니다. 무엇을 남기고 무엇을 접을지는 사람이 정합니다.' },
  'in-progress': { skill: 'bmad-dev-story', why: '하던 구현을 이어서 끝냅니다' },
  'ready-for-dev': { skill: 'auto-story-finish', why: '스토리 문서가 준비돼 있어 바로 구현에 들어갑니다' },
  backlog: { skill: 'bmad-create-story', why: '먼저 스토리 문서를 만들어야 구현이 헛돌지 않습니다' },
  drift: { skill: 'bmad-sprint-planning', why: '상태 파일(SoT)을 다시 맞춥니다' },
}
// sprint-status.yaml 을 쓰는 스킬 — 무인 배치 가동 중에는 실행하지 않는다
const WRITES_SPRINT = ['bmad-sprint-planning', 'bmad-correct-course', 'auto-story-finish', 'bmad-create-story']

function buildBoard(epics, sprint) {
  const next = []
  const batch = parseBatch()
  // 로그의 식별자는 상태 파일 키의 앞부분만 적힌 짧은 형태일 수 있다 — 엔진이 `--stories "1-1"` 같은
  // 짧은 식별자를 사후조건 prefix 매칭으로 받아 주고, 받은 문자열을 그대로 로그에 찍기 때문이다.
  // 정확 일치만 보면 그런 프로젝트에서 게이트가 통째로 무동작한다(그 사실도 화면에 안 나온다).
  const runsFor = (slug) => (slug
    ? Object.keys(RUNS).reduce((n, k) => n + (k === slug || slug.startsWith(k + '-') ? RUNS[k] : 0), 0)
    : 0)

  const fileOf = (slug) => storyRootRelOf(slug)

  // ① 다음 작업 — 상태값이 곧 할 일이다
  // 게이팅된 항목은 지금 누를 것이 없으므로 실행 가능한 진행 중 뒤로 내린다 —
  // review 와 같은 0으로 두면 게이팅이 늘어날수록 목록 머리가 통째로 버튼 없는 카드가 된다.
  const rank = { review: 0, 'in-progress': 1, 'review-gated': 1.5, 'ready-for-dev': 2, backlog: 3 }
  for (const e of epics) {
    if (e.status === 'done') continue
    let backlogTaken = false
    for (const st of e.stories) {
      const rec = sprint.storyStatus[st.id]
      const slug = rec ? rec.slug : ''
      if (['review', 'in-progress', 'ready-for-dev'].includes(st.status)) {
        // 리뷰를 이미 여러 번 끝냈는데 상태가 그대로면 자동 추천을 끊는다(비수렴 루프 차단).
        // status 는 'review' 그대로 두고 key 만 가른다 — 상태 SoT 를 화면이 왜곡하지 않는다.
        const n = st.status === 'review' && !RUNLOG_FOREIGN ? runsFor(slug) : 0
        const key = n >= REVIEW_GATE_RUNS ? 'review-gated' : st.status
        const map = SKILL[key]
        next.push({
          key, epic: e.num, story: st.id, title: st.title,
          status: st.status, slug, file: fileOf(slug),
          skill: map.skill, why: map.why,
          // 자동 판정이 사람의 작업을 막는 방향이므로 근거를 화면에 늘 적는다(사람이 뒤집을 수 있게)
          // 누적 기록이라 "이번 라운드에 N회"가 아니다 — 로그가 지지하지 않는 인과 주장을 쓰지 않는다
          gateWhy: key === 'review-gated' ? '무인 배치 기록에 이 스토리의 완료된 리뷰 실행이 누적 ' + n + '회 있습니다(이번 라운드분만은 아닙니다). 상태는 아직 review 입니다' : '',
        })
      } else if (st.status === 'backlog' && e.status === 'in-progress' && !backlogTaken) {
        // 에픽 순서상 "다음 하나"만 — backlog 전량을 늘어놓지 않는다
        backlogTaken = true
        next.push({
          key: 'backlog', epic: e.num, story: st.id, title: st.title,
          status: st.status, slug, file: '',
          skill: SKILL.backlog.skill, why: SKILL.backlog.why,
        })
      }
    }
  }
  next.sort((a, b) => (rank[a.key] - rank[b.key]) || (a.epic - b.epic) || a.story.localeCompare(b.story))

  // 상태별 묶음 실행 후보 + 파일 겹침 분석
  const BULK = {
    'ready-for-dev': { stages: 'create,dev,review', force: false, label: '개발 준비' },
    'in-progress': { stages: 'dev,review', force: true, label: '진행 중' },
    review: { stages: 'review', force: true, label: '리뷰 대기' },
  }
  const bulk = Object.keys(BULK).map((k) => {
    // 사람 판단 대기(review-gated)는 묶음 실행 후보에서 뺀다 — 카드 버튼 하나를 지워도
    // 묶음 버튼이 남으면 같은 스토리가 통째로 다시 자동 리뷰에 들어간다(이쪽 피해가 더 크다).
    const list = next.filter((n) => n.status === k && n.key !== 'review-gated')
    if (list.length < 2) return null
    return Object.assign({ status: k, list }, BULK[k], splitByOverlap(list))
  }).filter(Boolean)

  return { next, batch, bulk, writesSprint: WRITES_SPRINT }
}

// ── 신선도 재료 ────────────────────────────────────────────────
// 「이 화면이 지금을 반영하는가」의 판정은 freshness.mjs 가 하고, 여기서는 **재료만** 모은다.
// git 은 **읽기 명령만** 쓰고 fetch 하지 않는다(새로고침 경로에 네트워크·인증을 넣지 않는다).
// git 이 없거나 저장소가 아니면 전부 null 이고 판정은 「확인 불가(unknown)」다 — 없다고 죽지 않는다.
function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
    } catch { return null }
  }
  const head = run(['rev-parse', 'HEAD'])
  if (!head) return { available: false }
  const origin = run(['rev-parse', 'origin/' + MAIN])
  let behind = null
  let ahead = null
  if (origin) {
    const lr = run(['rev-list', '--left-right', '--count', 'HEAD...origin/' + MAIN])
    const m = lr && /^(\d+)\s+(\d+)$/.exec(lr)
    if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
  }
  const dirtyTxt = run(['status', '--porcelain'])
  return {
    available: true,
    head,
    headShort: head.slice(0, 8),
    headAt: run(['log', '-1', '--format=%cI']) || '',
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || '',
    mainBranch: MAIN,
    originMain: origin || '',
    originShort: origin ? origin.slice(0, 8) : '',
    behind,
    ahead,
    dirty: dirtyTxt == null ? null : dirtyTxt.split(/\r?\n/).filter(Boolean).length,
  }
}

/** 파일 하나의 「언제 바뀌었나」 근거 — 파일 시각 + 마지막 커밋 시각(git 이 없으면 파일 시각만). */
function fileAge(p) {
  const mt = mtimeSafe(p)
  let gitAt
  try {
    gitAt = execFileSync('git', ['log', '-1', '--format=%cI', '--', p],
      { cwd: rootDir, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
  } catch { gitAt = '' }
  return { file: p, mtime: mt == null ? null : new Date(mt).toISOString(), gitAt: gitAt || null }
}

/**
 * 상태 폴더 `chain-info.json` 의 갈래 이름 중 **아직 정본 갈래(mainBranch · 기본 main)에 안 들어간 것**만 남긴다.
 * 그 파일은 **어젯밤 사진**이라 오늘 아침 머지가 반영돼 있지 않다 — 여기서 한 번 더 확인한다.
 * 판정은 **지역 ref 로만** 한다(현황판은 네트워크를 쓰지 않는다).
 * 파일이 없으면 빈 배열이고, 그때 판정은 종전대로 큐가 적은 숫자 하나를 쓴다.
 * git 이 없거나 이름을 못 찾으면 **미머지로 본다**(나쁜 쪽이 이긴다 — 접는 쪽으로 기울지 않는다).
 */
function unmergedChainBranches(stateDir) {
  let names
  try { names = JSON.parse(read(join(stateDir, 'chain-info.json')) || '{}').branches } catch { return [] }
  if (!Array.isArray(names) || !names.length) return []
  const run = (args) => {
    try {
      execFileSync('git', args, { cwd: rootDir, timeout: 4000, stdio: 'ignore', windowsHide: true })
      return true
    } catch { return false }
  }
  const has = (ref) => run(['rev-parse', '-q', '--verify', ref + '^{commit}'])
  return names.map(String).filter(Boolean).filter((b) => {
    const ref = has(b) ? b : (has('origin/' + b) ? 'origin/' + b : null)
    return ref ? !run(['merge-base', '--is-ancestor', ref, MAIN]) : true
  })
}

// ── 조립 + 불일치(드리프트) 검사 ────────────────────────────────
// 이 함수는 **던지지 않는다.** 원천이 없거나 읽다가 깨지면 `{error:{…}}` 를 돌려주고,
// build.mjs 가 그 사유를 적은 화면 한 장을 만든다(2026-09-02 교차리뷰 M4).
export function scan() {
  if (INIT_ERRORS.length) {
    // 확인한 경로는 **전부** 보여 준다 — 첫 단계에서 막혀도 사람이 어디를 고쳐야 하는지 알아야 한다.
    const first = INIT_ERRORS[0]
    return errorResult({
      ...first,
      checked: [...new Set(INIT_ERRORS.flatMap((e) => e.checked || []))],
    })
  }
  try {
    return scanInner()
  } catch (err) {
    return errorResult({
      code: 'scan-failed',
      message: '원천을 읽는 중 오류가 났습니다 — ' + String(err?.message || err),
      checked: READ_ERRORS.map((e) => e.file + '   ' + e.code + ': ' + e.message),
      stack: String(err?.stack || ''),
    })
  }
}

/** scan() 실패 시의 구조화 결과 — 화면이 이 모양을 읽고 「원천을 읽지 못했습니다」를 그린다. */
function errorResult(error) {
  return {
    generatedAt: new Date().toISOString(),
    root: rootDir,
    error: { ...error, readErrors: READ_ERRORS.slice() },
    sprintUpdated: '', sources: {}, engineMismatch: false,
    warnings: [], epics: [], drift: [], driftNotes: [], freshness: {},
    board: { next: [], batch: { running: false, line: '', lastAt: '' }, bulk: [], writesSprint: [] },
    batch: null,
    runner: { available: false },
    devLine: null,
    migration: null,
  }
}

function scanInner() {
  const { epics, duplicateEpics } = parseEpics()
  let sprint = parseSprint()
  const pipeline = parsePipeline()
  const cfg = CFG

  // ── 개발선 덮어 읽기(러너 클론 · 읽기 전용) ──
  // 경로 설정이 없으면 아무것도 하지 않는다(종전대로 이 폴더만 읽는다).
  const clone = resolveRunnerClone(STATE.dir, rootDir)
  const devLine = {
    dir: clone.dir, why: clone.why, configured: clone.configured,
    sprintOverridden: [], storiesFromChain: [], copies: [], sprintMtime: '',
  }
  DEVLINE_STORIES = new Map()
  if (clone.dir) {
    const chainSprintPath = join(clone.dir, relative(rootDir, P.sprint))
    const chainTxt = read(chainSprintPath)
    if (chainTxt) {
      const mt = mtimeSafe(chainSprintPath)
      if (mt != null) devLine.sprintMtime = new Date(mt).toISOString()
      const merged = mergeDevLineSprint(sprint, parseSprintText(chainTxt))
      devLine.sprintOverridden = merged.overridden
      sprint = { ...sprint, storyStatus: merged.storyStatus, epicStatus: merged.epicStatus }
      // 덮인 스토리(또는 이 폴더에 문서가 없는 스토리)는 클론의 문서를 읽고,
      // 화면을 만들 때 화면 폴더의 devline/stories/ 로 복사해 링크가 열리게 한다.
      for (const [id, rec] of Object.entries(sprint.storyStatus)) {
        if (!(merged.overridden.includes(id) || !localStoryPath(rec.slug))) continue
        const chainFile = STORY_DIRS
          .map((d) => join(clone.dir, relative(rootDir, d), rec.slug + '.md'))
          .find((f) => existsSync(f))
        if (!chainFile) continue
        DEVLINE_STORIES.set(rec.slug, chainFile)
        devLine.storiesFromChain.push(rec.slug)
        devLine.copies.push({ from: chainFile, to: DEVLINE_STORY_REL(rec.slug) })
      }
    }
  }
  const drift = []
  // driftNotes = **참고로 접은 것**(판정이 끝난 과거 기록). 건수로 세지 않되 숨기지도 않는다 —
  // 숫자만 줄이고 말을 안 하면 다음 사람이 「왜 줄었지」를 다시 조사한다.
  const driftNotes = []
  const seen = new Set()
  let sprintOnly = 0

  for (const e of epics) {
    e.status = sprint.epicStatus[e.num] || 'unregistered'
    if (e.status === 'unregistered') {
      drift.push({ level: 'high', where: 'Epic ' + e.num, msg: '에픽 문서에는 있으나 sprint-status.yaml에 상태가 없습니다 — 스프린트 계획 갱신 필요' })
    }

    for (const s of e.stories) {
      const rec = sprint.storyStatus[s.id]
      if (rec) {
        seen.add(s.id)
        s.status = rec.status
        s.slug = rec.slug
        s.pipeline = pipeline[rec.slug] || {}
        s.storyFile = storyLinkOf(rec.slug)
        const a = norm(s.title)
        const b = norm(rec.slugTitle)
        let common = 0
        while (common < Math.min(a.length, b.length) && a[common] === b[common]) common++
        if (common < 4) {
          drift.push({ level: 'mid', where: 'Story ' + s.id, msg: '제목이 어긋납니다 — 에픽 문서 "' + s.title + '" vs 상태 파일 "' + rec.slugTitle.replace(/-/g, ' ') + '"' })
        }
      } else {
        s.status = 'unregistered'
        s.pipeline = {}
        s.storyFile = ''
        drift.push({ level: 'high', where: 'Story ' + s.id, msg: '"' + s.title + '" — 에픽 문서에는 있으나 sprint-status.yaml에 없습니다' })
      }
    }

    const doneCount = e.stories.filter((s) => s.status === 'done').length
    if (e.stories.length > 0 && doneCount === e.stories.length && e.status !== 'done') {
      drift.push({ level: 'mid', where: 'Epic ' + e.num, msg: '스토리가 전부 done인데 에픽 상태가 ' + e.status + '입니다 — done으로 바꿀 시점' })
    }
    if (e.status === 'backlog' && e.stories.some((s) => ['in-progress', 'review', 'done'].includes(s.status))) {
      drift.push({ level: 'mid', where: 'Epic ' + e.num, msg: '에픽은 backlog인데 이미 진행된 스토리가 있습니다' })
    }
  }

  for (const id of Object.keys(sprint.storyStatus)) {
    if (!seen.has(id)) {
      sprintOnly += 1
      drift.push({ level: 'high', where: 'Story ' + id, msg: '"' + sprint.storyStatus[id].slugTitle.replace(/-/g, ' ') + '" — 상태 파일에는 있으나 에픽 문서에 없습니다' })
    }
  }
  for (const k of sprint.extra) {
    drift.push({ level: 'mid', where: '상태 파일', msg: '해석할 수 없는 항목: ' + k })
  }

  // 매치 0건 경고 — 경로·서식이 어긋나도 "정상처럼 보이는 빈 화면"이 되지 않게 한다.
  // 원천 파일 실존은 위(로드 시 exit 2)에서 이미 보장됐다.
  const warnings = []
  const totalStories = epics.reduce((n, e) => n + e.stories.length, 0)
  const acTotal = epics.reduce((n, e) => n + e.stories.reduce((m, s) => m + s.acCount, 0), 0)
  const sprintN = Object.keys(sprint.epicStatus).length + Object.keys(sprint.storyStatus).length
  if (epics.length === 0) warnings.push('epics.md 는 읽었으나 `## Epic N:`·`### Epic N:` 패턴이 0건 — 서식이 다를 수 있습니다')
  else if (totalStories === 0) warnings.push('epics.md 에서 `### Story N.M:`·`#### Story N.M:` 패턴이 0건 — 서식이 다를 수 있습니다')
  if (sprintN === 0) warnings.push('sprint-status.yaml 은 읽었으나 development_status 항목이 0건 — 서식이 다를 수 있습니다')
  if (totalStories > 0 && acTotal === 0) warnings.push('스토리 본문에서 `**Given**`(수용기준) 패턴이 0건 — 서식이 다를 수 있습니다')
  // 리뷰 실행 기록은 있는데 어떤 식별자도 상태 파일 키와 맞지 않으면 리뷰 반복 게이트가 통째로
  // 무동작한다 — "리뷰 이력 없음"과 구분되지 않는 조용한 실패라 경고로 드러낸다.
  const runKeys = Object.keys(RUNS)
  const slugs = Object.values(sprint.storyStatus).map((r) => r.slug)
  if (runKeys.length && !runKeys.some((k) => slugs.some((s) => s === k || s.startsWith(k + '-')))) {
    warnings.push('run-summary.log 의 리뷰 실행 기록(' + runKeys.length + '종)이 sprint-status.yaml 키와 하나도 맞지 않습니다 — 리뷰 반복 게이트가 동작하지 않습니다')
  }
  for (const w of warnings) console.error('[dev-status] 경고: ' + w)

  // ── DB 마이그레이션 실측(있을 때만) ──────────────────────────────────────
  const mg = parseMigrationProbe()
  if (mg.wrongProject) {
    drift.push({ level: 'high', where: 'DB 마이그레이션', msg: '개발용이 아닌 프로젝트(' + mg.projectRef + ')를 쟀습니다 — 링크 대상을 확인하고 다시 측정하세요(숫자는 가렸습니다)' })
  }
  // 「파일 없이 적용」으로 보이는 버전 중 개발선 체인 파일·옛 번호표를 가려낸다(러너 클론은 위에서 잡았다).
  if (mg.success && mg.fresh === 'fresh' && !mg.projectUnverified && mg.success.remoteOnly > 0) {
    const cls = classifyRemoteOnly({
      versions: mg.success.remoteOnlyVersions ?? null,
      localDir: P.migDir,
      runnerDir: clone.dir ? join(clone.dir, relative(rootDir, P.migDir)) : '',
      baselineSince: cfgStr('migrationBaselineSince'),
    })
    if (!cls.known) {
      drift.push({ level: 'high', where: 'DB 마이그레이션', msg: '마이그레이션 파일 없이 적용된 DDL ' + mg.success.remoteOnly
        + '건 — 이번 측정에 버전 목록이 없어 성격을 가르지 못했습니다(probe-migrations.mjs 를 다시 실행하세요)' })
    } else {
      if (cls.violations.length) {
        drift.push({ level: 'high', where: 'DB 마이그레이션', msg: '마이그레이션 파일 없이 적용된 DDL ' + cls.violations.length
          + '건 — 「스키마 변경은 마이그레이션 파일로만」 규칙 위반 의심 · ' + cls.violations.slice(0, 3).join(' · ') })
      }
      if (cls.devLine.length) {
        driftNotes.push({ level: 'info', where: 'DB 마이그레이션', msg: '참고 — 개발선 파일 있음 ' + cls.devLine.length
          + '건(러너 클론의 마이그레이션 폴더에 파일이 있습니다 — 아직 이 폴더로 안 들어온 개발선 체인분)' })
      }
      if (cls.oldNumbering.length) {
        driftNotes.push({ level: 'info', where: 'DB 마이그레이션', msg: '참고 — 번호표만 다른 과거 적용분 ' + cls.oldNumbering.length
          + '건(기준일 ' + cfgStr('migrationBaselineSince') + ' 이전 · 같은 DDL 이 다른 번호로 적용된 구간)' })
      }
    }
  }

  // ── 새 배치 하네스 산출물 ────────────────────────────────────────────────
  // 읽기 전용이고, 어느 한 파일이 깨져도 그 블록만 「읽지 못했습니다」가 된다.
  const now = new Date()
  const B = collectBatchSources({
    root: rootDir, logDir: LOG_DIR, stateDir: STATE.dir, inboxPath: P.inbox, now,
  })
  // 러너 클론의 산출물을 **덧붙인다**(경로가 적혀 있고 실존할 때만 · 읽기 전용).
  // 합칠 때 키 하나당 가장 최근 것만 남긴다 — 두 자리에 같은 배치가 있으면 새 쪽이 이긴다.
  const cloneLogs = clone.dir ? readCloneLogs(clone.dir) : { dir: null, manifests: [], verifications: [], metrics: [] }
  const hereLast = B.manifests[0]?.at ?? null
  const hereCount = B.manifests.length
  const cloneLast = cloneLogs.manifests.map((m) => m.at).filter(Boolean).sort().pop() ?? null
  if (cloneLogs.dir) {
    B.manifests = mergeByKey([B.manifests, cloneLogs.manifests], (m) => m.batchId ?? m.at, (m) => m.at)
    B.verifications = mergeByKey([B.verifications, cloneLogs.verifications], (v) => v.story, (v) => v.generatedAt)
    B.metrics = mergeByKey([B.metrics, cloneLogs.metrics], (m) => m.batchId, (m) => m.at ?? m.batchId)
    B.lastNight = lastNightManifests(B.manifests, now)
  }
  const storyRows = Object.entries(sprint.storyStatus).map(([, r]) => ({ slug: r.slug, status: r.status }))
  // 기준선 — 마지막 릴리스는 RELEASE-LOG.md, 운영선 에픽은 릴리스 갈래 문서(없으면 sources.json 의
  // opsLineEpics), 나머지는 sources.json 설정이다. **전부 「있을 때만」 동작**하고, 없으면 종전대로
  // 전건을 센다(확인 못 한 것을 통과로 적지 않는다).
  const release = lastRelease(read(P.releaseLog))
  const fromLines = parseOpsEpics(read(P.releaseLines))
  const opsEpics = fromLines.length ? fromLines
    : (Array.isArray(cfg.opsLineEpics) ? cfg.opsLineEpics.map(Number).filter((x) => Number.isFinite(x)) : [])
  const verdict = deployVerdict({
    manifests: B.manifests, lastNight: B.lastNight, metrics: B.metrics,
    queue: B.queue.value, verifications: B.verifications, inbox: B.inbox.value,
    diagnosis: B.diagnosis.value, backlog: B.backlog.value, readiness: B.readiness.value,
    chainAgeDays: B.queue.value?.plan?.chainAgeDays ?? null,
    chainBranches: unmergedChainBranches(STATE.dir),
    devLineBranches: Array.isArray(cfg.devLineBranches) ? cfg.devLineBranches : null,
    qualityGatesSince: cfg.qualityGatesSince || null,
    opsEpics, lastReleaseAt: release.at, lastReleaseLabel: release.heading, now,
  })
  // ⑨ — 하네스가 만드는 경고 3종을 기존 4종 드리프트에 **더한다**(기존 렌더러가 그대로 그린다).
  const bw = batchWarnings({
    manifests: B.manifests, verifications: B.verifications, stories: storyRows,
    lastReleaseAt: release.at, lastReleaseLabel: release.heading,
    integrationGateSince: cfg.integrationGateSince || null,
  })
  drift.push(...bw.warnings)
  driftNotes.push(...bw.notes)
  const metricsTable = dailyMetrics({
    history: B.history.rows, manifests: B.manifests, verifications: B.verifications, now,
  })

  // ── 신선도 재료 ──────────────────────────────────────────────────────────
  // 판정은 freshness.mjs 가 한다(8항목). 여기서는 재료만 모은다 — 못 모은 것은 null 로 둔다.
  const allStories = epics.flatMap((e) => e.stories)
  const runnerState = parseRunner(STATE.dir)
  const freshness = {
    git: gitInfo(),
    sprint: { ...fileAge(P.sprint), commentDate: sprint.updated, commentCount: sprint.updatedLines },
    docs: {
      epics: epics.length,
      stories: allStories.length,
      hashStories: allStories.filter((s) => s.deep).length,
      sprintOnly,
      docOnly: allStories.filter((s) => s.status === 'unregistered').length,
      duplicateEpics,
    },
    runner: {
      stateDir: STATE.dir,
      lastLine: (B.heartbeat.lines || []).filter(Boolean).slice(-1)[0] || '',
      lockExists: !!runnerState.lock,
    },
    manifests: {
      lastAt: hereLast, count: hereCount,
      runnerLastAt: cloneLast, runnerCount: cloneLogs.manifests.length,
      runnerDir: cloneLogs.dir,
      runnerWhy: clone.dir && !cloneLogs.dir ? '러너 클론(' + clone.dir + ')에 배치 기록 폴더가 없음' : clone.why,
      runnerConfigured: clone.configured,
    },
    migration: mg.applicable ? {
      applicable: true,
      measuredAt: mg.success ? mg.success.measuredAt : '',
      measuredCount: mg.success ? mg.success.localFilesCount : null,
      localCount: mg.localFilesCount,
      latestFile: mg.localLatest,
      fresh: mg.fresh,
      malformed: mg.malformed,
      wrongProject: mg.wrongProject,
      projectUnverified: mg.projectUnverified,
      probeCommand: mg.probeCommand,
    } : { applicable: false, dir: mg.dir },
    inbox: fileAge(P.inbox),
  }

  return {
    generatedAt: new Date().toISOString(),
    error: null,
    readErrors: READ_ERRORS.slice(),
    sprintUpdated: sprint.updated,
    root: rootDir,
    sources: { epics: relFromRoot(P.epics), sprint: relFromRoot(P.sprint), state: relFromRoot(P.state) },
    engineMismatch: ENGINE_MISMATCH,
    warnings,
    epics,
    drift,
    driftNotes,
    freshness,
    devLine,
    migration: mg,
    runner: runnerState,
    board: buildBoard(epics, sprint),
    // 새 블록 ①②④⑤⑥⑦⑧ 의 재료 한 덩어리 — build.mjs 와 (b)갈래 이식판이 같이 쓴다.
    batch: {
      stateDir: STATE.dir, stateDirWhy: STATE.why, logDir: LOG_DIR,
      inboxPath: relFromRoot(P.inbox),
      cloneLogDir: cloneLogs.dir, cloneWhy: clone.why,
      autofinish: B.autofinish,
      heartbeat: B.heartbeat,
      manifests: B.manifests, lastNight: B.lastNight,
      verifications: B.verifications, metrics: B.metrics,
      history: { missing: B.history.missing, bad: B.history.bad, rows: B.history.rows.length, file: B.history.file },
      assign: B.assign, queue: B.queue, evidence: B.evidence, inbox: B.inbox,
      diagnosis: B.diagnosis, backlog: B.backlog, readiness: B.readiness, report: B.report,
      errors: B.errors,
      verdict,
      metricsTable,
      assignByStory: [...assignByStory(B.assign.value ?? { entries: {} })].map(([k, v]) => [k, v]),
    },
  }
}

// CLI 진입일 때만 exit 한다 — import 경로에서는 scan() 이 구조화 오류를 돌려줄 뿐이다(M4).
if (IS_CLI) {
  const r = scan()
  if (r.error) {
    console.error('[dev-status] ' + r.error.message)
    for (const l of r.error.checked || []) console.error('  ' + l)
    process.exit(2)
  }
  console.log(JSON.stringify(r, null, 2))
}
