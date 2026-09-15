// 러너 qa 창 감지(v0.2 · 파티 판정 3항) — 같은 PC 의 24시간 러너가 qa(typecheck·lint·vitest)를 돌리는 동안은
// screen-check 를 시작하지 않는다(2026-09-09 429 원인 = 러너 qa 의 1분 100회 로그인 · 스크린체크가 아니다).
// 판정 재료 3가지(하나라도 참이면 「바쁨」):
//   ① (참고만) ~/.baroos-auto/runner.lock — 배치 진행 자체는 막지 않는다(24시간 러너라 항상 켜져 있을 수 있다) · 막는 건 qa 창·codex 창
//   ② slots.log 마지막 qa-gate 줄 이후에 「배치 종료」 줄이 없고 그 줄이 최근 N분 이내
//   ③ vitest / tsc / eslint 프로세스가 살아 있음(대화형 세션의 qa 도 같은 부하)
//   ④ 러너의 codex exec 프로세스(리뷰 진행 중)가 살아 있음 — 벌 C(Codex)는 이때 시작하지 않는다(Codex 끼리 동시 금지)
// 사용: node runner-window.mjs [--wait <분>]  → exit 0 = 시작 가능 · exit 3 = 바쁨(대기 초과)
//       import { runnerBusy, waitForWindow } from './runner-window.mjs'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const STATE = process.env.BAROOS_STATE_DIR ?? resolve(homedir(), '.baroos-auto')
const RECENT_MIN = Number(process.env.SC_QA_WINDOW_MIN ?? 20)

function tailLines(file, n = 400) {
  if (!existsSync(file)) return []
  const buf = readFileSync(file)
  const text = buf.subarray(Math.max(0, buf.length - 512 * 1024)).toString('utf8')
  return text.split(/\r?\n/).slice(-n)
}

export function runnerBusy() {
  const reasons = []
  const notes = []
  if (existsSync(resolve(STATE, 'runner.lock'))) notes.push('runner.lock 존재(배치 진행 중 — qa/codex 창만 피한다)')
  const log = resolve(STATE, 'slots.log')
  const lines = tailLines(log)
  const lastQa = lines.map((l, i) => [i, l]).filter(([, l]) => /qa-gate|\[QA\]|\[INTEGRATION\]\[RUN\]/.test(l)).pop()
  const lastEnd = lines.map((l, i) => [i, l]).filter(([, l]) => /배치 종료|COMPLETION|STOP|exit \d/.test(l)).pop()
  if (lastQa && (!lastEnd || lastEnd[0] < lastQa[0])) {
    const ageMin = existsSync(log) ? (Date.now() - statSync(log).mtimeMs) / 60000 : 999
    if (ageMin <= RECENT_MIN) reasons.push(`slots.log qa-gate 진행 중(마지막 기록 ${ageMin.toFixed(0)}분 전)`)
  }
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\' or Name=\'codex.exe\'\\" | ForEach-Object { $_.CommandLine }"', { encoding: 'utf8', timeout: 15000 })
    const lines = out.split(/\r?\n/)
    const hits = lines.filter((l) => /vitest|\btsc\b|eslint/.test(l) && !/screen-check|e2e-tools/.test(l))
    if (hits.length) reasons.push(`qa 프로세스 ${hits.length}개(vitest/tsc/eslint)`)
    // 러너의 codex exec(리뷰) — Codex 끼리 동시 실행 금지. 우리 벌 C(-C <root>/e2e-wt)는 제외
    const cx = lines.filter((l) => /codex(\.exe)?["']?\s+exec\b/.test(l) && !/e2e-wt/.test(l))
    if (cx.length) reasons.push(`러너 codex exec ${cx.length}개(리뷰 진행 중)`)
  } catch { /* 프로세스 조회 실패는 「모름」 — 막지 않는다 */ }
  return { busy: reasons.length > 0, reasons, notes }
}

export async function waitForWindow(maxMin = 0, everySec = 30) {
  const until = Date.now() + maxMin * 60000
  for (;;) {
    const r = runnerBusy()
    if (!r.busy) return r
    console.log('[runner-window] 바쁨:', r.reasons.join(' · '))
    if (Date.now() >= until) return r
    await new Promise((res) => setTimeout(res, everySec * 1000))
  }
}

if (process.argv[1] && /runner-window\.mjs$/.test(process.argv[1])) {
  const i = process.argv.indexOf('--wait')
  const r = await waitForWindow(i > 0 ? Number(process.argv[i + 1]) : 0)
  console.log(r.busy ? `BUSY — ${r.reasons.join(' · ')}` : 'FREE — screen-check 시작 가능')
  process.exit(r.busy ? 3 : 0)
}
