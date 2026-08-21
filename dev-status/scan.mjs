// dev-status — BMad 프로젝트 개발 현황판: 데이터 수집기 (읽기 전용)
// 원천: epics.md(목록 SoT) + sprint-status.yaml(상태 SoT) + 스토리 .md + auto-pipeline-logs/
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// ── 원천 계약 — BMad v6 에픽·스토리 템플릿의 구조 패턴 ──────────
// 문서 언어가 한국어여도 이 구조 키워드는 영어로 남는다. SKILL.md "원천 계약" 참조.
const PATTERNS = {
  epic: /^## Epic (\d+): (.+?)\s*$/,           // epics.md 의 에픽 절
  story: /^### Story (\d+)\.(\d+): (.+?)\s*$/, // epics.md 의 스토리 절
  ac: /^\*\*Given\*\*/gm,                      // 수용기준 개수 = **Given** 개수
  goal: /^\s*So that (.+)$/m,                  // 스토리 목표 문장
  deferred: /^## Deferred from:/,              // 이 사본에서는 미사용 — 원천 계약 문서화용
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

// ── 경로 탐지: --root 인자(없으면 cwd) → 상위 최대 6단 → BMad config. 실패는 exit 2 ──
function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) out.root = argv[i + 1]
    else if (argv[i].startsWith('--root=')) out.root = argv[i].slice('--root='.length)
  }
  return out
}

function fail(checkedLines) {
  console.error('[dev-status] BMad 산출물을 찾지 못했습니다. 다음을 확인했습니다:')
  for (const l of checkedLines) console.error('  ' + l)
  console.error('→ BMad v6 프로젝트가 아니거나 산출물 경로가 다릅니다.')
  process.exit(2)
}

const argRoot = parseArgs(process.argv).root
const startDir = resolve(argRoot || process.cwd())
if (!existsSync(startDir)) {
  console.error('[dev-status] --root 경로가 없습니다: ' + startDir)
  process.exit(2)
}

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
if (!rootDir) fail(['(상위 탐색) ' + climbed.join(' → ') + '   _bmad/ 또는 .git/ 없음'])

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
if (!found.plan) fail(['(상위 탐색) ' + climbed.join(' → ') + '   루트: ' + rootDir].concat(found.checked))

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

const P = {
  epics: join(found.plan, 'epics.md'),
  sprint: sprintPath,
  state: join(engineDir, 'auto-pipeline-logs', 'state.json'),
  runLog: join(engineDir, 'auto-pipeline-logs', 'run-summary.log'),
}

// BMad 없는 프로젝트의 저하는 2단뿐 — 두 원천이 다 있으면 정상 화면, 아니면 exit 2(진단 출력).
// 대체 원천(git 커밋·TODO 주석)은 만들지 않는다.
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
function storyPathOf(slug) {
  if (!slug) return ''
  for (const d of STORY_DIRS) {
    const p = join(d, slug + '.md')
    if (existsSync(p)) return p
  }
  return ''
}

const norm = (s) => s.replace(/[\s·\-—()[\]{}/,.:]/g, '').toLowerCase()

// ── epics.md: 에픽 본문 절과 스토리 ─────────────────────────────
function parseEpics() {
  const lines = read(P.epics).split(/\r?\n/)
  const epics = []
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
      epics.push(epic)
      continue
    }
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
      story = { id: sm[1] + '.' + sm[2], epic: Number(sm[1]), num: Number(sm[2]), title: sm[3], body: '' }
      epic.stories.push(story)
      continue
    }
    if (story) buf.push(line)
    else if (!epic.desc && line.trim()) epic.desc = line.trim()
  }
  flush()

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
  return epics
}

// ── sprint-status.yaml: development_status 블록 ─────────────────
function parseSprint() {
  const txt = read(P.sprint)
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

  // last_updated 는 헤더 주석줄로 오는 서식도 있다(# last_updated: … 꼬리 주석 포함) — 완화해 읽는다
  const upd = /^#?\s*last_updated:\s*(\S+)/m.exec(txt)
  return { epicStatus, storyStatus, extra, updated: upd ? upd[1] : '' }
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
// 임계값 6의 근거 — 실측(2026-08-21, jng-os run-summary.log · 슬러그 38종): 정상 완료(done)한
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
  const txt = readFileSync(p, 'utf8')
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

  const fileOf = (slug) => {
    const p = storyPathOf(slug)
    return p ? relFromRoot(p) : ''
  }

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

// ── 조립 + 불일치(드리프트) 검사 ────────────────────────────────
export function scan() {
  const epics = parseEpics()
  const sprint = parseSprint()
  const pipeline = parsePipeline()
  const drift = []
  const seen = new Set()

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
        const sp = storyPathOf(rec.slug)
        s.storyFile = sp ? relFromOut(sp) : ''
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
  if (epics.length === 0) warnings.push('epics.md 는 읽었으나 `## Epic N:` 패턴이 0건 — 서식이 다를 수 있습니다')
  else if (totalStories === 0) warnings.push('epics.md 에서 `### Story N.M:` 패턴이 0건 — 서식이 다를 수 있습니다')
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

  return {
    generatedAt: new Date().toISOString(),
    sprintUpdated: sprint.updated,
    root: rootDir,
    sources: { epics: relFromRoot(P.epics), sprint: relFromRoot(P.sprint), state: relFromRoot(P.state) },
    engineMismatch: ENGINE_MISMATCH,
    warnings,
    epics,
    drift,
    board: buildBoard(epics, sprint),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(scan(), null, 2))
}
