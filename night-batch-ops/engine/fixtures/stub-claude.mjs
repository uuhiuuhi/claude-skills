// stub-claude.mjs — **실제 node 프로세스**로 도는 claude CLI 스텁 (종단 테스트 전용).
//
// 왜 실제 프로세스인가: 함수 스텁을 주입하면 「Windows `.cmd` 심이 argv 를 어떻게 받는가」·「stdin 으로
// 프롬프트가 실제로 들어오는가」·「러너 → 엔진 → 워커 3단 spawn 이 이어지는가」를 영영 못 본다.
// 2026-09-02 하드닝에서 고친 결함 대부분(#6 셸 결합 · #8 공백 경로)이 그 경계에서만 재현됐다.
//
// 계약:
//   · argv 와 stdin 전문을 `$STUB_DIR/claude-calls.jsonl` 에 **한 줄 JSON** 으로 남긴다(테스트가 읽는다).
//   · 응답은 환경변수로 지정한다 — 모델을 흉내 내지 않는다(무엇을 돌려줄지는 테스트가 정한다).
//   · 실제 `claude` 를 절대 부르지 않는다.
//
// 환경변수
//   STUB_DIR            기록 폴더(없으면 기록만 생략하고 정상 동작)
//   STUB_VERSION        `--version` 응답(기본 `2.1.250-stub (Claude Code)`)
//   STUB_PLAN           편성 계획 요청에 대한 응답: fable(기본) · invented · garbage · empty · error · leak
//                       leak = stderr 에 자격증명 한 줄을 흘리며 실패한다(마스킹 경로 검증용)
//   STUB_PLAN_MODELS    계획이 실을 모델 JSON(기본 `{"dev":"opus","review":"fable"}`)
//   STUB_FAIL_STORY     이 스토리의 dev 는 실패(exit 1)한다
//   STUB_REVIEW_FINDING 이 스토리의 리뷰는 열린 Patch 1건을 남긴다(clean 아님)
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CLAUDE_STUB_PATH = join(HERE, 'stub-claude.mjs')
export const CODEX_STUB_PATH = join(HERE, 'stub-codex.mjs')

/**
 * 스텁을 CLI 이름으로 부를 수 있게 심(shim)을 만든다.
 * Windows 는 `.cmd`(CreateProcess 가 `.mjs` 를 직접 못 돈다) · 그 밖은 `#!/bin/sh` 실행 파일.
 * @returns {string} 만들어진 심의 절대 경로 — `CLAUDE_BIN`/`CODEX_BIN` 에 그대로 넣는다.
 */
export function writeShim(binDir, name, scriptPath) {
  mkdirSync(binDir, { recursive: true })
  if (process.platform === 'win32') {
    const p = join(binDir, `${name}.cmd`)
    writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`)
    return p
  }
  const p = join(binDir, name)
  writeFileSync(p, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 })
  return p
}

/** claude·codex 스텁 심을 한 번에 깐다. @returns {{claude:string, codex:string}} */
export function installStubs(binDir) {
  return {
    claude: writeShim(binDir, 'claude', CLAUDE_STUB_PATH),
    codex: writeShim(binDir, 'codex', CODEX_STUB_PATH),
  }
}

/** 기록된 호출 목록(테스트 도우미). */
export function readCalls(stubDir, file = 'claude-calls.jsonl') {
  const p = join(stubDir, file)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
}

// ── 여기부터는 **스텁 프로세스 본체** ────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

function main() {
  const argv = process.argv.slice(2)
  const dir = process.env.STUB_DIR || ''
  const record = (o) => {
    if (!dir) return
    try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, 'claude-calls.jsonl'), JSON.stringify(o) + '\n') } catch { /* 기록 실패로 스텁을 세우지 않는다 */ }
  }

  if (argv.includes('--version')) {
    record({ tool: 'claude', kind: 'version', argv })
    console.log(process.env.STUB_VERSION || '2.1.250-stub (Claude Code)')
    process.exit(0)
  }

  let prompt = ''
  try { prompt = readFileSync(0, 'utf8') } catch { prompt = '' }
  const cwd = process.cwd()

  // ① 인증 프로브 — 엔진이 `ok` 한 글자를 보낸다
  if (prompt.trim() === 'ok') { record({ tool: 'claude', kind: 'probe', argv, cwd }); process.exit(0) }

  // ② 편성 계획 요청(Fable 오케스트레이터)
  if (/야간 배치 편성 계획 요청/.test(prompt)) {
    record({ tool: 'claude', kind: 'plan', argv, cwd, promptBytes: prompt.length })
    return respondPlan(prompt)
  }

  // ③ dev
  let m = /\/bmad-dev-story\s+(\S+)/.exec(prompt)
  if (m) { record({ tool: 'claude', kind: 'dev', story: m[1], argv, cwd }); return devStory(cwd, m[1]) }

  // ④ review
  m = /\/bmad-code-review\s+(\S+)/.exec(prompt)
  if (m) { record({ tool: 'claude', kind: 'review', story: m[1], argv, cwd }); return reviewStory(cwd, m[1]) }

  // ⑤ 자동 수리
  if (/자동 수리/.test(prompt)) {
    record({ tool: 'claude', kind: 'repair', argv, cwd })
    try { writeFileSync(join(cwd, 'REPAIRED'), '1') } catch { /* 워크트리 밖이면 무시 */ }
    console.log('수리 완료')
    process.exit(0)
  }

  record({ tool: 'claude', kind: 'unknown', argv, cwd, promptHead: prompt.slice(0, 200) })
  console.error('stub-claude: 알 수 없는 프롬프트')
  process.exit(1)
}

// ── 계획 응답 ────────────────────────────────────────────────────────────────
function respondPlan(prompt) {
  const mode = process.env.STUB_PLAN || 'fable'
  if (mode === 'empty') process.exit(0)
  if (mode === 'error') { console.error('stub-claude: 계획 실패(의도된 실패)'); process.exit(1) }
  // 실제 CLI 가 실패하며 stderr 첫 줄에 자격증명을 뱉는 상황(NEW-H4). 이 값이 호출부 로그로 나가면 안 된다.
  if (mode === 'leak') {
    console.error(`stub-claude: 계획 실패 — Authorization: Bearer ${process.env.STUB_LEAK_TOKEN || 'TOKENVALUE123456'}`)
    process.exit(1)
  }
  if (mode === 'garbage') { console.log('계획은 이렇습니다. (JSON 이 아니다)'); process.exit(0) }

  const cands = candidatesOf(prompt)
  const models = (() => { try { return JSON.parse(process.env.STUB_PLAN_MODELS || '') } catch { return { dev: 'opus', review: 'fable' } } })()
  // 후보를 **뒤집어** 한 배치 한 스토리로 낸다 — 규칙 계획과 순서가 달라야 「채택됐다」를 눈으로 센다.
  const batches = [...cands].reverse().map((c, i) => ({
    label: `FABLE-${i + 1}: ${c.key}`,
    stories: [c.key],
    stages: Array.isArray(c.stages) && c.stages.length ? c.stages : ['dev', 'review'],
    models,
  }))
  if (mode === 'invented') batches.push({ label: 'FABLE-지어냄', stories: ['99-99-없는-스토리'], stages: ['dev'], models })
  const plan = { rationale: '스텁 계획 — 후보를 역순으로 한 스토리씩', batches }
  console.log(JSON.stringify({ type: 'result', result: JSON.stringify(plan) }))
  process.exit(0)
}

function candidatesOf(prompt) {
  const after = prompt.split('## 후보')[1] ?? ''
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(after)?.[1] ?? '[]'
  try { const j = JSON.parse(block); return Array.isArray(j) ? j : [] } catch { return [] }
}

// ── dev · review ─────────────────────────────────────────────────────────────
const ART = '_bmad-output/implementation-artifacts'
const BT = String.fromCharCode(96)

function storyFile(cwd, key) {
  const dir = join(cwd, ART)
  const hit = readdirSync(dir).filter((f) => f.startsWith(key) && f.endsWith('.md')).sort((a, b) => a.length - b.length)[0]
  return hit ? join(dir, hit) : null
}

function setSprint(cwd, key, status) {
  const p = join(cwd, ART, 'sprint-status.yaml')
  try {
    const t = readFileSync(p, 'utf8')
    writeFileSync(p, t.replace(new RegExp(`^(  ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*)\\S+`, 'm'), `$1${status}`))
  } catch { /* 없으면 그대로 */ }
}

/** File List 절의 백틱 경로 전부(한 줄에 2개인 실물 형식 포함). */
function declaredFiles(md) {
  const sec = /### File List\n([\s\S]*?)(?=\n#{2,3} |\n*$)/.exec(md)?.[1] ?? ''
  return [...sec.matchAll(new RegExp(BT + '([^' + BT + '\n]+)' + BT, 'g'))].map((x) => x[1]).filter((p) => p.includes('/'))
}

function devStory(cwd, key) {
  if (process.env.STUB_FAIL_STORY === key) {
    console.error('stub-claude: dev 실패(의도된 실패)')
    process.exit(1)
  }
  const f = storyFile(cwd, key)
  if (!f) { console.error(`stub-claude: 스토리 파일을 찾지 못했다 — ${key}`); process.exit(1) }
  let md = readFileSync(f, 'utf8')
  for (const rel of declaredFiles(md)) {
    const p = join(cwd, rel)
    mkdirSync(dirname(p), { recursive: true })
    if (!existsSync(p)) writeFileSync(p, `export const ${key.replace(/[^A-Za-z0-9]/g, '_')} = 1\n`)
  }
  // 열린 Patch 를 **먼저** 닫는다(취소선 형식 하나 — 원장 표기 규칙). 순서가 반대면 아래 Task 틱이
  // `- [ ]` 를 먼저 지워 이 정규식이 영영 걸리지 않는다.
  md = md.replace(/^- \[ \] (\*\*)?\[Review\]\[Patch\](\[[a-z]+\])?\s*(.+)$/gm,
    (_m, b, sev, rest) => `- [x] ${b ?? ''}[Review][Patch]${sev ?? ''} ~~${String(rest).replace(/\*\*/g, '')}~~ — ✅ 해소(스텁 dev)`)
  // 미완 Task 를 닫는다 — 단 👤 사람 게이트 줄은 **건드리지 않는다**(사람 몫이다).
  md = md.split('\n').map((l) => (l.startsWith('- [ ]') && !l.includes('👤') ? l.replace('- [ ]', '- [x]') : l)).join('\n')
  md = md.replace(/^Status:\s*\S+/m, 'Status: review')
  writeFileSync(f, md)
  setSprint(cwd, key, 'review')
  console.log(`dev 완료 — ${key}`)
  process.exit(0)
}

function reviewStory(cwd, key) {
  const f = storyFile(cwd, key)
  if (!f) { console.error(`stub-claude: 스토리 파일을 찾지 못했다 — ${key}`); process.exit(1) }
  let md = readFileSync(f, 'utf8')
  const finding = process.env.STUB_REVIEW_FINDING === key
    ? '- [ ] **[Review][Patch][medium] 스텁 리뷰가 남긴 지적**\n'
    : '- ✅ Clean review — 발견 0건\n'
  md = md.replace('## Dev Notes', `### Review Findings — claude 스텁\n\n${finding}\n## Dev Notes`)
  if (!finding.startsWith('- [ ]')) md = md.replace(/^Status:\s*\S+/m, 'Status: done')
  writeFileSync(f, md)
  if (!finding.startsWith('- [ ]')) setSprint(cwd, key, 'done')
  console.log(`review 완료 — ${key}`)
  process.exit(0)
}

// 진입은 **맨 끝**이다 — 위쪽 `const` 선언(ART·BT)보다 먼저 부르면 TDZ 로 죽는다(2026-09-03 실측).
if (isMain) main()
