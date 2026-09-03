// dev-status — 새 배치 하네스 산출물 파서 (읽기 전용 · 외부 의존성 0 · LLM 호출 0)
//
// 무엇을 읽나: night-batch-ops 러너와 auto-story-finish 엔진이 남기는 산출물 9종이다.
//   ① auto-pipeline-logs/batch-<id>-manifest.json      night-batch-ops/batch-manifest/1
//   ② auto-pipeline-logs/<story>-verification.json     auto-story-finish/verification/1
//   ③ auto-pipeline-logs/metrics-<id>.json             night-batch-ops/metrics/1
//   ④ <stateDir>/metrics-history.jsonl                 줄 JSON(스키마 없음)
//   ⑤ <stateDir>/assign-history.json                   {version:1, entries:{…}}
//   ⑥ <stateDir>/auto-queue-*.json · night-queue.json  {planned,defaults,batches,validation,_편성}
//   ⑦ <stateDir>/archive/*-evidence/<story>/summary.json  night-batch-ops/evidence/1
//   ⑧ implementation-artifacts/DECISIONS-INBOX.md      마크다운
//   ⑨ <stateDir>/autofinish/<runId>/{diagnosis,backlog,readiness,report}.json
//
// 손상 내성이 이 파일의 본체다. 파서는 절대 throw 하지 않는다 — 실패는 값이 아니라
// `error:{file,why,kind}` 로 돌려주고, 화면은 그 블록만 「읽지 못했습니다」로 적는다.
// 예상 밖 schema 는 추측해서 그리지 않는다(kind:'schema' → 「알 수 없는 형식」 + 원문 경로).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// ── 결과 봉투 ────────────────────────────────────────────────────────────────
const ok = (value) => ({ value, error: null })
const err = (file, why, kind) => ({ value: null, error: { file, why, kind } })

/** 파일 텍스트 — 없으면 null(예외 없음). */
export function readText(file) {
  try {
    if (!existsSync(file)) return null
    return readFileSync(file, 'utf8')
  } catch { return null }
}

/** JSON 1개 — 부재/손상/스키마를 각각 다른 kind 로 가른다. */
export function parseJsonFile(file, { schema = null, text = undefined } = {}) {
  const raw = text === undefined ? readText(file) : text
  if (raw == null) return err(file, '파일이 없습니다', 'missing')
  let v
  try { v = JSON.parse(raw) } catch (e) { return err(file, 'JSON 을 읽지 못했습니다 — ' + (e?.message ?? e), 'broken') }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return err(file, '최상위가 객체가 아닙니다', 'schema')
  if (schema && v.schema !== schema) {
    return err(file, '알 수 없는 형식 — schema 가 ' + (v.schema ? '"' + v.schema + '"' : '없음') + ' 입니다(기대: "' + schema + '")', 'schema')
  }
  return ok(v)
}

export const BATCH_MANIFEST_SCHEMA = 'night-batch-ops/batch-manifest/1'
export const VERIFICATION_SCHEMA = 'auto-story-finish/verification/1'
export const METRICS_SCHEMA = 'night-batch-ops/metrics/1'
export const EVIDENCE_SCHEMA = 'night-batch-ops/evidence/1'
export const DIAGNOSIS_SCHEMA = 'night-batch-ops/diagnosis/1'
export const BACKLOG_SCHEMA = 'night-batch-ops/backlog/1'
export const READINESS_SCHEMA = 'night-batch-ops/readiness/1'
export const REPORT_SCHEMA = 'night-batch-ops/report/1'
export const COMPLETION_SCHEMA = 'auto-story-finish/completion/1'

// ── ① 배치 매니페스트 ────────────────────────────────────────────────────────
/** batch-<id>-manifest.json 1개. 정규화하되 없는 칸을 지어내지 않는다(없으면 null). */
export function parseBatchManifest(file, text) {
  const r = parseJsonFile(file, { schema: BATCH_MANIFEST_SCHEMA, text })
  if (r.error) return r
  const m = r.value
  const integ = m.integration && typeof m.integration === 'object' ? m.integration : null
  return ok({
    file,
    batchId: str(m.batchId),
    label: str(m.label),
    branch: str(m.branch),
    at: str(m.at) || null,
    mode: str(m.mode),
    stories: arr(m.stories).map(String),
    stages: arr(m.stages).map(String),
    workers: num(m.workers),
    landing: arr(m.landing).map((l) => ({ order: num(l?.order), story: str(l?.story), head: str(l?.head) })),
    failed: arr(m.failed).map((f) => ({ story: str(f?.story), exit: num(f?.exit), evidence: str(f?.evidence) || null })),
    integration: integ ? {
      result: str(integ.result) || 'unknown',
      qaExit: num(integ.qaExit),
      landingBase: str(integ.landingBase),
      at: str(integ.at) || null,
      ran: integ.ran === true,
    } : null,
    pushed: m.pushed === true,
    worst: num(m.worst),
  })
}

// ── ② 스토리 검증 매니페스트 ─────────────────────────────────────────────────
/** <story>-verification.json 1개. workers 가 per-story LLM 정본이다. */
export function parseVerification(file, text) {
  const r = parseJsonFile(file, { schema: VERIFICATION_SCHEMA, text })
  if (r.error) return r
  const v = r.value
  const workers = v.workers && typeof v.workers === 'object' ? v.workers : {}
  const norm = (w) => (w && typeof w === 'object'
    ? { provider: str(w.provider) || null, model: str(w.model) || null }
    : (str(w) ? { provider: null, model: str(w) } : null))
  const checks = v.checks && typeof v.checks === 'object' ? v.checks : {}
  const review = v.review && typeof v.review === 'object' ? v.review : null
  const counts = review && review.counts && typeof review.counts === 'object' ? review.counts : {}
  const completion = v.completion && typeof v.completion === 'object' && v.completion.schema === COMPLETION_SCHEMA ? v.completion : null
  return ok({
    file,
    story: str(v.story),
    generatedAt: str(v.generatedAt) || null,
    branch: str(v.branch),
    commit: str(v.commit),
    workers: {
      create: norm(workers.create), dev: norm(workers.dev),
      review: norm(workers.review), qa: norm(workers.qa),
    },
    checks: Object.fromEntries(Object.entries(checks).map(([k, val]) => [k, str(val)])),
    checkFails: Object.entries(checks)
      .filter(([, val]) => /^fail\b/.test(str(val)) || /^required-missing/.test(str(val)))
      .map(([k, val]) => ({ check: k, value: str(val) })),
    review: review ? {
      provider: str(review.provider) || null,
      model: str(review.model) || null,
      result: str(review.result) || null,
      high: num(counts.high) ?? num(review.high) ?? 0,
      medium: num(counts.medium) ?? num(review.medium) ?? 0,
      patch: num(counts.patch) ?? 0,
      decision: num(counts.decision) ?? 0,
      readEvidence: num(review.readEvidence),
    } : null,
    integration: v.integration && typeof v.integration === 'object'
      ? { result: str(v.integration.result) || 'unknown', at: str(v.integration.at) || null }
      : null,
    completion: completion ? {
      verdict: str(completion.verdict) || null,
      counts: completion.counts && typeof completion.counts === 'object' ? completion.counts : {},
      criteria: arr(completion.criteria).map((c) => ({ id: str(c?.id), label: str(c?.label), result: str(c?.result), why: str(c?.why) })),
    } : null,
    repair: v.repair && typeof v.repair === 'object' ? { attempts: num(v.repair.attempts) ?? 0, exhausted: v.repair.exhausted === true } : null,
  })
}

// ── ③④ 계측 ────────────────────────────────────────────────────────────────
export function parseMetrics(file, text) {
  const r = parseJsonFile(file, { schema: METRICS_SCHEMA, text })
  if (r.error) return r
  return ok({ file, ...r.value })
}

/**
 * metrics-history.jsonl — **깨진 줄만 버린다**. 한 줄이 잘렸다고 이력 전체를 잃지 않는다.
 * 반환 { rows, bad, badLines }.
 */
export function parseMetricsHistory(text) {
  const rows = []
  const badLines = []
  let n = 0
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    n += 1
    const line = raw.trim()
    if (!line) continue
    let v
    try { v = JSON.parse(line) } catch { badLines.push(n); continue }
    if (!v || typeof v !== 'object' || Array.isArray(v) || !str(v.at)) { badLines.push(n); continue }
    rows.push(v)
  }
  return { rows, bad: badLines.length, badLines }
}

// ── ⑤ 배정 기록 ─────────────────────────────────────────────────────────────
export function parseAssignHistory(file, text) {
  const r = parseJsonFile(file, { text })
  if (r.error) return r
  const h = r.value
  if (!h.entries || typeof h.entries !== 'object' || Array.isArray(h.entries)) {
    return err(file, '알 수 없는 형식 — entries 객체가 없습니다', 'schema')
  }
  const entries = {}
  for (const [k, v] of Object.entries(h.entries)) {
    if (!v || typeof v !== 'object') continue
    entries[k] = {
      attempts: num(v.attempts) ?? 0, fails: num(v.fails) ?? 0,
      failStreak: num(v.failStreak) ?? 0, rounds: num(v.rounds) ?? 0,
      avgRounds: num(v.avgRounds) ?? 0,
    }
  }
  return ok({ file, version: num(h.version) ?? 1, entries })
}

/** "story|provider|role" 키를 스토리별로 접는다 — 라운드 수·회피 판정에 쓴다. */
export function assignByStory(history) {
  const out = new Map()
  for (const [key, v] of Object.entries(history?.entries ?? {})) {
    const parts = String(key).split('|')
    if (parts.length < 3) continue
    const [story, provider, role] = parts
    const cur = out.get(story) ?? { story, rounds: 0, attempts: 0, avoid: [], roles: {} }
    cur.rounds = Math.max(cur.rounds, v.avgRounds || 0)
    cur.attempts += v.attempts || 0
    cur.roles[role + ':' + provider] = v
    if ((v.failStreak ?? 0) >= 2) cur.avoid.push({ provider, role, failStreak: v.failStreak })
    out.set(story, cur)
  }
  return out
}

// ── ⑥ 오늘 예정 큐 ──────────────────────────────────────────────────────────
export function parseQueue(file, text) {
  const r = parseJsonFile(file, { text })
  if (r.error) return r
  const q = r.value
  if (!Array.isArray(q.batches)) return err(file, '알 수 없는 형식 — batches 배열이 없습니다', 'schema')
  const val = q.validation && typeof q.validation === 'object' ? q.validation : null
  const plan = q['_편성'] && typeof q['_편성'] === 'object' ? q['_편성'] : null
  return ok({
    file,
    planned: str(q.planned) || 'manual',
    updated: str(q.updated),
    defaults: q.defaults && typeof q.defaults === 'object' ? q.defaults : {},
    batches: q.batches.filter((b) => b && typeof b === 'object').map((b) => ({
      label: str(b.label),
      enabled: b.enabled !== false,
      stories: arr(b.stories).map(String),
      stages: arr(b.stages).map(String),
      force: b.force === true,
      models: b.models && typeof b.models === 'object' ? b.models : null,
      parallel: num(b.parallel),
    })),
    validation: val ? {
      ok: val.ok !== false,
      errors: arr(val.errors).map((e) => ({ code: str(e?.code), key: str(e?.key) || null, msg: str(e?.msg) })),
      warnings: arr(val.warnings).map((e) => ({ code: str(e?.code), key: str(e?.key) || null, msg: str(e?.msg) })),
    } : null,
    plan: plan ? {
      date: str(plan.date),
      picked: arr(plan.picked).map((p) => ({ key: str(p?.key), why: str(p?.why) })),
      excluded: arr(plan.excluded).map((p) => ({ key: str(p?.key), why: str(p?.why) })),
      notes: arr(plan.notes).map(String),
      cap: num(plan.cap), capBonus: num(plan.capBonus),
      chainAgeDays: num(plan.chainAgeDays),
      alreadyPlannedToday: num(plan.alreadyPlannedToday),
    } : null,
  })
}

// ── ⑦ 증거 ──────────────────────────────────────────────────────────────────
export function parseEvidenceSummary(file, text) {
  const r = parseJsonFile(file, { schema: EVIDENCE_SCHEMA, text })
  if (r.error) return r
  const s = r.value
  return ok({
    file, dir: file.replace(/[/\\]summary\.json$/, ''),
    story: str(s.story), at: str(s.at) || null,
    base: str(s.base), head: str(s.head),
    diffBytes: num(s.diffBytes) ?? 0, redacted: s.redacted === true,
    untracked: arr(s.untracked).length, notes: arr(s.notes).map(String),
  })
}

// ── ⑧ 결정 인박스 ───────────────────────────────────────────────────────────
const INBOX_CLOSED_RE = /✅/
const H2_RE = /^##\s+(.*\S)\s*$/
const H3_RE = /^###\s+(.*\S)\s*$/

/**
 * DECISIONS-INBOX.md — 절 머리(`## …`)만 읽는다.
 *   `결정 대기` = 대기 · `사람 게이트` = 사람 게이트 · `사후 확인` = 사후 확인 · `✅` = 제외.
 * 대기 절 안의 `### 🟢 함께 봐 주실 것` 은 그 절의 사후 확인분으로 따로 센다
 * (사후 확인 절 안의 같은 소제목은 두 번 세지 않는다).
 * `등재 YYYY-MM-DD` 로 대기 일수를 세고, 3일 이상이면 old=true.
 */
export function parseInbox(file, text, { now = new Date() } = {}) {
  if (text == null) return err(file, '파일이 없습니다', 'missing')
  const items = []
  let cur = null
  const push = () => { if (cur) { cur.summary = cur.summary.trim().slice(0, 240); items.push(cur) } }
  const kindOf = (h) => (INBOX_CLOSED_RE.test(h) ? 'closed'
    : /결정\s*대기/.test(h) ? 'pending'
      : /사람\s*게이트/.test(h) ? 'gate'
        : /사후\s*확인/.test(h) ? 'ack' : 'other')

  for (const raw of String(text).split(/\r?\n/)) {
    const h2 = H2_RE.exec(raw)
    if (h2) {
      push()
      const head = h2[1]
      const dm = /등재\s*(\d{4}-\d{2}-\d{2})/.exec(head)
      const listed = dm ? dm[1] : null
      const ageDays = listed ? daysBetween(listed, now) : null
      const title = head.replace(/^[^—]*—\s*/, '').replace(/\s*\([^()]*\)\s*$/, '').trim() || head
      cur = {
        kind: kindOf(head), head, title: stripMd(title), listed, ageDays,
        old: typeof ageDays === 'number' && ageDays >= 3,
        severity: /🔴/.test(head) ? 'high' : 'normal',
        summary: '',
      }
      continue
    }
    const h3 = H3_RE.exec(raw)
    if (h3 && cur && (cur.kind === 'pending' || cur.kind === 'gate') && /함께\s*봐\s*주실\s*것/.test(h3[1])) {
      items.push({ ...cur, kind: 'ack', title: cur.title + ' — 함께 봐 주실 것', summary: '' })
      continue
    }
    if (cur && !cur.summary && raw.trim() && !/^[#>|\-*]/.test(raw.trim())) cur.summary = stripMd(raw.trim())
  }
  push()

  const pick = (k) => items.filter((i) => i.kind === k)
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
  return ok({
    file,
    items,
    pending: pick('pending'),
    gates: pick('gate'),
    ack: pick('ack'),
    closed: items.filter((i) => i.kind === 'closed').length,
  })
}

// ── ⑨ 자율 마무리 진단 ──────────────────────────────────────────────────────
export const parseDiagnosis = (file, text) => parseJsonFile(file, { schema: DIAGNOSIS_SCHEMA, text })
export const parseBacklog = (file, text) => parseJsonFile(file, { schema: BACKLOG_SCHEMA, text })
export const parseReadiness = (file, text) => parseJsonFile(file, { schema: READINESS_SCHEMA, text })
export const parseReport = (file, text) => parseJsonFile(file, { schema: REPORT_SCHEMA, text })

// ── 슬롯 심박 ────────────────────────────────────────────────────────────────
/**
 * 심박 판정(설계 §2-①):
 *   lock 있고 로그 45분 이내 = 가동 중 / lock 있고 45분 이상 = 심박 없음(1급 경보) /
 *   lock 없고 지난밤 0건 = 밤이 안 돌았다(1급 경보) / 로그 파일 없음 = 회색.
 */
export function slotHeartbeat({ logMtimeMs = null, lockExists = false, lastNightBatches = 0, now = Date.now(), lines = [] } = {}) {
  if (logMtimeMs == null) return { state: 'none', label: '러너 로그 없음', why: 'slots.log 가 없습니다 — 슬롯을 아직 설치하지 않았거나 상태 폴더가 다릅니다', ageMin: null, lines }
  const ageMin = Math.max(0, Math.round((now - logMtimeMs) / 60000))
  if (lockExists && ageMin < 45) return { state: 'ok', label: '슬롯 심박 정상 · ' + ageMin + '분 전', why: '', ageMin, lines }
  if (lockExists) return { state: 'alarm', label: '심박 없음 · ' + ageMin + '분째 조용', why: 'lock 은 잡혀 있는데 로그가 45분 넘게 멈췄습니다 — 1급 경보', ageMin, lines }
  if (lastNightBatches === 0) return { state: 'alarm', label: '지난밤 0건 · 밤이 안 돌았습니다', why: 'lock 도 없고 지난밤 배치 기록도 없습니다 — 1급 경보', ageMin, lines }
  return { state: 'idle', label: '슬롯 대기 · 마지막 기록 ' + ageMin + '분 전', why: '', ageMin, lines }
}

// ── 상태 폴더 해석 ──────────────────────────────────────────────────────────
/**
 * AUTO_BATCH_STATE_DIR → auto.config.json.stateDir → ~/.claude-auto/<project>
 *   → ~/.baroos-auto(jng-os 호환 폴백 · 실존할 때만).
 * 러너·편성기와 **같은 순서**여야 원장이 갈라지지 않는다(plan-queue.mjs:409 · run-night.mjs:78).
 */
export function resolveStateDir(root, { env = process.env, home = homedir() } = {}) {
  const tried = []
  const take = (dir, why) => ({ dir: resolve(dir), why, tried })

  if (env.AUTO_BATCH_STATE_DIR) return take(env.AUTO_BATCH_STATE_DIR, '환경변수 AUTO_BATCH_STATE_DIR')
  tried.push('환경변수 AUTO_BATCH_STATE_DIR   없음')

  let project = basename(root)
  const cfgPath = join(root, 'tools', 'auto', 'auto.config.json')
  const cfgTxt = readText(cfgPath)
  if (cfgTxt) {
    try {
      const cfg = JSON.parse(cfgTxt)
      if (cfg && typeof cfg.stateDir === 'string' && cfg.stateDir.trim()) {
        return take(cfg.stateDir, 'tools/auto/auto.config.json 의 stateDir')
      }
      if (typeof cfg?.project === 'string' && cfg.project.trim()) project = cfg.project.trim()
      tried.push(cfgPath + '   stateDir 키 없음')
    } catch { tried.push(cfgPath + '   JSON 손상 — 건너뜁니다') }
  } else tried.push(cfgPath + '   없음')

  const def = join(home, '.claude-auto', project)
  if (existsSync(def)) return take(def, '기본값 ~/.claude-auto/' + project)
  tried.push(def + '   없음')

  const legacy = join(home, '.baroos-auto')
  if (existsSync(legacy)) return take(legacy, 'jng-os 호환 폴백 ~/.baroos-auto')
  tried.push(legacy + '   없음')

  return take(def, '기본값(아직 만들어지지 않음)')
}

// ── 수집기 ──────────────────────────────────────────────────────────────────
const lsSafe = (dir) => { try { return readdirSync(dir) } catch { return [] } }
const mtimeSafe = (p) => { try { return statSync(p).mtimeMs } catch { return null } }

/** 자율 진단 산출물 폴더 — <stateDir>/autofinish/<최신 runId>/ 우선, auto-pipeline-logs 폴백. */
export function findAutofinishDir(stateDir, logDir) {
  const base = join(stateDir, 'autofinish')
  const runs = lsSafe(base)
    .map((n) => ({ n, p: join(base, n), m: mtimeSafe(join(base, n)) }))
    .filter((x) => x.m != null)
    .sort((a, b) => b.m - a.m)
  if (runs.length) return { dir: runs[0].p, runId: runs[0].n, from: 'stateDir' }
  if (existsSync(join(logDir, 'readiness.json')) || existsSync(join(logDir, 'diagnosis.json'))) {
    return { dir: logDir, runId: null, from: 'logDir' }
  }
  return { dir: null, runId: null, from: null }
}

/**
 * 새 산출물 전량 수집. **읽기만 한다** — 어떤 파일도 만들거나 고치지 않는다.
 * 반환값의 모든 블록은 `{ value, error }` 또는 배열이며, 하나가 깨져도 나머지는 그대로다.
 */
export function collectBatchSources({ root = '.', logDir, stateDir, inboxPath = '', slotsDir = stateDir, now = new Date() } = {}) {
  const nowMs = now.getTime()
  const errors = []
  const note = (e) => { if (e) errors.push(e) }

  // ① 배치 매니페스트
  const manifests = []
  for (const name of lsSafe(logDir)) {
    if (!/^batch-.+-manifest\.json$/.test(name)) continue
    const r = parseBatchManifest(join(logDir, name))
    if (r.error) note(r.error)
    else manifests.push(r.value)
  }
  manifests.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))

  // ② 스토리 검증 매니페스트
  const verifications = []
  for (const name of lsSafe(logDir)) {
    if (!/-verification\.json$/.test(name)) continue
    const r = parseVerification(join(logDir, name))
    if (r.error) note(r.error)
    else verifications.push(r.value)
  }
  verifications.sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')))

  // ③ 배치별 계측
  const metrics = []
  for (const name of lsSafe(logDir)) {
    if (!/^metrics-.+\.json$/.test(name)) continue
    const r = parseMetrics(join(logDir, name))
    if (r.error) note(r.error)
    else metrics.push(r.value)
  }

  // ④ 계측 이력
  const histFile = join(stateDir, 'metrics-history.jsonl')
  const histTxt = readText(histFile)
  const history = histTxt == null
    ? { rows: [], bad: 0, badLines: [], missing: true, file: histFile }
    : { ...parseMetricsHistory(histTxt), missing: false, file: histFile }

  // ⑤ 배정 기록
  const assign = parseAssignHistory(join(stateDir, 'assign-history.json'))
  if (assign.error && assign.error.kind !== 'missing') note(assign.error)

  // ⑥ 예정 큐 — auto-queue-*.json 최신 → tools/auto/night-queue.json
  const queueCands = lsSafe(stateDir)
    .filter((n) => /^auto-queue-.*\.json$/.test(n))
    .map((n) => ({ p: join(stateDir, n), m: mtimeSafe(join(stateDir, n)) }))
    .filter((x) => x.m != null)
    .sort((a, b) => b.m - a.m)
  const manualQueue = join(root, 'tools', 'auto', 'night-queue.json')
  const queueFile = queueCands.length ? queueCands[0].p : (existsSync(manualQueue) ? manualQueue : null)
  const queue = queueFile ? parseQueue(queueFile) : err(join(stateDir, 'auto-queue-*.json'), '파일이 없습니다', 'missing')
  if (queue.error && queue.error.kind !== 'missing') note(queue.error)

  // ⑦ 증거 — archive/*-evidence/<story>/summary.json
  const evidence = []
  const archive = join(stateDir, 'archive')
  for (const dir of lsSafe(archive)) {
    if (!/-evidence$/.test(dir)) continue
    for (const story of lsSafe(join(archive, dir))) {
      const f = join(archive, dir, story, 'summary.json')
      if (!existsSync(f)) continue
      const r = parseEvidenceSummary(f)
      if (r.error) note(r.error)
      else evidence.push(r.value)
    }
  }
  evidence.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))

  // ⑧ 결정 인박스
  const inbox = inboxPath
    ? parseInbox(inboxPath, readText(inboxPath), { now })
    : err('(경로 없음)', '경로를 알 수 없습니다', 'missing')
  if (inbox.error && inbox.error.kind !== 'missing') note(inbox.error)

  // ⑨ 자율 진단
  const af = findAutofinishDir(stateDir, logDir)
  const afRead = (name, parser) => (af.dir
    ? parser(join(af.dir, name))
    : err(join(stateDir, 'autofinish', '<runId>', name), '자율 진단 산출물이 아직 없습니다', 'missing'))
  const diagnosis = afRead('diagnosis.json', parseDiagnosis)
  const backlog = afRead('backlog.json', parseBacklog)
  const readiness = afRead('readiness.json', parseReadiness)
  const report = afRead('report.json', parseReport)
  for (const r of [diagnosis, backlog, readiness, report]) if (r.error && r.error.kind !== 'missing') note(r.error)

  // 슬롯 심박
  const slotsLog = join(slotsDir, 'slots.log')
  const slotsTxt = readText(slotsLog)
  const lockPath = join(stateDir, 'runner.lock')
  const lastNight = lastNightManifests(manifests, now)
  const heartbeat = slotHeartbeat({
    logMtimeMs: slotsTxt == null ? null : mtimeSafe(slotsLog),
    lockExists: existsSync(lockPath),
    lastNightBatches: lastNight.length,
    now: nowMs,
    lines: slotsTxt == null ? [] : slotsTxt.trim().split(/\r?\n/).slice(-4),
  })

  return {
    stateDir, logDir, slotsLog, lockPath,
    autofinish: af,
    manifests, lastNight, verifications, metrics, history,
    assign, queue, evidence, inbox,
    diagnosis, backlog, readiness, report,
    heartbeat,
    errors,
  }
}

// ── 「지난밤」 = 18:00 접기 ───────────────────────────────────────────────────
/** 로컬 시각 기준 그 시점이 속한 「밤」의 날짜 키(18:00 이전이면 전날). */
export function nightKey(input) {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input)
  if (Number.isNaN(d.getTime())) return null
  if (d.getHours() < 18) d.setDate(d.getDate() - 1)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 지금이 속한 밤에 만들어진 배치 매니페스트만. */
export function lastNightManifests(manifests, now = new Date()) {
  const key = nightKey(now)
  return (manifests ?? []).filter((m) => m.at && nightKey(m.at) === key)
}

// ── 잡 유틸 ─────────────────────────────────────────────────────────────────
function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)) }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null }
function arr(v) { return Array.isArray(v) ? v : [] }
function stripMd(s) {
  return String(s ?? '').replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
}
function daysBetween(ymd, now) {
  const t = Date.parse(ymd + 'T00:00:00')
  if (!Number.isFinite(t)) return null
  const n = new Date(now)
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  return Math.max(0, Math.round((today - t) / 86400000))
}
