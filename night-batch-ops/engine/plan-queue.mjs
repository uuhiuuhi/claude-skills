#!/usr/bin/env node
// 큐 자동 편성기 — 「다음 할 일」을 규칙만으로 고른다. LLM 호출 0.
// 이식판: 프로젝트 고유값(에픽 순서·병행 허용·하루 상한·모델)은 전부
// `tools/auto/auto.config.json` 이 소유한다 — 이 파일에는 프로젝트 이름이 없다.
//
// 실행:
//   node tools/auto/plan-queue.mjs --out <큐파일> [--state <디렉터리>] [--max N] [--dry]
//
// 출력 큐는 night-queue.json 과 같은 스키마 + { planned: 'auto', _편성: {…근거} }.
// 규칙 9종이 전부다 — 여기 없는 판단은 하지 않는다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SHARED_BOOKKEEPING } from './runner-rules.mjs'

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

/** sprint-status.yaml → [{key, status, epic}] (스토리 키 행만 — 주석·벌크 무시) */
export function parseSprint(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = /^ {2}(\d+-\d+[^:]*): *(backlog|ready-for-dev|in-progress|review|done)\b/.exec(line)
    if (m) rows.push({ key: m[1], status: m[2], epic: Number(m[1].split('-')[0]) })
  }
  return rows
}

/** 스토리 파일 판정 재료 */
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

/** epics.md 에서 해당 스토리 절 추출 — 키 4-1-... → 헤더 '### Story 4.1:' */
export function epicSection(epicsText, key) {
  const [a, b] = key.split('-')
  const re = new RegExp('^### Story ' + a + '\\.' + b + ':[^\\n]*\\n([\\s\\S]*?)(?=\\n### Story |\\n## )', 'm')
  return re.exec(epicsText)?.[1] ?? ''
}

/** 목업 게이트: 새 화면 스토리는 approved 목업이 실재해야 후보 */
export function mockupGateOk(section, key, verdicts) {
  if (!(section.includes('새 화면') && section.includes('UX-DR-27'))) return { ok: true }
  const prefix = 'mockups/story-' + key.split('-').slice(0, 2).join('-') + '-'
  const mine = Object.entries(verdicts?.items ?? {}).filter(([k]) => k.startsWith(prefix))
  if (mine.length === 0) return { ok: false, why: '새 화면인데 목업 부재(pending 취급)' }
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
  const PARALLEL_ALLOW = cfg.parallelAllow ?? {} // 예: { "4-0": 11 } — 4-0 은 Epic 11 진행 중에도 후보
  // 상한은 페이스가 아니라 폭주 방지 백스톱이다 — 몫을 다 했다고 남은 슬롯이 쉬면 안 된다
  // (실사고: 상한 12 시절, 오전에 12건 소진 후 남은 슬롯이 통째로 놀았다). 실질 제동은
  // STOP 차단기·결정 대기 제외·사용량 한도 대기·리뷰 게이트가 맡는다.
  const cap = max ?? cfg.dailyCap ?? 30
  const models = cfg.models ?? null // 예: { dev: 'fable', review: 'opus' } — 없으면 CLI 기본 모델

  const ART = join(root, '_bmad-output', 'implementation-artifacts')
  const sprintText = readIf(join(ART, 'sprint-status.yaml'))
  const epicsText = readIf(join(root, '_bmad-output', 'planning-artifacts', 'epics.md')) ?? ''
  const inboxText = readIf(join(ART, 'DECISIONS-INBOX.md')) ?? ''
  const verdicts = JSON.parse(readIf(join(root, 'tools', 'dev-status', 'mockup-verdicts.json')) ?? '{}')
  if (!sprintText) throw new Error('sprint-status.yaml 을 읽지 못했다 — 편성 불가(빈 큐를 정상인 척 내보내지 않는다)')

  // 일일 상한 원장 — 상태 파일은 저장소 밖(워크트리 reset 에 안 쓸린다)
  const statePath = join(stateDir, 'auto-plan-state.json')
  const state = JSON.parse(readIf(statePath) ?? '{}')
  state.days ??= {}
  const day = (state.days[today] ??= { planned: [], stops: 0, consumed: {} })
  const remaining = Math.max(0, cap - day.planned.length)

  const rows = parseSprint(sprintText).filter((r) => r.status !== 'done')
  const excluded = []
  const exclude = (key, why) => excluded.push({ key, why })
  // 무인 편성 누계(원장 전체) — 규칙 9 재료. 오늘·과거를 가리지 않는다(라운드는 날을 넘겨도 라운드다)
  const timesPlanned = (key) =>
    Object.values(state.days).reduce((n, d) => n + (d.planned ?? []).filter((k) => k === key).length, 0)
  for (const r of rows) if (!EPIC_ORDER.includes(r.epic)) exclude(r.key, '에픽 ' + r.epic + ' 은 목표 범위 밖(규칙 1 — epicOrder)')

  const judge = (r) => {
    const section = epicSection(epicsText, r.key)
    if (/⏸|이연 확정/.test(section)) return exclude(r.key, 'epics 이연 확정 문언(⏸) — 편성 제외(규칙 1)'), null
    const text = readIf(join(ART, r.key + '.md'))
    if (text === null) {
      const gate = mockupGateOk(section, r.key, verdicts)
      if (!gate.ok) return exclude(r.key, gate.why + '(규칙 6)'), null
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
    // 규칙 9: 무인 회수는 2라운드까지 — dev↔리뷰가 서로 뒤집기를 반복해도 편성기는 모른다.
    // 상한 소진 스토리는 사람 판단으로 넘긴다(무인 리뷰 비수렴 상한).
    if (recovery && timesPlanned(r.key) >= 2) {
      return exclude(r.key, '무인 편성 2회 소진 — 리뷰 반복은 사람 판단(규칙 9 · 비수렴 상한)'), null
    }
    if (recovery && s.unfinishedTasks === 0 && s.openPatches === 0) {
      // 규칙 10: review 상태 + 고칠 것 0 = **마감 재검수 후보** — 재검수 1회가 통과하면 done,
      // 새 findings 가 나오면 회수 재고가 된다. 종전에는 제외만 해서 미마무리가 영구 적체됐다.
      // in-progress 인데 0/0 인 기형 상태만 종전대로 제외(사람 확인 대상).
      if (r.status === 'review') {
        return { ...r, kind: 'closeout', files: s.files, stages: ['review'], force: true }
      }
      return exclude(r.key, '회수분 0 — force 재실행은 헛돈다(규칙 8)'), null
    }
    if (recovery && s.unfinishedTasks === 0 && s.openPatches > 0) {
      return exclude(r.key, '열린 Patch ' + s.openPatches + '건인데 미완 Task 0 — dev 재투입 전제 미충족(규칙 4 · 라운드 절은 사람이 연다)'), null
    }
    return { ...r, kind: recovery ? 'recovery' : 'new', files: s.files, stages: recovery ? ['dev'] : ['create', 'dev', 'review'], force: recovery }
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
        if (PARALLEL_ALLOW[shortKey] !== currentEpic) { exclude(r.key, '에픽 순서 대기 — Epic ' + currentEpic + ' 후보 잔존(규칙 1)'); continue }
        const got = judge(r)
        if (got) candidates.push(got)
      }
    }
  }

  // 규칙 7: 하루 상한
  const capped = candidates.slice(0, remaining)
  for (const c of candidates.slice(remaining)) exclude(c.key, '하루 상한 ' + cap + ' 도달(오늘 기편성 ' + day.planned.length + ' — 규칙 7)')

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
    updated: today + ' 자동 편성(plan-queue · 상한 ' + cap + ' · 오늘 기편성 ' + day.planned.length + ')',
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
    _편성: { date: today, picked, excluded, cap, alreadyPlannedToday: day.planned.length },
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
  const stateDir = resolve(opt('state', process.env.AUTO_BATCH_STATE_DIR || join(homedir(), '.claude-auto', projectName)))
  mkdirSync(stateDir, { recursive: true })
  const out = opt('out', '')
  const dry = argv.includes('--dry')
  const maxOpt = opt('max', '')
  const { queue, state, statePath, day } = plan({ root: process.cwd(), stateDir, max: maxOpt ? Number(maxOpt) : undefined, config: cfg })
  console.log('# 편성 ' + queue._편성.date + ' — 고름 ' + queue._편성.picked.length + ' · 뺌 ' + queue._편성.excluded.length + ' · 배치 ' + queue.batches.length)
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
