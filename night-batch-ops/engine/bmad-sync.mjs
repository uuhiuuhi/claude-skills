// bmad-sync.mjs — 진단·백로그가 찾아낸 일을 **BMAD 산출물**(epics.md · sprint-status.yaml · 스토리 md)에
// 반영한다. 설계 §1-3 · §3(BMAD 보존 규칙) · SPEC §3.
//
// 왜 이 모듈이 따로 있나: 자율 마무리는 「코드부터 고치지 않는다」가 원칙이다(SPEC §3). 모든 변경은
// ① 기존 스토리에 붙거나 ② 새 스토리/결함 스토리로 등록되어야 한다. 그 등록을 **사람이 쓴 문서를
// 망가뜨리지 않고** 하는 것이 이 파일의 전부다.
//
// ⚠️ 이 모듈은 자율 마무리 전체에서 **유일하게 대상 저장소에 쓰는 곳**이다(`applyBmadWrites` 하나).
// 나머지 export 는 전부 순수 함수다 — 계획을 만들고 문자열을 렌더할 뿐 파일을 건드리지 않는다.
//
// 보존 장치 6개(설계 §3 · §7-5·§7-6):
//   1. `_bmad-output/` 밖 경로 거부 — 화이트리스트 접두사 밖은 계획 자체를 폐기한다.
//   2. 삭제 op 없음 — op 4종은 전부 「만들기·끼우기·붙이기·한 줄 upsert」다.
//   3. append-only 앵커 화이트리스트 — `## Acceptance Criteria` 같은 사람이 쓴 절은 못 건드린다.
//   4. `baseHash`/`sectionHash` 3-way — 쓰기 직전에 다시 계산해 하나라도 어긋나면 **전체 계획 폐기**.
//   5. 줄 유실 0 검사 — 원문의 어떤 줄도 사라지지 않아야 한다(sprint 한 줄 upsert만 예외 1줄).
//   6. `path.tmp` → `rename` 원자 교체 + 실패 시 이미 쓴 파일 되돌리기(부분 적용 0).
//
// Status 전이는 여기서 하지 않는다 — `story-writes.setStoryStatus` 만이 그 일을 한다(설계 §3).
// 이 모듈은 오히려 **Status 줄이 바뀌면 거부**한다.

import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { setSprintStatus, setStoryStatus } from '../../auto-story-finish/story-writes.mjs'

export const BMAD_PLAN_SCHEMA = 'night-batch-ops/bmad-write-plan/1'
export const BMAD_APPLY_SCHEMA = 'night-batch-ops/bmad-apply/1'

/** 사람이 쓴 문서에서 **뒤에 덧붙이는 것만** 허용하는 절(설계 §3). 이 목록 밖 앵커는 거부한다. */
export const APPEND_ONLY_ANCHORS = Object.freeze([
  '### Review Findings',
  '### Completion Notes List',
  '### Debug Log References',
  '### File List',
  '## Change Log',
  '### 회수 라운드 개설',
])

/** epics.md 등재 자리 — 「그 에픽 마지막 `### Story` 절 뒤」(설계 §3). 스토리 절 헤더도 앵커로 허용한다. */
export const EPIC_STORY_ANCHOR_RE = /^#{2,3} Story \d+\.\d+:/
/** 결정 인박스는 H1 바로 아래(=맨 앞)에 끼운다. */
export const INBOX_H1_RE = /^#\s+.*결정 인박스/
export const WRITE_OPS = Object.freeze(['create-file', 'insert-after-heading', 'upsert-sprint-key', 'append-within-section'])

export const DEFAULT_GUARDS = Object.freeze({
  allowedPathPrefixes: ['_bmad-output/'],
  maxNewStories: 3,
  maxWritesPerRound: 12,
})

// ── 작은 도구 ────────────────────────────────────────────────────────────────
const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex')
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
const uniq = (a) => [...new Set(a)]
const eol = (text) => (String(text).includes('\r\n') ? '\r\n' : '\n')
const withEol = (block, nl) => String(block).replace(/\r?\n/g, nl)
const shortId = (key) => String(key ?? '').split('-').slice(0, 2).join('-')
const dotId = (key) => shortId(key).replace('-', '.')
const today = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString().slice(0, 10)

/** 한글을 살린 slug — 공백·구두점은 `-`, 40자 상한(설계 §3). */
export function slugify(title, { max = 40 } = {}) {
  const s = String(title ?? '')
    .replace(/[`*_~"'()[\]{}<>|]/g, '')
    .replace(/[\\/:;,.!?·—–]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s.slice(0, max).replace(/-$/, '') || '무제'
}

/** 경로 안전성 — 절대경로·상위참조·화이트리스트 밖은 전부 거부(설계 §7-6). */
export function pathAllowed(path, prefixes = DEFAULT_GUARDS.allowedPathPrefixes) {
  const p = norm(path)
  if (!p) return { ok: false, why: '경로가 비었다' }
  if (/^([A-Za-z]:)?\//.test(p)) return { ok: false, why: '절대 경로는 쓰지 않는다' }
  if (p.split('/').includes('..')) return { ok: false, why: '상위 폴더 참조(..)는 쓰지 않는다' }
  if (!prefixes.some((pre) => p.startsWith(norm(pre)))) return { ok: false, why: `허용 경로(${prefixes.join(', ')}) 밖이다` }
  return { ok: true }
}

/**
 * **실경로** 안전성(codex-review-r3 M3) — 문자열 접두사만으로는 링크를 못 막는다.
 * `_bmad-output/implementation-artifacts` 가 바깥 폴더로 걸린 junction/symlink 면
 * `join(root, rel)` 은 여전히 `_bmad-output/…` 으로 보이지만 실제 쓰기는 저장소 밖에서 일어난다.
 *
 * 판정 순서: ① 문자열 규칙(pathAllowed) → ② 경로 각 구간이 링크인지(reparse point 포함) → ③ 가장 가까운
 * **기존** 부모의 realpath 가 `realpath(root/<허용 뿌리>)` 안인지. 하나라도 어긋나면 거부한다.
 * @param {string} root 저장소 루트
 * @param {string} rel  저장소 기준 상대 경로
 */
export function realPathAllowed(root, rel, { prefixes = DEFAULT_GUARDS.allowedPathPrefixes, fs = nodeFs } = {}) {
  const base = pathAllowed(rel, prefixes)
  if (!base.ok) return base
  const p = norm(rel)
  let rootReal
  try { rootReal = fs.realpathSync(String(root)) } catch { return { ok: false, why: '저장소 폴더의 실제 경로를 확인할 수 없다 — 쓰지 않는다' } }

  // ② 구간별 링크 검사 — 중간 한 칸만 junction 이어도 그 아래는 전부 저장소 밖이다.
  let cur = rootReal
  for (const seg of p.split('/').filter(Boolean)) {
    cur = join(cur, seg)
    let st = null
    try { st = fs.lstatSync(cur) } catch { st = null } // 아직 없는 구간은 링크일 수 없다
    if (st && st.isSymbolicLink()) return { ok: false, why: `경로 구간 「${seg}」 이 링크(symlink·junction)다 — 허용 폴더 밖을 가리킬 수 있어 거부한다` }
  }

  // ③ 실제 위치 포함 검사 — 가장 가까운 기존 부모까지 거슬러 올라가 realpath 로 해석한다.
  const prefix = norm(prefixes.find((pre) => p.startsWith(norm(pre))) ?? '').replace(/\/+$/, '')
  const guardAbs = prefix ? join(rootReal, prefix) : rootReal
  let guardReal = guardAbs
  try { guardReal = fs.realpathSync(guardAbs) } catch { /* 허용 뿌리가 아직 없으면 문자열 그대로 본다 */ }
  let nearest = join(rootReal, p)
  for (;;) {
    try { nearest = fs.realpathSync(nearest); break } catch {
      const up = dirname(nearest)
      if (up === nearest) return { ok: false, why: '대상 경로의 실제 위치를 확인할 수 없다 — 쓰지 않는다' }
      nearest = up
    }
  }
  const key = (x) => (process.platform === 'win32' ? resolve(x).toLowerCase() : resolve(x))
  const c = key(nearest), q = key(guardReal)
  if (!(c === q || c.startsWith(q.endsWith(sep) ? q : q + sep))) {
    return { ok: false, why: `실제 경로가 허용 폴더(${prefix || '.'}) 밖을 가리킨다 — 링크·마운트로 벗어난 것으로 보고 거부한다` }
  }
  return { ok: true }
}

/** 앵커 허용 판정 — op 별로 다르다(§3 append-only 화이트리스트). */
export function anchorAllowed(op, anchor) {
  const a = String(anchor ?? '').trim()
  if (!a) return { ok: false, why: '앵커가 비었다' }
  if (op === 'append-within-section') {
    if (APPEND_ONLY_ANCHORS.includes(a) || EPIC_STORY_ANCHOR_RE.test(a)) return { ok: true }
    return { ok: false, why: `append-only 앵커 목록 밖이다 — 사람이 쓴 절은 고치지 않는다(${a})` }
  }
  if (op === 'insert-after-heading') {
    if (INBOX_H1_RE.test(a) || APPEND_ONLY_ANCHORS.includes(a)) return { ok: true }
    return { ok: false, why: `끼워넣기가 허용된 앵커가 아니다(${a})` }
  }
  return { ok: true }
}

const headingLevel = (line) => (/^(#{1,6}) /.exec(line ?? '')?.[1].length ?? 0)

/** 앵커 헤더가 있는 줄 번호(0-base). occurrence 는 1-base(기본 1 = 첫 등장, -1 = 마지막). */
export function findHeadingLine(text, anchor, occurrence = 1) {
  const lines = String(text ?? '').split('\n')
  const a = String(anchor).trim()
  const hits = []
  lines.forEach((l, i) => { if (l.trim() === a || (l.startsWith(a) && headingLevel(l) > 0)) hits.push(i) })
  if (hits.length === 0) return -1
  if (occurrence === -1) return hits[hits.length - 1]
  return hits[occurrence - 1] ?? -1
}

/** 헤더가 여는 절의 범위 [본문시작줄, 끝줄(배타)] — 같은 레벨 이상 헤더 앞에서 끊는다. */
export function sectionRange(text, headLine) {
  const lines = String(text ?? '').split('\n')
  const lv = headingLevel(lines[headLine] ?? '')
  let end = lines.length
  for (let i = headLine + 1; i < lines.length; i++) {
    const l = headingLevel(lines[i])
    if (l > 0 && l <= lv) { end = i; break }
  }
  return [headLine + 1, end]
}

/** 절 본문(헤더 제외) — `sectionHash` 의 재료. */
export function sectionBody(text, anchor, occurrence = 1) {
  const at = findHeadingLine(text, anchor, occurrence)
  if (at < 0) return null
  const [s, e] = sectionRange(text, at)
  return String(text).split('\n').slice(s, e).join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 매핑 — 작업 항목을 기존 스토리 / 새 스토리 / 결함 스토리 / 질문으로 가른다 (설계 §3)
// ═══════════════════════════════════════════════════════════════════════════

/** 에픽 단위 다음 번호 = max(sprint ∪ epics ∪ 구현 폴더 md) + 1. */
export function nextStoryNumber(epic, snapshot) {
  const e = Number(epic)
  let max = 0
  const bump = (n) => { if (Number.isFinite(n) && n > max) max = n }
  const fromKey = (key) => {
    const m = /^(\d+)-(\d+)(?:-|$)/.exec(String(key ?? ''))
    if (m && Number(m[1]) === e) bump(Number(m[2]))
  }
  for (const r of snapshot?.sprint ?? []) fromKey(r.key)
  for (const s of snapshot?.epicStories ?? []) if (Number(s.epic) === e) bump(Number(s.num))
  for (const s of snapshot?.stories ?? []) fromKey(s.key)
  for (const d of snapshot?.orphanStoryDocs ?? []) fromKey(d.name)
  for (const o of snapshot?.epicOnly ?? []) if (Number(o.epic) === e) bump(Number(o.num))
  return max + 1
}

export function storyKeyFor({ epic, num, title, defect = false }) {
  return `${Number(epic)}-${Number(num)}-${defect ? '결함-' : ''}${slugify(title)}`
}

/** 파일 경로로 에픽을 추정한다 — 그 파일을 File List 에 선언한 스토리들의 다수 에픽(질문 최소화 §5). */
export function inferEpic(item, snapshot) {
  if (item?.epic != null && Number.isFinite(Number(item.epic))) return Number(item.epic)
  const files = new Set((item?.files ?? []).map(norm))
  if (files.size === 0) return null
  const tally = new Map()
  for (const st of snapshot?.stories ?? []) {
    const hit = (st.fileList?.declared ?? []).some((p) => files.has(norm(p)))
    if (hit && st.epic != null) tally.set(st.epic, (tally.get(st.epic) ?? 0) + 1)
  }
  if (tally.size === 0) return null
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
}

/**
 * 작업 항목 → BMAD 자리. **기존 스토리가 있으면 무조건 거기 붙인다**(재개봉하지 않는다 · 프로젝트 규칙).
 * @param {{items:object[], snapshot:object}} o
 * @returns {{mapped:object[], newStories:object[], defects:object[], unmappable:object[]}}
 */
export function mapToStories({ items = [], snapshot = null } = {}) {
  const sprintKeys = new Set((snapshot?.sprint ?? []).map((r) => r.key))
  const knownEpics = new Set([...(snapshot?.epicHeaders ?? []).map((h) => Number(h.epic)), ...(snapshot?.sprint ?? []).map((r) => Number(r.epic))].filter(Number.isFinite))
  const epicOnlyById = new Map((snapshot?.epicOnly ?? []).map((e) => [e.id, e]))
  const storyByKey = new Map((snapshot?.stories ?? []).map((s) => [s.key, s]))

  const mapped = []
  const newStories = []
  const defects = []
  const unmappable = []
  const nextNum = new Map() // 라운드 안에서 번호가 겹치지 않게 이어 센다

  const takeNum = (epic) => {
    const n = nextNum.get(epic) ?? nextStoryNumber(epic, snapshot)
    nextNum.set(epic, n + 1)
    return n
  }

  for (const item of items ?? []) {
    // ① 원장에 있는 스토리 — 그 스토리 원장에 붙인다
    if (item?.story && sprintKeys.has(item.story)) {
      const st = storyByKey.get(item.story)
      mapped.push({
        item, key: item.story, epic: st?.epic ?? Number(String(item.story).split('-')[0]),
        path: st?.path ?? null, exists: st?.exists !== false,
        why: 'sprint 원장에 있는 스토리다 — 새로 만들지 않고 그 스토리 원장에 지적을 붙인다',
      })
      continue
    }
    // ② epics.md 에만 있는 스토리 — 파일·원장 행만 신설한다(에픽 등재는 이미 있다)
    const sid = item?.story ? shortId(item.story) : null
    if (sid && epicOnlyById.has(sid)) {
      const e = epicOnlyById.get(sid)
      newStories.push({
        item, epic: e.epic, num: e.num, title: e.title, key: storyKeyFor({ epic: e.epic, num: e.num, title: e.title }),
        kind: 'new', epicsEntry: false, section: e.section ?? '',
        why: 'epics.md 에만 있고 원장·파일이 없다 — 계획 문서의 번호를 그대로 쓴다',
      })
      continue
    }
    // ③ 에픽 추정 → 새 스토리 / 결함 스토리
    const epic = inferEpic(item, snapshot)
    if (epic == null || !knownEpics.has(epic)) {
      unmappable.push({
        item, category: 'product-intent',
        why: '어느 에픽에도 매핑할 수 없다 — 에픽을 새로 만들지 않고 사람에게 묻는다(설계 §3)',
      })
      continue
    }
    const isDefect = item.storyLink === 'defect' || Number(item.tier) <= 3
    const num = takeNum(epic)
    const title = String(item.title ?? '이름 없는 작업')
    const rec = {
      item, epic, num, title, kind: isDefect ? 'defect' : 'new', epicsEntry: true,
      key: storyKeyFor({ epic, num, title, defect: isDefect }),
      why: isDefect ? '기존 스토리에 매이지 않는 결함이다 — 영향 에픽에 결함 스토리를 만든다' : '기능 누락이다 — 해당 에픽에 새 스토리를 만든다',
    }
    ;(isDefect ? defects : newStories).push(rec)
  }
  return { mapped, newStories, defects, unmappable }
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 렌더러 — 전부 순수 문자열 (jng-os 절 이름·형식 그대로)
// ═══════════════════════════════════════════════════════════════════════════

const quoteBlock = (lines) => (lines ?? []).filter(Boolean).map((l) => `> ${l}`).join('\n')

/**
 * 새 스토리 md — jng-os 절 이름·순서를 100% 따른다(설계 §0 표).
 * frontmatter `baseline_commit` · 생성 근거 인용 블록이 필수다(어디서 왔는지 모르는 스토리를 만들지 않는다).
 */
export function renderNewStory(spec = {}) {
  const epic = Number(spec.epic)
  const num = Number(spec.num)
  const title = String(spec.title ?? '이름 없는 스토리')
  const date = today(spec.now ?? spec.date)
  const status = spec.status ?? 'backlog'
  const round = spec.round ?? 0
  const baseline = spec.baselineCommit ?? spec.baseline ?? 'unknown'
  const kindLabel = spec.kind === 'defect' ? '결함 스토리' : '신규 스토리'
  const evidence = (spec.evidence ?? []).slice(0, 6)
  const acceptance = (spec.acceptance ?? []).length ? spec.acceptance : ['이 작업의 완료 기준을 dev 착수 전에 확정한다']
  const tasks = (spec.tasks ?? []).length ? spec.tasks : ['진단이 지목한 지점을 재현한다', '고친다', '회귀 테스트를 추가한다']
  const epicsPath = spec.epicsPath ?? '_bmad-output/planning-artifacts/epics.md'

  const acBlock = acceptance.map((a, i) => [
    `**AC-${i + 1} ${typeof a === 'string' ? a : a.title}**`,
    `**When** ${typeof a === 'string' ? '이 스토리를 끝내면' : (a.when ?? '이 스토리를 끝내면')}`,
    `**Then** ${typeof a === 'string' ? a : (a.then ?? a.title)}`,
  ].join('\n')).join('\n\n')

  return [
    '---',
    `baseline_commit: ${baseline}`,
    '---',
    '',
    `# Story ${epic}.${num}: ${title}`,
    '',
    `Status: ${status}`,
    '',
    quoteBlock([
      `**${date} 자율 마무리 진단이 만든 ${kindLabel}(라운드 ${round}).**`,
      `${spec.purpose ?? '진단이 찾아낸 미완·결함을 BMAD 원장에 올린다'} — ${spec.userImpact ?? '사용자가 겪는 영향은 아래 근거를 본다'}.`,
      '**생성 근거(진단이 실제로 읽은 것)**:',
      ...evidence.map((e) => `> - ${typeof e === 'string' ? e : `${e.what ?? ''}${e.rank ? ` (증거 등급 ${e.rank})` : ''}`}`),
      evidence.length ? '' : '> - (근거 인용 없음 — 사람이 확인해야 한다)',
      '이 스토리는 사람이 쓴 것이 아니다. 범위·문구가 어긋나면 그대로 고쳐 쓰면 된다.',
    ]),
    '',
    '## Story',
    '',
    `As a ${spec.persona ?? '사용자'},`,
    `I want ${spec.want ?? title},`,
    `So that ${spec.soThat ?? (spec.purpose ?? '일이 끝난다')}.`,
    '',
    '## Acceptance Criteria',
    '',
    acBlock,
    '',
    '## Tasks / Subtasks',
    '',
    ...tasks.map((t, i) => `- [ ] Task ${i + 1} ${t}`),
    '',
    '### Review Findings',
    '',
    '(아직 리뷰 전 — 지적이 나오면 `- [ ] [Review][Patch] …` 형식으로 이 절에 적는다.)',
    '',
    '## Dev Notes',
    '',
    spec.devNotes ?? '진단이 만든 스토리다. 착수 전에 아래 References 의 근거를 먼저 읽는다.',
    '',
    '### References',
    '',
    `- \`${epicsPath}\` — Story ${epic}.${num}`,
    ...(spec.references ?? []).map((r) => `- ${r}`),
    '',
    '## Dev Agent Record',
    '',
    '### Agent Model Used',
    '',
    '(미착수)',
    '',
    '### Debug Log References',
    '',
    '(미착수)',
    '',
    '### Completion Notes List',
    '',
    '(미착수)',
    '',
    '### File List',
    '',
    '(미착수 — dev 라운드가 실제 변경 파일을 여기에 적는다)',
    '',
    '## Change Log',
    '',
    '| 날짜 | 변경 | 비고 |',
    '| --- | --- | --- |',
    `| ${date} | 스토리 생성(자율 마무리 진단 · 라운드 ${round}) | ${spec.changeNote ?? '진단 근거는 위 인용 블록'} |`,
    '',
  ].join('\n')
}

/**
 * 기존 스토리 `### Review Findings` 에 붙일 결함 블록.
 * ⚠️ 줄 형식은 jng-os 원장 그대로여야 한다 — `story-ledger.openFindings` 가 이 줄을 센다.
 * 열린 줄만 적는다(`- [x]` 는 이 모듈이 만들지 않는다 — 닫는 것은 회수한 dev 의 몫).
 */
export function renderDefectBlock(spec = {}) {
  const date = today(spec.now ?? spec.date)
  const round = spec.round ?? 0
  const findings = spec.findings ?? []
  const lines = findings.map((f) => {
    const tag = f.tag ?? (f.category === 'decision' ? 'Decision' : 'Patch')
    const sev = f.severity ? `[${f.severity}]` : ''
    const where = f.path ? ` [\`${norm(f.path)}${f.line ? `:${f.line}` : ''}\`]` : ''
    return `- [ ] [Review][${tag}]${sev} ${f.title ?? f.why ?? '제목 없음'}${f.why && f.title ? ` — ${f.why}` : ''}${where}`
  })
  return [
    `**자율 마무리 진단 — ${date} 라운드 ${round}** (근거: ${spec.source ?? '게이트 실행 + 코드·문서 대조'} · 자동 등재)`,
    '',
    ...(lines.length ? lines : ['- [ ] [Review][Patch] 진단이 지적을 만들지 못했다 — 사람이 확인한다']),
    '',
  ].join('\n')
}

/** epics.md 등재 절 — 실제 epics 형식(`### Story N.M:` + 근거 인용 + As/I want/So that + AC). */
export function renderEpicsEntry(spec = {}) {
  const epic = Number(spec.epic)
  const num = Number(spec.num)
  const date = today(spec.now ?? spec.date)
  const acceptance = (spec.acceptance ?? []).length ? spec.acceptance : ['완료 기준은 스토리 파일이 소유한다']
  return [
    '',
    `### Story ${epic}.${num}: ${spec.title ?? '이름 없는 스토리'}`,
    '',
    quoteBlock([
      `**${date} 자율 마무리 진단 신설(라운드 ${spec.round ?? 0}).** ${spec.why ?? '진단이 찾은 미완을 계획 문서에 올린다'}.`,
      ...(spec.evidence ?? []).slice(0, 4).map((e) => `> - 근거: ${typeof e === 'string' ? e : (e.what ?? '')}`),
    ]),
    '',
    `As a ${spec.persona ?? '사용자'},`,
    `I want ${spec.want ?? spec.title},`,
    `So that ${spec.soThat ?? (spec.purpose ?? '일이 끝난다')}.`,
    '',
    '**Acceptance Criteria:**',
    '',
    ...acceptance.flatMap((a) => [
      `**Given** ${typeof a === 'string' ? '이 스토리의 범위' : (a.given ?? '이 스토리의 범위')}`,
      `**When** ${typeof a === 'string' ? '끝내면' : (a.when ?? '끝내면')}`,
      `**Then** ${typeof a === 'string' ? a : (a.then ?? a.title)}`,
      '',
    ]),
  ].join('\n')
}

/** sprint-status.yaml 한 줄 — 2칸 들여쓰기 + 뒤 주석(파서가 읽는 형식 그대로). */
export function renderSprintEntry(key, status = 'backlog', note = '') {
  const n = String(note ?? '').replace(/\r?\n/g, ' ').trim()
  return `  ${key}: ${status}${n ? `  # ${n}` : ''}`
}

/**
 * 완료 기록(설계 §3-5) — `### Completion Notes List` 에 붙인다.
 * **qa 수치는 매니페스트 값을 그대로 옮긴다.** 매니페스트에 없으면 지어내지 않고 `NOT VERIFIED` 라고 적는다
 * (「215 files · 6,147 passed」 같은 숫자는 실행하지 않고는 쓸 수 없는 값이다).
 */
export function renderCompletionRecord(spec = {}) {
  const date = today(spec.now ?? spec.date)
  const round = spec.round ?? 0
  const m = spec.manifest ?? null
  const qa = m?.qa ?? null
  const checks = m?.checks ?? {}
  const NV = 'NOT VERIFIED'

  const qaLine = (() => {
    if (!m) return `${NV} — 검증 매니페스트가 없다(qa 를 실행한 기록이 없다)`
    const exit = qa?.exit ?? (checks.qa === 'pass' ? 0 : checks.qa === 'fail' ? 1 : null)
    if (exit === null || exit === undefined) return `${NV} — 매니페스트에 qa 결과가 없다`
    const nums = [
      qa?.files != null ? `${qa.files} files` : null,
      qa?.passed != null ? `${qa.passed} passed` : null,
      qa?.skipped != null ? `${qa.skipped} skipped` : null,
    ].filter(Boolean)
    return `qa exit ${exit}${nums.length ? ` (${nums.join(' / ')})` : ` — 통과 수치는 ${NV}(매니페스트에 없다)`}`
  })()

  const notVerified = uniq([
    ...(spec.notVerified ?? []),
    ...Object.entries(checks)
      .filter(([, v]) => typeof v === 'string' && /^(n\/a|not-run|unknown|required-missing)/.test(v))
      .map(([k, v]) => `${k}: ${v}`),
    ...(m ? [] : ['검증 매니페스트 없음']),
  ])

  const files = spec.files ?? {}
  const fileLine = ['신규', '수정', '문서'].map((k) => {
    const arr = files[k] ?? files[k === '신규' ? 'added' : k === '수정' ? 'changed' : 'docs'] ?? []
    return arr.length ? `${k} ${arr.length}` : null
  }).filter(Boolean).join(' · ') || `${NV} — 변경 파일 목록이 전달되지 않았다`

  const rev = m?.review ?? spec.review ?? null
  const dev = m?.workers?.dev ?? spec.dev ?? null
  const reviewLine = rev
    ? `${rev.provider ?? '?'}/${rev.model ?? '?'} (dev = ${dev?.provider ?? '?'}/${dev?.model ?? '?'}) · high ${rev.high ?? rev.findings?.high ?? NV}`
    : `${NV} — 교차 리뷰 기록이 없다`

  return [
    `**✅ ${date} 자율 마무리 라운드 ${round} 완주**`,
    '',
    `- **구현**: ${spec.summary ?? `${NV} — 요약이 전달되지 않았다`}`,
    `- **변경 파일**: ${fileLine}`,
    `- **테스트**: ${qaLine}`,
    `- **교차 리뷰**: ${reviewLine}`,
    `- **남은 위험**: ${(spec.risks ?? []).length ? spec.risks.join(' · ') : '없음(진단 기준)'}`,
    `- **commit/push**: ${spec.commit ?? 0} / ${spec.push ?? 0}`,
    '',
    `**${NV} (정직 표기)**`,
    '',
    ...(notVerified.length ? notVerified.map((x) => `- ${x}`) : ['- 없음']),
    '',
  ].join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ planBmadWrites — 순수 계획 (파일 접근 0)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {{mapping:object, snapshot:object, config?:object|null, texts?:object, now?:Date, round?:number,
 *          completions?:object[], inbox?:{block:string, fingerprints?:string[]}}} o
 * @returns {{schema, at, round, writes, guards, deferred, notes}} BmadWritePlan
 */
export function planBmadWrites({ mapping = {}, snapshot = null, config = null, texts = {}, now = new Date(), round = 0, completions = [], inbox = null } = {}) {
  const guards = { ...DEFAULT_GUARDS, ...(config?.autofinish?.guards ?? config?.guards ?? {}) }
  const P = snapshot?.paths ?? {}
  const implDir = P.impl ?? '_bmad-output/implementation-artifacts'
  const epicsPath = P.epics ?? '_bmad-output/planning-artifacts/epics.md'
  const sprintPath = `${implDir}/sprint-status.yaml`
  const inboxPath = P.inbox ?? `${implDir}/DECISIONS-INBOX.md`
  const date = today(now)
  const writes = []
  const deferred = []
  const notes = []

  const hashOf = (path, fallback = null) => (texts[path] !== undefined ? sha(texts[path]) : fallback)
  const sectionHashOf = (path, anchor, occurrence = 1) => {
    if (texts[path] === undefined) return null
    const body = sectionBody(texts[path], anchor, occurrence)
    return body === null ? null : sha(body)
  }

  // ── ① 기존 스토리에 지적 붙이기 ──────────────────────────────────────────
  for (const m of mapping.mapped ?? []) {
    const st = (snapshot?.stories ?? []).find((s) => s.key === m.key)
    if (!st?.exists) { deferred.push({ key: m.key, why: '스토리 md 가 없다 — 원장 줄을 붙일 자리가 없다' }); continue }
    if (texts[st.path] !== undefined && findHeadingLine(texts[st.path], '### Review Findings') < 0) {
      deferred.push({ key: m.key, why: '`### Review Findings` 절이 없다 — append-only 앵커 밖은 만들지 않는다' })
      continue
    }
    const item = m.item ?? {}
    writes.push({
      op: 'append-within-section',
      path: st.path,
      anchor: '### Review Findings',
      anchorOccurrence: 1,
      baseHash: hashOf(st.path, st.hash ?? null),
      sectionHash: sectionHashOf(st.path, '### Review Findings'),
      body: renderDefectBlock({
        now, round, source: item.why ?? '진단',
        findings: [{ title: item.title, why: item.purpose, severity: item.tier <= 2 ? 'high' : item.tier <= 4 ? 'medium' : 'low', path: (item.files ?? [])[0] ?? null, tag: item.storyLink === 'blocked' || item.state === 'blocked' ? 'Decision' : 'Patch' }],
      }),
      why: `${m.key} 원장에 진단 지적 등재`,
      group: `story:${m.key}`,
    })
  }

  // ── ② 새 스토리 / 결함 스토리 ────────────────────────────────────────────
  const created = [...(mapping.newStories ?? []), ...(mapping.defects ?? [])]
  const allowed = created.slice(0, Math.max(0, guards.maxNewStories))
  for (const over of created.slice(allowed.length)) {
    deferred.push({ key: over.key, why: `라운드당 신규 스토리 상한 ${guards.maxNewStories} 초과 — 다음 라운드로 미룬다` })
  }
  for (const rec of allowed) {
    const item = rec.item ?? {}
    const path = `${implDir}/${rec.key}.md`
    const group = `new:${rec.key}`
    writes.push({
      op: 'create-file', path, ifAbsent: true, group,
      why: `${rec.key} 스토리 파일 생성(${rec.kind})`,
      body: renderNewStory({
        epic: rec.epic, num: rec.num, title: rec.title, kind: rec.kind, now, round,
        baselineCommit: snapshot?.git?.head || 'unknown',
        purpose: item.purpose, userImpact: item.userImpact,
        acceptance: item.acceptance ?? [], tasks: item.tests?.length ? ['재현 테스트를 먼저 RED 로 만든다', ...item.tests.slice(0, 3).map((t) => `${t} 를 채운다`)] : undefined,
        evidence: (item.source?.findings ?? []).slice(0, 4).map((id) => `finding ${id}`),
        epicsPath, changeNote: rec.why,
      }),
    })
    if (rec.epicsEntry !== false) {
      const last = lastStoryAnchor(snapshot, rec.epic, texts[epicsPath])
      if (!last) {
        deferred.push({ key: rec.key, why: `epics.md 에서 에픽 ${rec.epic} 의 마지막 스토리 절을 찾지 못했다 — 등재를 미룬다` })
      } else {
        writes.push({
          op: 'append-within-section', path: epicsPath, anchor: last.anchor, anchorOccurrence: last.occurrence,
          baseHash: hashOf(epicsPath, null), sectionHash: sectionHashOf(epicsPath, last.anchor, last.occurrence),
          body: renderEpicsEntry({ epic: rec.epic, num: rec.num, title: rec.title, now, round, why: rec.why, purpose: item.purpose, acceptance: item.acceptance ?? [] }),
          why: `epics.md 에 Story ${rec.epic}.${rec.num} 등재`, group,
        })
      }
    }
    writes.push({
      op: 'upsert-sprint-key', path: sprintPath, key: rec.key, value: 'backlog',
      after: lastSprintKeyOfEpic(snapshot, rec.epic),
      comment: `${date} 자율 마무리 신설 — ${item.id ?? rec.kind}`,
      baseHash: hashOf(sprintPath, null),
      why: `sprint-status 에 ${rec.key} 등재`, group,
    })
  }

  // ── ③ 완료 기록 ──────────────────────────────────────────────────────────
  for (const c of completions ?? []) {
    const st = (snapshot?.stories ?? []).find((s) => s.key === c.story)
    if (!st?.exists) { deferred.push({ key: c.story, why: '완료 기록을 붙일 스토리 md 가 없다' }); continue }
    writes.push({
      op: 'append-within-section', path: st.path, anchor: '### Completion Notes List', anchorOccurrence: 1,
      baseHash: hashOf(st.path, st.hash ?? null), sectionHash: sectionHashOf(st.path, '### Completion Notes List'),
      body: renderCompletionRecord({ ...c, now, round }),
      why: `${c.story} 완료 기록`, group: `done:${c.story}`,
    })
  }

  // ── ④ 결정 인박스 ────────────────────────────────────────────────────────
  if (inbox?.block) {
    const led = snapshot?.ledgers?.inbox ?? {}
    if (led.exists === false) {
      writes.push({ op: 'create-file', path: inboxPath, ifAbsent: true, body: inbox.newFileBody ?? inbox.block, why: '결정 인박스 생성(부재)', group: 'inbox' })
    } else {
      const h1 = texts[inboxPath] !== undefined ? (String(texts[inboxPath]).split('\n')[0] ?? '') : '# 결정 인박스 (상시)'
      writes.push({
        op: 'insert-after-heading', path: inboxPath, anchor: h1.trim() || '# 결정 인박스 (상시)', anchorOccurrence: 1,
        baseHash: hashOf(inboxPath, led.hash ?? null), body: inbox.block,
        why: '결정 인박스 맨 앞에 질문 등재', group: 'inbox',
      })
    }
  }

  // ── 라운드 쓰기 상한 — 그룹 단위로 자른다(스토리 하나가 반만 등재되면 더 나쁘다) ──
  const capped = []
  const seenGroups = new Set()
  for (const w of writes) {
    const g = w.group ?? w.path
    if (capped.length >= guards.maxWritesPerRound && !seenGroups.has(g)) {
      deferred.push({ key: g, why: `라운드 쓰기 상한 ${guards.maxWritesPerRound} 초과 — 다음 라운드로 미룬다` })
      continue
    }
    seenGroups.add(g)
    capped.push(w)
  }
  if (capped.length !== writes.length) notes.push(`쓰기 ${writes.length}건 중 ${capped.length}건만 이번 라운드에 적용한다`)

  return {
    schema: BMAD_PLAN_SCHEMA,
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
    round,
    writes: capped,
    guards,
    deferred,
    notes,
  }
}

/** 그 에픽의 **마지막** `### Story N.M:` 헤더(등재 자리). epics 본문이 있으면 등장 순번까지 준다. */
function lastStoryAnchor(snapshot, epic, epicsText) {
  const mine = (snapshot?.epicStories ?? []).filter((s) => Number(s.epic) === Number(epic))
  if (mine.length === 0) return null
  const last = mine[mine.length - 1]
  const anchor = `### Story ${last.epic}.${last.num}:`
  if (epicsText === undefined) return { anchor, occurrence: 1 }
  const lines = String(epicsText).split('\n')
  let occ = 0
  for (const l of lines) if (l.startsWith(anchor)) occ++
  return { anchor, occurrence: occ > 1 ? -1 : 1 }
}

/** 그 에픽의 마지막 sprint 키(그 줄 다음에 새 줄을 끼운다). */
function lastSprintKeyOfEpic(snapshot, epic) {
  const mine = (snapshot?.sprint ?? []).filter((r) => Number(r.epic) === Number(epic))
  return mine.length ? mine[mine.length - 1].key : null
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ applyBmadWrites — **유일한 쓰기 IO**
// ═══════════════════════════════════════════════════════════════════════════

/** 원문의 줄이 사라지지 않았는가(append-only 보증). 허용 유실 수를 넘으면 거부한다. */
export function lineLoss(before, after) {
  const bag = new Map()
  for (const l of String(after).split('\n')) bag.set(l, (bag.get(l) ?? 0) + 1)
  let lost = 0
  for (const l of String(before).split('\n')) {
    const n = bag.get(l) ?? 0
    if (n > 0) bag.set(l, n - 1)
    else lost++
  }
  return lost
}

const statusLine = (text) => /^Status:.*$/m.exec(String(text ?? ''))?.[0] ?? null

/** 계획 1건을 텍스트에 적용 — 순수(문자열 → 문자열). 실패는 `{ok:false, why}`. */
export function applyWriteToText(write, before) {
  const nl = eol(before ?? '\n')
  const op = write.op
  if (op === 'create-file') {
    if (before !== null && write.ifAbsent) return { ok: true, skip: true, why: '이미 있다(ifAbsent)' }
    if (before !== null) return { ok: false, why: '같은 경로에 파일이 이미 있다 — 덮어쓰지 않는다' }
    return { ok: true, text: withEol(write.body, '\n') }
  }
  const text = String(before ?? '')
  if (op === 'upsert-sprint-key') {
    const r = setSprintStatus(text, write.key, write.value)
    if (r.changed) return { ok: true, text: r.text, maxLoss: 1 }
    // 없는 키 — `after` 줄 다음에 새 줄을 끼운다(재직렬화 금지 · 주석 무손실)
    const lines = text.split(/\r?\n/)
    const line = renderSprintEntry(write.key, write.value, write.comment ?? '')
    let at = -1
    if (write.after) at = lines.findIndex((l) => new RegExp(`^ {2}${write.after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(l))
    if (at < 0) at = lines.findIndex((l) => /^development_status:/.test(l))
    if (at < 0) return { ok: false, why: 'sprint-status 에 development_status 절이 없다' }
    lines.splice(at + 1, 0, line)
    return { ok: true, text: lines.join(nl) }
  }
  const at = findHeadingLine(text, write.anchor, write.anchorOccurrence ?? 1)
  if (at < 0) return { ok: false, why: `앵커를 찾지 못했다: ${write.anchor}` }
  const lines = text.split(/\r?\n/)
  const body = withEol(String(write.body).replace(/\s+$/, ''), nl).split(nl)
  if (op === 'insert-after-heading') {
    lines.splice(at + 1, 0, '', ...body)
    return { ok: true, text: lines.join(nl) }
  }
  if (op === 'append-within-section') {
    const [, end] = sectionRange(text, at)
    let e = end
    while (e > at + 1 && (lines[e - 1] ?? '').trim() === '') e-- // 절 끝 빈 줄 앞에 붙인다
    lines.splice(e, 0, '', ...body)
    return { ok: true, text: lines.join(nl) }
  }
  return { ok: false, why: `알 수 없는 op: ${op}` }
}

/**
 * 계획을 실제 파일에 적용한다. **부분 적용 0**:
 *  ① 전 계획을 메모리에서 계산하며 경로·앵커·해시를 전부 검사하고
 *  ② 하나라도 어긋나면 아무것도 쓰지 않고 폐기하며
 *  ③ 쓰기 단계에서 실패해도 이미 쓴 파일을 원문으로 되돌린다.
 * @param {object} plan planBmadWrites 결과
 * @param {{root:string, now?:Date, fs?:object, guards?:object}} o
 * @returns {{schema,applied,skipped,conflicts,rejected,rolledBack,wrote}}
 */
export function applyBmadWrites(plan, { root, now = new Date(), fs = nodeFs, guards = null } = {}) {
  const G = { ...DEFAULT_GUARDS, ...(plan?.guards ?? {}), ...(guards ?? {}) }
  const applied = []
  const skipped = []
  const conflicts = []
  const rejected = []
  // 폐기는 언제나 **전체**다 — 부분 적용을 남기지 않는다. `rolledBack:true` 는 「이 계획은 하나도 안 들어갔다」는 뜻.
  const abort = (wrote = []) => ({ schema: BMAD_APPLY_SCHEMA, at: (now instanceof Date ? now : new Date(now)).toISOString(), applied: [], skipped, conflicts, rejected, rolledBack: true, wrote })

  const originals = new Map() // path → 원문(없으면 null)
  const staged = new Map() // path → 현재 계산본
  const readNow = (rel) => {
    const abs = join(root, rel)
    try { return fs.readFileSync(abs, 'utf8') } catch { return null }
  }

  // ── 1) 전 계획 계산 + 검사 ────────────────────────────────────────────────
  for (const w of plan?.writes ?? []) {
    if (!WRITE_OPS.includes(w.op)) { rejected.push({ path: w.path ?? null, why: `허용되지 않은 op: ${w.op}` }); return abort() }
    // 문자열 규칙 + **실경로** 규칙을 모두 통과해야 쓴다(M3) — 링크로 허용 폴더를 빠져나가는 길을 막는다.
    const pa = realPathAllowed(root, w.path, { prefixes: G.allowedPathPrefixes, fs })
    if (!pa.ok) { rejected.push({ path: w.path ?? null, why: `${pa.why} — 계획 전체를 폐기한다` }); return abort() }
    const aa = anchorAllowed(w.op, w.anchor ?? '')
    if (w.anchor !== undefined && !aa.ok) { rejected.push({ path: w.path, why: aa.why }); return abort() }

    const rel = norm(w.path)
    if (!originals.has(rel)) originals.set(rel, readNow(rel))
    const original = originals.get(rel)
    const current = staged.has(rel) ? staged.get(rel) : original

    // baseHash 는 **원문** 기준(같은 파일에 두 번 쓰더라도 계획이 본 원문과 비교한다)
    if (w.baseHash) {
      const actual = original === null ? null : sha(original)
      if (actual !== w.baseHash) {
        conflicts.push({ path: rel, expected: w.baseHash, actual, why: '계획을 세운 뒤 파일이 바뀌었다 — 사람 변경을 덮지 않기 위해 전체 계획을 폐기한다' })
        return abort()
      }
    }
    if (w.sectionHash && original !== null) {
      const body = sectionBody(original, w.anchor, w.anchorOccurrence ?? 1)
      const actual = body === null ? null : sha(body)
      if (actual !== w.sectionHash) {
        conflicts.push({ path: rel, expected: w.sectionHash, actual, section: w.anchor, why: '그 절이 계획 이후 바뀌었다 — 전체 계획을 폐기한다' })
        return abort()
      }
    }

    const r = applyWriteToText(w, current)
    if (!r.ok) { conflicts.push({ path: rel, expected: w.anchor ?? w.key ?? null, actual: null, why: r.why }); return abort() }
    if (r.skip) { skipped.push({ path: rel, op: w.op, why: r.why }); continue }

    if (current !== null) {
      const lost = lineLoss(current, r.text)
      const maxLoss = r.maxLoss ?? 0
      if (lost > maxLoss) { rejected.push({ path: rel, why: `원문 ${lost}줄이 사라진다(허용 ${maxLoss}) — 덮어쓰기로 판단해 폐기한다` }); return abort() }
      const sb = statusLine(current)
      if (sb && statusLine(r.text) !== sb) { rejected.push({ path: rel, why: 'Status 줄이 바뀐다 — 상태 전이는 setStoryStatus 만 한다' }); return abort() }
    }
    staged.set(rel, r.text)
    applied.push({ path: rel, op: w.op, why: w.why ?? '', bytes: r.text.length })
  }

  // ── 2) 쓰기(tmp → rename) · 실패 시 되돌리기 ──────────────────────────────
  const wrote = []
  try {
    for (const [rel, text] of staged) {
      const abs = join(root, rel)
      fs.mkdirSync(dirname(abs), { recursive: true })
      const tmp = `${abs}.tmp`
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, abs)
      wrote.push(rel)
    }
  } catch (err) {
    for (const rel of wrote) {
      const abs = join(root, rel)
      const orig = originals.get(rel)
      try { if (orig === null) fs.rmSync(abs, { force: true }); else fs.writeFileSync(abs, orig, 'utf8') } catch { /* 되돌리기 실패는 아래 why 에 남는다 */ }
    }
    rejected.push({ path: wrote[wrote.length - 1] ?? null, why: `쓰기 실패 — 이미 쓴 ${wrote.length}건을 되돌렸다: ${String(err?.message ?? err).slice(0, 200)}` })
    return abort(wrote)
  }

  return { schema: BMAD_APPLY_SCHEMA, at: (now instanceof Date ? now : new Date(now)).toISOString(), applied, skipped, conflicts, rejected, rolledBack: false, wrote }
}

/** 계획에 필요한 원문을 읽어 온다(읽기 전용 · planBmadWrites 의 `texts` 인자용). */
export function collectTexts(root, paths = [], { fs = nodeFs } = {}) {
  const out = {}
  for (const p of uniq(paths.filter(Boolean).map(norm))) {
    try { out[p] = fs.readFileSync(join(root, p), 'utf8') } catch { /* 없는 파일은 넣지 않는다 */ }
  }
  return out
}

export { setStoryStatus }
