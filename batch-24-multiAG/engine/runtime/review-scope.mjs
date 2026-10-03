// review-scope.mjs — 리뷰 diff 범위 좁히기(2026-10-02 실사고 · 5-18 리뷰에 4.20 의 ContractsPage 지적 · 4-18 리뷰에 1-53/2-18 의 티켓 화면 지적).
//
// 왜: 24시간 러너는 한 갈래(auto/<날짜>)에서 여러 스토리를 겹쳐 진행한다. 리뷰 diff(작업 트리 vs HEAD · 비면 baseline_commit..HEAD)에
// **다른 활성 스토리의 변경**(STOP 잔여물 보존 커밋 포함)이 섞이면 리뷰어가 엉뚱한 스토리에 지적을 붙이고, 그 스토리의 열린 Patch 가
// 줄지 않아 완료가 늦어진다.
// 무엇: 변경 파일 f 를 **뺀다** = (a) 이 스토리 File List 에 없고 (b) 경로에 이 스토리 키(4-21 · 4.21)가 없고 (c) 다른 활성 스토리의
// File List(또는 그 스토리 파일 자체)가 f 를 소유할 때뿐이다. 소유가 불분명한 파일은 남긴다(보수적).
// 이 모듈은 순수하다(파일·git 을 직접 읽지 않는다) — 호출부가 텍스트와 읽기 함수를 준다. 어떤 오류도 리뷰를 막지 않게 호출부가 감싼다(fail-open).
// ⚠️ 통합 게이트(landing · quality-gates 의 변경 범위)는 이 모듈을 쓰지 않는다 — 전체 범위 그대로다.

/** 범위 밖 지적 표식 — 리뷰어가 줄에 붙이고, 계수기(countOpenFindings · story-ledger.openFindings)는 이 표식 줄을 열린 지적으로 세지 않는다. */
export const FOREIGN_MARK = '[다른 스토리 소관:'
export const FOREIGN_MARK_RE = /\[다른 스토리 소관:/

const INACTIVE = new Set(['done', 'backlog', 'deferred'])
const normPath = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * 스토리 md 의 File List 절(들) → 경로 배열. 절이 없으면 null.
 * `## File List` · `### File List` · `#### File List (설명)` 를 받는다. 항목 = `- `/`* ` 줄(체크박스 허용) — 백틱이 있으면 첫 백틱 안,
 * 없으면 첫 낱말(끝의 설명 괄호·구두점 제거). `\` → `/`. 절은 다음 헤딩에서 끝난다 · 펜스 안 줄은 무시.
 */
export function parseFileListLoose(md) {
  const lines = String(md ?? '').split(/\r?\n/)
  let inList = false, inFence = false, found = false
  const out = []
  for (const line of lines) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^ {0,3}#{1,6}[ \t]/.test(line)) {
      inList = /^ {0,3}#{2,4}[ \t]+File List\b/i.test(line)
      if (inList) found = true
      continue
    }
    if (!inList) continue
    const b = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)
    if (!b) continue
    const code = /`([^`]+)`/.exec(b[1])
    let raw = code ? code[1] : b[1].split(/[\s(]/)[0]
    raw = normPath(raw.replace(/\s*\([^)]*\)\s*$/, '').replace(/[,;:]+$/, ''))
    if (raw && !raw.startsWith('~~')) out.push(raw)
  }
  return found ? [...new Set(out)] : null
}

const globToRe = (g) => new RegExp('^' + g.split(/(\*\*\/|\*\*|\*|\?)/).map((part) => {
  if (part === '**/') return '(?:.*/)?'
  if (part === '**') return '.*'
  if (part === '*') return '[^/]*'
  if (part === '?') return '[^/]'
  return part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}).join('') + '$')

/** File List 항목이 파일을 덮는가 — 정확 일치 · 디렉터리 접두(`src/feature/` 또는 `src/feature`) · 단순 글롭(`*`·`**`·`?`). */
export function entryMatches(entry, file) {
  const e = normPath(entry), f = normPath(file)
  if (!e || !f) return false
  if (/[*?]/.test(e)) { try { return globToRe(e).test(f) } catch { return false } }
  const dir = e.replace(/\/+$/, '')
  return f === dir || f.startsWith(dir + '/')
}

/** 스토리 키의 번호 부분(`4-21-contract` → ['4','21']) — 없으면 null. */
export function storyNumber(key) {
  const m = /^(\d+)[-.](\d+)/.exec(String(key ?? '').replace(/^.*[\\/]/, ''))
  return m ? [m[1], m[2]] : null
}

/** 경로에 스토리 번호(4-21 · 4.21 · 4_21)가 들어 있는가 — 14-21·4-210·1.4.21 같은 이웃 숫자는 아니다. */
export function pathHasStoryKey(file, key) {
  const n = storyNumber(key)
  if (!n) return false
  return new RegExp('(?<![\\d.])' + n[0] + '[-._]' + n[1] + '(?!\\d)').test(normPath(file))
}

const sameStory = (a, b) => {
  if (!a || !b) return false
  if (a === b) return true
  const x = storyNumber(a), y = storyNumber(b)
  return Boolean(x && y && x[0] === y[0] && x[1] === y[1])
}

/** sprint-status.yaml → [{key, status}] (스토리 키 행만 · 같은 키가 두 번이면 마지막 행). */
export function parseSprintRows(text) {
  const rows = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s{2,}(\d+-\d+[^\s:]*)\s*:\s*([A-Za-z][A-Za-z-]*)/.exec(line) // 키 본문은 한글 등 비 ASCII 가 보통이다(2026-10-03 실사고: ASCII 한정 → 행 0 → 범위 안 좁혀짐)
    if (m) rows.set(m[1], { key: m[1], status: m[2].toLowerCase() })
  }
  return [...rows.values()]
}

/** 다른 활성 스토리(done/backlog/deferred 아님 · 자기 자신 제외)의 소유 목록 [{key, entries}]. 스토리 파일이 없거나 File List 가 없으면 건너뛴다. */
export function activeOwners({ sprintText, story = '', ownKey = '', readStory }) {
  const owners = []
  for (const { key, status } of parseSprintRows(sprintText)) {
    if (INACTIVE.has(status)) continue
    if (sameStory(key, ownKey) || sameStory(key, story)) continue
    let r
    try { r = readStory(key) } catch { r = null } // 한 스토리를 못 읽어도 그 스토리만 건너뛴다(소유 불분명 = 남긴다)
    if (!r || r.text == null) continue
    const entries = parseFileListLoose(r.text) ?? []
    if (r.file) entries.push(normPath(r.file)) // 그 스토리의 md 자체도 그 스토리 소유다
    if (entries.length) owners.push({ key: r.key ?? key, entries })
  }
  return owners
}

/** 파일을 소유한 다른 활성 스토리 키(여럿이면 `, ` 로 잇는다) — 없으면 ''. */
export function ownerOfPath(owners, file) {
  return (owners ?? []).filter((o) => o.entries.some((e) => entryMatches(e, file))).map((o) => o.key).join(', ')
}

/**
 * 리뷰 범위 판정(순수).
 * @param {{files:string[], story?:string, ownKey?:string, ownText?:string|null, sprintText?:string|null, readStory:(key:string)=>({key?:string,file?:string,text:string}|null)}} o
 * @returns {{kept:string[], excludedByOwner:{file:string, owner:string}[], owners:{key:string, entries:string[]}[], fallback:string|null}}
 *   fallback = 좁히지 않은 이유(sprint-status 없음 · 스토리 파일 없음) — 이때 kept = 입력 전체.
 */
export function computeReviewScope({ files = [], story = '', ownKey = '', ownText = null, sprintText = null, readStory }) {
  const all = [...files]
  if (sprintText == null) return { kept: all, excludedByOwner: [], owners: [], fallback: 'sprint-status 없음' }
  if (ownText == null) return { kept: all, excludedByOwner: [], owners: [], fallback: '스토리 파일 없음' }
  const own = parseFileListLoose(ownText) ?? []
  const owners = activeOwners({ sprintText, story, ownKey, readStory })
  const kept = [], excludedByOwner = []
  for (const f of all) {
    if (own.some((e) => entryMatches(e, f)) || pathHasStoryKey(f, ownKey) || pathHasStoryKey(f, story)) { kept.push(f); continue }
    const owner = ownerOfPath(owners, f)
    if (owner) excludedByOwner.push({ file: f, owner })
    else kept.push(f)
  }
  return { kept, excludedByOwner, owners, fallback: null }
}

/** computeReviewScope 의 fail-open 판 — 어떤 오류도 리뷰를 막지 않는다: 전체 범위 + warn 1회. */
export function safeReviewScope(args, warn = () => {}) {
  try {
    return computeReviewScope(args)
  } catch (e) {
    warn(`리뷰 범위 좁히기 실패(${e?.message ?? e}) — 종전 전체 범위로 리뷰한다`)
    return { kept: [...(args?.files ?? [])], excludedByOwner: [], owners: [], fallback: '오류' }
  }
}

/** unified diff 에서 drop(path) 가 참인 파일 절을 본문째 들어내고 표식 한 줄만 남긴다(명령줄 길이와 무관 — pathspec 대신 본문 단계). */
export function dropFileSections(diff, drop, label = (p) => `[리뷰 범위 밖 — 다른 활성 스토리 소유: ${p}]`) {
  const text = String(diff ?? '')
  if (!text) return text
  const unwrap = (s) => s.replace(/^"|"$/g, '').replace(/^[ab]\//, '')
  const out = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length)
      const cut = Math.max(rest.lastIndexOf(' b/'), rest.lastIndexOf(' "b/'))
      const a = unwrap(cut >= 0 ? rest.slice(0, cut) : rest)
      const b = unwrap(cut >= 0 ? rest.slice(cut + 1) : rest)
      skipping = Boolean(drop(a) || drop(b))
      out.push(skipping ? label(b || a) : line)
      continue
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

const listExcluded = (excluded, max = 40) => {
  const shown = excluded.slice(0, max).map((e) => `${e.file}(${e.owner})`).join(', ')
  return excluded.length > max ? `${shown} 외 ${excluded.length - max}건` : shown
}

/** run-summary 한 줄 */
export const summarizeExcluded = (excluded) => `리뷰 범위 밖 ${excluded.length}건 — 다른 활성 스토리 소유: ${listExcluded(excluded)}`

/**
 * 리뷰 지시문 문단(claude prompts.review · codex codexReviewPrompt 공용).
 * @param {{file:string, owner:string}[]} excluded
 * @param {{codex?:boolean}} o codex = JSON 출력이라 표식을 title 맨 앞에 붙이게 한다
 */
export function foreignScopeBrief(excluded = [], { codex = false } = {}) {
  const where = codex ? '그 finding 의 title 맨 앞에' : '그 줄에'
  const head = `[리뷰 범위 · 2026-10-02] 변경 파일 목록 밖 파일에서 발견한 문제는 ${where} \`${FOREIGN_MARK} <경로>]\` 를 붙여 **별도 줄로 분리**하라 — 그 줄은 이 스토리의 Patch 로 세지 않고 엔진이 소유 스토리 몫으로 이관한다(지적을 없애지는 않는다 · 이월 금지 5범주도 기록은 그대로 남는다).`
  return excluded.length ? `${head} 다른 활성 스토리 소유로 제외된 파일 목록: ${listExcluded(excluded)}` : head
}
