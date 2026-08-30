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

const { SHARED_BOOKKEEPING } = RULES
/** 미머지 체인 나이 상한(일) — 러너 규칙이 SoT. 여기 값은 구버전 폴백용 사본일 뿐이다. */
const CHAIN_MAX_AGE_DAYS = RULES.CHAIN_MAX_AGE_DAYS ?? 2
/** 체인 게이트 판정은 규칙 함수를 그대로 쓴다(비교식을 편성기에 복제하지 않는다).
 *  구버전 runner-rules 에 함수가 없을 때만 같은 뜻의 폴백을 쓴다 — 링크 단계에서 죽지 않기 위해서다. */
const allowNewUnderChain = RULES.allowNewUnderChain ?? ((ageDays) => (ageDays ?? 0) < CHAIN_MAX_AGE_DAYS)

/** 목업 게이트(규칙 6) 기본값 — 프로젝트가 `cfg.mockupGate` 로 덮어쓴다.
 *  marker  : 에픽 문서에서 「새 화면 스토리」를 가리키는 문구(비면 게이트 미구성 = 통과)
 *  ruleId  : 함께 있어야 게이트가 걸리는 프로젝트 내부 규칙 ID(선택 · null 이면 marker 만으로 판정)
 *  mockupsDir   : 목업 판정 키의 접두 경로
 *  verdictsPath : 목업 판정 JSON 의 저장소 상대 경로 */
export const MOCKUP_GATE_DEFAULT = Object.freeze({
  marker: '새 화면',
  ruleId: null,
  mockupsDir: 'mockups',
  verdictsPath: 'tools/dev-status/mockup-verdicts.json',
})

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

/** sprint-status.yaml → [{key, status, epic}] (스토리 키 행만 — 주석·벌크 무시) */
export function parseSprint(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = /^ {2}(\d+-\d+[^:]*): *(backlog|ready-for-dev|in-progress|review|done)\b/.exec(line)
    if (m) rows.push({ key: m[1], status: m[2], epic: Number(m[1].split('-')[0]) })
  }
  return rows
}

/** 스토리 파일 판정 재료
 *
 *  ⚠️ **스토리 문서 규약에 의존한다** — 아래 정규식의 절 제목(`## Tasks…`·`### File List`),
 *  체크박스 표기(`- [ ] [Review][Decision]`·`[Review][Patch]`), 한국어 관용 문구
 *  (`재투입 금지`·`마지막 구현 라운드`·`사람 게이트`·`👤`)는 **이 배치가 전제하는 스토리 문서
 *  서식**이다. 다른 서식·다른 언어로 스토리를 쓰는 프로젝트에서는 이 판정들이 전부 「해당 없음」이
 *  되어 **게이트가 조용히 무동작한다**(결정 대기·재투입 금지·사람 게이트가 안 걸리고 편성된다).
 *  → 이식할 때는 스토리 문서를 이 서식에 맞추거나, 문구의 config 화를 후속 과제로 잡는다.
 *  (문구 자체의 config 화는 이번 범위 밖 — 동작을 바꾸지 않는다.) */
export function readStorySignals(text) {
  const openDecision = /^- \[ \] \[Review\]\[Decision\]/m.test(text)
  const openPatches = (text.match(/^- \[ \] \[Review\]\[Patch\]/gm) ?? []).length
  const banPresent = /재투입 금지|마지막 구현 라운드/.test(text)
  // Tasks/Subtasks 절 안의 미완 체크박스만 센다. 사람 게이트 항목(사람만 풀 수 있는 것)은
  // 기계 일감에서 뺀다 — 그것만 남은 스토리를 편성하면 no-op STOP 이 예약된다.
  const tasksSection = /## Tasks[^\n]*\n([\s\S]*?)(?=\n## )/.exec(text)?.[1] ?? ''
  const unfinishedTasks = (tasksSection.match(/^\s*- \[ \] [^\n]*/gm) ?? [])
    .filter((l) => !/사람 게이트|👤/.test(l)).length
  const fileSection = /### File List\n([\s\S]*?)(?=\n#{2,3} )/.exec(text)?.[1] ?? ''
  const files = [...fileSection.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((p) => p.includes('/'))
  return { openDecision, openPatches, banPresent, unfinishedTasks, files }
}

/** epics.md 에서 해당 스토리 절 추출 — 키 4-1-... → 헤더 '### Story 4.1:'
 *  (역시 스토리·에픽 문서 규약이다 — 헤더 서식이 다르면 절이 빈 문자열이 되어 규칙 1·6 이 무동작한다) */
export function epicSection(epicsText, key) {
  const [a, b] = key.split('-')
  const re = new RegExp('^### Story ' + a + '\\.' + b + ':[^\\n]*\\n([\\s\\S]*?)(?=\\n### Story |\\n## )', 'm')
  return re.exec(epicsText)?.[1] ?? ''
}

/** 목업 게이트: 새 화면 스토리는 approved 목업이 실재해야 후보.
 *  판정에 쓰는 값은 전부 `cfg.mockupGate`(→ MOCKUP_GATE_DEFAULT) 가 소유한다 —
 *  프로젝트 내부 규칙 ID·목업 경로가 코드에 박히지 않는다.
 *  marker 가 비면 **게이트 미구성**으로 보아 통과시키고, 호출부가 그 사실을 편성 근거에 남긴다. */
export function mockupGateOk(section, key, verdicts, gate = MOCKUP_GATE_DEFAULT) {
  const marker = gate?.marker
  if (!marker) return { ok: true, unconfigured: true }
  if (!section.includes(marker)) return { ok: true }
  // ruleId 는 선택 — 지정하면 marker 와 **함께** 있을 때만 게이트가 걸린다(오탐 축소용).
  if (gate.ruleId && !section.includes(gate.ruleId)) return { ok: true }
  const dir = String(gate.mockupsDir ?? MOCKUP_GATE_DEFAULT.mockupsDir).replace(/[/\\]+$/, '')
  const prefix = dir + '/story-' + key.split('-').slice(0, 2).join('-') + '-'
  const mine = Object.entries(verdicts?.items ?? {}).filter(([k]) => k.startsWith(prefix))
  const tag = gate.ruleId ? ' — ' + gate.ruleId : ''
  if (mine.length === 0) return { ok: false, why: marker + ' 인데 목업 부재(pending 취급' + tag + ')' }
  const bad = mine.filter(([, v]) => v.verdict !== 'approved')
  if (bad.length > 0) return { ok: false, why: '목업 미승인: ' + bad.map(([k]) => k.split('/').pop()).join(', ') }
  return { ok: true }
}

export function plan({ root, stateDir, max, today = todayStr(), config }) {
  const cfg = config ?? loadConfig(root)
  const EPIC_ORDER = cfg.epicOrder
  if (!Array.isArray(EPIC_ORDER) || EPIC_ORDER.length === 0) {
    throw new Error('auto.config.json 의 epicOrder 가 비어 있다 — 편성 불가(프로젝트의 에픽 우선순위는 사람이 정한다)')
  }
  const PARALLEL_ALLOW = cfg.parallelAllow ?? {} // 예: { "<스토리키>": <에픽번호> } — 그 에픽이 진행 중이어도 후보로 두는 예외
  // 상한은 페이스가 아니라 폭주 방지 백스톱이다 — 몫을 다 했다고 남은 슬롯이 쉬면 안 된다
  // (실사고: 상한 12 시절, 오전에 12건 소진 후 남은 슬롯이 통째로 놀았다). 실질 제동은
  // STOP 차단기·결정 대기 제외·사용량 한도 대기·리뷰 게이트가 맡는다.
  const capBase = max ?? cfg.dailyCap ?? 30
  const models = cfg.models ?? null // 예: { dev: 'fable', review: 'opus' } — 없으면 CLI 기본 모델

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
  // day.progressed[] 는 러너가 쓴다(그 라운드 커밋이 실제로 만진 스토리 키) — 규칙 9 v2 의 재료.
  // 편성기는 읽기만 한다(단일 작성자 원칙).
  const day = (state.days[today] ??= { planned: [], stops: 0, consumed: {} })
  // 상한 연장 보너스(/extend) — 원격 명령 처리기가 상태 폴더에 당일 파일로 남긴 값을
  // **읽기 전용**으로 가산한다. 원장(auto-plan-state.json)을 두 프로세스가 같이 쓰지 않기
  // 위해서다. 당일 한정 — 자정이 지나면 파일이 바뀌어 기본 상한으로 돌아간다.
  const capBonus = Math.max(0, Number(readJson(join(stateDir, `cap-extend-${today}.json`)).extra ?? 0) || 0)
  const cap = capBase + capBonus
  const remaining = Math.max(0, cap - day.planned.length)
  // 체인 게이트 — 사람 검토 없는 축조에 상한을 둔다. 러너가 라운드마다 남기는 chain-info 를 읽어
  // 미머지 체인이 CHAIN_MAX_AGE_DAYS 일 이상이면 **신규 착수만** 보류한다(회수·마감 재검수는 계속 —
  // 이미 시작된 일의 마무리는 검토 축적이 아니다). 사람이 머지하면 러너가 나이를 0 으로 되돌린다.
  const chainAgeDays = Math.max(0, Number(readJson(join(stateDir, 'chain-info.json')).ageDays ?? 0) || 0)
  const chainBlocksNew = !allowNewUnderChain(chainAgeDays)

  const rows = parseSprint(sprintText).filter((r) => r.status !== 'done')
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
      const plannedN = (rec.planned ?? []).filter((k) => k === key).length
      if (plannedN === 0) continue
      if ((rec.progressed ?? []).includes(key)) streak = 0
      else streak += plannedN
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
  for (const r of rows) if (!EPIC_ORDER.includes(r.epic)) exclude(r.key, '에픽 ' + r.epic + ' 은 목표 범위 밖(규칙 1 — epicOrder)')

  const judge = (r) => {
    const section = epicSection(epicsText, r.key)
    if (/⏸|이연 확정/.test(section)) return exclude(r.key, 'epics 이연 확정 문언(⏸) — 편성 제외(규칙 1)'), null
    const text = readIf(join(ART, r.key + '.md'))
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
  for (const epic of EPIC_ORDER) {
    const epicRows = rows.filter((r) => r.epic === epic)
    const got = epicRows.map(judge).filter(Boolean)
    if (got.length > 0) { currentEpic = epic; candidates.push(...got); break }
  }
  if (currentEpic !== null) {
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
  const capped = candidates.slice(0, remaining)
  const capText = cap + (capBonus > 0 ? '(기본 ' + capBase + ' + 연장 ' + capBonus + ')' : '')
  for (const c of candidates.slice(remaining)) exclude(c.key, '하루 상한 ' + capText + ' 도달(오늘 기편성 ' + day.planned.length + ' — 규칙 7 · /extend 로 연장 가능)')

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
    if (headFiles.length > 0) {
      const mateIdx = pool.findIndex((c) => {
        const mateFiles = realFiles(c)
        return c.kind === head.kind && c.epic === head.epic && mateFiles.length > 0 &&
          mateFiles.every((f) => !headFiles.includes(f))
      })
      if (mateIdx >= 0) batch.push(pool.splice(mateIdx, 1)[0])
    }
    batches.push(batch)
  }
  const KIND_LABEL = { recovery: (c) => '회수(' + c.status + ')', closeout: () => '마감 재검수(review→done 후보 · 규칙 10)', new: () => '신규(backlog)' }
  const picked = batches.flat().map((c) => ({ key: c.key, why: (KIND_LABEL[c.kind] ?? KIND_LABEL.new)(c) }))
  // 중요도 모델 배정 + 교차검증(dev ≠ review): cfg.models 가 평면({dev,review})이면 전 종류 공통(종전 호환),
  // { new, recovery, closeout } 형태면 종류별 지정. 없으면 내장 기본 —
  //   신규 dev=최상위/review=차상위 · 회수 dev=차상위/review=최상위(상위 교차) · 마감 재검수 review=차상위.
  // 한도는 엔진 품질 사다리(자동 강등 · dev 모델 회피)가 흡수한다.
  const modelsFor = (kind) => {
    if (models && (models.new || models.recovery || models.closeout)) return models[kind] ?? null
    if (models) return models
    return kind === 'closeout' ? { review: 'opus' }
      : kind === 'recovery' ? { dev: 'opus', review: 'fable' }
        : { dev: 'fable', review: 'opus' }
  }

  const queue = {
    planned: 'auto',
    updated: today + ' 자동 편성(plan-queue · 상한 ' + capBase + (capBonus > 0 ? '+' + capBonus : '') +
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
      ...(modelsFor(b[0].kind) ? { models: modelsFor(b[0].kind) } : {}),
    })),
    // cap = 실효 상한(기본 + /extend 연장) · capBonus = 연장분 · chainAgeDays = 미머지 체인 나이
    // notes = 스토리별이 아닌 편성 전체의 단서(예: 목업 게이트 미구성)
    _편성: { date: today, picked, excluded, notes: gateNotes, cap, capBonus, chainAgeDays, alreadyPlannedToday: day.planned.length },
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
  console.log('# 편성 ' + info.date + ' — 고름 ' + info.picked.length + ' · 뺌 ' + info.excluded.length + ' · 배치 ' + queue.batches.length +
    ' · 상한 ' + info.cap + (info.capBonus > 0 ? '(연장 +' + info.capBonus + ')' : '') +
    (info.chainAgeDays > 0 ? ' · 체인 ' + info.chainAgeDays + '일' : ''))
  for (const n of info.notes ?? []) console.log('  ! ' + n)
  for (const p of queue._편성.picked) console.log('  V ' + p.key + ' — ' + p.why)
  for (const e of queue._편성.excluded) console.log('  X ' + e.key + ' — ' + e.why)
  if (!dry && out) {
    writeFileSync(resolve(out), JSON.stringify(queue, null, 2) + '\n', 'utf8')
    if (!argv.includes('--no-ledger')) {
      day.planned.push(...queue._편성.picked.map((p) => p.key))
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    }
    console.log('→ 큐: ' + resolve(out) + ' · 오늘 누계 ' + day.planned.length)
  }
}
