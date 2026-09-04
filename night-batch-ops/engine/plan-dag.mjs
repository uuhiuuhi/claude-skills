// 계획 DAG + 결정적 검증기 — 2026-09-02 「9점대 하네스」
//
// 왜 있나: 편성기(plan-queue)는 규칙 10종을 **순서대로** 적용해 큐를 만들 뿐, 만들어진 큐가
// 스스로 모순인지(선행이 안 끝났는데 뒤 스토리를 넣었다 · 같은 배치 두 스토리가 같은 파일을
// 만진다 · 지어낸 스토리 키 · 셸 메타문자가 섞인 모델 스펙)를 **다시 확인하지 않았다**.
// 계획을 사람이 아닌 LLM(Fable 오케스트레이터)이 만들기 시작하면 그 확인이 필수다 —
// 검증기는 LLM 계획과 규칙 계획을 **같은 잣대로** 본다(자기 큐도 이 검증을 통과해야 한다).
//
// 이 파일의 모든 함수는 순수·결정적이다(같은 입력 → 같은 출력 · 파일·시계·난수 없음).

import { parallelHazardsExtended } from './conflicts.mjs'

// ── 모델 스펙 ─────────────────────────────────────────────────────────────
/** 허용 = `opus` · `fable` · `codex` · `codex:gpt-5.6-sol` · `claude:opus`. 그 외 문자는 전부 거부.
 *  왜 이렇게 좁히나: 이 값은 결국 자식 프로세스의 argv 로 간다 — 공백·따옴표·`;`·`$(`·`&` 같은
 *  셸 메타문자가 섞이면 실행 경로(특히 Windows `.cmd` 심)에서 명령이 갈라질 수 있다. */
export const MODEL_SPEC_RE = /^(?:(?:claude|codex):)?[A-Za-z0-9][A-Za-z0-9._-]*$/
/** 단계 이름 화이트리스트 — 엔진(auto-story-pipeline)과 같은 5종. mockup(AI 목업 초안)·replan(시니어 재계획)은
 *  자율운전(2026-09-03)에서 추가됐다. 계획 검증기·오케스트레이터 스키마가 같은 목록을 본다. */
export const STAGE_NAMES = Object.freeze(['create', 'mockup', 'replan', 'dev', 'review'])
export function isValidModelSpec(spec) {
  const s = String(spec ?? '')
  if (!s || s !== s.trim()) return false
  if (s.length > 64) return false
  if (/[^A-Za-z0-9._:-]/.test(s)) return false // 공백·메타문자 전부 거부(화이트리스트)
  if ((s.match(/:/g) ?? []).length > 1) return false
  return MODEL_SPEC_RE.test(s)
}

// ── 의존 표기 파싱 ─────────────────────────────────────────────────────────
/** 스토리 md 의 선행 표기. **줄머리 라벨만** 인정한다 — 본문에 「선행」이 스쳐도 의존으로
 *  읽으면 멀쩡한 스토리가 편성에서 통째로 빠진다(2026-08-31 부분 문자열 오탐 계열). */
const DEP_LINE_RE = /^[ \t>*+_-]*(?:선행(?:\s*(?:조건|스토리))?|depends[-\s]?on)[*_]{0,2}\s*[:：]\s*(.+)$/gim
const KEY_IN_TEXT_RE = /(\d+)[-.](\d+)/g

/** "선행: 2.1, 11-3" → ['2-1','11-3'] (짧은 키 = epic-번호). 없으면 []. */
export function parseDependsOn(md) {
  const text = String(md ?? '')
  const out = []
  DEP_LINE_RE.lastIndex = 0
  for (const m of text.matchAll(DEP_LINE_RE)) {
    const body = m[1]
    if (/없음|none|N\/A/i.test(body)) continue
    for (const k of body.matchAll(KEY_IN_TEXT_RE)) out.push(`${k[1]}-${k[2]}`)
  }
  return [...new Set(out)]
}

/** 스토리 키(2-16-b) → 짧은 키(2-16) */
export const shortKey = (key) => String(key ?? '').split('-').slice(0, 2).join('-')
const storyNum = (key) => Number(String(key ?? '').split('-')[1]) || 0

// ── DAG ───────────────────────────────────────────────────────────────────
/**
 * 편성 후보로 DAG 를 만든다.
 * stories = [{ key, epic, kind, files[], deps[](선행 짧은키) }]
 * 간선의 출처 3종: ① 스토리 md 의 선행 표기 ② 같은 파일(File List 겹침) ③ 같은 에픽의 신규 순서.
 * 반환 { nodes, edges, order(위상), cycles, byKey } — 전부 결정적 정렬.
 */
export function buildDag({ stories = [], epicOrder = [] } = {}) {
  const rank = (s) => {
    const e = epicOrder.indexOf(s.epic)
    return [e < 0 ? 999 : e, storyNum(s.key), String(s.key)]
  }
  const cmp = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0)
  }
  const nodes = [...stories].map((s) => ({
    key: String(s.key),
    epic: s.epic ?? null,
    kind: s.kind ?? 'new',
    files: [...(s.files ?? [])].map(String),
    deps: [...new Set((s.deps ?? []).map(String))],
    unresolvedDeps: [],
  })).sort(cmp)
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const byShort = new Map()
  for (const n of nodes) if (!byShort.has(shortKey(n.key))) byShort.set(shortKey(n.key), n.key)

  const edges = []
  const push = (from, to, why) => {
    if (from === to) return
    if (edges.some((e) => e.from === from && e.to === to && e.why === why)) return
    edges.push({ from, to, why })
  }

  // ① 선행 표기 — 후보 안에 있으면 간선, 없으면 unresolvedDeps(검증기가 done 여부로 판정)
  for (const n of nodes) {
    for (const d of n.deps) {
      const target = byShort.get(d) ?? (byKey.has(d) ? d : null)
      if (target) push(target, n.key, '선행 표기')
      else n.unresolvedDeps.push(d)
    }
  }
  // ② 같은 파일 — 앞선 순위가 먼저(자동 뭉개기 금지 · 순차화의 근거)
  const owners = new Map()
  for (const n of nodes) for (const f of n.files) {
    const list = owners.get(f) ?? []
    list.push(n.key)
    owners.set(f, list)
  }
  for (const f of [...owners.keys()].sort()) {
    const list = owners.get(f)
    for (let i = 1; i < list.length; i++) push(list[i - 1], list[i], `같은 파일(${f})`)
  }
  // ③ 같은 에픽의 신규 착수는 번호 순서(선행 스키마 스토리가 뒤로 가지 않게)
  const byEpic = new Map()
  for (const n of nodes) {
    if (n.kind !== 'new') continue
    const list = byEpic.get(n.epic) ?? []
    list.push(n)
    byEpic.set(n.epic, list)
  }
  for (const list of byEpic.values()) for (let i = 1; i < list.length; i++) push(list[i - 1].key, list[i].key, '같은 에픽 순서')

  // 위상 정렬(Kahn · 준비 목록은 rank 순 = 결정적)
  const indeg = new Map(nodes.map((n) => [n.key, 0]))
  for (const e of edges) if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1)
  const ready = nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key)
  const order = []
  while (ready.length) {
    ready.sort((a, b) => cmp(byKey.get(a), byKey.get(b)))
    const k = ready.shift()
    order.push(k)
    for (const e of edges) {
      if (e.from !== k || !indeg.has(e.to)) continue
      indeg.set(e.to, indeg.get(e.to) - 1)
      if (indeg.get(e.to) === 0) ready.push(e.to)
    }
  }
  const cycles = nodes.map((n) => n.key).filter((k) => !order.includes(k)).sort()
  return { nodes, edges, order, cycles, byKey }
}

// ── 검증기 ────────────────────────────────────────────────────────────────
const E = (code, key, msg) => ({ code, key: key ?? null, msg })

/**
 * 계획 검증(결정적) — 규칙 계획이든 LLM 계획이든 **같은 잣대**.
 * plan        = { batches: [{ stories[], stages[], models{} }] }
 * dag         = buildDag(...) 결과
 * constraints = {
 *    knownKeys[]      스프린트에 실재하는 스토리 키(없으면 검사 생략)
 *    doneKeys[]       done 인 키(선행 해소 판정)
 *    epicOrder[]      · currentEpic · parallelAllow{짧은키: 에픽}
 *    cap {limit, plannedToday[]}   하루 상한(고유 스토리 단위 · 재편성 무과금)
 *    streakSpent[]    규칙 9 무진전 상한 소진 키
 *    blocked{key:why} 사람 게이트·결정 대기로 봉쇄된 키
 *    batchMax         한 배치 최대 스토리 수(기본 6)
 * }
 * 반환 { ok, errors[], warnings[] } — errors[].key 가 있으면 호출부가 그 스토리만 뺄 수 있다.
 */
export function validatePlan(plan, dag = { nodes: [], edges: [], cycles: [], byKey: new Map() }, constraints = {}) {
  const errors = []
  const warnings = []
  const batches = Array.isArray(plan?.batches) ? plan.batches : []
  const known = constraints.knownKeys ? new Set(constraints.knownKeys.map(String)) : null
  const done = new Set((constraints.doneKeys ?? []).map(String))
  const blocked = constraints.blocked ?? {}
  const streakSpent = new Set((constraints.streakSpent ?? []).map(String))
  const batchMax = Number(constraints.batchMax) || 6
  const byKey = dag?.byKey ?? new Map()

  // ① 사이클 — 순서를 못 정하는 계획은 실행할 수 없다
  for (const k of dag?.cycles ?? []) errors.push(E('cycle', k, '의존 사이클에 속한다 — 위상 순서를 정할 수 없다'))

  // 배치 순서대로 스토리를 훑는다(선행 해소 판정에 순서가 필요하다)
  const seen = new Map() // key → 배치 index
  batches.forEach((b, bi) => {
    const stories = (b?.stories ?? []).map(String)
    if (stories.length === 0) errors.push(E('empty-batch', null, `배치 ${bi + 1} 에 스토리가 없다`))
    if (stories.length > batchMax) errors.push(E('batch-size', stories[0] ?? null, `배치 ${bi + 1} 이 ${stories.length}스토리 — 상한 ${batchMax} 초과`))
    for (const k of stories) {
      if (seen.has(k)) errors.push(E('duplicate', k, `배치 ${seen.get(k) + 1}·${bi + 1} 에 중복 편성됐다`))
      else seen.set(k, bi)
    }
    // ⑥ 모델 스펙 형식
    const models = b?.models ?? {}
    for (const [stage, spec] of Object.entries(models)) {
      if (spec === undefined || spec === null || spec === '') continue
      if (!isValidModelSpec(spec)) errors.push(E('model-spec', stories[0] ?? null, `배치 ${bi + 1} 의 ${stage} 모델 스펙이 형식 위반이다: ${JSON.stringify(spec)}`))
    }
    // 단계 이름
    for (const s of b?.stages ?? []) {
      if (!STAGE_NAMES.includes(s)) errors.push(E('stage', stories[0] ?? null, `배치 ${bi + 1} 에 알 수 없는 단계 '${s}'`))
    }
    // ④ 같은 배치 안 충돌 — File List 겹침 + 범주별 위험(마이그레이션·스키마·계약·설정·테스트 환경)
    //    review 전용 배치(마감 재검수 · dev 없음)는 코드를 쓰지 않으므로 겹침이 병렬을 깨지 않는다 — 검사 생략(👤 2026-09-04).
    const writesCode = !Array.isArray(b?.stages) || b.stages.includes('dev')
    if (stories.length >= 2 && writesCode) {
      const lists = stories.map((k) => byKey.get(k)?.files ?? [])
      const hz = parallelHazardsExtended(lists, constraints.hazardOpts ?? {})
      if (!hz.parallelOk) {
        for (const r of hz.reasons) {
          const owner = stories[(r.stories?.[1] ?? r.stories?.[0] ?? 1) - 1] ?? stories[0]
          errors.push(E('batch-conflict', owner, `배치 ${bi + 1} 병렬 불가 — ${r.why}(순차화 필요)`))
        }
      }
    }
  })

  for (const [key, bi] of seen) {
    // ⑤ 존재하지 않는 스토리 키
    if (known && !known.has(key)) { errors.push(E('unknown-story', key, '스프린트에 없는 스토리 키다(지어냈거나 오타)')); continue }
    // ③ 사람 게이트·규칙 9
    if (blocked[key]) errors.push(E('blocked', key, `봉쇄된 스토리다 — ${blocked[key]}`))
    if (streakSpent.has(key)) errors.push(E('streak', key, '무진전 편성 상한 소진(규칙 9 v2) — 사람 판단 대상'))
    // ③ 에픽 순서(규칙 1) — 신규 착수만 에픽 도달을 기다린다
    const node = byKey.get(key)
    const epicOrder = constraints.epicOrder ?? []
    if (epicOrder.length && node && !epicOrder.includes(node.epic)) errors.push(E('epic-range', key, `에픽 ${node.epic} 은 목표 범위 밖(규칙 1 — epicOrder)`))
    else if (node?.kind === 'new' && constraints.currentEpic != null && node.epic !== constraints.currentEpic) {
      const allow = (constraints.parallelAllow ?? {})[shortKey(key)] === constraints.currentEpic
      if (!allow) errors.push(E('epic-order', key, `신규 착수인데 에픽 ${node.epic} 이 진행 에픽(${constraints.currentEpic}) 이 아니다(규칙 1)`))
    }
    // ② 미해결 선행
    const deps = [...(node?.deps ?? [])]
    for (const d of deps) {
      const target = [...byKey.keys()].find((k) => k === d || shortKey(k) === d)
      if (target) {
        const tb = seen.get(target)
        if (tb === undefined) { if (!done.has(target)) errors.push(E('unresolved-dep', key, `선행 ${d} 이 done 이 아닌데 편성됐다`)) }
        else if (tb > bi) errors.push(E('dep-order', key, `선행 ${d} 이 뒤 배치(${tb + 1})에 있다 — 순서 역전`))
        else warnings.push({ code: 'dep-same-plan', key, msg: `선행 ${d} 을 같은 계획에서 먼저 돌린다(배치 ${tb + 1})` })
        continue
      }
      const doneMatch = [...done].some((k) => k === d || shortKey(k) === d)
      if (!doneMatch) errors.push(E('unresolved-dep', key, `선행 ${d} 이 done 이 아닌데 편성됐다`))
    }
  }

  // ③ 하루 상한(고유 스토리 단위 · 오늘 이미 편성된 키는 무과금)
  const cap = constraints.cap
  if (cap && Number.isFinite(Number(cap.limit))) {
    const already = new Set((cap.plannedToday ?? []).map(String))
    const fresh = [...seen.keys()].filter((k) => !already.has(k))
    const room = Math.max(0, Number(cap.limit) - already.size)
    if (fresh.length > room) {
      for (const k of fresh.slice(room)) errors.push(E('daily-cap', k, `하루 상한 ${cap.limit} 초과(오늘 고유 ${already.size} + 신규 ${fresh.length} — 규칙 7)`))
    }
  }

  errors.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0))
  return { ok: errors.length === 0, errors, warnings }
}
