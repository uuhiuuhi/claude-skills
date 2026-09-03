// Fable 오케스트레이터 — 계획 생성 + 결정적 폴백 (2026-09-02 「9점대 하네스」)
//
// 무엇인가: 편성기(plan-queue)의 규칙 계획은 **안전하지만 근시안**이다 — 규칙 1~10 은 「지금
// 무엇을 편성해도 되는가」만 보고, 「오늘 밤 무엇부터 하면 가장 많이 끝나는가」(난이도·위험도·
// 짝짓기·병렬 폭)는 보지 않는다. 그 판단만 지휘 모델(Fable)에게 맡기고, **채택 여부는 규칙이
// 정한다**: LLM 계획은 ① 후보 집합의 부분집합이고 ② 검증기(plan-dag.validatePlan)를 통과할
// 때만 쓰인다. 하나라도 어긋나면 **말없이 규칙 계획으로 되돌아간다**(fallback).
//
// 절대 규칙: LLM 이 계획을 못 내도 밤은 계속 돈다. 실행기 부재·예외·타임아웃·비JSON·스키마
// 불일치·지어낸 스토리·검증 거부 — 전부 fallback 이고, 사유를 `plan.source` 에 남긴다.
//
// 이 파일은 실제 LLM 을 **호출하지 않는다**(호출은 주입된 runner 가 한다 — 테스트는 스텁).

import { STAGE_NAMES, isValidModelSpec, validatePlan } from './plan-dag.mjs'
import { spawnWithDeadline } from './spawn-deadline.mjs'

/** 계획 응답 JSON 스키마 — 프롬프트에 그대로 실어 형식을 강제한다. */
export const PLAN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['batches'],
  properties: {
    rationale: { type: 'string' },
    batches: {
      type: 'array',
      minItems: 0,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stories'],
        properties: {
          label: { type: 'string' },
          stories: { type: 'array', minItems: 1, items: { type: 'string' } },
          stages: { type: 'array', items: { enum: [...STAGE_NAMES] } },
          models: {
            type: 'object',
            additionalProperties: false,
            properties: { create: { type: 'string' }, mockup: { type: 'string' }, replan: { type: 'string' }, dev: { type: 'string' }, review: { type: 'string' } },
          },
          parallel: { type: 'integer', minimum: 1, maximum: 6 },
          risk: { type: 'number', minimum: 0, maximum: 10 },
          difficulty: { type: 'number', minimum: 0, maximum: 10 },
          rationale: { type: 'string' },
        },
      },
    },
  },
})

/** 프롬프트 + 스키마 생성(순수). context = { date, candidates[], dag, constraints, history[], notes[] } */
export function buildPlanPrompt(context = {}) {
  const { date = '', candidates = [], dag = null, constraints = {}, history = [], notes = [], mode = 'guarded', parallel = null } = context
  const full = mode === 'full' // 자율운전(2026-09-03) — 시니어 기획자 역할 · 후보 전부 편성 · 진행 에픽 댐 없음
  const cand = candidates.map((c) => ({
    key: c.key, epic: c.epic ?? null, kind: c.kind ?? 'new',
    stages: c.stages ?? [], files: (c.files ?? []).slice(0, 20),
    difficulty: c.difficulty ?? null, risk: c.risk ?? null,
    ...(Array.isArray(c.notes) && c.notes.length ? { notes: c.notes } : {}),
    ...(c.replanHint ? { replanHint: c.replanHint } : {}),
  }))
  const capLimit = Number(constraints.cap?.limit)
  const edges = (dag?.edges ?? []).map((e) => `${e.from} → ${e.to} (${e.why})`)
  const lines = [
    '# 야간 배치 편성 계획 요청',
    `날짜: ${date}`,
    '',
    '## 역할',
    ...(full ? [
      '너는 **시니어 개발 기획자**이고 이 배치는 **24시간 자율운전**이다. 사람이 결정을 기다리게 하지 않는다.',
      '아래 후보는 규칙이 「지금 돌릴 수 있다」고 판정한 스토리 전부다. **실행 가능한 후보는 전부 계획에 넣는다**(후보가 있는데 빈 계획을 내지 않는다).',
      '가치 순서: ① 진행 중·회수(recovery)·마감 재검수(closeout) 먼저 ② 그다음 신규(new) — 에픽 우선순위와 선행 관계를 지킨다 ③ 같은 에픽 안에서는 번호 순.',
      '각 후보의 stages 는 규칙이 정한 것이다(replan = 시니어 재계획 · mockup = AI 목업 초안) — 바꾸지 말고 순서·짝·모델·병렬 폭만 정한다. notes/replanHint 는 판단 재료다.',
      '코드를 고치지 않고, 스토리를 새로 만들지 않는다. 계획은 기계 검증기를 통과해야 채택된다.',
    ] : [
      '너는 무인 야간 배치의 **지휘자**다. 아래 후보 스토리만 써서 오늘 밤 실행 계획(배치 목록)을 짠다.',
      '코드를 고치지 않고, 스토리를 새로 만들지 않는다. 계획은 기계 검증기를 통과해야 채택된다.',
    ]),
    '',
    '## 후보 (이 목록 **밖의 스토리 키를 쓰면 계획 전체가 폐기**된다)',
    '```json',
    JSON.stringify(cand, null, 2),
    '```',
    '',
    '## 의존 간선 (from 이 먼저 끝나야 to 를 돌릴 수 있다)',
    edges.length ? edges.map((e) => '- ' + e).join('\n') : '- (없음)',
    '',
    '## 제약 (어기면 폐기)',
    `- 하루 상한(고유 스토리): ${Number.isFinite(capLimit) ? capLimit : '제한 없음'} · 오늘 이미 편성: ${(constraints.cap?.plannedToday ?? []).length}`,
    ...(full ? [
      `- 에픽 우선순위: ${(constraints.epicOrder ?? []).join(' → ') || '(없음)'} — 우선순위일 뿐 댐이 아니다(앞 에픽 후보를 먼저 두되 뒤 에픽 후보도 편성한다).`,
      ...(parallel ? [`- 병렬 폭: ${parallel} — 한 배치에 File List 서로소 스토리를 ${constraints.batchMax ?? 2}개까지 묶으면 러너가 워크트리를 나눠 동시에 돌린다.`] : []),
    ] : [
      `- 에픽 우선순위: ${(constraints.epicOrder ?? []).join(' → ') || '(없음)'} · 진행 에픽: ${constraints.currentEpic ?? '(없음)'}`,
      '- 신규 착수는 진행 에픽에서만. 회수·마감 재검수는 뒤 에픽도 가능.',
    ]),
    '- 한 배치의 스토리들은 File List 가 서로소여야 한다. 마이그레이션·스키마·API 계약·공유 설정·테스트 환경이 겹치면 배치를 나눠 순차로 돌린다.',
    `- 한 배치 최대 스토리 수: ${constraints.batchMax ?? 2}`,
    '- 모델 스펙은 `opus`·`fable`·`sonnet`·`codex`·`codex:<모델>` 형식만. 공백·특수문자 금지.',
    '- dev 와 review 는 서로 다른 모델(또는 다른 프로바이더)이어야 한다.',
    '',
    '## 최근 성적 (같은 프로바이더가 연속 실패한 조합은 피한다)',
    history.length ? history.map((h) => `- ${h.story} · ${h.provider}/${h.role ?? 'dev'} · ${h.ok ? '성공' : '실패'}${h.rounds ? ` · ${h.rounds}라운드` : ''}`).join('\n') : '- (기록 없음)',
    ...(notes.length ? ['', '## 단서', ...notes.map((n) => '- ' + n)] : []),
    '',
    '## 출력',
    '아래 JSON 스키마에 **정확히** 맞는 JSON 하나만 출력한다(설명 문장·코드펜스 밖 텍스트 금지).',
    '```json',
    JSON.stringify(PLAN_SCHEMA, null, 2),
    '```',
  ]
  return { prompt: lines.join('\n'), schema: PLAN_SCHEMA }
}

/** 스키마 형태 검사(경량 · 필요한 것만) — 반환 [] 면 합격 */
export function validatePlanShape(obj) {
  const errs = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['최상위가 객체가 아니다']
  if (!Array.isArray(obj.batches)) return ['batches 배열이 없다']
  obj.batches.forEach((b, i) => {
    if (!b || typeof b !== 'object') { errs.push(`batches[${i}] 가 객체가 아니다`); return }
    if (!Array.isArray(b.stories) || b.stories.length === 0) errs.push(`batches[${i}].stories 가 비었다`)
    else if (b.stories.some((s) => typeof s !== 'string' || !s.trim())) errs.push(`batches[${i}].stories 에 빈 값이 있다`)
    if (b.stages !== undefined && (!Array.isArray(b.stages) || b.stages.some((s) => !STAGE_NAMES.includes(s)))) errs.push(`batches[${i}].stages 형식 위반`)
    if (b.models !== undefined) {
      if (!b.models || typeof b.models !== 'object' || Array.isArray(b.models)) errs.push(`batches[${i}].models 형식 위반`)
      else for (const [k, v] of Object.entries(b.models)) {
        if (!STAGE_NAMES.includes(k)) errs.push(`batches[${i}].models.${k} 는 허용되지 않는다`)
        else if (!isValidModelSpec(v)) errs.push(`batches[${i}].models.${k} 모델 스펙 형식 위반`)
      }
    }
    if (b.parallel !== undefined && (!Number.isInteger(b.parallel) || b.parallel < 1 || b.parallel > 6)) errs.push(`batches[${i}].parallel 범위 위반`)
  })
  return errs
}

const firstJsonBlock = (text) => {
  const s = String(text ?? '')
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const body = fence ? fence[1] : s
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return body.slice(start, i + 1) }
  }
  return null
}

/**
 * 응답 파싱 — `claude -p --output-format json` 봉투(`{type:'result', result:'<본문>'}`),
 * 코드펜스, 앞뒤 잡문을 모두 벗겨 계획 객체를 꺼낸다. 반환 { ok, plan?, error? }.
 */
export function parsePlanResponse(input) {
  if (input == null) return { ok: false, error: 'empty' }
  let obj = null
  if (typeof input === 'object') obj = input
  else {
    const text = String(input)
    if (!text.trim()) return { ok: false, error: 'empty' }
    try { obj = JSON.parse(text) } catch { obj = null }
    if (obj === null) {
      const block = firstJsonBlock(text)
      if (!block) return { ok: false, error: 'not-json' }
      try { obj = JSON.parse(block) } catch { return { ok: false, error: 'not-json' } }
    }
  }
  // 봉투 벗기기(최대 2겹) — result 가 문자열이면 그 안이 본문이다
  for (let i = 0; i < 2; i++) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && !Array.isArray(obj.batches) && typeof obj.result === 'string') {
      const inner = obj.result
      let next = null
      try { next = JSON.parse(inner) } catch {
        const block = firstJsonBlock(inner)
        if (block) { try { next = JSON.parse(block) } catch { next = null } }
      }
      if (!next) return { ok: false, error: 'not-json' }
      obj = next
    }
  }
  const errs = validatePlanShape(obj)
  if (errs.length) return { ok: false, error: 'schema:' + errs[0] }
  return { ok: true, plan: obj }
}

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)))

/**
 * 실행기 실패의 **고정 코드** (codex-review-r4 NEW-H4).
 * 외부 도구(stderr 첫 줄)를 `plan.source` 에 넣으면 `[ORCHESTRATOR] source=…` 로그가 토큰을 그대로 찍는다.
 * `source` 는 이 세 값 중 하나뿐이고, 원문은 **산출물 JSON 의 `plan.errorDetail`** 로만 흘러간다 —
 * 그 자리는 쓰기 직전에 `deepRedact` 를 지난다(autofinish 의 `writeJson`). 로그·`source` 에는 절대 없다.
 * 이 모듈이 마스커를 직접 import 하지 않는 이유: 설치본은 엔진을 `tools/auto/` **한 폴더로** 복사하므로
 * 저장소 밖 상대 경로(`../../auto-story-finish/...`)가 풀리지 않는다(2026-09-03 실측 — run-night 가
 * ERR_MODULE_NOT_FOUND 로 죽었다). 마스킹은 쓰기 경계 한 곳에서만 한다.
 */
export const RUNNER_ERROR_CODES = Object.freeze(['runner-error', 'runner-timeout', 'runner-nonzero'])
const errorCodeOf = (e) => (RUNNER_ERROR_CODES.includes(e?.code) ? e.code : 'runner-error')
const errorDetailOf = (e) => String(e?.detail ?? e?.message ?? e ?? '').split('\n')[0].slice(0, 200) || null

/**
 * 계획 요청 — 주입된 실행기로 Fable 계획을 받아 검증하고, 어긋나면 규칙 계획으로 돌아간다.
 * 인자: { context, dag, constraints, deterministic(규칙 계획 큐), runner(prompt, schema, {timeoutMs}) → jsonText, schema, timeoutMs }
 * 반환: Promise<{ plan, source, errors, warnings }> · plan.source 에도 같은 사유를 남긴다.
 *
 * **async 다**(codex-review-r6 Medium): 실행기가 `spawnWithDeadline` 기반이라 Promise 를 돌려준다.
 * 동기 실행기(스텁)를 넣어도 그대로 산다 — `await` 는 값도 그대로 통과시킨다.
 *
 * `timeoutMs` 는 **잔여 예산**이다(codex-review-r5 Medium) — 호출부(autofinish)가 `min(설정 planTimeout, 잔여)`
 * 를 계산해 넘기고, 실행기는 그보다 오래 걸리는 자식 프로세스를 죽인다. 계획 한 번이 마감을 통째로
 * 먹어 「예산을 넘겨서야 끝나는 밤」이 되는 것을 막는다. 주지 않으면 실행기 자신의 기본값을 쓴다.
 */
export async function requestPlan({ context = {}, dag = null, constraints = {}, deterministic = null, runner = null, schema = PLAN_SCHEMA, timeoutMs = null } = {}) {
  const fallback = (why, detail = null) => {
    const plan = clone(deterministic) ?? { batches: [] }
    plan.source = `deterministic-fallback(${why})`
    if (detail) plan.errorDetail = detail // 산출물 JSON 전용 — 로그·source 에는 절대 싣지 않는다
    return { plan, source: plan.source, errors: [], warnings: [] }
  }
  if (typeof runner !== 'function') return fallback('no-runner')

  const { prompt } = buildPlanPrompt({ ...context, dag, constraints })
  let raw
  try { raw = await runner(prompt, schema, { timeoutMs }) } catch (e) { return fallback(errorCodeOf(e), errorDetailOf(e)) }
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return fallback('empty-response')

  const parsed = parsePlanResponse(raw)
  if (!parsed.ok) return fallback('parse:' + parsed.error)

  // 후보 집합의 **부분집합**만 허용 — 지어낸 스토리는 계획 전체 폐기
  const allowed = new Set((context.candidates ?? []).map((c) => String(c?.key ?? c)))
  if (allowed.size > 0) {
    const invented = [...new Set(parsed.plan.batches.flatMap((b) => b.stories))].filter((k) => !allowed.has(String(k)))
    if (invented.length) return fallback('invented-story:' + invented.slice(0, 3).join(','))
  }

  const v = validatePlan(parsed.plan, dag ?? { nodes: [], edges: [], cycles: [], byKey: new Map() }, constraints)
  if (!v.ok) return fallback('validator:' + v.errors[0].code)

  const plan = clone(parsed.plan)
  plan.source = 'fable'
  return { plan, source: 'fable', errors: [], warnings: v.warnings }
}

// ── 기본 실행기 (테스트에서는 호출하지 않는다 — 주입 스텁을 쓴다) ─────────────
const SAFE_BIN_RE = /^[A-Za-z0-9._:\\/ -]+$/

/** 계획 실행기의 기본 상한(ms) — 잔여 예산을 주지 않았을 때만 쓰인다(종전 값 그대로). */
export const DEFAULT_PLAN_TIMEOUT_MS = 180_000

/**
 * `claude -p --model <spec> --output-format json` 실행기.
 * 셸 문자열 결합 없이 **실행파일 + argv 배열**로 spawn 한다(BRIEF 정책 8).
 * Windows `.cmd`/`.bat` 심은 shell:true 대신 `cmd.exe /d /s /c` 전용 경로로만 지난다.
 * 모델·실행파일 경로에 셸 메타문자가 있으면 **거부**(실행하지 않는다).
 *
 * timeout 은 **둘 중 짧은 쪽**이다 — 만들 때 준 `timeoutMs`(설정 상한)와 부를 때 준
 * `opts.timeoutMs`(그 시점의 잔여 예산). 마감이 3분 남았는데 계획에 3분을 다 쓰게 두지 않는다.
 *
 * 마감은 **프로세스 트리 전체**에 걸린다(codex-review-r6 Medium · `spawn-deadline.mjs`) —
 * `cmd.exe` 만 죽이면 손자 node 가 파이프를 쥔 채 살아 마감 뒤까지 반환하지 않았다.
 * 실행기는 **async** 다(Promise 를 돌려준다).
 */
export function makeClaudePlanRunner({ bin = 'claude', model = 'fable', cwd = undefined, timeoutMs = DEFAULT_PLAN_TIMEOUT_MS, spawn = spawnWithDeadline, env = process.env } = {}) {
  if (!isValidModelSpec(model)) throw new Error(`계획 모델 스펙 거부: ${JSON.stringify(model)}`)
  const exe = String(bin)
  if (!SAFE_BIN_RE.test(exe)) throw new Error(`계획 실행파일 경로 거부(셸 메타문자): ${JSON.stringify(bin)}`)
  return async (prompt, _schema = null, opts = {}) => {
    const argv = ['-p', '--model', model, '--output-format', 'json']
    const isCmdShim = /\.(cmd|bat)$/i.test(exe)
    const file = isCmdShim ? (env.ComSpec || 'cmd.exe') : exe
    const args = isCmdShim ? ['/d', '/s', '/c', exe, ...argv] : argv
    const left = Number(opts?.timeoutMs)
    const timeout = Math.max(1, Number.isFinite(left) ? Math.min(timeoutMs, left) : timeoutMs)
    const r = await spawn(file, args, {
      input: prompt, encoding: 'utf8', cwd, timeout,
      shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    })
    // 실패는 **고정 코드 + 별도 상세**로 던진다(NEW-H4) — 호출부가 코드만 `source` 에 쓰고
    // 상세는 마스킹해 산출물에만 남긴다. 오류 메시지 자체에 stderr 원문을 섞지 않는다.
    const fail = (code, detail) => {
      const err = new Error(code)
      err.code = code
      err.detail = String(detail ?? '').split('\n')[0].slice(0, 200)
      throw err
    }
    // 분류 **순서가 진단의 정확도**다(codex-review-r6 Low). 마감에 걸린 실행은 `error(ETIMEDOUT)` 와
    // `signal(SIGTERM)` 을 **동시에** 준다 — 그런데 `maxBuffer` 초과(ENOBUFS)도 똑같이 준다.
    //   ① ETIMEDOUT(또는 우리 타이머가 남긴 `timedOut`) → runner-timeout   ← 진짜 예산 초과만
    //   ② 그 밖의 error(ENOBUFS 등)                    → runner-error     ← 출력 과다를 예산 탓으로 읽지 않는다
    //   ③ 원인 없는 signal                              → runner-timeout   ← 안전 폴백(종전 동작 보존)
    // signal 을 먼저 보면 ENOBUFS 가 `runner-timeout` 으로 둔갑해, 운영자가 예산을 늘리며 헛발질한다.
    if (r.timedOut === true || r.error?.code === 'ETIMEDOUT') fail('runner-timeout', `timeout ${r.error?.code ?? 'ETIMEDOUT'}`)
    if (r.error) fail('runner-error', r.error?.code ? `${r.error.code}: ${r.error?.message ?? ''}` : (r.error?.message ?? String(r.error)))
    if (r.signal) fail('runner-timeout', `signal ${r.signal}`)
    if (r.status !== 0) fail('runner-nonzero', `exit ${r.status}: ${String(r.stderr ?? '')}`)
    return r.stdout ?? ''
  }
}
