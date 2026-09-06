// quality-rules.mjs — 품질 게이트·자율 수리·테스트 무결성·조건부 게이트·검증 매니페스트·에스컬레이션.
// 전부 **순수 함수**(LLM 호출 0 · 파일 I/O 0) — node:test 가 결정적으로 문다. 엔진은 호출만 한다.
//
// 원칙(2026-09-02 지시 §8~§15):
//   · 프로젝트에 실제로 있는 명령만 쓴다(package.json scripts 탐지) — 없는 게이트는 n/a 로 정직 기록.
//   · 수리 루프는 무한하지 않다 — 같은 원인 N회 · 총 M회. 예산 소진 = 종전 qa RED STOP + 에스컬레이션.
//   · 테스트 통과를 위한 꼼수(.only · 테스트 삭제 · 단언 약화 · skip 남발 · ts-ignore · 규칙 비활성화)는 탐지한다.
//   · mock 통과를 운영 통합 성공으로 간주하지 않는다 — 매니페스트가 integration 을 'unknown' 으로 둔다.

// ── 게이트 탐지 ───────────────────────────────────────────────────────────────────────
const pick = (scripts, names) => names.find((n) => typeof scripts?.[n] === 'string' && scripts[n].trim() !== '') ?? null
export function detectGates(scripts = {}) {
  const g = (names) => { const n = pick(scripts, names); return { available: Boolean(n), cmd: n ? `npm run ${n}` : null, script: n } }
  return {
    qa: g(['qa']),
    lint: g(['lint', 'eslint']),
    typecheck: g(['typecheck', 'type-check', 'tsc', 'check-types']),
    build: g(['build']),
    test: g(['test', 'test:unit', 'vitest']),
    coverage: g(['coverage', 'test:coverage']),
    e2e: g(['e2e', 'test:e2e', 'e2e:smoke']),
    // 조건부 게이트는 **실제로 실행**된다(#10) — 프로젝트가 쓰는 흔한 이름을 넓게 본다(앞의 것이 우선).
    security: g(['test:security', 'security', 'rls:check', 'audit']),
    performance: g(['test:perf', 'perf', 'test:performance', 'bench']),
  }
}

/** `npm run qa` 정의(`npm run typecheck && npm run lint && npm run test`)에서 사슬을 뽑는다 */
export function parseQaChain(qaScript) {
  return [...String(qaScript ?? '').matchAll(/npm (?:run )?([a-zA-Z0-9:_-]+)/g)].map((m) => m[1]).filter((s) => s !== 'run')
}

// ── qa 실패 분류 ──────────────────────────────────────────────────────────────────────
const KIND_MARKERS = [
  ['typecheck', /^.+\(\d+,\d+\): error TS\d{4}|^.+:\d+:\d+ - error TS\d{4}/m],
  ['lint', /(?:✖|×)\s*\d+\s+problems?|\d+\s+errors?,?\s+\d+\s+warnings?|@typescript-eslint\/|eslint(?![-\w])/i],
  ['test', /\bFAIL\b|Test Files\s+\d+\s+failed|Tests\s+\d+\s+failed|AssertionError|Error: expect\(/],
  ['build', /vite build|Rollup failed|build failed|error during build|Build failed/i],
]
const norm = (s) => String(s).replace(/\r/g, '').replace(/\[[0-9;]*m/g, '')
const chainToKind = { typecheck: 'typecheck', lint: 'lint', test: 'test', build: 'build' }

/** 로그에서 실패 종류 + 안정적인 「원인 서명」 + 발췌를 뽑는다. 서명은 같은 원인의 반복을 세는 열쇠라
 *  줄·열 번호 같은 흔들리는 값은 뺀다. */
export function classifyQaFailure(logText) {
  const text = norm(logText ?? '')
  let best = null
  for (const [kind, re] of KIND_MARKERS) {
    const m = re.exec(text)
    if (m && (best === null || m.index < best.index)) best = { kind, index: m.index }
  }
  const kind = best?.kind ?? 'unknown'
  const lines = text.split('\n')
  let signature = `${kind}:`
  if (kind === 'typecheck') {
    const m = /^(.+?)\(\d+,\d+\): error (TS\d{4})/m.exec(text) || /^(.+?):\d+:\d+ - error (TS\d{4})/m.exec(text)
    signature += m ? `${m[1].trim()}:${m[2]}` : (lines.find((l) => /error TS\d{4}/.test(l)) ?? '').slice(0, 120)
  } else if (kind === 'lint') {
    const file = lines.find((l) => /^[^\s].*\.(?:[cm]?[jt]sx?)$/.test(l.trim()) && !/^\s*\d/.test(l)) ?? ''
    const rule = /\berror\s+.*?\s{2,}([@\w-]+\/[\w-]+|[\w-]+)\s*$/m.exec(text)?.[1] ?? ''
    signature += `${file.trim()}:${rule}` || (lines.find((l) => /error/i.test(l)) ?? '').slice(0, 120)
  } else if (kind === 'test') {
    // FAIL 줄(파일 > 케이스)을 우선한다 — 그 앞의 `× 케이스` 요약 줄에는 파일이 없다
    const m = /^\s*FAIL\s+(.+?)(?:\s+\d+ms)?\s*$/m.exec(text) || /^\s*(?:×|✗)\s+(.+?)(?:\s+\d+ms)?\s*$/m.exec(text)
    const assertion = /(AssertionError[^\n]{0,80}|Error: expect\([^\n]{0,80})/.exec(text)?.[1] ?? ''
    signature += m ? m[1].trim().slice(0, 160) : assertion.slice(0, 120)
  } else if (kind === 'build') {
    signature += (lines.find((l) => /error/i.test(l)) ?? '').trim().slice(0, 120)
  } else {
    signature += (lines.find((l) => /error|fail/i.test(l)) ?? lines[lines.length - 1] ?? '').trim().slice(0, 120)
  }
  const start = best ? Math.max(0, text.slice(0, best.index).split('\n').length - 3) : Math.max(0, lines.length - 40)
  const excerpt = lines.slice(start, start + 80).join('\n').slice(0, 6000)
  return { kind, signature, excerpt }
}

// ── 수리 예산 ─────────────────────────────────────────────────────────────────────────
export const REPAIR_DEFAULTS = Object.freeze({ totalRepairAttempts: 5, sameRootCauseMaxRetries: 3 })

/** attempts = 이미 실행한 수리 횟수 · signatures = 관측한 실패 서명들(현재 실패 포함, 시간순).
 *  같은 서명을 이미 N회 수리했는데 또 같으면 멈춘다(무진전) · 총 M회 넘으면 멈춘다. */
export function repairDecision({ attempts = 0, signatures = [], cfg = {} } = {}) {
  const c = { ...REPAIR_DEFAULTS, ...(cfg ?? {}) }
  const total = Number(c.totalRepairAttempts) || 0
  const same = Number(c.sameRootCauseMaxRetries) || 0
  if (total <= 0) return { repair: false, why: '자동 수리 꺼짐(autoRepair 0)' }
  if (attempts >= total) return { repair: false, why: `총 수리 시도 ${total}회 소진` }
  const last = signatures[signatures.length - 1]
  const seen = last ? signatures.filter((s) => s === last).length : 0
  const repairedSame = Math.max(0, seen - 1) // 현재 관측 이전에 같은 원인을 몇 번 고쳤나
  if (last && repairedSame >= same) return { repair: false, why: `같은 원인 ${same}회 수리 후에도 반복(${last}) — 사람 판단` }
  return { repair: true, why: `수리 ${attempts + 1}/${total} · 같은 원인 ${repairedSame + 1}/${same}` }
}

// ── 테스트 무결성 ─────────────────────────────────────────────────────────────────────
export const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const CONFIG_COVERAGE_RE = /(vitest|vite)\.config\.[cm]?[jt]s$|jest\.config/
const GATE_CONFIG_RE = /^package\.json$|^tsconfig[^/]*\.json$|^eslint\.config\.[cm]?[jt]s$|^\.eslintrc|^(vitest|vite)\.config\.[cm]?[jt]s$|^jest\.config/

/** 수리 라운드가 **새로 만든** 흔적은 경고가 아니라 차단이다(F5) — 기준선(첫 검사)에 없던 warn 을 block 으로 올린다.
 *  같은 rule+file 이 기준선에 있었으면(선재 skip·disable) 그대로 warn. 순수. */
/** 지문(fp) = 문제 줄의 정규화 내용. 줄 번호는 흔들리니 쓰지 않는다(같은 파일이 커지면 번호가 밀린다). */
export const normalizeFingerprint = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)

export function escalateRepairIntroduced(baseline, current) {
  // `rule|file` 만 보면 **같은 파일에 같은 종류의 skip 을 하나 더** 넣어도 기존 warning 에 가려진다(리뷰 #8).
  // 줄 내용 지문까지 열쇠에 넣어 「새로 생긴 줄」을 새 흔적으로 본다(지문이 없는 옛 기록끼리는 종전과 같다).
  const key = (f) => `${f.rule}|${f.file}|${f.fp ?? ''}`
  const seen = new Set((baseline ?? []).map(key))
  return (current ?? []).map((f) => (f.level === 'warn' && !seen.has(key(f)) ? { ...f, level: 'block', rule: `${f.rule}(repair-introduced)`, detail: `${f.detail} — 수리 라운드가 새로 만든 흔적(차단)` } : f))
}

/** unified diff → 파일별 {added:[{line,text}], removed:[...]} — 줄 번호는 hunk 헤더로 센다 */
export function splitDiffByFile(diff) {
  const out = {}
  let cur = null, newLine = 0
  for (const raw of String(diff ?? '').replace(/\r/g, '').split('\n')) {
    const h = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
    if (h) { cur = { path: h[2], added: [], removed: [] }; out[h[2]] = cur; continue }
    if (!cur) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { newLine = Number(hunk[1]); continue }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue
    if (raw.startsWith('+')) { cur.added.push({ line: newLine, text: raw.slice(1) }); newLine++ }
    else if (raw.startsWith('-')) cur.removed.push({ text: raw.slice(1) })
    else if (!raw.startsWith('\\')) newLine++
  }
  return out
}

const basename = (p) => String(p).split('/').pop()
/** 스토리 파일이 그 테스트 파일의 삭제 사유를 적었나 — 같은 줄에 파일명 + 삭제/제거 어휘 */
export function deletedTestJustified(storyText, path) {
  const base = basename(path)
  return String(storyText ?? '').split(/\r?\n/).some((l) => l.includes(base) && /(삭제|제거|폐기|delete|removed?|obsolete)/i.test(l))
}

/** changes = [{status:'A'|'M'|'D'|'R…', path}] (git diff --name-status) · diff = 통합 diff · storyText = 스토리 md.
 *  block = 반드시 해소(qa RED 와 같은 취급) · warn = 매니페스트·요약에 기록. */
export function testIntegrityFindings({ changes = [], diff = '', storyText = '' } = {}) {
  const out = []
  const push = (level, rule, file, line, detail, fp = '') => out.push({ level, rule, file, line: line || 0, detail, fp: normalizeFingerprint(fp) })
  for (const c of changes) {
    const st = String(c.status ?? '')[0]
    const p = String(c.path ?? '').replace(/\\/g, '/')
    if (st === 'D' && TEST_FILE_RE.test(p)) {
      if (deletedTestJustified(storyText, p)) push('warn', 'deleted-test-justified', p, 0, '테스트 파일 삭제 — 스토리에 사유 기재됨')
      else push('block', 'deleted-test', p, 0, '테스트 파일이 삭제됐는데 스토리 파일에 삭제 사유가 없다(실패 테스트 삭제 금지)')
    }
  }
  const files = splitDiffByFile(diff)
  for (const [path, f] of Object.entries(files)) {
    const isTest = TEST_FILE_RE.test(path)
    for (const a of f.added) {
      const t = a.text
      if (/\b(it|test|describe)\.only\s*\(/.test(t)) push('block', 'test-only', path, a.line, '`.only` 는 나머지 테스트를 조용히 끈다 — 커밋 전 제거', t)
      if (/\b(it|test|describe)\.skip\s*\(|\bx(it|test|describe)\s*\(|\btest\.todo\s*\(/.test(t)) push('warn', 'test-skip', path, a.line, '테스트 skip/todo 추가 — 사유가 스토리에 있어야 한다', t)
      if (/@ts-ignore/.test(t)) push('warn', 'ts-ignore', path, a.line, '@ts-ignore 추가 — 타입 오류 은폐 의심(@ts-expect-error + 사유 권장)', t)
      if (/eslint-disable/.test(t)) push('warn', 'eslint-disable', path, a.line, 'eslint-disable 추가 — 규칙 비활성화 사유 필요', t)
      if (isTest && /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)|expect\(\s*1\s*\)\.toBe\(\s*1\s*\)|assert\.ok\(\s*(?:1|true)\s*\)|assert\.(?:equal|strictEqual)\(\s*(true\s*,\s*true|1\s*,\s*1)\s*\)/.test(t)) push('warn', 'trivial-assertion', path, a.line, '항상 참인 단언 — 결함을 재현하지 못한다', t)
      if (CONFIG_COVERAGE_RE.test(path) && /exclude\s*:/.test(t)) push('warn', 'coverage-exclude', path, a.line, '커버리지·테스트 exclude 추가 — 사유 필요', t)
      // 빈 테스트 본문 — `it('x', () => {})` 은 언제나 통과한다(단언 0). trivial assertion 과 같은 갈래.
      if (isTest && /\b(it|test)\s*\(\s*(['"`])[^'"`]*\2\s*,\s*(async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(t)) push('warn', 'empty-test', path, a.line, '본문이 빈 테스트 — 단언 0건이라 언제나 통과한다', t)
    }
    // 게이트 자체를 손대 통과시키는 가장 싼 우회(F32) — qa/lint/typecheck/test 스크립트 · tsconfig · eslint/vite 설정
    if (GATE_CONFIG_RE.test(path)) {
      const touched = f.added.filter((a) => path === 'package.json' ? /"(qa|lint|typecheck|test|build)"\s*:/.test(a.text) : true)
      if (touched.length) push('warn', 'gate-config-changed', path, touched[0].line, '품질 게이트 정의(스크립트·tsconfig·eslint/vite 설정)가 바뀌었다 — 통과 우회 의심 · 사유 필요', touched[0].text)
    }
    if (isTest) {
      const removedExpect = f.removed.filter((r) => /\bexpect\s*\(/.test(r.text)).length
      const addedExpect = f.added.filter((r) => /\bexpect\s*\(/.test(r.text)).length
      // 순 감소 2 이상 = 「단언 3개를 항상-참 1개로 바꾼」 류. 경고일 뿐이라(차단 아님) 오탐 비용은 기록 한 줄이다.
      if (removedExpect - addedExpect >= 2) push('warn', 'assertion-weakened', path, 0, `단언 ${removedExpect}개 제거 · ${addedExpect}개 추가 — 단언 약화 의심`, `-${removedExpect}/+${addedExpect}`)
    }
  }
  return out
}

// ── 조건부 게이트 트리거 ───────────────────────────────────────────────────────────────
const SEC_PATH_RE = /(auth|login|session|token|permission|role|rls|polic|secret|vault|upload|migrations\/|functions\/|middleware|guard)/i
const SEC_DIFF_RE = /\b(auth\.|jwt|bearer|password|secret|service_role|api[_-]?key|create policy|alter policy|grant |revoke |security definer|dangerouslySetInnerHTML|innerHTML|eval\(|new Function\(|multipart|upload|cookie|cors)/i
const PERF_PATH_RE = /(pagination|cache|batch|worker|queue|image|resize|export|report|chart)/i
const PERF_DIFF_RE = /(paginat|\.range\(|\.limit\(|cache|memo(ize)?|batch|Promise\.all|createObjectURL|FileReader|canvas|sharp|resize|for \(.*of .*\)\s*\{[^}]*await|while \(true\))/i

export function securityTriggers({ files = [], diff = '' } = {}) {
  const reasons = []
  for (const f of files) if (SEC_PATH_RE.test(f)) reasons.push(`경로: ${f}`)
  const added = String(diff ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  for (const l of added) { const m = SEC_DIFF_RE.exec(l); if (m) { reasons.push(`diff: ${m[0]}`); if (reasons.length > 12) break } }
  return { required: reasons.length > 0, reasons: [...new Set(reasons)].slice(0, 12) }
}
export function performanceTriggers({ files = [], diff = '' } = {}) {
  const reasons = []
  for (const f of files) if (PERF_PATH_RE.test(f)) reasons.push(`경로: ${f}`)
  const added = String(diff ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  for (const l of added) { const m = PERF_DIFF_RE.exec(l); if (m) { reasons.push(`diff: ${m[0].slice(0, 40)}`); if (reasons.length > 12) break } }
  return { required: reasons.length > 0, reasons: [...new Set(reasons)].slice(0, 12) }
}

// ── 매니페스트 ────────────────────────────────────────────────────────────────────────
/** qa 사슬(typecheck→lint→test)에서 각 단계 판정: 통과면 사슬 전부 pass · 실패면 그 단계 fail, 앞은 pass, 뒤는 not-run */
export function qaSubchecks({ chain = [], qaExit = null, failureKind = 'unknown' } = {}) {
  const out = {}
  if (qaExit === null) { for (const s of chain) out[chainToKind[s] ?? s] = 'not-run'; return out }
  if (qaExit === 0) { for (const s of chain) out[chainToKind[s] ?? s] = 'pass'; return out }
  const idx = chain.findIndex((s) => (chainToKind[s] ?? s) === failureKind)
  chain.forEach((s, i) => { const k = chainToKind[s] ?? s; out[k] = idx < 0 ? 'unknown' : i < idx ? 'pass' : i === idx ? 'fail' : 'not-run' })
  return out
}

export const MANIFEST_SCHEMA = 'auto-story-finish/verification/1'
export function buildVerificationManifest({ story, generatedAt, branch = '', commit = '', workers = {}, gates = {}, qa = {}, integrity = [], repair = {}, review = null, security = {}, performance = {}, escalation = null, notes = [] } = {}) {
  const sub = qaSubchecks({ chain: qa.chain ?? [], qaExit: qa.exit ?? null, failureKind: qa.failureKind ?? 'unknown' })
  const gate = (name) => (gates?.[name]?.available ? undefined : `n/a(package.json scripts 에 ${name} 없음)`)
  const checks = {
    qa: qa.exit === null || qa.exit === undefined ? 'not-run' : qa.exit === 0 ? 'pass' : 'fail',
    typecheck: sub.typecheck ?? (gates?.typecheck?.available ? 'unknown' : gate('typecheck')),
    lint: sub.lint ?? (gates?.lint?.available ? 'unknown' : gate('lint')),
    build: sub.build ?? (gates?.build?.available ? 'not-run' : gate('build')),
    unit: sub.test ?? (gates?.test?.available ? 'unknown' : gate('test')),
    integration: 'unknown(mock/픽스처 통과는 운영 통합 성공이 아니다 — landing 후 통합 게이트가 별도)',
    coverage: gates?.coverage?.available ? (qa.coverage ?? 'not-run') : 'n/a(coverage 스크립트 없음)',
    // 트리거 + 스크립트 있음 = **실제로 실행한다**(#10) — 그 결과(pass/fail)를 그대로 싣는다.
    security: security.required ? (gates?.security?.available ? (security.result ?? qa.security ?? 'not-run') : 'required-missing(트리거됐으나 프로젝트에 보안 테스트 스크립트 없음)') : 'not-required',
    performance: performance.required ? (gates?.performance?.available ? (performance.result ?? qa.performance ?? 'not-run') : 'required-missing(트리거됐으나 성능 테스트 스크립트 없음)') : 'not-required',
    e2e: gates?.e2e?.available ? (qa.e2e ?? 'not-run(배치 종료 후 1회 · --e2e)') : 'n/a(e2e 스크립트 없음)',
  }
  return {
    schema: MANIFEST_SCHEMA, story, generatedAt, branch, commit,
    workers, checks,
    triggers: { security: security.reasons ?? [], performance: performance.reasons ?? [] },
    // 실행한 조건부 게이트의 실물 기록 — 무엇을 어떤 exit 로 돌렸는지(안 돌렸으면 script 가 없다).
    conditionalGates: {
      security: { script: security.script ?? null, exit: security.exit ?? null, result: security.result ?? (security.required ? 'not-run' : 'not-required') },
      performance: { script: performance.script ?? null, exit: performance.exit ?? null, result: performance.result ?? (performance.required ? 'not-run' : 'not-required') },
    },
    integrity, repair: { attempts: repair.attempts ?? 0, signatures: repair.signatures ?? [], exhausted: Boolean(repair.exhausted) },
    review, escalation, notes,
  }
}

// ── 에스컬레이션 보고 ─────────────────────────────────────────────────────────────────
/** 사람을 부를 때의 고정 6절 — 「어떻게 할까요?」 금지. 문자열 하나로 돌려준다(알림·로그·매니페스트 공용). */
export function escalationReport({ story, stage, situation, cause, tried = [], options = [], recommendation, risk }) {
  const li = (xs) => (xs.length ? xs.map((x, i) => `  ${i + 1}. ${x}`).join('\n') : '  (없음)')
  return [
    `🆘 사람 판단 필요 — [${story}] ${stage}`,
    `1) 상황: ${situation}`,
    `2) 원인: ${cause}`,
    `3) 이미 시도한 것:\n${li(tried)}`,
    `4) 선택지:\n${li(options)}`,
    `5) 추천: ${recommendation}`,
    `6) 위험도: ${risk}`,
  ].join('\n')
}
