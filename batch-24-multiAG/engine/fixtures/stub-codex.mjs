// stub-codex.mjs — **실제 node 프로세스**로 도는 codex CLI 스텁 (종단 테스트 전용).
//
// `codex exec` 의 실제 계약을 흉내 낸다: JSONL 이벤트를 stdout 으로 흘리고, `-o <파일>` 이 있으면
// 같은 JSON 을 그 파일에도 쓴다. 실제 `codex` 는 절대 부르지 않는다.
//
// 환경변수
//   STUB_DIR             호출 기록 폴더(`codex-calls.jsonl`)
//   STUB_CODEX_VERSION   `--version` 응답
//   STUB_CODEX_LIMIT=1   한도 소진 사건(엔진의 claude 폴백 갈래를 재현)
//   STUB_CODEX_FINDING   이 스토리에는 medium 지적 1건을 낸다(그 밖은 clean)
//   STUB_CODEX_FAIL=1    turn.failed + exit 1
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const STUB_CODEX_PATH = join(HERE, 'stub-codex.mjs')

/** 기록된 호출 목록(테스트 도우미). */
export function readCodexCalls(stubDir) {
  const p = join(stubDir, 'codex-calls.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()

function main() {
  const argv = process.argv.slice(2)
  const dir = process.env.STUB_DIR || ''
  const record = (o) => {
    if (!dir) return
    try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, 'codex-calls.jsonl'), JSON.stringify(o) + '\n') } catch { /* 기록 실패로 스텁을 세우지 않는다 */ }
  }
  const ev = (o) => console.log(JSON.stringify(o))

  if (argv.includes('--version')) {
    record({ tool: 'codex', kind: 'version', argv })
    console.log(process.env.STUB_CODEX_VERSION || 'codex-cli 0.152.1-stub')
    process.exit(0)
  }
  if (argv[0] === 'login' && argv[1] === 'status') {
    record({ tool: 'codex', kind: 'login-status', argv })
    console.log('Logged in using ChatGPT')
    process.exit(0)
  }

  let prompt = ''
  try { prompt = readFileSync(0, 'utf8') } catch { prompt = '' }
  const story = /스토리\s+(\S+)/.exec(prompt)?.[1] ?? '?'
  const outIdx = argv.indexOf('-o')
  const out = outIdx >= 0 ? argv[outIdx + 1] : null
  const sIdx = argv.indexOf('-s')
  record({ tool: 'codex', kind: 'exec', story, sandbox: sIdx >= 0 ? argv[sIdx + 1] : null, argv, cwd: process.cwd(), promptBytes: prompt.length })

  if (process.env.STUB_CODEX_LIMIT === '1') {
    ev({ type: 'thread.started', thread_id: 't' })
    ev({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro" })
    ev({ type: 'turn.failed', error: { message: 'usage limit' } })
    process.exit(1)
  }
  if (process.env.STUB_CODEX_FAIL === '1') {
    ev({ type: 'thread.started', thread_id: 't' })
    ev({ type: 'turn.failed', error: { message: 'stub 실패(의도)' } })
    process.exit(1)
  }

  const findings = process.env.STUB_CODEX_FINDING === story
    ? [{ lens: 'blind', severity: 'medium', kind: 'patch', title: '스텁 codex 지적', file: 'src/feature/c.ts', line: 1, detail: '스텁이 낸 지적', evidence: 'export const', preExisting: false }]
    : []
  const json = {
    summary: '스텁 codex 리뷰',
    verdict: findings.length ? 'findings' : 'clean',
    acVerdicts: [{ ac: 'AC-1', status: 'pass', evidence: 'stub' }],
    findings,
  }
  ev({ type: 'thread.started', thread_id: 't1' })
  ev({ type: 'turn.started' })
  // 열람 증거(BRIEF 정책 14) — 엔진은 clean 리뷰를 「명령 개수」가 아니라 **스토리 파일·리뷰 diff 를
  // 실제로 읽었는가**로 인정한다. 프롬프트가 지목한 경로를 그대로 읽은 것처럼 남긴다.
  // 프롬프트가 경로를 두 형식으로 준다: ① 백틱(`스토리 파일`·`diff 파일`) ② `- 변경 파일:` 아래의
  // 들여쓴 목록(백틱 없음 · 비ASCII 이름은 git C-인용 `"…\\355\\214…"` 형태 그대로).
  // ②를 빼먹으면 엔진이 「변경 구현 파일 0건 열람」으로 clean 을 무효 처리한다(codex-review-r3 M6).
  // 그래서 목록 줄은 **글자 그대로** 옮긴다 — 확장자로 거르거나 따옴표를 벗기면 엔진의 문자열 대조가 빗나간다.
  const looksPath = (x) => /[/\\]/.test(x) && /\.(md|diff|txt|ts|tsx|sql|json|mjs)$/i.test(x)
  const changed = []
  const lines = prompt.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!/^-\s*변경 파일:/.test(lines[i])) continue
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^\s+-\s+(.+?)\s*$/.exec(lines[j])
      if (!m) break
      if (!m[1].startsWith('(')) changed.push(m[1])
    }
  }
  const seen = [...new Set([
    ...[...prompt.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter(looksPath),
    ...changed,
  ])].slice(0, 12)
  seen.forEach((p, i) => ev({ type: 'item.completed', item: { id: `c${i}`, type: 'command_execution', command: `cat ${p}`, exit_code: 0 } }))
  if (seen.length === 0) ev({ type: 'item.completed', item: { id: 'c0', type: 'command_execution', command: 'cat', exit_code: 0 } })
  ev({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: JSON.stringify(json) } })
  ev({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
  if (out) {
    // `-o` 는 절대 경로로 올 수 있다(엔진 실물) — cwd 와 무조건 합치면 `C:\proj\C:\…` 가 된다.
    const p = isAbsolute(out) ? out : join(process.cwd(), out)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(json))
  }
  process.exit(0)
}
