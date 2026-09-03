#!/usr/bin/env node
// autofinish.mjs — 자율 마무리(Autonomous Finish) **진입 CLI + 라운드 통제** (2026-09-02 · 설계서 §1-7·§4)
//
// 무엇인가: 「지금 상태를 파악하고 배포 가능한 수준까지 자율적으로 마무리해줘」 한 줄이 들어왔을 때
// 실제로 도는 루프다. 스스로 코드를 고치지 않는다 — **진단(diagnose) → 작업항목(backlog) → 질문(decisions)
// → BMAD 등재(bmad-sync) → 계획(plan-dag·orchestrate) → 큐(run-night --queue)** 로 이어 붙이고,
// 라운드마다 진전이 있었는지만 판정한다(loopDecision).
//
// 이 파일이 **부수효과 집중부**다: 게이트 spawn · 러너 spawn · 산출물 쓰기 · 대상 저장소 쓰기(bmad-sync 경유).
// 나머지 모듈은 전부 순수하거나 읽기 전용이다. 그래서 안전 경계도 여기 한 곳에 모여 있다:
//   ① `--diagnose-only` 는 대상 저장소에 **한 바이트도** 쓰지 않는다(게이트 0 · 러너 0 · bmad 쓰기 0).
//   ② 러너는 언제나 `run-night.mjs --queue <경로>` 로만 부른다 — 기존 계약(워크트리·auto/* 브랜치·커밋 가드)을
//      그대로 물려받고, main 직접 작업은 이 파일 어디에도 없다.
//   ③ 경로·모델 인자는 `providers/spawn-safe` 의 검증기를 통과해야 하고, 실행은 전부 argv 분리(`shell:false`)다.
//   ④ 산출물(JSON·보고서)은 쓰기 직전에 다시 마스킹한다 — 시크릿 원문은 어디에도 남기지 않는다.
//   ⑤ 커밋·푸시·머지·배포는 하지 않는다. 「배포 가능한 상태」와 「배포」는 다른 말이다(SPEC 머리말).
//
// 게이트 예산(설계 §2-3): 라운드마다 qa 1회 + 마지막에 전 게이트 1회 = **qa 총 라운드+1회**.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { deepRedact, diagnose, maskSecrets, readProject, runGateProbe } from './diagnose.mjs'
import { buildBacklog, classifyFailure, hazardOptsFor, mergeBacklog, selectRunnable } from './backlog.mjs'
import { applyBmadWrites, collectTexts, mapToStories, planBmadWrites } from './bmad-sync.mjs'
import { blockedMap, buildQuestion, inboxWritePlan, needsHuman, pendingKeys, questionFingerprint } from './decisions.mjs'
import { projectReadiness, taskReadiness } from './readiness.mjs'
import { buildReport, renderReportJson, renderReportMd } from './report.mjs'
import { buildDag, isValidModelSpec, parseDependsOn, validatePlan } from './plan-dag.mjs'
import { DEFAULT_PLAN_TIMEOUT_MS, makeClaudePlanRunner, requestPlan } from './orchestrate.mjs'
import { spawnWithDeadline } from './spawn-deadline.mjs'
import { assignWorkers } from './assign.mjs'
import { parallelHazardsExtended } from './conflicts.mjs'
import { summarizeTimeline } from './metrics.mjs'
import { resolveAsf } from './asf-resolve.mjs'
const { escalationReport } = await import(resolveAsf('quality-rules.mjs'))
const { assertSafeModel, assertSafePath } = await import(resolveAsf('providers/spawn-safe.mjs'))

const HERE = dirname(fileURLToPath(import.meta.url))

export const AUTOFINISH_SCHEMA = 'night-batch-ops/autofinish/1'

/** 기본값 — `auto.config.json` 의 `autofinish` 블록이 덮어쓴다(설계 §10 착수 전 확인). */
export const DEFAULTS = Object.freeze({
  maxRounds: 3,
  budgetMin: 480,
  gates: Object.freeze(['qa']),
  bmadWrites: 'plan',
  planModel: 'fable',
  maxNewStories: 3,
  batchMax: 2,
  parallel: 2,
  cap: 4,
})

const GATE_NAME_RE = /^[a-z][a-z0-9:_-]{0,30}$/
const arr = (a) => (Array.isArray(a) ? a : [])
const uniq = (a) => [...new Set(a)]
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

/** 설정·인자 거부 — 부작용 0 으로 끊고 **종료 코드 2**(인자 거부와 같은 자리)로 나간다. */
export class ConfigRejected extends Error {
  constructor(message) { super(message); this.name = 'ConfigRejected'; this.exitCode = 2 }
}

// ── 거부 규칙 ① 푸시는 설정으로도 켤 수 없다 (codex-review-r4 NEW-H1) ────────
/**
 * 큐의 `defaults.push` 는 **항상 false** 다. 설정(`autofinish.queueDefaults.push`)에 `true` 가 있으면
 * 조용히 무시하지 않고 **거부**한다 — 무시는 「켰다고 믿는 사람」을 만들고, 그 믿음이 다음 사고다.
 * 외부로 나가는 것(push·머지·배포·발송)은 언제나 사람 승인이다(SPEC §8).
 */
export function assertQueueDefaultsSafe(defaults = {}, where = 'autofinish.queueDefaults') {
  if (defaults && defaults.push !== undefined && Boolean(defaults.push)) {
    throw new ConfigRejected(`${where}.push 는 켤 수 없다 — 외부 반영은 사람 승인이다(자율 마무리는 푸시하지 않는다)`)
  }
  return true
}

// ── 거부 규칙 ③ state·out 은 대상 저장소 밖이어야 한다 (NEW-H3) ──────────────
const sameOrInside = (child, parent) => {
  const k = (x) => (process.platform === 'win32' ? resolve(x).toLowerCase() : resolve(x))
  const c = k(child), p = k(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}
/** 가장 가까운 **기존** 조상까지 거슬러 올라가 realpath 로 해석한다(없는 경로도 판정할 수 있게). */
function nearestReal(target, fs) {
  let cur = resolve(target)
  for (;;) {
    try { return fs.realpathSync(cur) } catch {
      const up = dirname(cur)
      if (up === cur) return null
      cur = up
    }
  }
}
/**
 * `--state`·`--out` 이 대상 저장소 **안**을 가리키면 거부한다(NEW-H3).
 * 세 갈래로 본다 — ① 문자열 포함 ② realpath 포함(가장 가까운 기존 조상 기준)
 * ③ 경로 구간의 symlink/junction 이 저장소 안을 가리키는 경우(`bmad-sync.realPathAllowed` 와 같은 방식).
 * `~/.baroos-auto/autofinish` 나 `AUTO_BATCH_STATE_DIR` 같은 **기본값도 같은 잣대**로 본다.
 */
export function assertOutsideRepo(root, target, label, { fs = { realpathSync, lstatSync } } = {}) {
  const abs = resolve(String(target ?? ''))
  const rootAbs = resolve(String(root ?? '.'))
  const rootReal = nearestReal(rootAbs, fs) ?? rootAbs
  const deny = (why) => { throw new ConfigRejected(`${label} 은 대상 저장소 안에 둘 수 없다 — ${why}: ${abs}`) }

  if (sameOrInside(abs, rootAbs) || sameOrInside(abs, rootReal)) deny('산출물이 대상 저장소를 더럽힌다')

  // 경로 구간 링크 — 저장소 밖처럼 보이는 경로가 링크로 안을 가리킬 수 있다
  const parts = abs.split(sep).filter(Boolean)
  let cur = abs.startsWith(sep) ? sep : ''
  for (const seg of parts) {
    cur = cur === sep ? sep + seg : cur ? cur + sep + seg : seg
    let st = null
    try { st = fs.lstatSync(cur) } catch { st = null } // 아직 없는 구간은 링크일 수 없다
    if (!st || !st.isSymbolicLink()) continue
    const real = nearestReal(cur, fs)
    if (real && (sameOrInside(real, rootAbs) || sameOrInside(real, rootReal))) {
      deny(`경로 구간 「${seg}」 이 링크(symlink·junction)로 저장소 안을 가리킨다`)
    }
  }

  const real = nearestReal(abs, fs)
  if (real && (sameOrInside(real, rootAbs) || sameOrInside(real, rootReal))) deny('실제 경로가 저장소 안이다(링크·마운트)')
  return abs
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 인자 — 셸 메타문자·형식 위반은 **실행 전에** 거부한다(BRIEF 정책 8)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `process.argv.slice(2)` → 옵션 객체. 위반은 throw(부작용 0 · 프로세스도 파일도 만들지 않는다).
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const val = (n, d = null) => {
    const i = argv.indexOf(`--${n}`)
    if (i < 0) return d
    const v = argv[i + 1]
    return v !== undefined && !String(v).startsWith('--') ? String(v) : d
  }
  const has = (n) => argv.includes(`--${n}`)
  const posNum = (n, d) => {
    const v = val(n, null)
    if (v === null) return d
    const x = Number(v)
    if (!Number.isFinite(x) || x <= 0) throw new Error(`--${n} 은 양수여야 한다: ${JSON.stringify(v)}`)
    return x
  }

  const root = assertSafePath(val('root', '.'), '--root 경로')
  const state = val('state', null)
  if (state !== null) assertSafePath(state, '--state 경로')
  const out = val('out', null)
  if (out !== null) assertSafePath(out, '--out 경로')

  const planModel = assertSafeModel(val('plan-model', DEFAULTS.planModel), '--plan-model 모델')
  if (!isValidModelSpec(planModel)) throw new Error(`--plan-model 모델 스펙 형식 위반: ${JSON.stringify(planModel)}`)

  const gatesRaw = val('gates', null)
  const noGates = has('no-gates')
  // ── 거부 규칙 ④ 상충하는 게이트 플래그 (codex-review-r5 Low · r6 재지적) ───
  // `--gates qa --no-gates` 를 「--no-gates 승」으로 조용히 처리하면 사람은 **자기가 적은 qa 가 돌았다**고
  // 읽는다(안전하게 안 돌긴 하지만, 문서 계약은 「함께 쓸 수 없다」다). 모드와 무관하게 거부한다 —
  // `--diagnose-only --gates qa --no-gates` 도 여기서 걸린다.
  //
  // 판정 기준은 **값이 아니라 플래그의 존재**(`has`)다(codex-review-r6 Low). 예전엔 `gatesRaw !== null`
  // 로 봤는데, `--gates --no-gates` 는 다음 토큰이 `--` 로 시작해 값이 null 이 되고, 그래서 상충이
  // 아닌 것으로 통과해 조용히 `--no-gates` 가 이겼다 — 고치려던 바로 그 오독이다.
  if (has('gates') && noGates) {
    throw new Error('--gates 와 --no-gates 는 함께 쓸 수 없다 — 돌릴 검사를 적든지 끄든지 하나만 준다')
  }
  // 값 없는 `--gates` 자체도 거부한다 — 조용히 기본 게이트로 돌리면 사람이 적으려던 목록이 사라진다.
  if (has('gates') && gatesRaw === null) {
    throw new Error('--gates 에 값이 없습니다 — 돌릴 검사를 쉼표로 적는다(예: --gates qa,security)')
  }
  let gates = gatesRaw === null ? [...DEFAULTS.gates] : uniq(gatesRaw.split(',').map((s) => s.trim()).filter(Boolean))
  for (const g of gates) if (!GATE_NAME_RE.test(g)) throw new Error(`--gates 이름 거부(형식 위반): ${JSON.stringify(g)}`)
  if (noGates) gates = []

  // ── 거부 규칙 ② 진단 전용은 실행 0 이다 (NEW-H2) ──────────────────────────
  // `--diagnose-only --gates qa` 를 조용히 무시하면 사람은 「검사도 돌았다」고 읽는다. 반대로 돌려 주면
  // `npm run <게이트>` 가 대상 저장소 cwd 에서 임의 쓰기(코드젠·포맷)를 할 수 있어 읽기 전용이 깨진다.
  const diagnoseOnly = has('diagnose-only')
  if (diagnoseOnly && gatesRaw !== null) {
    throw new Error('--diagnose-only 는 진단 전용이라 실행이 0 이다 — --gates 를 함께 줄 수 없다(빼거나 --diagnose-only 를 뺀다)')
  }
  if (diagnoseOnly) gates = []

  const bmadWrites = val('bmad-writes', DEFAULTS.bmadWrites)
  if (!['on', 'plan'].includes(bmadWrites)) throw new Error(`--bmad-writes 는 on|plan 만 된다: ${JSON.stringify(bmadWrites)}`)

  return {
    root,
    diagnoseOnly,
    dryRun: has('dry-run'),
    maxRounds: posNum('max-rounds', DEFAULTS.maxRounds),
    budgetMin: posNum('budget-min', DEFAULTS.budgetMin),
    gates,
    gatesExplicit: gatesRaw !== null && !diagnoseOnly,
    noGates,
    state,
    out,
    bmadWrites,
    planModel,
  }
}

/** 상태 폴더 기본값 — **대상 저장소 밖**이다(진단만 돌려도 저장소가 더러워지지 않게). */
export const defaultStateDir = () => process.env.AUTO_BATCH_STATE_DIR || join(homedir(), '.baroos-auto', 'autofinish')

// ═══════════════════════════════════════════════════════════════════════════
// ② loopDecision — 언제 멈추고 언제 사람을 부르는가 (설계 §4-3)
// ═══════════════════════════════════════════════════════════════════════════

/** 백로그·진단 어느 쪽을 줘도 같은 요약으로 읽는다. */
export function roundSummary(x) {
  if (!x) return { fingerprint: null, critical: 0, signature: null }
  const tiers = x.byTier ?? x.counts?.findings ?? {}
  const critical = [1, 2, 3].reduce((a, t) => a + (Number(tiers[t]) || 0), 0)
  return {
    fingerprint: x.fingerprint ?? null,
    critical: Number.isFinite(x.critical) ? x.critical : critical,
    signature: x.signature ?? null,
  }
}

/**
 * 라운드 사이 판정.
 * @param {{round:number, before:object, after:object, cfg?:object}} o
 *   before/after = 백로그(또는 진단) · cfg = `{maxRounds,budgetMin,elapsedMin,signatures[]}`
 * @returns {{action:'continue'|'stop'|'escalate', why:string, code:string}}
 *
 * 순서: **위험(escalate)을 먼저 본다.** 라운드 상한에 걸렸다는 이유로 「같은 원인 3회」를 삼키면
 * 사람이 받는 것은 「그냥 끝났다」뿐이라, 다음 밤도 같은 자리에서 선다.
 */
export function loopDecision({ round = 0, before = null, after = null, cfg = {} } = {}) {
  const b = roundSummary(before)
  const a = roundSummary(after)
  const maxRounds = num(cfg.maxRounds) ?? DEFAULTS.maxRounds
  const budgetMin = num(cfg.budgetMin) ?? DEFAULTS.budgetMin
  const elapsedMin = num(cfg.elapsedMin) ?? 0
  const signatures = arr(cfg.signatures).map(String).filter(Boolean)

  // ① 상위 3단계(비밀·데이터·인증 / 빌드·실행 / 배포 차단)가 **늘었다** — 고치다 더 망가뜨렸다는 뜻이다.
  if (b.fingerprint !== null && a.critical > b.critical) {
    return { action: 'escalate', code: 'critical-increase', why: `상위 3단계 문제가 ${b.critical}건 → ${a.critical}건으로 늘었다 — 자동 진행을 멈추고 사람을 부른다` }
  }
  // ② 같은 원인으로 세 번 막혔다 — 네 번째도 같다.
  const repeated = signatures.filter((s) => s && s === a.signature).length
  if (a.signature && repeated >= 3) {
    return { action: 'escalate', code: 'repeat-signature', why: `같은 원인(${a.signature})으로 ${repeated}회 막혔다 — 무한 재시도 금지(SPEC §8)` }
  }
  // ③ 라운드 상한
  if (round >= maxRounds) {
    return { action: 'stop', code: 'max-rounds', why: `라운드 상한 ${maxRounds} 에 도달했다 — 남은 것은 보고서로 넘긴다` }
  }
  // ④ 무진전 — 백로그 지문이 그대로면 한 번 더 돌려도 같은 결과다.
  if (b.fingerprint !== null && a.fingerprint !== null && b.fingerprint === a.fingerprint) {
    return { action: 'stop', code: 'no-progress', why: '지난 라운드와 남은 문제가 한 건도 달라지지 않았다 — 더 돌려도 같다' }
  }
  // ⑤ 예산
  if (elapsedMin > budgetMin) {
    return { action: 'stop', code: 'budget', why: `예산 ${budgetMin}분을 넘겼다(${Math.round(elapsedMin)}분) — 여기서 끊고 보고한다` }
  }
  return { action: 'continue', code: 'continue', why: '진전이 있고 예산·상한 안이다 — 계속한다' }
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 후보 · 결정적 계획 · 큐
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 백로그 → 편성 후보. **원장(sprint)에 실재하고 md 가 있는 스토리**만 후보다 —
 * 러너·엔진이 스토리 키로 파일을 찾기 때문이다. 자동 수리 금지 범주(이월 금지 5범주)는 뺀다.
 */
export function candidatesFrom({ backlog, snapshot, texts = {}, cap = DEFAULTS.cap, blocked = {}, blockedWhy = {} } = {}) {
  const byKey = new Map(arr(snapshot?.stories).map((s) => [s.key, s]))
  // 봉쇄 판정은 **여기서** 한다 — `selectRunnable` 에 넘겨 먼저 걸러 버리면 「왜 빠졌나」가 사라진다.
  // 아침 브리핑이 읽는 것은 결과가 아니라 사유다(2026-09-03 실측: 봉쇄가 조용히 증발했다).
  const picked = selectRunnable(backlog, { cap: cap * 5 })
  const out = []
  const seen = new Set()
  const excluded = []
  let unlinked = 0
  // 봉쇄 사유는 기본이 「결정 대기」다. 다른 이유(BMAD 등재 폐기 등)는 `blockedWhy` 로 문장을 그대로 준다.
  for (const [key, why] of Object.entries(blocked)) excluded.push({ key, why: blockedWhy[key] ?? `결정 대기로 봉쇄됐다 — ${why}` })
  for (const b of arr(backlog?.blocked)) if (!blocked[b.key]) excluded.push({ key: b.key, why: b.why })
  for (const item of picked) {
    if (out.length >= cap) break
    const key = item.story
    if (!key) { unlinked++; continue }
    if (seen.has(key)) continue
    const st = byKey.get(key)
    if (blocked[key]) { seen.add(key); continue } // 사유는 위에서 이미 남겼다
    if (item.autoFixAllowed === false) { excluded.push({ key, why: '무인 수리 금지 범주(보안·개인정보·데이터 손실·결제·외부 발송) — 사람 판단 대상' }); continue }
    if (!st?.exists) { excluded.push({ key, why: '스토리 md 가 없다 — 러너가 열 파일이 없다' }); continue }
    seen.add(key)
    out.push({
      key,
      epic: st.epic ?? item.epic ?? null,
      kind: 'recovery',
      stages: ['dev', 'review'],
      files: arr(st.fileList?.declared),
      deps: texts[st.path] ? parseDependsOn(texts[st.path]) : [],
      difficulty: item.difficulty ?? null,
      risk: item.risk ?? null,
      item,
    })
  }
  // 스토리에 매이지 않은 항목은 한 줄로 모은다 — 백로그 절반이 사유 목록이 되면 아무도 안 읽는다.
  if (unlinked > 0) excluded.push({ key: '(스토리 밖)', why: `스토리에 매이지 않은 항목 ${unlinked}건 — BMAD 등재 뒤 다음 라운드에 후보가 된다` })
  return { candidates: out, excluded }
}

/**
 * 규칙 계획(결정적) — Fable 이 못 내거나 계획이 거부됐을 때 **말없이** 이것으로 돌아간다.
 * 위상 순서대로 훑되 ① 같은 배치 안 의존 간선 금지 ② 파일·보수 범주 충돌이면 배치를 나눈다.
 */
export function deterministicPlan({ candidates = [], dag = null, batchMax = DEFAULTS.batchMax, hazardOpts = {}, models = {} } = {}) {
  const byKey = new Map(candidates.map((c) => [c.key, c]))
  const order = arr(dag?.order).filter((k) => byKey.has(k))
  for (const c of candidates) if (!order.includes(c.key)) order.push(c.key)
  const edges = arr(dag?.edges)
  const linked = (a, b) => edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))

  // 한 배치는 모델 한 벌을 쓴다(큐 형식이 배치 단위다) — 배정이 다르면 묶지 않는다.
  // 묶으면 뒤 스토리의 교차 리뷰 제공자가 조용히 앞 스토리의 것으로 바뀐다(2026-09-03 실측).
  const sameModels = (a, b) => JSON.stringify(models[a] ?? null) === JSON.stringify(models[b] ?? null)

  const batches = []
  for (const key of order) {
    const c = byKey.get(key)
    const last = batches[batches.length - 1]
    const fits = last && last.stories.length < Math.max(1, batchMax) &&
      sameModels(last.stories[0], key) &&
      !last.stories.some((k) => linked(k, key)) &&
      parallelHazardsExtended([...last.stories.map((k) => byKey.get(k)?.files ?? []), c.files ?? []], hazardOpts).parallelOk
    if (fits) last.stories.push(key)
    else batches.push({ label: '', stories: [key], stages: c.stages ?? ['dev', 'review'] })
  }
  return {
    source: 'deterministic',
    batches: batches.map((b, i) => ({
      label: `AF-${i + 1}: ${b.stories.join(' · ')}`,
      stories: b.stories,
      stages: b.stages,
      ...(models[b.stories[0]] ? { models: models[b.stories[0]] } : {}),
    })),
  }
}

/**
 * 계획 → `run-night --queue` 가 그대로 먹는 큐 JSON.
 * 스키마는 `plan-queue.mjs` 산출물과 **같다**(planned·updated·defaults·batches·validation·_편성).
 * `planned` 만 `'autofinish'` 로 달라진다 — 러너의 「사람이 쓴 큐가 이긴다」 갈래를 타기 위해서다.
 */
export function buildQueueFromPlan(plan, backlog = null, snapshot = null, opts = {}) {
  const {
    date = new Date().toISOString().slice(0, 10),
    round = 0,
    source = plan?.source ?? 'deterministic',
    validation = null,
    excluded = [],
    notes = [],
    models = {},
    defaults = {},
  } = opts
  const cfg = snapshot?.config ?? {}
  assertQueueDefaultsSafe(defaults, 'autofinish.queueDefaults') // 마지막 방어선 — 큐에는 push 가 실릴 수 없다
  const parallel = num(defaults.parallel) ?? num(cfg.parallel) ?? DEFAULTS.parallel
  const batches = arr(plan?.batches).map((b, i) => {
    const stories = arr(b.stories).map(String)
    const m = b.models ?? models[stories[0]] ?? null
    return {
      label: b.label || `AF-${i + 1}: ${stories.join(' · ')}`,
      enabled: true,
      stories,
      stages: arr(b.stages).length ? b.stages : ['dev', 'review'],
      ...(m ? { models: m } : {}),
      ...(Number.isInteger(b.parallel) ? { parallel: b.parallel } : {}),
    }
  })
  const picked = batches.flatMap((b) => b.stories.map((k) => ({ key: k, why: `자율 마무리 라운드 ${round} — 계획 출처 ${source}` })))
  return {
    planned: 'autofinish',
    updated: `${date} 자율 마무리 라운드 ${round}(계획 ${source} · 스토리 ${picked.length})`,
    defaults: {
      waitAuthMin: num(defaults.waitAuthMin) ?? 480,
      stageTimeoutMin: num(defaults.stageTimeoutMin) ?? 150,
      // 커밋은 러너 계약대로 워크트리·`auto/*` 브랜치에서만 일어난다. **push 는 설정으로도 못 켠다** —
      // 외부로 나가는 것은 사람 승인이다(SPEC §8 · NEW-H1). 값은 리터럴 `false` 고, 설정에 `true` 가
      // 있었다면 위 `assertQueueDefaultsSafe` 가 이미 거부해 여기까지 오지 않는다.
      commit: defaults.commit !== undefined ? Boolean(defaults.commit) : true,
      push: false,
      parallel,
    },
    batches,
    validation: validation ?? { ok: true, errors: [], warnings: [] },
    _편성: {
      date,
      picked,
      excluded: arr(excluded),
      notes: arr(notes),
      cap: num(cfg.dailyCap) ?? picked.length,
      capBonus: 0,
      chainAgeDays: 0,
      alreadyPlannedToday: 0,
      autofinish: { round, source, backlog: backlog?.fingerprint ?? null },
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 산출물 — 쓰기 직전에 다시 마스킹한다
// ═══════════════════════════════════════════════════════════════════════════

// 마스킹은 **공용 단일 소스** 하나다(codex-review-r3 H1) — `diagnose.mjs` 가 재수출하는
// `redactSecrets` 그물을 그대로 쓴다. 여기서 따로 정의하면 진단·보고서와 그물이 갈린다.
const maskDeep = deepRedact

/** tmp → rename. 부분 파일을 남기지 않는다. */
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
  return path
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ runAutoFinish — 루프
// ═══════════════════════════════════════════════════════════════════════════

const stampOf = (d) => `${d.toISOString().slice(0, 10)}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`

/** 러너 경로 — 대상 저장소의 설치본이 있으면 그것을 쓴다(그 저장소의 계약이 진실이다). */
export function resolveRunner(root, override = null) {
  const cand = override ?? join(root, 'tools', 'auto', 'run-night.mjs')
  if (existsSync(cand)) return assertSafePath(cand, '러너 경로')
  return assertSafePath(join(HERE, 'run-night.mjs'), '러너 경로')
}

/**
 * @param {object} opts parseArgs 결과 + 주입(`exec`·`spawnRunner`·`planRunner`·`now`·`log`·`runId`·`runner`)
 * @returns {Promise<{exitCode:number, report:object, rounds:object[], outDir:string, reportPath:string, gateCalls:object}>}
 */
export async function runAutoFinish(opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const root = resolve(assertSafePath(o.root ?? '.', '--root 경로'))
  const nowFn = typeof o.now === 'function' ? o.now : () => new Date()
  const startedAt = nowFn()
  const runId = o.runId ?? stampOf(startedAt)
  const stateDir = resolve(o.state ?? defaultStateDir())
  const outDir = join(stateDir, 'autofinish', runId)
  const reportPath = resolve(o.out ?? join(outDir, 'report.md'))
  // 게이트·러너 spawn 은 **같은 헬퍼**를 쓴다(codex-review-r6 Medium) — timeout 이 걸리면
  // `taskkill /T`(win32) · 프로세스 그룹 SIGKILL(POSIX) 로 트리를 끊고 즉시 반환한다.
  // 주입 스텁은 동기 값이어도 그대로 산다(`await` 가 값도 통과시킨다).
  const exec = o.exec ?? spawnWithDeadline
  const spawnRunner = o.spawnRunner ?? spawnWithDeadline
  // 콘솔로 나가는 **모든 줄**은 공용 마스커를 지난다(NEW-H4) — 외부 도구의 stderr 한 줄이
  // 그대로 재출력되면 산출물 JSON 을 아무리 마스킹해도 터미널·CI 로그에 원문이 남는다.
  const rawLog = o.log ?? ((m) => console.log(m))
  const log = (m) => rawLog(maskSecrets(typeof m === 'string' ? m : String(m)))
  const diagnoseOnly = Boolean(o.diagnoseOnly)
  const dryRun = Boolean(o.dryRun)
  // 진단 전용은 게이트를 **돌리지 않는다**(빈 배열). 명시 `--gates` 는 조용히 무시하지 않고 거부한다.
  if (diagnoseOnly && o.gatesExplicit) {
    throw new ConfigRejected('--diagnose-only 는 진단 전용이라 실행이 0 이다 — --gates 를 함께 줄 수 없다')
  }
  const gates = diagnoseOnly ? [] : arr(o.gates)

  // 거부 규칙 ①③ — 부작용(폴더 생성·게이트·러너) **이전에** 본다.
  assertQueueDefaultsSafe(rawConfigAt(root)?.autofinish?.queueDefaults ?? {}, 'auto.config.json 의 autofinish.queueDefaults')
  assertOutsideRepo(root, stateDir, '--state 상태 폴더')
  assertOutsideRepo(root, reportPath, '--out 보고서 경로')

  // 예산은 **절대 deadline** 이다(NEW-M2 · codex-review-r5 Medium) — 「넘기면 그 자리에서 끊는다」가
  // 문서 계약이라, ① 모든 게이트·러너·계획 spawn 의 timeout 을 `min(개별 상한, 잔여)` 로 자르고
  // ② spawn **직전**에 잔여를 보고 ③ spawn **직후**에 다시 본다(자식이 마감을 넘겨 끝났을 수 있다)
  // ④ 라운드 진입·대상 저장소 쓰기(BMAD 등재)·계획 생성 앞에서도 본다.
  // 그래서 예산이 다한 뒤에는 **대상 저장소 쓰기 0 · 러너 0 · 라운드 진입 0** 이다.
  const budgetMin = num(o.budgetMin) ?? DEFAULTS.budgetMin
  const deadlineMs = startedAt.getTime() + budgetMin * 60_000
  const remainingMs = () => deadlineMs - nowFn().getTime()
  const budget = { budgetMin, deadline: new Date(deadlineMs).toISOString(), exhausted: false, stops: [] }
  // 건너뛴 단계는 보고서 ⑧「확인하지 못한 것」으로도 나간다 — 안 돌린 검사를 통과로 세지 않기 위해서다.
  const budgetSkipped = []
  /** @param {'skip'|'after'} mode skip = 안 돌리고 접었다 / after = 돌긴 했는데 끝났을 때 이미 마감 뒤였다 */
  const budgetStop = (where, mode = 'skip') => {
    budget.exhausted = true
    const why = mode === 'after'
      ? `예산 소진 — ${budgetMin}분을 다 썼다. ${where} 이(가) 끝난 시점에 이미 마감을 넘겼다`
      : `예산 소진 — ${budgetMin}분을 다 썼다. ${where} 을(를) 건너뛴다`
    if (!budget.stops.includes(why)) budget.stops.push(why)
    if (mode === 'skip' && !budgetSkipped.some((s) => s.what === where)) budgetSkipped.push({ what: where, why })
    log(`[BUDGET] ${why}`)
    return why
  }

  mkdirSync(outDir, { recursive: true })
  const artifacts = []
  const writeJson = (name, data) => { artifacts.push(name); return writeAtomic(join(outDir, name), JSON.stringify(maskDeep(data), null, 2) + '\n') }
  const writeText = (name, text) => { artifacts.push(name); return writeAtomic(join(outDir, name), maskSecrets(text)) }

  const gateCalls = {}
  const GATE_MAX_MS = 20 * 60_000
  const runGate = async (name, snapshot, tag) => {
    // spawn **직전**에 잔여 예산을 본다 — 0 이하면 돌리지 않고 `available:false` 로 접는다.
    const left = remainingMs()
    if (left <= 0) {
      const why = budgetStop(`게이트 ${name}`)
      return { name, script: null, cmd: null, available: false, exit: null, ms: 0, timedOut: false, source: 'gate', log: '', logPath: null, failure: null, why }
    }
    // `runGateProbe` 가 받는 것은 **스크립트 이름**이다(`npm run <이름>`) — 명령 문자열을 넘기면
    // `&&` 가 섞여 셸 메타문자 거부에 걸린다. 없는 게이트는 null 을 넘겨 `available:false` 로 만든다.
    const known = snapshot?.scripts?.gates?.[name]
    const script = known?.available ? (known.script ?? name) : (snapshot?.scripts?.all?.[name] ? name : null)
    const g = await runGateProbe({ root, name, script, exec, logDir: outDir, timeoutMs: Math.min(GATE_MAX_MS, left) })
    gateCalls[name] = (gateCalls[name] ?? 0) + 1
    const { log: body, ...meta } = g
    writeJson(`gate-${tag}-${name}.json`, meta)
    if (body) writeText(`gate-${tag}-${name}.log`, body)
    log(`[GATE] ${name} ${g.available === false ? 'n/a' : `exit ${g.exit} (${g.ms}ms)`}`)
    // spawn **직후** 재확인 — 게이트가 마감을 먹고 끝났으면 그 사실이 여기서 기록돼야 한다.
    if (remainingMs() <= 0) budgetStop(`게이트 ${name}`, 'after')
    return g
  }

  const rounds = []
  const diagnoses = []
  let prevDiagnosis = null
  let backlog = null
  let escalation = null
  let lastSnapshot = null
  let questions = []
  let bmadApplied = null
  const signatures = []
  const events = [{ kind: 'batch', start: startedAt.toISOString(), end: null }]
  const stageEvents = []

  const maxRounds = diagnoseOnly ? 1 : Math.max(1, num(o.maxRounds) ?? DEFAULTS.maxRounds)

  for (let round = 0; round < maxRounds; round++) {
    // 라운드 **진입 전** 마감 확인 — 남은 시간이 없으면 스냅숏도 뜨지 않는다(다음 라운드는 통째로 초과분이다).
    if (remainingMs() <= 0) { budgetStop(`라운드 ${round}`); break }
    const rec = { round, at: nowFn().toISOString(), gates: {}, decision: null, plan: null, queue: null, runner: null }
    const snapshot = readProject(root, { now: nowFn() })
    lastSnapshot = snapshot
    writeJson(`round-${round}-snapshot.json`, snapshot)

    // 게이트 — 일반 실행은 라운드마다 qa 1회. `--diagnose-only` 는 **언제나 0회**(NEW-H2:
    // `npm run <게이트>` 는 코드젠·포맷으로 대상 저장소에 쓸 수 있어 읽기 전용 보증이 깨진다).
    const roundGates = {}
    if (!diagnoseOnly && gates.includes('qa')) {
      roundGates.qa = await runGate('qa', snapshot, `r${round}`)
    }
    for (const [name, g] of Object.entries(roundGates)) {
      rec.gates[name] = { exit: g.exit, ms: g.ms, available: g.available }
      stageEvents.push({ kind: 'stage', stage: name === 'qa' ? 'qa' : name, story: '', provider: 'local', ms: g.ms, exit: g.exit ?? 0 })
      if (g.available !== false && g.exit !== 0) {
        const f = classifyFailure({ stage: name, exit: g.exit, qaLog: g.log ?? '' })
        rec.failure = { kind: f.kind, signature: f.signature, action: f.action, retry: f.retry }
        signatures.push(f.signature)
      }
    }

    const diagnosis = diagnose(snapshot, { gates: roundGates, prevDiagnosis, round, now: nowFn() })
    writeJson(`round-${round}-diagnosis.json`, diagnosis)
    diagnoses.push(diagnosis)

    const next = buildBacklog({ diagnosis, snapshot, config: rawConfig(snapshot), round })
    backlog = round === 0 ? next : mergeBacklog(backlog, next)
    writeJson(`round-${round}-backlog.json`, backlog)
    rec.counts = { findings: diagnosis.counts.findingsTotal, open: backlog.counts?.open ?? backlog.items.length, closed: arr(backlog.closed).length }
    rec.fingerprint = backlog.fingerprint

    // 라운드 1+ — 계속할지 여기서 정한다(라운드 0 은 언제나 실행한다).
    if (round > 0) {
      const elapsedMin = (nowFn().getTime() - startedAt.getTime()) / 60_000
      const d = loopDecision({
        round,
        before: { ...rounds[rounds.length - 1].summary },
        after: { fingerprint: backlog.fingerprint, critical: criticalOf(diagnosis), signature: rec.failure?.signature ?? null },
        cfg: { maxRounds, budgetMin: o.budgetMin, elapsedMin, signatures },
      })
      rec.decision = d
      log(`[LOOP] 라운드 ${round} — ${d.action}: ${d.why}`)
      if (d.action !== 'continue') {
        if (d.action === 'escalate') {
          escalation = escalationReport({
            story: '(프로젝트 전체)',
            stage: `자율 마무리 라운드 ${round}`,
            situation: d.why,
            cause: rec.failure?.action ?? '진단이 낸 상위 단계 문제가 줄지 않았다',
            tried: rounds.map((r) => `라운드 ${r.round}: 남은 문제 ${r.counts?.open ?? '?'}건 · 계획 ${r.plan?.source ?? '-'}`),
            options: ['사람이 해당 항목을 직접 판단한다', '봉쇄된 스토리를 빼고 나머지만 다시 돌린다', '이번 회차를 접고 다음 밤으로 넘긴다'],
            recommendation: '결정 인박스의 대기 항목을 먼저 확정한 뒤 다시 돌린다',
            risk: 'high',
          })
          writeText('escalation.md', escalation)
        }
        rec.summary = { fingerprint: backlog.fingerprint, critical: criticalOf(diagnosis), signature: rec.failure?.signature ?? null }
        rounds.push(rec)
        break
      }
    }

    rec.summary = { fingerprint: backlog.fingerprint, critical: criticalOf(diagnosis), signature: rec.failure?.signature ?? null }

    if (diagnoseOnly) {
      // 읽기 전용이어도 「사람이 정해 줘야 넘어가는 것」은 낸다(계산만 한다 — 인박스에 쓰지 않는다).
      const inboxText = collectTexts(root, [snapshot.paths?.inbox])[snapshot.paths?.inbox] ?? ''
      questions = collectQuestions({ snapshot, diagnosis, backlog, inboxText, round, now: nowFn() }).questions
      writeJson(`round-${round}-questions.json`, { questions, inboxPlan: { ok: false, op: 'skip', why: '--diagnose-only — 인박스에 쓰지 않는다' } })
      rounds.push(rec)
      break
    }

    // ── 실행부 ────────────────────────────────────────────────────────────
    const step = await executeRound({
      root, round, snapshot, diagnosis, backlog, opts: o, dryRun,
      writeJson, writeText, log, spawnRunner, nowFn, stageEvents,
      runner: resolveRunner(root, o.runner ?? null),
      remainingMs, budgetStop,
    })
    questions = step.questions
    bmadApplied = step.bmadApplied ?? bmadApplied
    rec.plan = { source: step.planSource, batches: step.plan.batches.length, validation: step.validation?.ok ?? null }
    rec.queue = step.queuePath
    rec.runner = step.runner
    rec.bmad = step.bmadSummary
    if (step.runner?.failure?.signature) signatures.push(step.runner.failure.signature)

    prevDiagnosis = diagnosis
    rounds.push(rec)

    // 예산이 라운드 도중에 다했다 — 다음 라운드는 통째로 마감 뒤라서 열지 않는다.
    if (step.budgetStopped) { log('[LOOP] 예산 소진 — 라운드를 더 열지 않는다'); break }

    // 환경 실패(인증·한도·네트워크·권한)는 **재실행하지 않는다** — 같은 조건이면 결과도 같다(설계 §4-2).
    // 여기서 끊고 사람을 부르는 것이 다음 라운드를 통째로 태우는 것보다 낫다.
    const envKind = [rec.runner?.failure?.kind, rec.failure?.kind].find((k) => k === 'env')
    if (envKind) {
      escalation = escalationReport({
        story: '(프로젝트 전체)',
        stage: `자율 마무리 라운드 ${round}`,
        situation: '환경 문제로 멈췄다(인증·사용 한도·네트워크·권한 가운데 하나)',
        cause: rec.runner?.failure?.action ?? rec.failure?.action ?? '환경 실패 — 재실행해도 같은 결과다',
        tried: [`라운드 ${round}: 러너 실행 1회(종료 코드 ${rec.runner?.exit ?? rec.gates?.qa?.exit ?? '?'})`],
        options: ['인증·한도가 풀린 뒤 같은 명령을 다시 돌린다', '해당 제공자를 빼고 나머지로 돌린다', '오늘은 접고 다음 밤으로 넘긴다'],
        recommendation: '원인(인증·한도·네트워크)을 먼저 풀고 같은 명령을 다시 돌린다 — 완료된 단계는 자동으로 건너뛴다',
        risk: '중간(산출물 무변경 · 커밋은 auto 브랜치까지)',
      })
      writeText('escalation.md', escalation)
      log('[LOOP] 환경 실패 — 재실행 금지 규칙에 따라 중단한다')
      break
    }
  }

  // ── 마무리: 최종 게이트 → 최종 진단 → 판정 → 보고 ──────────────────────
  let finalDiagnosis = diagnoses[diagnoses.length - 1] ?? null
  let finalSnapshot = lastSnapshot
  // 최종 **재진단은 언제나 한다**(NEW-M1) — 게이트를 안 돌렸다고 실행 전 스냅숏으로 보고하면
  // 「이번에 끝낸 것 / 남은 문제」가 러너가 손대기 전 상태다. 게이트 호출만 `gates.length` 로 가른다.
  if (!diagnoseOnly) {
    finalSnapshot = readProject(root, { now: nowFn() })
    const finalGates = {}
    // 잔여 예산이 0 이면 최종 게이트도 건너뛴다 — 증거가 없으니 판정은 `not-verified` 로 남는다.
    // 게이트가 애초에 없는 실행(`--no-gates`)에서도 **마감을 넘긴 사실 자체는 기록한다**
    // (codex-review-r5 Medium ③ — 예전에는 `gates.length` 가 0 이라 러너가 마감을 넘겨도
    //  `budget.exhausted` 가 false 로 남아 「예산 안에 끝났다」로 읽혔다).
    if (remainingMs() <= 0) budgetStop(gates.length ? '최종 게이트' : '최종 확인(돌릴 게이트 없음)')
    else for (const g of gates) finalGates[g] = await runGate(g, finalSnapshot, 'final')
    for (const [name, g] of Object.entries(finalGates)) {
      stageEvents.push({ kind: 'stage', stage: name === 'qa' ? 'qa' : name, story: '', provider: 'local', ms: g.ms, exit: g.exit ?? 0 })
    }
    finalDiagnosis = diagnose(finalSnapshot, { gates: finalGates, prevDiagnosis: finalDiagnosis, round: rounds.length, now: nowFn() })
    writeJson('final-diagnosis.json', finalDiagnosis)
    diagnoses.push(finalDiagnosis)
    const merged = mergeBacklog(backlog, buildBacklog({ diagnosis: finalDiagnosis, snapshot: finalSnapshot, config: rawConfig(finalSnapshot), round: rounds.length }))
    backlog = merged
    writeJson('final-backlog.json', backlog)
  }

  const manifests = Object.values(finalSnapshot?.manifests ?? {})
  const endedAt = nowFn()
  events[0].end = endedAt.toISOString()
  const metrics = summarizeTimeline([...events, ...stageEvents], {
    workers: num(o.parallel) ?? DEFAULTS.parallel,
    quality: {
      qaExit: finalDiagnosis?.gates?.qa?.exit ?? null,
      highFindings: arr(finalDiagnosis?.findings).filter((f) => f.severity === 'high').length,
      integration: integrationOf(manifests),
    },
  })

  const project = projectReadiness({ diagnosis: finalDiagnosis, manifests, backlog, metrics })
  const tasks = arr(backlog?.items).filter((i) => i.story).slice(0, 20).map((item) => taskReadiness({
    item,
    manifest: finalSnapshot?.manifests?.[item.story] ?? null,
    story: arr(finalSnapshot?.stories).find((s) => s.key === item.story) ?? null,
    diagnosis: finalDiagnosis,
  }))
  writeJson('readiness.json', { project, tasks })

  const model = buildReport({
    run: {
      id: runId, root, project: null, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
      rounds: rounds.length, mode: diagnoseOnly ? 'diagnose-only' : dryRun ? 'dry-run' : 'autofinish',
      gates: gateSignatureOf(gates, diagnoseOnly),
      // 예산이 없어 건너뛴 단계는 보고서 ⑧「확인하지 못한 것」에 그대로 실린다 — 안 돌린 검사는 통과가 아니다.
      notVerified: budgetSkipped,
    },
    diagnoses,
    backlog,
    readiness: { project, tasks },
    metrics,
    questions,
    bmadApplied,
    manifests,
  })
  const md = renderReportMd(model)
  writeAtomic(reportPath, md)
  writeJson('report.json', renderReportJson(model))
  writeJson('run.json', {
    schema: AUTOFINISH_SCHEMA, runId, root, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
    options: { diagnoseOnly, dryRun, maxRounds, budgetMin, gates, bmadWrites: o.bmadWrites, planModel: o.planModel, state: stateDir, out: reportPath },
    rounds, gateCalls, budget, escalation: escalation ? 'escalation.md' : null, verdict: project.verdict, artifacts,
  })

  // 종료 코드 — 0 = 돌았다. 1 = 사람 호출(escalate). 판정 not-ready 자체는 실패가 아니다(그게 결론이다).
  const exitCode = escalation ? 1 : 0
  log(`[AUTOFINISH] 판정 ${project.verdict} · 라운드 ${rounds.length} · 보고서 ${reportPath}`)
  return { exitCode, report: model, reportMd: md, rounds, outDir, reportPath, gateCalls, budget, readiness: { project, tasks }, backlog, diagnoses, escalation }
}

/** 설정 원문 — 스냅숏 없이(=부작용 전에) 읽는다. 없으면 `null`. */
function rawConfigAt(root, rel = 'tools/auto/auto.config.json') {
  try { return JSON.parse(readFileSync(join(root, rel), 'utf8')) } catch { return null }
}

const criticalOf = (d) => [1, 2, 3].reduce((a, t) => a + (Number(d?.counts?.findings?.[t]) || 0), 0)
const gateSignatureOf = (gates, diagnoseOnly) => ({ names: [...gates].sort(), mode: diagnoseOnly ? 'diagnose-only' : 'full' })
const integrationOf = (manifests) => {
  const vals = arr(manifests).map((m) => String(m?.checks?.integration ?? '')).filter(Boolean)
  if (vals.some((v) => /fail|rollback|red/i.test(v))) return 'fail'
  if (!vals.length) return 'unknown'
  return 'pass'
}
function rawConfig(snapshot) {
  const p = snapshot?.paths?.config ?? 'tools/auto/auto.config.json'
  try { return JSON.parse(readFileSync(join(snapshot.root, p), 'utf8')) } catch { return snapshot?.config ?? null }
}

/**
 * 질문 뽑기(순수 — 파일을 읽지도 쓰지도 않는다). `--diagnose-only` 도 이것만은 돈다 —
 * 「지금 사람이 정해 줘야 넘어가는 것」은 진단의 결론이지 실행의 부산물이 아니다.
 */
export function collectQuestions({ snapshot, diagnosis, backlog, inboxText = '', round = 0, now = new Date() } = {}) {
  const findingById = new Map(arr(diagnosis?.findings).map((f) => [f.id, f]))
  const kindOf = (item) => arr(item.source?.findings).map((id) => findingById.get(id)?.kind).find(Boolean) ?? 'story-partial'
  const mapping = mapToStories({ items: arr(backlog?.items), snapshot })
  const subjects = [
    ...arr(mapping.unmappable).map((u) => ({ ...(u.item ?? {}), kind: 'unmappable', why: u.why, category: u.category })),
    ...arr(backlog?.items).map((i) => ({ ...i, kind: kindOf(i) })),
  ]
  const questions = []
  const askedFp = new Set()
  for (const s of subjects) {
    const v = needsHuman(s, { inboxText, round })
    if (!v.ask) continue
    const fp = questionFingerprint(s)
    if (askedFp.has(fp)) continue
    askedFp.add(fp)
    questions.push(buildQuestion(s, v, { index: questions.length + 1, now }))
  }
  return { mapping, questions }
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 한 라운드의 실행부 — 질문 → BMAD → 계획 → 큐 → 러너
// ═══════════════════════════════════════════════════════════════════════════

/** BMAD 쓰기 계획의 `group`(`story:` · `new:` · `done:`)에서 스토리 키를 꺼낸다. `inbox` 는 스토리가 아니다. */
export function storiesOfBmadPlan(plan) {
  const keys = new Set()
  for (const w of arr(plan?.writes)) {
    const m = /^(story|new|done):(.+)$/.exec(String(w?.group ?? ''))
    if (m) keys.add(m[2])
  }
  return [...keys]
}

async function executeRound({ root, round, snapshot, diagnosis, backlog, opts, dryRun, writeJson, writeText, log, spawnRunner, nowFn, stageEvents, runner, remainingMs = () => Infinity, budgetStop = () => '' }) {
  const now = nowFn()
  const date = now.toISOString().slice(0, 10)
  const cfg = rawConfig(snapshot) ?? {}
  const P = snapshot.paths ?? {}
  const storyPaths = arr(snapshot.stories).filter((s) => s.exists).map((s) => s.path)
  const texts = collectTexts(root, [P.inbox, P.epics, `${P.impl}/sprint-status.yaml`, ...storyPaths])
  const inboxText = texts[P.inbox] ?? ''

  // ── ① 질문 (SPEC §6 — 기술 판단은 묻지 않는다) ─────────────────────────
  const { mapping, questions } = collectQuestions({ snapshot, diagnosis, backlog, inboxText, round, now })
  const iwp = inboxWritePlan({ path: P.inbox, exists: snapshot.ledgers?.inbox?.exists === true, text: inboxText, questions, date, now })
  writeJson(`round-${round}-questions.json`, { questions, inboxPlan: { ok: iwp.ok, op: iwp.op, why: iwp.why } })
  if (!iwp.ok) log(`⚠ [DECISION] 인박스 적용 실패 — ${iwp.why}`)

  const pending = pendingKeys(inboxText, { storyKeys: arr(snapshot.sprint).map((r) => r.key) })
  const blocked = blockedMap(pending)

  // ── ② BMAD 등재 (유일한 대상 저장소 쓰기) ──────────────────────────────
  const plan = planBmadWrites({
    mapping, snapshot, config: cfg, texts, now, round,
    completions: [],
    inbox: iwp.ok && iwp.op !== 'skip' ? { block: iwp.block, newFileBody: iwp.body } : null,
  })
  writeJson(`round-${round}-bmad-plan.json`, plan)
  let bmadApplied = null
  // BMAD 등재가 폐기되면(해시 충돌·경로 거부·junction) 그 계획에 걸린 스토리는 **봉쇄**한다(NEW-M3) —
  // 지적·완료기준이 원장에 붙지 않은 채로 구현을 시작하면 「무슨 근거로 고쳤나」가 사라진다.
  // 계획에 쓰기가 없던 스토리(이미 BMAD 에 있고 이번에 손댈 것이 없는 것)만 계속 돈다.
  const bmadBlocked = {}
  const bmadBlockedWhy = {}

  // ── 예산 hard stop — 대상 저장소 쓰기·계획 생성 **앞에서** 끊는다 (codex-review-r5 Medium) ──
  // 마감을 넘긴 뒤의 BMAD 등재는 「사람이 자는 사이 마감 밖에서 원장을 고친 것」이 되고,
  // 계획·러너는 시작하자마자 죽는다. 그래서 여기서 라운드를 접고 그 사유를 그대로 남긴다.
  const budgetHalt = (where) => ({
    budgetStopped: true,
    questions, bmadApplied,
    plan: { source: 'budget-stop', batches: [] }, planSource: 'budget-stop', validation: null,
    queue: null, queuePath: null,
    runner: { skipped: true, why: budgetStop(where) },
    bmadSummary: { writes: plan.writes.length, applied: arr(bmadApplied?.applied).length, rolledBack: Boolean(bmadApplied?.rolledBack), inbox: iwp.ok ? iwp.op : 'failed' },
  })
  if (remainingMs() <= 0) return budgetHalt('BMAD 등재')

  if (opts.bmadWrites === 'on' && !dryRun) {
    bmadApplied = applyBmadWrites(plan, { root, now })
    writeJson(`round-${round}-bmad-apply.json`, bmadApplied)
    log(`[BMAD] 적용 ${arr(bmadApplied.applied).length} · 건너뜀 ${arr(bmadApplied.skipped).length} · 충돌 ${arr(bmadApplied.conflicts).length}${bmadApplied.rolledBack ? ' · 전체 폐기' : ''}`)
    const failed = Boolean(bmadApplied.rolledBack) || arr(bmadApplied.rejected).length > 0 || arr(bmadApplied.conflicts).length > 0
    if (failed) {
      const why = arr(bmadApplied.conflicts)[0]?.why ?? arr(bmadApplied.rejected)[0]?.why ?? 'BMAD 등재가 폐기됐다'
      for (const key of storiesOfBmadPlan(plan)) {
        bmadBlocked[key] = 'BMAD 등재 폐기'
        bmadBlockedWhy[key] = `BMAD 등재가 폐기돼 봉쇄한다 — 지적·완료기준이 원장에 붙지 않았다(${String(why).slice(0, 120)})`
      }
      log(`⚠ [BMAD] 등재 폐기 — 이 계획에 걸린 스토리 ${Object.keys(bmadBlocked).length}건을 이번 라운드에서 뺀다`)
    }
  } else {
    log(`[BMAD] 계획만 세운다(--bmad-writes ${opts.bmadWrites}${dryRun ? ' · dry-run' : ''}) — 쓰기 ${plan.writes.length}건 보류`)
  }

  // ── ③ 후보 · DAG · 배정 ────────────────────────────────────────────────
  const cap = num(opts.cap) ?? num(cfg.autofinish?.cap) ?? DEFAULTS.cap
  Object.assign(blocked, bmadBlocked)
  const { candidates, excluded } = candidatesFrom({ backlog, snapshot, texts, cap, blocked, blockedWhy: bmadBlockedWhy })
  const epicOrder = arr(cfg.epicOrder ?? snapshot.config?.epicOrder)
  const dag = buildDag({ stories: candidates, epicOrder })
  // 기본 배정: 실행 dev = opus(P0-①) · 리뷰는 **만든 쪽과 다른 제공자**(SPEC §4). codex 가 켜져 있고
  // 리뷰 역할을 맡을 수 있으면 리뷰를 codex 로 두고, 그 밖에는 모델이라도 다르게 둔다(fable).
  const providers = cfg.providers ?? snapshot.config?.providers ?? {}
  const codexCfg = providers.codex ?? {}
  const codexReviews = codexCfg.enabled === true && (Array.isArray(codexCfg.roles) ? codexCfg.roles : ['review']).includes('review')
  const assigned = assignWorkers({
    stories: candidates.map((c) => ({ key: c.key, kind: c.kind, files: c.files, text: texts[arr(snapshot.stories).find((s) => s.key === c.key)?.path] ?? '' })),
    roles: ['dev', 'review'],
    providers,
    config: { models: cfg.autofinish?.models ?? { dev: 'opus', review: codexReviews ? 'codex' : 'fable' } },
  })
  const models = {}
  for (const a of assigned) models[a.story] = { dev: a.dev, review: a.review }

  // ── ④ 계획: Fable → 검증 → (거부 시) 규칙 계획 ─────────────────────────
  const hazardOpts = hazardOptsFor(arr(backlog.items))
  const batchMax = num(cfg.workers?.batchSize) ?? DEFAULTS.batchMax
  const deterministic = deterministicPlan({ candidates, dag, batchMax, hazardOpts, models })
  const constraints = {
    knownKeys: arr(snapshot.sprint).map((r) => r.key),
    doneKeys: arr(snapshot.sprint).filter((r) => r.status === 'done').map((r) => r.key),
    epicOrder,
    blocked,
    batchMax,
    hazardOpts,
  }
  // 계획 생성 앞에서도 마감을 본다 — 지휘 모델 한 번이 남은 예산을 통째로 먹는 자리다.
  if (remainingMs() <= 0) return budgetHalt('계획 생성')
  // 계획 실행기의 timeout = `min(설정 planTimeout, 잔여 예산)`. 설정이 없으면 실행기 기본값(3분)이다.
  const planTimeoutMs = num(cfg.autofinish?.planTimeoutMs) ?? DEFAULT_PLAN_TIMEOUT_MS
  const planBudgetMs = Math.max(1, Math.min(planTimeoutMs, remainingMs()))
  // `planRunner: false` 또는 `AUTOFINISH_NO_LLM=1` = 지휘 모델을 아예 부르지 않는다(규칙 계획 전용).
  let planRunner = typeof opts.planRunner === 'function' ? opts.planRunner : null
  const llmOff = opts.planRunner === false || process.env.AUTOFINISH_NO_LLM === '1'
  if (!planRunner && !llmOff && candidates.length) {
    try {
      planRunner = makeClaudePlanRunner({ bin: process.env.CLAUDE_BIN || 'claude', model: opts.planModel ?? DEFAULTS.planModel, cwd: root, timeoutMs: planBudgetMs })
    } catch (e) {
      log(`[ORCHESTRATOR] 계획 실행기 거부 — 규칙 계획으로 간다: ${e?.message ?? e}`)
      planRunner = null
    }
  }
  const res = await requestPlan({
    context: { date, candidates, notes: [`자율 마무리 라운드 ${round} — 남은 문제 ${backlog.items.length}건`] },
    dag, constraints, deterministic, runner: planRunner, timeoutMs: planBudgetMs,
  })
  // 계획 spawn 직후 재확인 — 계획이 마감을 넘겨 끝났으면 그 사실이 기록돼야 한다.
  if (remainingMs() <= 0) budgetStop('계획 생성', 'after')
  const chosen = res.plan
  // 채택된 계획도 **같은 잣대**로 한 번 더 본다. 걸린 스토리만 빼고(계획 전체를 버리지 않는다 — 밤은 계속 돈다),
  // 뺀 사유는 큐의 `_편성.excluded` 로 남겨 아침 브리핑이 「왜 빠졌나」를 읽게 한다.
  let validation = validatePlan(chosen, dag, constraints)
  if (!validation.ok) {
    const bad = new Map()
    for (const e of validation.errors) if (e.key && !bad.has(e.key)) bad.set(e.key, e.msg)
    if (bad.size) {
      chosen.batches = arr(chosen.batches)
        .map((b) => ({ ...b, stories: arr(b.stories).filter((k) => !bad.has(k)) }))
        .filter((b) => b.stories.length > 0)
      for (const [key, msg] of bad) excluded.push({ key, why: `계획 검증 실패 — ${msg}` })
      validation = validatePlan(chosen, dag, constraints)
    }
  }
  writeJson(`round-${round}-plan.json`, { source: res.source, plan: chosen, deterministic, validation, dag: { order: dag.order, edges: dag.edges }, assigned, excluded })
  log(`[ORCHESTRATOR] source=${res.source} · 배치 ${arr(chosen.batches).length}`)

  // ── ⑤ 큐 → 러너 ───────────────────────────────────────────────────────
  const queue = buildQueueFromPlan(chosen, backlog, snapshot, {
    date, round, source: res.source, validation, excluded, models,
    notes: [...arr(plan.notes), ...(iwp.ok ? [] : ['결정 인박스 적용 실패 — 질문이 등재되지 않았다'])],
    defaults: cfg.autofinish?.queueDefaults ?? {},
  })
  const queuePath = writeJson(`round-${round}-queue.json`, queue)

  let runnerResult = null
  let budgetStopped = false
  const left = remainingMs()
  if (arr(queue.batches).length === 0) {
    const why = Object.keys(bmadBlocked).length ? '편성 0건 — BMAD 등재 폐기로 후보가 전부 봉쇄됐다' : '편성 0건'
    log(`[RUNNER] ${why} — 이번 라운드는 돌릴 것이 없다`)
    runnerResult = { skipped: true, why }
  } else if (left <= 0) {
    // 예산이 남지 않았으면 러너를 **띄우지 않는다**(NEW-M2) — 어차피 시작하자마자 죽는다.
    runnerResult = { skipped: true, why: budgetStop('러너') }
    budgetStopped = true
  } else {
    const args = [runner, '--queue', queuePath]
    if (dryRun) args.push('--dry-run')
    const t0 = nowFn().getTime()
    const r = await spawnRunner(process.execPath, args, {
      cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
      // 러너에게 「다시 예산 전체」를 주지 않는다 — 남은 시간만큼만 준다(min(개별 상한, 잔여)).
      timeout: Math.max(1, Math.min((num(opts.budgetMin) ?? DEFAULTS.budgetMin) * 60_000, left)),
      maxBuffer: 64 * 1024 * 1024,
    })
    const ms = nowFn().getTime() - t0
    const out = maskSecrets(`${r?.stdout ?? ''}\n${r?.stderr ?? ''}`)
    const exit = r?.status === null || r?.status === undefined ? 1 : r.status
    runnerResult = { exit, ms, dryRun }
    if (exit !== 0) runnerResult.failure = classifyFailure({ stage: 'runner', exit, qaLog: out })
    stageEvents.push({ kind: 'stage', stage: 'runner', story: '', provider: 'local', ms, exit })
    writeJson(`round-${round}-runner.json`, { ...runnerResult, cmd: `node run-night.mjs --queue <queue>${dryRun ? ' --dry-run' : ''}` })
    writeText(`round-${round}-runner.log`, out)
    log(`[RUNNER] exit ${exit} (${ms}ms)${runnerResult.failure ? ` · ${runnerResult.failure.kind}` : ''}`)
    // spawn 직후 재확인 — 러너가 마감을 넘겨(또는 timeout 으로 죽어) 끝났으면 예산 소진이다.
    // 게이트가 없는 실행에서도 여기서 잡힌다(codex-review-r5 Medium ③).
    if (remainingMs() <= 0) budgetStopped = Boolean(budgetStop('러너', 'after'))
  }

  return {
    budgetStopped,
    questions, bmadApplied, plan: chosen, planSource: res.source, validation, queue, queuePath,
    runner: runnerResult,
    bmadSummary: { writes: plan.writes.length, applied: arr(bmadApplied?.applied).length, rolledBack: Boolean(bmadApplied?.rolledBack), inbox: iwp.ok ? iwp.op : 'failed' },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ CLI
// ═══════════════════════════════════════════════════════════════════════════

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  // 콘솔 출력도 **전부 마스킹**을 지난다(NEW-H4) — 예외 stack 에 외부 도구의 오류 원문이 실릴 수 있다.
  const errOut = (m) => console.error(maskSecrets(String(m)))
  let parsed
  try { parsed = parseArgs(process.argv.slice(2)) } catch (e) {
    errOut(`✖ 인자 거부: ${e?.message ?? e}`)
    process.exit(2)
  }
  runAutoFinish(parsed)
    .then((r) => process.exit(r.exitCode))
    .catch((e) => {
      // 설정 거부(ConfigRejected)는 인자 거부와 같은 자리다 — 종료 코드 2 · 부작용 0.
      const code = Number.isInteger(e?.exitCode) ? e.exitCode : 3
      errOut(code === 2 ? `✖ 설정 거부: ${e?.message ?? e}` : `✖ 자율 마무리 실패: ${e?.stack ?? e}`)
      process.exit(code)
    })
}
