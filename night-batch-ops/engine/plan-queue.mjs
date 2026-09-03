#!/usr/bin/env node
// 큐 자동 편성기 — 「다음 할 일」을 규칙만으로 고른다. LLM 호출 0.
// 이식판: 프로젝트 고유값(에픽 순서·병행 허용·하루 상한·목업 게이트·상태 폴더)은 전부
// `tools/auto/auto.config.json` 이 소유한다 — 이 파일에는 프로젝트 이름이 없다.
// 모델만 예외다: `cfg.models` 가 있으면 그것이 이기고, **없으면 이 파일의 종류별 교차검증
// 기본값**(신규 dev=fable/review=opus · 회수 dev=opus/review=fable · 마감 재검수 review=opus)을
// 쓴다 — 「전부 config 소유」가 아니다. 기본값을 원치 않으면 cfg.models 로 덮어쓴다.
//
// 실행:
//   node tools/auto/plan-queue.mjs --out <큐파일> [--state <디렉터리>] [--max N] [--dry]
//
// 출력 큐는 night-queue.json 과 같은 스키마 + { planned: 'auto', _편성: {…근거} }.
// 규칙 10종이 전부다 — 여기 없는 판단은 하지 않는다.
//
// 무정지 개편분: ① 규칙 9 v2 — 반복 편성 상한이 「평생 N회」가 아니라 **무진전 연속 N회**다
// (진전이 있으면 0 으로 리셋 · 마감 재검수 1회 · 그 외 2회). ② 체인 게이트 — 미머지 체인이
// 길면 신규 착수만 보류한다. ③ /extend 연장분을 상한에 읽기 전용으로 가산한다.
// ②·③ 의 재료 파일은 러너·원격 명령 처리기가 쓰고, 편성기는 읽기만 한다(단일 작성자 원칙).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
// 네임스페이스로 받는다 — 체인 게이트 상수는 러너 규칙이 SoT 이지만, 그 상수가 없는
// 구버전 runner-rules 와 섞여도 편성기가 링크 단계에서 죽지 않아야 한다(무정지 원칙).
import * as RULES from './runner-rules.mjs'
// 원장(Markdown) 해석은 **단일 소스**다 — 2026-09-01 P0-a. 편성기·가드·현황판·브리핑이
// 각자 문장을 해석하다 표기 흔들림(굵게 · 👤 인용 · 부정문)으로 오판이 반복됐다.
// 해석 규칙을 고칠 일이 있으면 story-ledger.mjs 한 곳만 고친다. 종전 소비자 호환을 위해 재수출한다.
import {
  MOCKUP_GATE_DEFAULT, openFindings, isHumanGateLine,
  readStorySignals, parseSprint, epicSection, mockupGateOk, mockupEntries,
} from './story-ledger.mjs'
// 계획 DAG·검증기(9점대 하네스 · 2026-09-02): 편성기가 만든 큐도 **자기 검증**을 통과해야 한다.
// LLM 계획(orchestrate.mjs)과 같은 잣대로 본다 — 검증기가 규칙 계획만 봐주면 잣대가 아니다.
import { buildDag, parseDependsOn, validatePlan } from './plan-dag.mjs'
// 짝짓기 단계에서 확장 충돌 판정(테스트 환경·마이그레이션·계약·공유 설정)을 **미리** 본다 — 검증기가 나중에 걸면
// 걸린 스토리가 이번 라운드에서 통째로 빠진다(2026-09-04 실측: 자율 편성 53건 중 3건이 「배치 병렬 불가」로 탈락).
import { parallelHazardsExtended } from './conflicts.mjs'
// 모델 배정은 홀짝이 아니라 **점수**(난이도·위험도·가용성·최근 실패)로 한다.
import { ASSIGN_HISTORY_FILE, assignBatchModels, parseHistory } from './assign.mjs'
export {
  MOCKUP_GATE_DEFAULT, openFindings, isHumanGateLine,
  readStorySignals, parseSprint, epicSection, mockupGateOk,
}

/** 주간 한도가 소진된 모델 — 프로젝트가 `auto.config.json` 의 `exhaustedModels` 로 소유한다.
 *  기본은 빈 목록이다: 남의 프로젝트에 이번 주 우리 사정이 하드코딩되면 안 된다. */
export const MODEL_SUBSTITUTE = 'opus'   // 「모든 모델」 한도를 쓰는 상위 모델
export const MODEL_SUBSTITUTE_2 = 'sonnet' // 1순위가 상대 단계와 겹칠 때의 2순위(교차검증 유지)
export const avoidExhausted = (model, exhausted = []) =>
  typeof model === 'string' && exhausted.includes(model) ? MODEL_SUBSTITUTE : model
/** 배정 **짝**을 소진 회피로 바꾼다 — ⚠️ 단계별로 따로 바꾸면 `dev === review` 가 되어
 *  교차검증(dev ≠ review 항상)이 깨진다. 상대가 이미 1순위를 쓰면 2순위로 내린다. */
export const avoidExhaustedPair = (models, exhausted = []) => {
  if (!models || exhausted.length === 0) return models
  const out = { ...models }
  for (const stage of ['dev', 'review']) {
    if (!exhausted.includes(out[stage])) continue
    const other = stage === 'dev' ? out.review : out.dev
    out[stage] = other === MODEL_SUBSTITUTE ? MODEL_SUBSTITUTE_2 : MODEL_SUBSTITUTE
  }
  return out
}

const { SHARED_BOOKKEEPING } = RULES
/** 미머지 체인 나이 상한(일) — 러너 규칙이 SoT. 여기 값은 구버전 폴백용 사본일 뿐이다. */
const CHAIN_MAX_AGE_DAYS = RULES.CHAIN_MAX_AGE_DAYS ?? 2
/** 체인 게이트 판정은 규칙 함수를 그대로 쓴다(비교식을 편성기에 복제하지 않는다).
 *  구버전 runner-rules 에 함수가 없을 때만 같은 뜻의 폴백을 쓴다 — 링크 단계에서 죽지 않기 위해서다. */
const allowNewUnderChain = RULES.allowNewUnderChain ?? ((ageDays) => (ageDays ?? 0) < CHAIN_MAX_AGE_DAYS)

/** 프로젝트 설정 — 없으면 빈 객체(호출부가 필수값 부재를 판정한다) */
export function loadConfig(root) {
  const p = join(root, 'tools', 'auto', 'auto.config.json')
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {} } catch { return {} }
}

export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
// 부수 상태 파일(상한 연장·체인 정보)은 다른 프로세스가 쓴다 — 반쯤 쓰인 파일 하나가
// 편성기를 통째로 세우면 무정지가 아니다. 깨졌으면 「없음」으로 보고 계속한다.
const readJson = (p) => { try { return JSON.parse(readIf(p) ?? '{}') } catch { return {} } }

export function plan({ root, stateDir, max, today = todayStr(), config }) {
  const cfg = config ?? loadConfig(root)
  const EPIC_ORDER = cfg.epicOrder
  if (!Array.isArray(EPIC_ORDER) || EPIC_ORDER.length === 0) {
    throw new Error('auto.config.json 의 epicOrder 가 비어 있다 — 편성 불가(프로젝트의 에픽 우선순위는 사람이 정한다)')
  }
  const PARALLEL_ALLOW = cfg.parallelAllow ?? {} // 예: { "<스토리키>": <에픽번호> } — 그 에픽이 진행 중이어도 후보로 두는 예외
  // ── 자율운전(full) — 2026-09-03 👤 「판단을 사람에게 넘기는 기준 전부 삭제 · 시니어 기획자 수준 24시간」 ──
  // guarded(기본 · 종전) 는 아래 규칙 1~10 그대로다. full 은 「되돌릴 수 없는 실행」만 사람 몫으로 남기고
  // 결정·회수 라운드 개방·재투입 금지·무진전·체인·상한·목업 승인을 전부 편성 안에서 푼다(replan/mockup 단계).
  const AUTO = cfg.autonomy?.mode === 'full'
  const autoCfg = { maxReplansPerStory: 2, epicScope: 'all', mockups: 'ai-draft', ...(cfg.autonomy ?? {}) }
  const humanGates = [] // { key, type: 'question'|'gate'|'post-hoc', text } — 「내가 할 일 뭐야」 재료
  // 상한은 페이스가 아니라 폭주 방지 백스톱이다 — 몫을 다 했다고 남은 슬롯이 쉬면 안 된다
  // (실사고: 상한 12 시절, 오전에 12건 소진 후 남은 슬롯이 통째로 놀았다). 실질 제동은
  // STOP 차단기·결정 대기 제외·사용량 한도 대기·리뷰 게이트가 맡는다.
  const capBase = max ?? (AUTO && !(Number(cfg.dailyCap) > 0) ? Infinity : (cfg.dailyCap ?? 30)) // full: 0/없음 = 무제한
  const models = cfg.models ?? null // 예: { dev: 'fable', review: 'opus' } — 없으면 CLI 기본 모델
  // 주간 한도가 소진된 모델 — 배정 단계에서 미리 피한다(엔진 프로브가 헛돌지 않게).
  // 프로젝트 사정이라 config 소유이고 기본은 빈 목록이다.
  const exhausted = Array.isArray(cfg.exhaustedModels) ? cfg.exhaustedModels : []

  // 목업 게이트(규칙 6) 재료 — 경로·문구·규칙 ID 는 전부 config 소유(기본값 병합)
  const gateCfg = { ...MOCKUP_GATE_DEFAULT, ...(cfg.mockupGate ?? {}) }
  const gateNotes = []
  if (!gateCfg.marker) gateNotes.push('목업 게이트 미구성 — cfg.mockupGate.marker 가 비어 규칙 6 을 적용하지 않았다(새 화면 스토리도 통과)')

  const ART = join(root, '_bmad-output', 'implementation-artifacts')
  const sprintText = readIf(join(ART, 'sprint-status.yaml'))
  const epicsText = readIf(join(root, '_bmad-output', 'planning-artifacts', 'epics.md')) ?? ''
  const inboxText = readIf(join(ART, 'DECISIONS-INBOX.md')) ?? ''
  const verdictsPath = String(gateCfg.verdictsPath ?? MOCKUP_GATE_DEFAULT.verdictsPath).split(/[/\\]+/).filter(Boolean)
  const verdicts = gateCfg.marker ? JSON.parse(readIf(join(root, ...verdictsPath)) ?? '{}') : {}
  if (!sprintText) throw new Error('sprint-status.yaml 을 읽지 못했다 — 편성 불가(빈 큐를 정상인 척 내보내지 않는다)')

  // 일일 상한 원장 — 상태 파일은 저장소 밖(워크트리 reset 에 안 쓸린다)
  const statePath = join(stateDir, 'auto-plan-state.json')
  const state = JSON.parse(readIf(statePath) ?? '{}')
  state.days ??= {}
  state.replans ??= {} // full: 스토리별 replan 회차(진전이 나면 0 으로 본다)
  // day.progressed[] 는 러너가 쓴다(그 라운드 커밋이 실제로 만진 스토리 키) — 규칙 9 v2 의 재료.
  // 편성기는 읽기만 한다(단일 작성자 원칙).
  const day = (state.days[today] ??= { planned: [], stops: 0, consumed: {} })
  // 상한 연장 보너스(/extend) — 원격 명령 처리기가 상태 폴더에 당일 파일로 남긴 값을
  // **읽기 전용**으로 가산한다. 원장(auto-plan-state.json)을 두 프로세스가 같이 쓰지 않기
  // 위해서다. 당일 한정 — 자정이 지나면 파일이 바뀌어 기본 상한으로 돌아간다.
  const capBonus = Math.max(0, Number(readJson(join(stateDir, `cap-extend-${today}.json`)).extra ?? 0) || 0)
  const cap = capBase + capBonus
  // 규칙 7 개정(2026-09-01 운영 체계 정비 P0-b): 상한 단위 = **하루 고유 스토리 수**.
  // 종전에는 편성 이벤트를 세서 같은 스토리의 dev↔review 재편성이 상한을 거듭 소모했다 —
  // 실측: 편성 30 = 고유 12 · 편성 50 = 고유 29. 「30 소진」이 「30개 스토리」가 아니었고,
  // 낮에 상한이 차서 밤 슬롯이 빈손으로 돌았다. 이제 이미 오늘 편성된 스토리의 재편성은
  // 무과금이고 새 스토리만 슬롯을 쓴다. day.planned 배열 자체는 그대로 쌓는다
  // (규칙 9 무진전 스트릭이 편성 횟수를 재료로 쓰기 때문이다).
  const plannedSet = new Set(day.planned)
  const uniqueUsed = plannedSet.size
  const remaining = Math.max(0, cap - uniqueUsed)
  // 체인 게이트 — 사람 검토 없는 축조에 상한을 둔다. 러너가 라운드마다 남기는 chain-info 를 읽어
  // 미머지 체인이 CHAIN_MAX_AGE_DAYS 일 이상이면 **신규 착수만** 보류한다(회수·마감 재검수는 계속 —
  // 이미 시작된 일의 마무리는 검토 축적이 아니다). 사람이 머지하면 러너가 나이를 0 으로 되돌린다.
  const chainAgeDays = Math.max(0, Number(readJson(join(stateDir, 'chain-info.json')).ageDays ?? 0) || 0)
  const chainBlocksNew = AUTO ? false : !allowNewUnderChain(chainAgeDays) // full: 체인은 알림만(머지는 사람 몫)

  const allRows = parseSprint(sprintText)
  const doneKeys = allRows.filter((r) => r.status === 'done').map((r) => r.key)
  const rows = allRows.filter((r) => r.status !== 'done')
  // full: 에픽 순서는 우선순위일 뿐 — 적힌 에픽 뒤에 나머지 에픽을 번호순으로 잇는다(epicScope 'listed' 면 종전처럼 자른다).
  const allEpics = [...new Set(allRows.map((r) => r.epic))].sort((a, b) => a - b)
  const EPIC_ORDER_EFF = AUTO && autoCfg.epicScope !== 'listed' ? [...EPIC_ORDER, ...allEpics.filter((e) => !EPIC_ORDER.includes(e))] : EPIC_ORDER
  // full: 선행이 review(코드 실재)면 후속을 허용한다 — done 만 기다리면 3주 표류(2-1) 뒤의 후속이 영영 막힌다.
  const depSatisfiedKeys = AUTO ? allRows.filter((r) => r.status === 'done' || r.status === 'review').map((r) => r.key) : doneKeys
  // 스토리 md 의 선행 표기(「선행: 2.1」 · 「depends-on: 11-3」) — DAG 간선 재료.
  // 줄머리 라벨만 인정한다(본문에 스친 「선행」을 의존으로 읽으면 멀쩡한 스토리가 통째로 빠진다).
  const depsOf = new Map()
  const excluded = []
  const exclude = (key, why) => excluded.push({ key, why })
  // 규칙 9 v2: 상한 대상이 「편성 횟수」가 아니라 **「무진전 편성의 연속 횟수」**다.
  // 「평생 N회」는 24h 무정지에서 폭주 상한이 아니라 그 스토리의 사형 선고였다 — 정상적으로
  // 전진하는 스토리(신규→회수→마감 재검수)도 몇 라운드면 소진돼 무인 done 경로가 봉쇄됐다.
  // 여기서는 날짜 오름차순으로 원장을 훑어 — 그날 편성됐는데 진전이 없으면 스트릭 +편성수,
  // 진전이 있으면 0 리셋. 무진전 반복(같은 날 같은 스토리를 계속 다시 집는 폭주)은 종전과
  // 똑같이 잡힌다 — 폭주 백스톱은 무손실이다.
  const unproductiveStreak = (key) => {
    let streak = 0
    for (const d of Object.keys(state.days).sort()) {
      const rec = state.days[d]
      // 판정 순서 주의(2026-09-02 실사고 — 재편성 승인이 무효였다): progressed 를
      // plannedN 조기 continue **앞에서** 본다. 종전 순서는 「그날 편성되지 않은 날」을
      // 통째로 건너뛰어, 편성 밖에서 들어온 진전 기재(사람이 규칙 9 의 「반복 편성은 사람
      // 판단」을 집행하려고 넣는 승인 · 다른 세션이 스토리 md 를 만진 라운드)가 스트릭을
      // 영원히 리셋하지 못했다. 누적 갈래(편성됐고 진전 0)는 그대로 — 폭주 백스톱 무손실.
      if ((rec.progressed ?? []).includes(key)) { streak = 0; continue }
      streak += (rec.planned ?? []).filter((k) => k === key).length
    }
    return streak
  }
  // 무진전 연속 상한 — 마감 재검수는 1회(통과/불통과가 한 번에 갈린다), 그 외는 2회.
  const streakLimit = (kind) => (kind === 'closeout' ? 1 : 2)
  const streakSpent = (key, kind) => unproductiveStreak(key) >= streakLimit(kind)
  const STREAK_WHY = (kind) =>
    '무진전 편성 ' + streakLimit(kind) + '회 연속 소진 — 반복 편성은 사람 판단(규칙 9 v2 · 진전 시 자동 리셋)'
  const CHAIN_WHY = () =>
    '무머지 체인 ' + chainAgeDays + '일 — 신규 착수 보류(사람 머지 후 재개 · 회수·재검수는 계속)'
  for (const r of rows) if (!EPIC_ORDER_EFF.includes(r.epic)) exclude(r.key, '에픽 ' + r.epic + ' 은 목표 범위 밖(규칙 1 — epicOrder)')

  // ── 자율운전(full) 판정 ──
  // 사람 몫으로 남는 것은 ① 스토리가 스스로 남긴 「사람 질문 대기」 표식(BLOCKED-ON-HUMAN) ② 사람 게이트 Task 만 남은 스토리
  // ③ 자율 한계(무진전 + replan 소진) ④ epics 이연 확정 ⑤ 선행 미완(후속을 미루고 선행을 먼저) 뿐이다.
  // 결정·회수 라운드 개방·재투입 금지·무진전은 전부 replan(시니어 재계획) 단계가 흡수한다.
  const gateOut = (key, type, why) => { exclude(key, why); humanGates.push({ key, type, text: why }); return null }
  const replansOf = (key) => (unproductiveStreak(key) === 0 ? 0 : Number(state.replans[key] ?? 0))
  const mockupPlan = (section, key) => {
    if (autoCfg.mockups === 'approved-only') { const g = mockupGateOk(section, key, verdicts, gateCfg); return g.ok ? { stage: false } : { block: g.why + '(규칙 6)' } }
    const m = mockupEntries(section, key, verdicts, gateCfg)
    if (!m.applies) return { stage: false }
    if (m.entries.length === 0) return { stage: true, note: 'AI 목업 초안 생성(목업 부재)' }
    const names = (list) => list.map((e) => e.file.split('/').pop()).join(', ')
    const rejected = m.entries.filter((e) => e.verdict === 'rejected')
    if (rejected.length && !m.entries.some((e) => e.verdict === 'approved')) return { stage: true, note: '목업 재작성(rejected: ' + names(rejected) + ')' }
    const pending = m.entries.filter((e) => e.verdict === 'pending')
    if (pending.length) humanGates.push({ key, type: 'post-hoc', text: '목업 사후 확인: ' + names(pending) })
    return { stage: false }
  }
  const judgeAuto = (r, section, text) => {
    const streak = unproductiveStreak(r.key)
    const overLimit = () => streak >= 2 && replansOf(r.key) >= autoCfg.maxReplansPerStory
    const limitWhy = () => '자율 한계 — 사람 질문 필요(무진전 ' + streak + '회 · replan ' + replansOf(r.key) + '회)'
    if (text === null) {
      const mp = mockupPlan(section, r.key)
      if (mp.block) return exclude(r.key, mp.block), null
      if (overLimit()) return gateOut(r.key, 'question', limitWhy())
      if (streak >= 2) state.replans[r.key] = replansOf(r.key) + 1 // 신규는 replan 단계가 없다(파일 부재) — 회차만 센다
      const stages = mp.stage ? ['create', 'mockup', 'dev', 'review'] : ['create', 'dev', 'review']
      return { ...r, kind: 'new', files: [], stages, force: false, notes: [mp.note].filter(Boolean) }
    }
    const s = readStorySignals(text)
    depsOf.set(r.key, parseDependsOn(text))
    if (s.blockedOnHuman) return gateOut(r.key, 'question', '사람 질문 대기: ' + s.blockedOnHuman)
    if (s.unfinishedTasks === 0 && s.humanGateTasks > 0 && s.openPatches === 0 && r.status !== 'review') {
      return gateOut(r.key, 'gate', '사람 게이트만 남음: ' + String(s.humanGateLines[0] ?? '').slice(0, 120))
    }
    const recovery = r.status === 'review' || r.status === 'in-progress'
    const notes = []
    let kind, stages
    if (r.status === 'review' && s.unfinishedTasks === 0 && s.openPatches === 0 && !s.openDecision) { kind = 'closeout'; stages = ['review'] }
    else {
      kind = recovery ? 'recovery' : 'new'
      stages = kind === 'recovery' ? ['dev'] : ['create', 'dev', 'review']
      const why = []
      if (s.openDecision) why.push('AI 결정 ' + s.openDecisions + '건 채택')
      if (s.unfinishedTasks === 0 && s.openPatches > 0) why.push('회수 라운드 개방(열린 Patch ' + s.openPatches + ')')
      else if (s.unfinishedTasks === 0 && recovery) why.push('남은 일 재계획(미완 Task 0)')
      if (s.banPresent) why.push('재투입 금지 표기는 조언으로만 봄')
      if (why.length) { stages = ['replan', ...stages]; notes.push(...why) }
    }
    const mp = kind === 'closeout' ? { stage: false } : mockupPlan(section, r.key) // 마감 재검수엔 목업 초안을 붙이지 않는다
    if (mp.block) return exclude(r.key, mp.block), null
    if (mp.stage) { stages = ['mockup', ...stages]; notes.push(mp.note) }
    let replanHint = null
    if (streak >= 2) {
      if (overLimit()) return gateOut(r.key, 'question', limitWhy())
      const n = replansOf(r.key) + 1
      state.replans[r.key] = n
      if (!stages.includes('replan')) stages = ['replan', ...stages]
      replanHint = '무진전 편성 ' + streak + '회 — 접근을 바꿔라(과제 재작성·분할·다른 구현 경로)'
      notes.push('무진전 ' + streak + '회 → replan ' + n + '/' + autoCfg.maxReplansPerStory)
    }
    return { ...r, kind, files: s.files, stages, force: kind !== 'new', notes, ...(replanHint ? { replanHint } : {}) }
  }

  const judge = (r) => {
    const section = epicSection(epicsText, r.key)
    if (/⏸|이연 확정/.test(section)) return exclude(r.key, 'epics 이연 확정 문언(⏸) — 편성 제외(규칙 1)'), null
    const text = readIf(join(ART, r.key + '.md'))
    if (AUTO) return judgeAuto(r, section, text)
    if (text === null) {
      const gate = mockupGateOk(section, r.key, verdicts, gateCfg)
      if (!gate.ok) return exclude(r.key, gate.why + '(규칙 6)'), null
      // 스토리 파일이 아직 없는 신규 갈래도 같은 검사를 지난다 — 사람 게이트에 막힌 신규가
      // 매 라운드 재편성 + 전 단계 skip 커밋으로 도는 폭주가 정확히 이 갈래였다.
      if (streakSpent(r.key, 'new')) return exclude(r.key, STREAK_WHY('new')), null
      if (chainBlocksNew) return exclude(r.key, CHAIN_WHY()), null
      return { ...r, kind: 'new', files: [], stages: ['create', 'dev', 'review'], force: false }
    }
    const s = readStorySignals(text)
    depsOf.set(r.key, parseDependsOn(text))
    if (s.openDecision) {
      const short = r.key.split('-').slice(0, 2).join('.')
      const inInbox = inboxText.includes(short) || inboxText.includes(r.key)
      return exclude(r.key, '열린 [Review][Decision] — 결정 대기(규칙 2)' + (inInbox ? '' : ' · ⚠️ 인박스 미등재 의심(단일 창구 위반)')), null
    }
    if (s.banPresent && s.unfinishedTasks === 0) {
      return exclude(r.key, '재투입 금지 지시 실재 · 해제 라운드 소진(미완 Task 0 — 규칙 3)'), null
    }
    const recovery = r.status === 'review' || r.status === 'in-progress'
    // ── kind 를 먼저 정하고, 그 다음에 상한을 검사한다 ──
    // 순서가 중요하다: 상한 검사가 앞서면 규칙 9 가 마감 재검수를 선점해, 정상 파이프라인
    // (신규→회수→마감 재검수)의 무인 done 경로가 영구 봉쇄된다. 상한은 kind 별로 다르다.
    let kind
    if (recovery && s.unfinishedTasks === 0 && s.openPatches === 0) {
      // 규칙 10: review 상태 + 고칠 것 0 = **마감 재검수 후보** — 재검수 1회가 통과하면 done,
      // 새 findings 가 나오면 회수 재고가 된다. 종전에는 제외만 해서 미마무리가 영구 적체됐다.
      // in-progress 인데 0/0 인 기형 상태만 종전대로 제외(사람 확인 대상).
      if (r.status !== 'review') return exclude(r.key, '회수분 0 — force 재실행은 헛돈다(규칙 8)'), null
      kind = 'closeout'
    } else if (recovery && s.unfinishedTasks === 0 && s.openPatches > 0) {
      return exclude(r.key, '열린 Patch ' + s.openPatches + '건인데 미완 Task 0 — dev 재투입 전제 미충족(규칙 4 · 라운드 절은 사람이 연다)'), null
    } else {
      kind = recovery ? 'recovery' : 'new'
    }
    // 규칙 9 v2: 상한 = **무진전 연속 편성**(마감 재검수 1회 · 그 외 2회). 진전이 있으면
    // 스트릭이 0 으로 돌아 파이프라인이 계속 흐른다.
    if (streakSpent(r.key, kind)) return exclude(r.key, STREAK_WHY(kind)), null
    // 체인 게이트: 미머지 체인이 길면 신규 착수만 보류한다(회수·마감 재검수는 계속).
    if (kind === 'new' && chainBlocksNew) return exclude(r.key, CHAIN_WHY()), null
    if (kind === 'closeout') return { ...r, kind, files: s.files, stages: ['review'], force: true }
    return { ...r, kind, files: s.files, stages: kind === 'recovery' ? ['dev'] : ['create', 'dev', 'review'], force: kind === 'recovery' }
  }

  // 규칙 1: 순서상 첫 「후보 보유」 에픽까지만 편성한다. 전부 막힌 에픽은 다음 에픽에 길을 내준다.
  const candidates = []
  let currentEpic = null
  if (AUTO) {
    // full: 에픽 순서는 우선순위일 뿐 댐이 아니다 — 유효 순서의 모든 에픽을 훑어 후보를 전부 모은다(진행 에픽 개념 없음).
    for (const epic of EPIC_ORDER_EFF) for (const r of rows.filter((x) => x.epic === epic)) { const got = judge(r); if (got) candidates.push(got) }
  } else {
    for (const epic of EPIC_ORDER) {
      const epicRows = rows.filter((r) => r.epic === epic)
      const got = epicRows.map(judge).filter(Boolean)
      if (got.length > 0) { currentEpic = epic; candidates.push(...got); break }
    }
  }
  if (!AUTO && currentEpic !== null) {
    for (const epic of EPIC_ORDER.slice(EPIC_ORDER.indexOf(currentEpic) + 1)) {
      for (const r of rows.filter((x) => x.epic === epic)) {
        const shortKey = r.key.split('-').slice(0, 2).join('-')
        if (PARALLEL_ALLOW[shortKey] === currentEpic) {
          const got = judge(r)
          if (got) candidates.push(got) // 명시 병행 허용분은 뒤 에픽이어도 후보(규칙 1 단서)
          continue
        }
        // 규칙 1 개정: 에픽 순서는 **우선순위이지 댐이 아니다** — 뒤 에픽의 회수·마감 재검수(이미
        // 시작된 스토리의 마무리)는 앞 에픽에 후보가 남아 있어도 통과한다(실교착: 앞 에픽의 사람-대기
        // 잔존이 뒤 에픽 회수까지 막았다). **신규 착수만** 에픽 도달을 기다린다(선행 스키마 스토리보다
        // 후속 스토리가 먼저 도는 순서 사고 방지). 후보가 에픽 순서로 쌓이므로 상한은 뒤 에픽부터 잘린다.
        const got = judge(r)
        if (!got) continue // 제외 사유는 judge 가 이미 남겼다
        if (got.kind === 'new') { exclude(r.key, '에픽 순서 대기 — 신규 착수는 에픽 도달 후(규칙 1 개정 · 회수·마감 재검수는 통과)'); continue }
        candidates.push(got)
      }
    }
  }

  // 규칙 7: 하루 상한
  const capText = Number.isFinite(cap) ? cap + (capBonus > 0 ? '(기본 ' + capBase + ' + 연장 ' + capBonus + ')' : '') : '제한 없음'
  // 규칙 7(P0-b): 재편성(오늘 이미 편성된 스토리)은 **무과금**이라 잘라내지 않는다 —
  // slice 로 앞에서 N개만 취하면 dev↔review 왕복이 상한을 거듭 먹어 새 스토리가 밀린다.
  const capped = []
  let newUnique = 0
  for (const c of candidates) {
    const isReplan = plannedSet.has(c.key)
    if (isReplan || newUnique < remaining) {
      capped.push(c)
      if (!isReplan) newUnique++
    } else {
      exclude(c.key, '하루 상한 ' + capText + ' 도달(오늘 고유 스토리 ' + uniqueUsed + ' — 규칙 7 · 재편성은 무과금 · /extend 로 연장 가능)')
    }
  }

  // 중요도 모델 배정 + 교차검증(dev ≠ review): cfg.models 가 평면({dev,review})이면 전 종류 공통(종전 호환),
  // { new, recovery, closeout } 형태면 종류별 지정. 없으면 내장 기본 —
  //   신규 dev=최상위/review=차상위 · 회수 dev=차상위/review=최상위(상위 교차) · 마감 재검수 review=차상위.
  // 한도는 엔진 품질 사다리(자동 강등 · dev 모델 회피)가 흡수한다.
  // Codex 교차 리뷰(2026-09-02 다중 프로바이더): providers.codex.enabled + roles 에 review + kind 가 reviewKinds 에 있으면
  // review 스펙을 "codex" 로 둔다(구현 Claude → 리뷰 Codex = 다른 벤더의 눈). recovery 는 review 단계가 없어 대상이 아니다.
  // 가용성(미설치·미인증·한도)은 엔진이 실행 시점에 판정해 claude 로 폴백한다 — 편성기는 의도만 적는다.
  const codexCfg = cfg.providers?.codex ?? null
  const codexReviewFor = (kind) => Boolean(codexCfg?.enabled) &&
    (Array.isArray(codexCfg.roles) ? codexCfg.roles : ['review']).includes('review') &&
    (Array.isArray(codexCfg.reviewKinds) ? codexCfg.reviewKinds : ['new', 'closeout']).includes(kind) &&
    kind !== 'recovery'
  const modelsFor = (kind) => {
    let base =
      models && (models.new || models.recovery || models.closeout) ? (models[kind] ?? null)
        : models ? models
          : kind === 'closeout' ? { review: 'opus' }
            : kind === 'recovery' ? { dev: 'opus', review: 'fable' }
              : { dev: 'fable', review: 'opus' }
    if (codexReviewFor(kind)) base = { ...(base ?? {}), review: 'codex' }
    // 소진 회피는 **짝 단위**로 한다 — 단계별로 따로 바꾸면 dev === review 가 되어 교차검증이 깨진다.
    // exhaustedModels 에 "codex" 를 적으면 종전 짝 회피가 그대로 codex 를 claude 대체로 돌린다.
    return base ? avoidExhaustedPair(base, exhausted) : null
  }
  // 배정기(assign.mjs) — 난이도·위험도·프로바이더 가용성·최근 실패 기록으로 짝을 조정한다.
  // 설정(providers)·기록이 없으면 **modelsFor 결과를 그대로** 돌려준다(종전 큐와 바이트 동일).
  const assignHistory = parseHistory(readJson(join(stateDir, ASSIGN_HISTORY_FILE)))
  const modelsForBatch = (kind, group) => {
    const base = modelsFor(kind)
    if (!base) return null
    const res = assignBatchModels({
      base,
      stories: group.map((c) => ({ key: c.key, kind, files: c.files ?? [] })),
      providers: cfg.providers ?? {},
      history: assignHistory,
      config: { split: Boolean(cfg.providers?.codex?.split) },
    })
    const assigned = res ? { ...res } : res
    if (AUTO && assigned) {
      // 재계획·목업 단계 모델 — 지휘/판정은 최상위(fable) · 소진 시 opus(교차검증 짝과 무관한 단독 단계)
      const top = exhausted.includes('fable') ? 'opus' : 'fable'
      const st = group[0]?.stages ?? []
      if (st.includes('replan') && !assigned.replan) assigned.replan = top
      if (st.includes('mockup') && !assigned.mockup) assigned.mockup = top
    }
    return assigned
  }

  // 규칙 5: 회수끼리 File List 서로소면 2개까지 한 배치 · 신규는 단독 배치
  const batches = []
  const pool = [...capped]
  while (pool.length) {
    const head = pool.shift()
    const batch = [head]
    // 규칙 5 확장: 같은 에픽 · 같은 종류 · File List 서로소(공유 장부 제외)면 2개까지 한 배치.
    // 신규도 지시서에 File List 가 채워져 있으면 짝이 된다(빈 목록 = 파일을 모르는 스펙 → 단독).
    const realFiles = (c) => (c.files ?? []).filter((f) => !SHARED_BOOKKEEPING.includes(f))
    const headFiles = realFiles(head)
    // 짝 크기 = cfg.workers.batchSize(기본 2 = 종전과 동일 · 절대 상한 6) — 러너의 워커 풀 폭과 함께 올려야 의미가 있다.
    const batchSize = Math.max(1, Math.min(6, Number(cfg.workers?.batchSize) || 2))
    if (headFiles.length > 0) {
      while (batch.length < batchSize) {
        const used = batch.flatMap(realFiles)
        const mateIdx = pool.findIndex((c) => {
          const mateFiles = realFiles(c)
          return c.kind === head.kind && c.epic === head.epic && mateFiles.length > 0 &&
            (c.stages ?? []).join() === (head.stages ?? []).join() && (c.replanHint ?? '') === (head.replanHint ?? '') && // 단계 서명이 같은 것끼리만(replan 유무)
            mateFiles.every((f) => !used.includes(f)) &&
            parallelHazardsExtended([...batch.map((b) => b.files ?? []), c.files ?? []]).parallelOk // 검증기와 같은 잣대로 짝을 고른다
        })
        if (mateIdx < 0) break
        batch.push(pool.splice(mateIdx, 1)[0])
      }
    }
    batches.push(batch)
  }
  // ── 자기 검증(9점대 하네스 · 2026-09-02) ──
  // 규칙 10종은 「후보 하나하나가 편성 가능한가」만 본다. 만들어진 **큐 전체**가 모순인지
  // (선행 미해소 · 배치 안 충돌 · 중복 · 모델 스펙 형식 · 상한 초과)는 아무도 안 봤다.
  // 검증기는 LLM 계획(orchestrate)과 **같은 함수**다 — 규칙 계획만 봐주면 잣대가 아니다.
  // 실패해도 throw 하지 않는다(밤이 서면 안 된다): 걸린 스토리만 빼고 사유를 큐에 남긴다.
  const dag = buildDag({
    stories: batches.flat().map((c) => ({ key: c.key, epic: c.epic, kind: c.kind, files: c.files ?? [], deps: depsOf.get(c.key) ?? [] })),
    epicOrder: EPIC_ORDER_EFF,
  })
  const validation = validatePlan(
    { batches: batches.map((b) => ({ stories: b.map((c) => c.key), stages: b[0].stages, ...(modelsForBatch(b[0].kind, b) ? { models: modelsForBatch(b[0].kind, b) } : {}) })) },
    dag,
    {
      knownKeys: allRows.map((r) => r.key),
      doneKeys: depSatisfiedKeys,
      epicOrder: EPIC_ORDER_EFF,
      currentEpic,
      parallelAllow: PARALLEL_ALLOW,
      cap: { limit: cap, plannedToday: day.planned },
      batchMax: Math.max(1, Math.min(6, Number(cfg.workers?.batchSize) || 2)),
    },
  )
  if (!validation.ok) {
    const bad = new Map()
    for (const e of validation.errors) if (e.key && !bad.has(e.key)) bad.set(e.key, e.msg)
    for (let i = batches.length - 1; i >= 0; i--) {
      const keep = batches[i].filter((c) => !bad.has(c.key))
      if (keep.length === batches[i].length) continue
      for (const c of batches[i]) if (bad.has(c.key)) exclude(c.key, '계획 검증 실패 — ' + bad.get(c.key))
      if (keep.length > 0) batches[i] = keep
      else batches.splice(i, 1)
    }
  }

  const KIND_LABEL = { recovery: (c) => '회수(' + c.status + ')', closeout: () => '마감 재검수(review→done 후보 · 규칙 10)', new: () => '신규(backlog)' }
  const picked = batches.flat().map((c) => ({
    key: c.key,
    why: (KIND_LABEL[c.kind] ?? KIND_LABEL.new)(c) + ((c.notes ?? []).length ? ' · ' + c.notes.join(' · ') : '') + (AUTO ? ' · ' + (c.stages ?? []).join('→') : ''),
  }))

  const queue = {
    planned: 'auto',
    updated: today + (AUTO ? ' 자율 편성(full · plan-queue · 상한 ' : ' 자동 편성(plan-queue · 상한 ') + (Number.isFinite(capBase) ? capBase : '없음') + (capBonus > 0 ? '+' + capBonus : '') +
      ' · 오늘 기편성 ' + day.planned.length + (chainAgeDays > 0 ? ' · 체인 ' + chainAgeDays + '일' : '') + ')',
    // parallel ≥ 2 = 병렬 점화 — File List 서로소 2스토리 dev 배치(규칙 5 짝)만 러너가
    // 워크트리 분리 병렬로 돌린다. 조건 미달 배치는 러너가 순차 폴백(runner-rules.parallelPlan).
    defaults: { waitAuthMin: 480, stageTimeoutMin: 150, commit: true, push: true, parallel: cfg.parallel ?? 2 },
    batches: batches.map((b, i) => ({
      label: 'AUTO-' + (i + 1) + ': ' + b.map((c) => c.key.split('-').slice(0, 2).join('-')).join(' · ') + ' (' + (b[0].kind === 'recovery' ? '회수' : b[0].kind === 'closeout' ? '마감 재검수' : '신규') + ')',
      enabled: true,
      stories: b.map((c) => c.key),
      stages: b[0].stages,
      force: b[0].force,
      ...(b[0].replanHint ? { replanHint: b[0].replanHint } : {}),
      ...(modelsForBatch(b[0].kind, b) ? { models: modelsForBatch(b[0].kind, b) } : {}),
    })),
    // 자기 검증 결과 — ok=false 여도 큐는 나간다(걸린 스토리는 위에서 이미 뺐다).
    // 러너·브리핑이 「왜 빠졌나」를 근거로 읽는다.
    validation,
    // cap = 실효 상한(기본 + /extend 연장) · capBonus = 연장분 · chainAgeDays = 미머지 체인 나이
    // notes = 스토리별이 아닌 편성 전체의 단서(예: 목업 게이트 미구성)
    _편성: { date: today, mode: AUTO ? 'full' : 'guarded', picked, excluded, humanGates, notes: gateNotes, cap: Number.isFinite(cap) ? cap : null, capBonus, chainAgeDays, alreadyPlannedToday: day.planned.length },
  }
  return { queue, state, statePath, day }
}

// ── CLI ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
  const cfg = loadConfig(process.cwd())
  const projectName = cfg.project || basename(process.cwd())
  // 상태 폴더 = 환경변수 → cfg.stateDir → 기본(~/.claude-auto/<project>) 3단계.
  // 러너·원격 명령 처리기와 **같은 식**이어야 한다 — 한 곳만 cfg.stateDir 을 빠뜨리면
  // 원장·체인 정보·상한 연장 파일이 서로 다른 폴더에 흩어져 편성이 조용히 어긋난다.
  // `--state` 는 그 위의 명시 지정(러너가 자기 STATE_DIR 을 넘길 때 쓴다).
  const stateDir = resolve(opt('state', process.env.AUTO_BATCH_STATE_DIR || cfg.stateDir || join(homedir(), '.claude-auto', projectName)))
  mkdirSync(stateDir, { recursive: true })
  const out = opt('out', '')
  const dry = argv.includes('--dry')
  const maxOpt = opt('max', '')
  const { queue, state, statePath, day } = plan({ root: process.cwd(), stateDir, max: maxOpt ? Number(maxOpt) : undefined, config: cfg })
  const info = queue._편성
  console.log('# 편성 ' + info.date + (info.mode === 'full' ? ' [자율운전 full]' : '') + ' — 고름 ' + info.picked.length + ' · 뺌 ' + info.excluded.length + ' · 배치 ' + queue.batches.length +
    ' · 상한 ' + (info.cap ?? '없음') + (info.capBonus > 0 ? '(연장 +' + info.capBonus + ')' : '') +
    (info.chainAgeDays > 0 ? ' · 체인 ' + info.chainAgeDays + '일' : ''))
  for (const n of info.notes ?? []) console.log('  ! ' + n)
  for (const p of queue._편성.picked) console.log('  V ' + p.key + ' — ' + p.why)
  for (const e of queue._편성.excluded) console.log('  X ' + e.key + ' — ' + e.why)
  for (const g of info.humanGates ?? []) console.log('  ? ' + g.key + ' [' + g.type + '] ' + g.text)
  if (!dry && out) {
    writeFileSync(resolve(out), JSON.stringify(queue, null, 2) + '\n', 'utf8')
    if (!argv.includes('--no-ledger')) {
      day.planned.push(...queue._편성.picked.map((p) => p.key))
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    }
    console.log('→ 큐: ' + resolve(out) + ' · 오늘 누계 ' + day.planned.length)
  }
}
