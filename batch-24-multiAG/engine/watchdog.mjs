// engine/watchdog.mjs (설치본 tools/auto/watchdog.mjs) — 24시간 러너 **감시자(지휘자 대행)**. 👤 2026-09-09 밤 지시:
//   「일정 시간 이상 멈춰 있으면 원인 찾아서 계속 진행하는 지휘자 역할이 되도록」.
//
// 왜 필요한가: 러너(예약작업 `<project>-auto-slots` · 30분)는 같은 배치가 같은 이유로 멈춰도(예: 5-1 마감 재검수
// 「구현자 모델 기록 없음」 exit 5 · 2026-09-09 밤 6슬롯 연속) 다음 슬롯에 **같은 일을 또 시도**한다 —
// exit 5 를 「한도(날씨)」로 보고 차단기에서 빼기 때문이다. 아침에 사람이 「멈춰 있었습니다 · 원인을
// 찾겠습니다」로 시작하던 하루가 여기서 사라진다.
//
// 무엇을 하나(슬롯 사이 · 30분마다 · 예약작업 `<project>-watchdog`):
//   ① 진단 — exit-info.json(엔진 STOP 부기) + night-last-run.md + slots.log 로 「같은 스토리·같은 이유 반복」 ·
//      「러너 침묵(75분 이상 라운드 없음)」 · 「lock 정체(3시간 이상 로그 정지)」 를 가른다.
//   ② 알려진 원인은 플레이북으로 **바로 고친다**(구현자 기록 부재 → state.json 복원 · 런타임 핀 불일치 →
//      핀 재기록 · codex CLI 판 부족 → 재설치 · 429/한도 → 대기).
//   ③ 모르는 원인은 Claude 진단 세션(headless `claude -p` · opus · 편집 허용 = 상태·설정 파일만)을 불러
//      원인을 찾고 고치게 한다(보고서 `<상태 폴더>/watchdog-claude-<ts>.md`).
//   ④ 고친 뒤 러너를 **즉시 기동**(Start-ScheduledTask · lock 이 중복을 막는다).
//   ⑤ 같은 스토리가 수리 뒤에도 3회 이상 반복 정지하면 그 스토리 파일에 `BLOCKED-ON-HUMAN:` 표식을 남겨
//      **그 스토리만** 편성에서 빼고(plan-queue 자율운전 ⑦) 나머지는 계속 돌린다 → 사람은 「내가 할 일 뭐야」로 본다.
//   ⑥ 모든 판단·행동을 `<상태 폴더>/watchdog.log` 에 남기고 텔레그램(비공개 봇)으로 알린다.
//   ⑦ 증거 보존 정리(👤 2026-09-12 「1 승인」) — `<상태 폴더>/archive/<날짜>-<ts>-evidence` 가 3일(WD_EVIDENCE_KEEP_DAYS)을
//      넘기면 삭제한다. 09-12 실사고: 한도 대기 루프가 하루 207폴더·214 GB 를 쌓아 C: 가 0 바이트가 됐고(엔진 쪽은 무작업
//      exit 5 증거 생략으로 막았다), 실 STOP 증거도 건당 수백 MB 라 보존 기간 없이는 며칠이면 다시 찬다. `-evidence` 폴더만 본다.
//
// 하지 않는 것: 앱 코드 수정 · main 머지 · 배포 · 운영 DB · 외부 발송(텔레그램 봇 = 내부 채널). 운영 방식 5항 그대로.
// 사용: node tools/ops/watchdog.mjs [--dry-run] [--once] [--no-claude] [--force-restart]
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { restoreDevProvenance, stopBlocked, stopWindowId } from './runner-rules.mjs'

const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const DRY = has('--dry-run'); const NO_CLAUDE = has('--no-claude')
// 프로젝트 고유값은 코드에 박지 않는다 — 환경변수 → 설치된 프로젝트의 tools/auto/auto.config.json → 위치에서 유도 순으로 정한다.
//   러너 폴더 = 이 파일(tools/auto/watchdog.mjs)이 설치된 저장소 루트 · 상태 폴더 = config.stateDir(없으면 ~/.claude-auto/<project>)
//   예약작업 이름 = config.watchdog.runnerTask(없으면 `<project>-auto-slots`) · 정본 = config.watchdog.canonicalDir(없으면 이웃 claude-skills → 전역 스킬 폴더)
//   BAROOS_* 환경변수는 첫 설치 프로젝트의 옛 이름이라 호환으로만 읽는다.
const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const RUNNER = (process.env.AUTO_RUNNER_DIR ?? process.env.BAROOS_RUNNER_DIR ?? resolve(SELF_DIR, '..', '..')).replace(/\\/g, '/')
// 설정을 못 읽으면 추측으로 돌지 않는다 — 엉뚱한 상태 폴더·예약작업을 감시·기동하는 것보다 멈추는 편이 안전하다.
const CONFIG_PATH = join(RUNNER, 'tools', 'auto', 'auto.config.json')
const CONFIG = (() => {
  if (!existsSync(CONFIG_PATH)) { console.error(`[watchdog] 설정 파일 없음: ${CONFIG_PATH} — AUTO_RUNNER_DIR 를 러너 폴더로 지정하거나 설치를 확인하세요`); process.exit(2) }
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')) } catch (e) { console.error(`[watchdog] 설정 파일을 읽지 못함: ${CONFIG_PATH} — ${e?.message ?? e}`); process.exit(2) }
})()
const PROJECT = String(CONFIG.project ?? basename(RUNNER))
const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, homedir())
const STATE_DIR = resolve(expandHome(process.env.AUTO_BATCH_STATE_DIR ?? process.env.BAROOS_STATE_DIR ?? CONFIG.stateDir ?? join(homedir(), '.claude-auto', PROJECT)))
const RUNNER_TASK = process.env.AUTO_RUNNER_TASK ?? process.env.WD_RUNNER_TASK ?? CONFIG.watchdog?.runnerTask ?? `${PROJECT}-auto-slots` // ops/lib.sh 와 같은 이름을 먼저 읽는다
const CANONICAL = process.env.WD_CANONICAL_DIR ?? CONFIG.watchdog?.canonicalDir
  ?? [resolve(RUNNER, '..', 'claude-skills', 'batch-24-multiAG'), join(homedir(), '.claude', 'skills', 'batch-24-multiAG')].find((d) => existsSync(join(d, 'install.mjs')))
  ?? join(homedir(), '.claude', 'skills', 'batch-24-multiAG')
// 진단 세션이 도는 폴더(사람이 평소 쓰는 체크아웃 — 그 폴더의 Claude 메모리를 읽게 한다). 없으면 러너 폴더.
const PROJECT_DIR = (process.env.WD_PROJECT_DIR ?? CONFIG.watchdog?.projectDir ?? RUNNER).replace(/\\/g, '/')
const MEMORY_MD = join(homedir(), '.claude', 'projects', PROJECT_DIR.replace(/[:\\/]/g, '-'), 'memory', 'MEMORY.md')
const LOGS = join(RUNNER, '_bmad-output', 'implementation-artifacts', 'auto-pipeline-logs')
const STORIES = join(RUNNER, '_bmad-output', 'implementation-artifacts')
const WD_LOG = join(STATE_DIR, 'watchdog.log')
const WD_STATE = join(STATE_DIR, 'watchdog-state.json')
const SILENT_MIN = Number(process.env.WD_SILENT_MIN ?? 75)      // 이 시간 이상 새 라운드가 없으면 「침묵」
const SHELL_STUCK_MIN = Number(process.env.WD_SHELL_STUCK_MIN ?? 20) // 예약작업은 Running 인데 lock 없이 이 시간 동안 일지가 그대로면 「껍데기 정지」(2026-09-24 06:35 실사고)
const LOCK_STALE_MIN = Number(process.env.WD_LOCK_STALE_MIN ?? 180)
const REPEAT_FIX_AT = 2                                           // 같은 이유 2회 반복 → 수리
const REPEAT_GATE_AT = 3                                          // 수리 뒤에도 3회 → 그 스토리만 편성 제외
const RETRY_AFTER_MIN = Number(process.env.WD_RETRY_AFTER_MIN ?? 180) // 미해소(진단 unfixed/skipped) 뒤 같은 서명 재시도 간격 — 30분마다 25분짜리 진단 세션을 다시 부르지 않게

const now = () => new Date()
const stamp = () => { const d = now(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}` }
function log(line) { const l = `[${stamp()}] ${line}`; console.log(l); if (!DRY) appendFileSync(WD_LOG, l + '\n', 'utf8') }
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
const tail = (p, n) => { try { const b = readFileSync(p); return b.subarray(Math.max(0, b.length - 400 * 1024)).toString('utf8').split(/\r?\n/).slice(-n) } catch { return [] } }
const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60000 })

// ── 0. 증거 보존 정리 (⑦) ─────────────────────────────────────────────────────────────────
const EVIDENCE_KEEP_DAYS = Number(process.env.WD_EVIDENCE_KEEP_DAYS ?? 3)
function dirBytes(p) { let n = 0; try { for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); n += e.isDirectory() ? dirBytes(q) : statSync(q).size } } catch { /* 잠긴 파일은 0 */ } return n }
/** 이름의 ms 타임스탬프(`YYYY-MM-DD-<ms>-evidence`)가 보존 기간을 넘긴 증거 폴더만 지운다 — 다른 archive 항목(dup-run·integration·engine-drift…)은 무접촉. */
function pruneEvidence() {
  const dir = join(STATE_DIR, 'archive'); if (!existsSync(dir) || !(EVIDENCE_KEEP_DAYS > 0)) return null
  const cutoff = Date.now() - EVIDENCE_KEEP_DAYS * 86400000
  let count = 0, bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const m = e.isDirectory() ? /^\d{4}-\d{2}-\d{2}-(\d{10,})-evidence$/.exec(e.name) : null
    if (!m || !(Number(m[1]) < cutoff)) continue
    const p = join(dir, e.name); bytes += dirBytes(p); count++
    if (!DRY) { try { rmSync(p, { recursive: true, force: true }) } catch (err) { log(`⚠ 증거 정리 실패 — ${e.name}: ${err?.message ?? err}`) } }
  }
  return { count, bytes }
}
{
  const r = pruneEvidence()
  if (r?.count) log(`증거 정리 — ${EVIDENCE_KEEP_DAYS}일 지난 증거 폴더 ${r.count}개 ${DRY ? '삭제 대상' : '삭제'}(약 ${(r.bytes / 1073741824).toFixed(1)} GB)`)
}

// ── 1. 진단 ───────────────────────────────────────────────────────────────────────────────
const wd = readJson(WD_STATE, { repeats: {}, fixed: {}, gated: {}, lastRoundAt: null })
const exitInfoRaw = readJson(join(LOGS, 'exit-info.json'))
// exit 8(리뷰 대기·회수 대기)은 정지가 아니라 다음 편성의 몫 — 반복으로 세면 정상 왕복(마감 재검수↔회수)에 진단 세션을 부른다(2026-09-10 회수 대기 도입과 함께).
const exitInfo = exitInfoRaw && Number(exitInfoRaw.code) === 8 ? null : exitInfoRaw
const lock = existsSync(join(STATE_DIR, 'runner.lock'))
const slots = tail(join(STATE_DIR, 'slots.log'), 4000) // 09-11 05:50 오탐: 14시간 라운드에서 헤더가 600줄 밖으로 밀려 정상 STOP 을 pre-engine 으로 오인
const lastRoundIdx = slots.map((l, i) => [i, l]).filter(([, l]) => /^# 야간 배치 .* 라운드 \d+/.test(l)).pop()
const lastStopLine = slots.filter((l) => /\*\*중단\(exit \d+\)\*\*/.test(l)).pop() ?? ''
// 차단기 걸림 — 러너가 편성 없이 「이 창(…) 차단」 한 줄만 찍고 나간다(09-10 05:21 실사고: 감시자가 05:10 갈라진 ref 를 고쳐 재기동했지만
// 직후 CLOSE-1 STOP 으로 창 누적 4회 → 다음 기동이 즉시 종료 · exit-info 는 옛 것 · lock 없음 · slots.log 는 매 슬롯 갱신 → 종전 판정 「정상」이 창 끝(최대 12시간)까지 이어진다).
const lastSlotStart = slots.map((l, i) => [i, l]).filter(([, l]) => /^워크트리 기준: /.test(l)).pop()
const breakerWin = lastSlotStart ? (slots.slice(lastSlotStart[0]).find((l) => /^이 창\(.+?\) 차단/.test(l))?.match(/^이 창\((.+?)\) 차단/)?.[1] ?? '') : ''
const lastHold = slots.filter((l) => /^⏸ \[|^✖ |^⚠ /.test(l)).pop() ?? ''
const slotsMtimeMin = existsSync(join(STATE_DIR, 'slots.log')) ? (Date.now() - statSync(join(STATE_DIR, 'slots.log')).mtimeMs) / 60000 : 9999
const taskInfo = ps(`Get-ScheduledTaskInfo -TaskName ${RUNNER_TASK} | ForEach-Object { $_.LastRunTime.ToString('s') + '|' + $_.NextRunTime.ToString('s') + '|' + $_.LastTaskResult }`).stdout.trim()
const taskState = ps(`(Get-ScheduledTask -TaskName ${RUNNER_TASK}).State`).stdout.trim()

// 정지 서명 — 엔진이 부기(exit-info.json)를 남기지 못하는 정지(워크트리 새로고침 거부 · 커밋 가드 · 핀 불일치 = 엔진 진입 전)는
// 슬롯 출력의 마지막 ✖ 줄이 서명이다(09-10 새벽 실사고: 「divergent or unrelated refs」 exit 3 이 10슬롯 반복됐는데 부기는 옛 것이라 「정상」 판정).
const lastRunAt = taskInfo ? new Date(taskInfo.split('|')[0]) : null
const exitInfoStale = !exitInfo?.at || (lastRunAt && new Date(exitInfo.at).getTime() < lastRunAt.getTime() - 60000)
const lastFatal = slots.slice(lastRoundIdx ? lastRoundIdx[0] : Math.max(0, slots.length - 40)).filter((l) => /^✖ /.test(l)).pop() ?? ''
// 러너가 살아 있으면(lock) 정지가 아니다 — 스토리 단위 STOP(exit 1 · 라운드 계속)의 ✖ 줄을 정지로 읽지 않는다(09-11 05:50 오탐 · Claude 진단 공회전 + 오경보).
// 라운드 헤더가 tail 안에 없으면 마지막 ✖ 줄 자체가 pre-engine 패턴일 때만 인정한다.
const PRE_ENGINE_RE = /^✖ 워크트리 새로고침 중단|^✖ COMMIT GUARD|tracked tooling differs/
const preEngineStop = !lock && exitInfoStale && lastFatal && (lastRoundIdx ? slots.slice(lastRoundIdx[0]).some((l) => PRE_ENGINE_RE.test(l)) : PRE_ENGINE_RE.test(lastFatal))
const signature = breakerWin ? `breaker|${breakerWin}` : preEngineStop
  ? 'pre-engine|' + lastFatal.replace(/\s+/g, ' ').replace(/\([0-9a-f]{7,}[^)]*\)/g, '(…)').slice(0, 140)
  : exitInfo ? `${exitInfo.story ?? '-'}|${exitInfo.stage ?? '-'}|${exitInfo.kind ?? '-'}|${exitInfo.why ?? '-'}` : (lastStopLine ? lastStopLine.replace(/\s+/g, ' ').slice(0, 120) : '')
const stopAt = (breakerWin || preEngineStop) ? lastRunAt : (exitInfo?.at ? new Date(exitInfo.at) : null)
const stopAgeMin = stopAt ? (Date.now() - stopAt.getTime()) / 60000 : null
// 반복 횟수 — 같은 서명이면 새 슬롯(예약작업 마지막 실행 시각이 바뀜)마다 +1
const tick = (breakerWin || preEngineStop) ? (taskInfo.split('|')[0] ?? '') : (exitInfo?.at ?? '')
if (signature) { wd.repeats[signature] = (wd.repeats[signature] ?? 0) + (wd.lastTick === tick ? 0 : 1); wd.lastTick = tick }
const repeats = signature ? wd.repeats[signature] : 0

log(`진단 — task=${taskState || '?'}(${taskInfo || '-'}) lock=${lock} slots.log ${slotsMtimeMin.toFixed(0)}분 전 · STOP=${signature || '없음'}${stopAgeMin !== null ? ` (${stopAgeMin.toFixed(0)}분 전 · 반복 ${repeats}회)` : ''}`)

// 한도(날씨) 서명 — 엔진 exit 5 의 라우팅 차단(no eligible model · shared cooldown)·429·한도는 대기가 답이다(러너도 차단기에서 뺀다).
// 09-12 00:20 실사고: 주간 한도 중 9-4 create 「no eligible model; shared cooldown applies」 반복 2회를 「플레이북 밖」으로 판정해 헛 Claude 진단(exit 1) + 오경보.
const WEATHER_RE = /rate limit|429|limit reached|한도|spend|usage|no eligible model|shared cooldown|cooldown applies/i
const isWeather = (sig) => Boolean(sig) && (WEATHER_RE.test(sig) || Number(exitInfo?.code) === 5 && /routing-blocked/.test(sig) && !/missing implementation provenance|구현자 모델 기록/.test(sig))
const triedRecently = (sig) => { const t = wd.fixed[sig]; return Boolean(t && !t.done && t.at && (Date.now() - Date.parse(t.at)) < RETRY_AFTER_MIN * 60000) }
// 하향 동기 충돌은 ✖ STOP 이 아니라 「이 라운드 휴면」 + 정상 종료로 보인다(2026-09-22 실사고) —
// 러너가 일을 한 건도 못 받고 30분마다 잠만 자는 상태를 따로 잡는다.
const downSyncDormant = !lock && slots.slice(-400).filter((l) => /하향 동기 코드 충돌/.test(l)).length >= 2
let verdict = 'ok'
if (lock && slotsMtimeMin > LOCK_STALE_MIN) verdict = 'lock-stale'
// 2026-09-24 06:28~07:04 실사고: 밤 배치 node 가 종료 시 libuv 단언으로 죽고 슬롯 껍데기(powershell)가 안 끝나 예약작업이 Running 으로 남았다 —
// MultipleInstances=IgnoreNew 라 06:35 트리거가 무시(0x800710E0)됐고 종전 판정은 taskState==='Ready' 만 침묵으로 봐 「정상」이었다.
else if (!lock && slotsMtimeMin > SHELL_STUCK_MIN && taskState === 'Running') verdict = 'shell-stuck'
else if (!lock && slotsMtimeMin > SILENT_MIN && taskState === 'Ready') verdict = 'silent'
else if (isWeather(signature)) verdict = 'weather' // 한도·라우팅 차단은 반복이어도 정지가 아니다 — 다음 슬롯이 다시 집는다
else if (lock) verdict = 'ok' // 러너가 살아 있으면(lock · 정체는 위 lock-stale 이 본다) 반복 정지 판정을 하지 않는다 — 09-11 05:50 오탐
else if (signature && repeats >= REPEAT_FIX_AT && !(wd.fixed[signature]?.done) && triedRecently(signature)) verdict = 'retry-wait'
else if (signature && repeats >= REPEAT_FIX_AT && !(wd.fixed[signature]?.done)) verdict = 'repeat'
else if (signature && repeats >= REPEAT_GATE_AT && wd.fixed[signature]?.done && !wd.gated[exitInfo?.story ?? '']) verdict = 'repeat-after-fix'
else if (downSyncDormant) verdict = 'downsync'
log(`판정 — ${verdict}`)

// ── 2. 플레이북(알려진 원인 → 자동 수리) ─────────────────────────────────────────────────
function implementerFromStory(story) {
  const p = join(STORIES, `${story}.md`); if (!existsSync(p)) return null
  const md = readFileSync(p, 'utf8')
  const rec = md.slice(md.search(/Dev Agent Record|구현 기록|Completion Notes/i) >= 0 ? md.search(/Dev Agent Record|구현 기록|Completion Notes/i) : 0)
  if (/codex.*gpt-6-astra|astra/i.test(rec)) return { provider: 'codex', model: 'codex:gpt-6-astra' }
  if (/gpt-5\.6-sol|\bsol\b/i.test(rec)) return { provider: 'codex', model: 'codex:gpt-5.6-sol' }
  if (/opus/i.test(rec)) return { provider: 'claude', model: 'opus' }
  if (/fable/i.test(rec)) return { provider: 'claude', model: 'fable' }
  if (/sonnet/i.test(rec)) return { provider: 'claude', model: 'sonnet' }
  return null
}
const PLAYBOOK = [
  {
    // 차단기(같은 서명 2회 · 창 누적 4회)가 걸리면 러너는 슬롯마다 즉시 나가 창이 끝날 때까지 아무 배치도 안 돈다.
    // 감시자가 원인을 이미 고친 경우는 아래 행동부(수리 뒤 재기동)가 창을 연다. 여기는 감시자 손 밖에서 걸린 차단(서로 다른 원인 4건 누적 등):
    // Claude 진단이 서명별 원인 해소를 확인(FIXED)할 때만 /resume 동등으로 연다 — 미해소면 열지 않는다(폭주 백스톱 유지 · 사람 몫).
    name: '창 차단기(같은 원인 2회 · 창 누적 4회)',
    match: (s) => /^breaker\|/.test(s),
    fix: () => {
      const w = readJson(join(STATE_DIR, 'auto-plan-state.json'), {})?.windows?.[breakerWin] ?? {}
      const res = claudeDiagnose(`창 차단기 ${breakerWin} 걸림 — 서명(exit|배치): ${JSON.stringify(w.sigs ?? {})} · 누계 ${w.total ?? 0}. 각 서명의 STOP 원인이 지금 해소됐는지(원장 Status·state.json·최근 slots.log·인박스)를 판단하라. 전부 해소됐으면 FIXED, 하나라도 남았으면 UNFIXED(창을 열지 않는다).`)
      if (res !== 'fixed') return `Claude 진단 ${res} — 창을 열지 않음(백스톱 유지 · 사람 몫: 「내가 할 일 뭐야」)`
      return resetBreaker(breakerWin, 'Claude 진단이 서명별 원인 해소 확인')
    },
  },
  {
    name: '구현자 기록 부재(routing-blocked · missing implementation provenance)',
    match: (s) => /missing implementation provenance|구현자 모델 기록/.test(s),
    fix: () => {
      const story = exitInfo?.story; if (!story) return '스토리 미상'
      const p = join(LOGS, 'state.json'); const st = readJson(p, { done: {}, workers: {} })
      // 매니페스트는 workers 와 done 이 둘 다 있어야 구현자를 싣는다 — workers 만 복원하면 T6 에서 또 선다(2026-10-11 실사고).
      const who = implementerFromStory(story) ?? { provider: 'claude', model: 'opus' }
      const { key: K, added, worker } = restoreDevProvenance(st, story, who, now().toISOString())
      if (!added.length) return `이미 기록 있음(workers+done) ${JSON.stringify(worker).slice(0, 80)}`
      if (!DRY) writeFileSync(p, JSON.stringify(st, null, 2))
      return `state.json workers+done[${K}] 확인 — 새로 적은 칸 ${added.join('+')} · 구현자 ${worker.provider}/${worker.model}`
    },
  },
  {
    name: '런타임 핀 불일치(tracked tooling differs from reviewed runtime pin)',
    match: (s) => /tracked tooling differs|installed tooling differs|runtime pin|reviewed tooling commit/.test(s),
    // 핀 재기록은 CLI 가 없다(runtime-pin.mjs 는 라이브러리) — 검토된 커밋 판정이 필요하므로 Claude 진단 세션에 넘긴다(메모리: 09-08 핀 불일치 18시간 무음 정지 복구 절차)
    fix: () => { const r = reinstallEngineAndRepin(); return /완료$/.test(r) ? r : (claudeDiagnose('runtime pin mismatch — 자가 수리 실패(' + r + ') · 정본 대조 후 핀 재기록 또는 재설치') === 'fixed' ? '핀 재기록(Claude 진단)' : `자가 수리 미해결(${r}) — Claude 진단도 미해결 · 사람 몫`) },
  },
  {
    name: 'Codex CLI 판 부족/실행 실패',
    match: (s) => /codex.*(version|exit=1|not found)|Codex CLI/i.test(s) || (!preEngineStop && slots.slice(-80).filter((l) => /\[CODEX\].*(exit=1|분류 other)/.test(l)).length >= 3),
    fix: () => { if (DRY) return '(리허설) npm i -g @openai/codex@latest'; const r = spawnSync('npm', ['i', '-g', '@openai/codex@latest', '--no-audit', '--no-fund'], { encoding: 'utf8', shell: true, timeout: 300000 }); return `codex 재설치 exit ${r.status}` },
  },
  {
    // 죽은 워커 잔여물 보존 브랜치(auto/<날짜>-wip-*)가 오늘 브랜치와 갈라져 있으면 worktree-refresh 가 시작을 거부한다
    // (09-10 새벽 실사고: wip-1-12 ×3 · 10슬롯 정지). 내용은 지우지 않고 keep/ 이름공간으로 옮겨 refresh 의 auto/* 스캔에서 뺀다.
    name: '갈라진 wip 브랜치(divergent or unrelated refs · non-date auto branches)',
    match: (s) => /divergent or unrelated refs|non-date auto branches need explicit reconciliation/.test(s),
    fix: () => {
      const g = (a) => spawnSync('git', ['-C', RUNNER, ...a], { encoding: 'utf8' })
      const wips = g(['branch', '--list', 'auto/*-wip-*']).stdout.split(/\r?\n/).map((l) => l.replace(/^[* ]+/, '').trim()).filter(Boolean)
      if (!wips.length) return claudeDiagnose('갈라진 ref — wip 브랜치가 아님 · ' + lastFatal) === 'fixed' ? 'Claude 진단 정리' : 'Claude 진단 미해결 — 사람 몫'
      if (DRY) return `(리허설) wip ${wips.length}개 → keep/ 이동`
      const moved = []
      for (const b of wips) {
        const keep = b.replace(/^auto\//, 'keep/')
        if (g(['branch', '-m', b, keep]).status !== 0) continue
        g(['push', '-q', 'origin', keep]); g(['push', '-q', 'origin', '--delete', b]); moved.push(`${b}→${keep}`)
      }
      return `wip 보존 이동 ${moved.length}건: ${moved.join(', ')}`
    },
  },
  {
    // 실행 중 원격 ref 가 바뀌어(대화형 세션의 push) 커밋 가드가 멈춘 것 — 일시적. 재기동만 한다.
    name: '커밋 가드(실행 중 원격 ref 변경 · exit 6)',
    match: (s) => /COMMIT GUARD|원격 ref 가 실행 전후로 달라졌다/.test(s),
    fix: () => '일시적(외부 push) — 재기동',
  },
  {
    // 러너 클론이 dirty 면 worktree-refresh 가 시작 자체를 거부한다(09-09 23:35 실사고: 감시자가 고친 state.json 1건이 잔여물로 잡혀 정지).
    // 잔여물이 로그·상태·산출물(_bmad-output/**)뿐이면 보존 커밋으로 닫고 재기동, 소스가 섞여 있으면 Claude 진단(wip 브랜치 보존 절차 — 메모리 09-09).
    name: '워크트리 새로고침 중단(dirty 러너 클론)',
    match: (s) => /unfinished changes preserved/.test(s) || (/워크트리 새로고침 중단/.test(s) && !/divergent|non-date/.test(s)),
    fix: () => {
      const st = spawnSync('git', ['status', '--porcelain'], { cwd: RUNNER, encoding: 'utf8' }).stdout.trim().split(/\r?\n/).filter(Boolean)
      if (!st.length) return 'dirty 아님(이미 정리됨)'
      const files = st.map((l) => l.slice(3).trim())
      if (!files.every((f) => f.startsWith('_bmad-output/'))) return claudeDiagnose(`dirty 러너 클론 — 소스 잔여물 ${files.slice(0, 5).join(', ')}`) === 'fixed' ? 'Claude 진단이 잔여물 정리' : '소스 잔여물 — 사람 몫'
      if (DRY) return `(리허설) 잔여물 ${files.length}건 보존 커밋`
      spawnSync('git', ['add', '-A', '_bmad-output'], { cwd: RUNNER, encoding: 'utf8' })
      const c = spawnSync('git', ['commit', '-q', '-m', `chore(watchdog): 러너 잔여물 보존(${files.length}건 · 로그·상태·산출물만) — 워크트리 새로고침 재개`], { cwd: RUNNER, encoding: 'utf8' })
      return `잔여물 ${files.length}건 보존 커밋 exit ${c.status}`
    },
  },
  {
    name: '한도·429(날씨 — 대기)',
    match: (s) => WEATHER_RE.test(s),
    fix: () => '한도는 대기가 답이다 — 조치 0(다음 슬롯이 다시 집는다)',
    weather: true,
  },
]

// ── 자가 수리 2종 (👤 2026-09-22 「원인 찾아서 문제 해결 후 계속 작업 진행」) ──────────────
// 둘 다 **정지 경계에서만**(lock 없음) 돌고, 손댄 범위가 계약 밖이면 되돌리고 사람 몫으로 넘긴다.
const rgit = (args) => spawnSync('git', ['--literal-pathspecs', ...args], { cwd: RUNNER, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })

/** ① 엔진이 검토된 핀과 다르다 → 정본에서 재설치하고 핀을 다시 기록한다.
 *  2026-09-22: 정본 b2a489b 가 고쳐져 있었는데 설치되지 않아 러너가 4시간 멈췄다. 설치·lint·커밋·핀·검증까지 한 번에. */
function reinstallEngineAndRepin() {
  if (lock) return '러너 작동 중 — 정지 경계 아님(다음 슬롯 재시도)'
  if (!existsSync(join(CANONICAL, 'install.mjs'))) return `정본 없음(${CANONICAL}) — 사람 몫`
  if (rgit(['status', '--porcelain']).stdout.trim()) return '러너 클론에 미커밋 변경 — 사람 몫'
  if (DRY) return `(리허설) ${CANONICAL}/install.mjs --force + 핀 재기록`
  const inst = spawnSync(process.execPath, [join(CANONICAL, 'install.mjs'), '--force'], { cwd: RUNNER, encoding: 'utf8', timeout: 600000, windowsHide: true })
  if (inst.status !== 0) { rgit(['checkout', '--', 'tools/auto']); return `설치 실패 exit ${inst.status} — 되돌림 · 사람 몫` }
  const changed = rgit(['status', '--porcelain']).stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim())
  if (!changed.length) return '설치했으나 바뀐 파일 0 — 원인이 엔진이 아니다'
  const outside = changed.filter((p) => !p.startsWith('tools/auto/'))
  if (outside.length) { rgit(['checkout', '--', '.']); return `설치가 tools/auto 밖을 건드림(${outside[0]}) — 되돌림 · 사람 몫` }
  const lint = spawnSync('npx', ['eslint', 'tools/auto', '--max-warnings=0'], { cwd: RUNNER, encoding: 'utf8', shell: true, timeout: 900000, windowsHide: true })
  if (lint.status !== 0) { rgit(['checkout', '--', 'tools/auto']); return '설치본 lint 실패 — 되돌림 · 사람 몫' }
  rgit(['add', 'tools/auto'])
  if (rgit(['commit', '-m', 'chore(batch): 감시자 자가 수리 — 정본 엔진 재설치 + 핀 재기록']).status !== 0) return '커밋 실패 — 사람 몫'
  const head = rgit(['rev-parse', 'HEAD']).stdout.trim()
  const pinPath = join(STATE_DIR, 'runtime-pin.json'); const pin = readJson(pinPath, {})
  writeFileSync(pinPath + '.bak-' + Date.now(), JSON.stringify(pin, null, 2))
  writeFileSync(pinPath, JSON.stringify({ ...pin, commit: head }, null, 2) + '\n')
  const left = rgit(['diff', '--no-ext-diff', '--name-only', head, '--', 'tools/auto']).stdout.trim()
  if (left) return `핀 검증 실패(${left.split('\n')[0]}) — 사람 몫`
  return `정본 재설치 + 핀 ${head.slice(0, 8)} 재기록 완료`
}

/** ② 하향 동기(main → 체인) 충돌 → **목록형만** 규칙으로 합쳐 푼다.
 *  규칙(2026-09-22 실증): 한쪽이 빈 hunk = 그쪽 채택 · 양쪽 다 마이그레이션 파일명 목록 = 파일명 오름차순 합집합
 *  (KNOWN_LATER 는 readdirSync 정렬 결과와 toEqual 로 대조되므로 순서가 계약이다).
 *  둘 다 아닌 hunk 가 하나라도 있으면 병합을 되돌리고 사람 몫으로 넘긴다 — 코드 충돌을 추측으로 합치지 않는다. */
function resolveDownSyncConflicts() {
  if (lock) return '러너 작동 중 — 정지 경계 아님(다음 슬롯 재시도)'
  if (rgit(['status', '--porcelain']).stdout.trim()) return '러너 클론에 미커밋 변경 — 사람 몫'
  if (DRY) return '(리허설) origin/main 병합 후 목록형 충돌 정렬 합집합'
  rgit(['fetch', 'origin'])
  rgit(['merge', 'origin/main', '--no-commit'])
  const files = rgit(['diff', '--name-only', '--diff-filter=U']).stdout.trim().split(/\r?\n/).filter(Boolean)
  if (!files.length) { rgit(['merge', '--abort']); return '충돌 파일 0 — 다른 원인' }
  const fname = (l) => (l.match(/'(\d{14}_[^']+\.sql)'/) || [])[1]
  const blocks = (lines) => { const out = []; let cur = []; for (const l of lines) { if (fname(l) === undefined && cur.some(fname)) { out.push(cur); cur = [l] } else cur.push(l) } if (cur.length) out.push(cur); return out }
  const key = (b) => b.map(fname).find(Boolean) ?? '\uffff'
  const done = []
  for (const f of files) {
    const L = readFileSync(join(RUNNER, f), 'utf8').split(/\r?\n/); const out = []
    let i = 0
    while (i < L.length) {
      if (!L[i].startsWith('<<<<<<<')) { out.push(L[i++]); continue }
      let m = i + 1; while (m < L.length && !L[m].startsWith('=======')) m++
      let e = m + 1; while (e < L.length && !L[e].startsWith('>>>>>>>')) e++
      if (e >= L.length) { rgit(['merge', '--abort']); return `충돌 표시가 깨짐(${f}) — 사람 몫` }
      const ours = L.slice(i + 1, m), theirs = L.slice(m + 1, e)
      let res
      if (!ours.length) res = theirs
      else if (!theirs.length) res = ours
      else if (ours.some(fname) && theirs.some(fname)) {
        const seen = new Set()
        res = [...blocks(ours), ...blocks(theirs)].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
          .filter((b) => { const k = key(b); if (seen.has(k)) return false; seen.add(k); return true }).flat()
      } else { rgit(['merge', '--abort']); return `규칙 밖 충돌(${f}) — 코드 충돌은 추측으로 합치지 않는다 · 사람 몫` }
      out.push(...res); i = e + 1
    }
    writeFileSync(join(RUNNER, f), out.join('\n')); done.push(f)
  }
  const tests = done.filter((f) => /^tests\/.*\.test\.[cm]?tsx?$/.test(f))
  if (tests.length) {
    const v = spawnSync('npx', ['vitest', 'run', '--no-file-parallelism', ...tests], { cwd: RUNNER, encoding: 'utf8', shell: true, timeout: 900000, windowsHide: true })
    if (v.status !== 0) { rgit(['merge', '--abort']); return `해소본 테스트 실패(${tests.length}파일) — 되돌림 · 사람 몫` }
  }
  rgit(['add', ...done])
  if (rgit(['commit', '-m', `chore(chain): 하향 동기 — 감시자 자가 수리로 목록형 충돌 ${done.length}파일 정렬 합집합 해소`]).status !== 0) { rgit(['merge', '--abort']); return '커밋 실패 — 사람 몫' }
  return `하향 동기 충돌 ${done.length}파일 해소 완료`
}

function notify(text) {
  try {
    const token = readFileSync(join(STATE_DIR, 'telegram-token.txt'), 'utf8').trim()
    const chat = readJson(join(STATE_DIR, 'telegram-chat.json'), {})
    const chatId = chat.chat_id ?? chat.chatId ?? chat.id
    if (!token || !chatId || DRY) { log(`알림(미발송${DRY ? ' · 리허설' : ''}): ${text.slice(0, 160)}`); return }
    const body = JSON.stringify({ chat_id: chatId, text: `🐶 감시자 · ${text}`.slice(0, 3800), disable_notification: false })
    const r = spawnSync('curl', ['-s', '-m', '20', '-X', 'POST', `https://api.telegram.org/bot${token}/sendMessage`, '-H', 'Content-Type: application/json', '-d', body], { encoding: 'utf8' })
    log(`알림 발송 ${r.status === 0 ? 'ok' : 'fail'}: ${text.slice(0, 120)}`)
  } catch (e) { log(`알림 실패: ${e.message}`) }
}
/** 창 차단기 리셋(/resume 동등 · telegram-rules.resetWindowStops 와 같은 모양) — 걸려 있을 때만 쓴다. */
function resetBreaker(winId, why) {
  const p = join(STATE_DIR, 'auto-plan-state.json'); const st = readJson(p); const w = st?.windows?.[winId]
  if (!w) return `창 ${winId} 기록 없음`
  const cap = readJson(join(RUNNER, 'tools', 'auto', 'auto.config.json'), {})?.breaker?.windowTotal
  if (!stopBlocked(w, { total: cap })) return `창 ${winId} 열려 있음(리셋 불필요)`
  st.windows[winId] = { ...w, stops: 0, sigs: {}, total: 0, note: `${stamp()} 감시자 리셋(/resume 동등) — ${why} · 직전 sigs ${JSON.stringify(w.sigs ?? {})} total ${w.total ?? 0}` }
  if (!DRY) writeFileSync(p, JSON.stringify(st, null, 2) + '\n', 'utf8')
  return `창 ${winId} 차단기 리셋(${why})`
}
function startRunner(why) {
  if (has('--dry-run')) { log(`(리허설) 러너 기동 — ${why}`); return }
  if (existsSync(join(STATE_DIR, 'runner.lock'))) { log(`러너 기동 생략 — lock 존재(진행 중) · ${why}`); return }
  const r = ps(`Start-ScheduledTask -TaskName ${RUNNER_TASK}`)
  log(`러너 기동(Start-ScheduledTask) exit ${r.status} — ${why}`)
}
function gateStory(story, why) {
  const p = join(STORIES, `${story}.md`); if (!existsSync(p)) return log(`편성 제외 실패 — 스토리 파일 없음 ${story}`)
  const md = readFileSync(p, 'utf8')
  if (/BLOCKED-ON-HUMAN:/.test(md)) return log(`편성 제외 — 이미 표식 있음 ${story}`)
  const line = `\n\nBLOCKED-ON-HUMAN: 감시자(watchdog) — 이 스토리가 같은 이유로 ${REPEAT_GATE_AT}회 이상 멈춰 자동 수리로도 풀리지 않았습니다(${why}). 나머지 배치는 계속 돕니다. — 풀리는 조건: 사람이 원인을 보고 이 줄을 취소선으로 닫는다(「내가 할 일 뭐야」 창구).\n`
  if (!DRY) appendFileSync(p, line, 'utf8')
  wd.gated[story] = { at: now().toISOString(), why }
  log(`편성 제외(BLOCKED-ON-HUMAN) — ${story}: ${why}`)
}
function claudeDiagnose(signatureText) {
  if (NO_CLAUDE || DRY) { log(`(${DRY ? '리허설' : '--no-claude'}) Claude 진단 세션 생략`); return 'skipped' }
  const out = join(STATE_DIR, `watchdog-claude-${now().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`)
  const prompt = [
    `당신은 ${PROJECT} 24시간 러너의 **감시자 진단 세션**입니다(사람은 자리에 없습니다). 러너가 같은 이유로 반복 정지했는데 플레이북에 없는 원인입니다. 원인을 찾아 **상태·설정 파일 수준에서** 고치고, 고칠 수 없으면 왜인지와 사람이 할 일을 적으세요.`,
    `정지 부기: ${signatureText}`,
    `보세요: ${join(LOGS, 'exit-info.json')} · ${join(LOGS, 'night-last-run.md')} · ${join(STATE_DIR, 'slots.log')} 끝 300줄 · 최근 증거 폴더 ${join(STATE_DIR, 'archive')} 최신 · 메모리 ${MEMORY_MD}(있으면 · 러너 정지 실사례: 핀 불일치 · dirty 워크트리 · codex 판 · 429 · 구현자 기록).`,
    `허용: ${STATE_DIR} 안의 상태 파일 · ${LOGS} 의 state.json · 러너 클론 auto.config.json 1줄 · runtime-pin 재기록 · codex 재설치 · git stash/branch 로 잔여물 보존. 금지: 앱 코드 수정 · main 머지 · 배포 · 운영 DB · 외부 발송 · 엔진(claude-skills) 수정.`,
    `끝나면 ${out} 에 「원인 / 조치 / 남은 사람 몫」 3절로 적고, 조치했으면 마지막 줄에 FIXED, 못 했으면 UNFIXED 라고 쓰세요.`,
  ].join('\n')
  const r = spawnSync('claude', ['-p', '--model', 'opus', '--permission-mode', 'acceptEdits', '--max-turns', '40', prompt], { cwd: PROJECT_DIR, encoding: 'utf8', shell: true, timeout: 25 * 60 * 1000 })
  const verdictLine = existsSync(out) ? (readFileSync(out, 'utf8').trim().split('\n').pop() ?? '') : ''
  log(`Claude 진단 세션 exit ${r.status} · ${verdictLine.slice(0, 60)} · 보고서 ${out}`)
  return /FIXED$/.test(verdictLine) && !/UNFIXED$/.test(verdictLine) ? 'fixed' : 'unfixed'
}

// ── 3. 행동 ────────────────────────────────────────────────────────────────────────────────
if (verdict === 'repeat' || has('--force-restart')) {
  const hit = PLAYBOOK.find((p) => p.match(signature + ' ' + lastHold))
  if (hit?.weather) { log(`플레이북 — ${hit.name}: ${hit.fix()}`) }
  else if (hit && /^창 차단기/.test(hit.name) && !/차단기 리셋\(/.test((wd._breakerResult = hit.fix()))) {
    // 원인 미해소 — 창을 열지 않는다. fixed 로 적지 않고(다음엔 RETRY_AFTER_MIN 뒤 재시도) 재기동도 하지 않는다(기동해도 「이 창 차단」으로 즉시 죽는다).
    const result = wd._breakerResult; delete wd._breakerResult
    wd.fixed[signature] = { done: false, at: now().toISOString(), by: hit.name, result }
    log(`플레이북 — ${hit.name}: ${result}`)
    notify(`창 차단기 걸림(${breakerWin}) — ${result} · ${RETRY_AFTER_MIN}분 뒤 재시도`)
  } else if (hit) {
    const result = wd._breakerResult ?? hit.fix(); delete wd._breakerResult
    // ⚠ 2026-09-22 실사고: 플레이북이 「미해결 — 사람 몫」을 돌려줘도 done:true 로 적혀, 같은 서명이 다시 나면
    //    플레이북을 건너뛰고 곧장 repeat-after-fix(스토리 편성 제외)로 갔다. 09-16 에 그렇게 굳은 서명
    //    「pre-engine|워크트리 새로고침 중단 … installed tooling differs」가 09-22 에 러너를 4시간 세웠다.
    //    **못 고쳤으면 done:false** — RETRY_AFTER_MIN 뒤 같은 플레이북을 다시 시도한다.
    const unresolved = /미해결|사람 몫|실패|unfixed|skipped/.test(String(result))
    wd.fixed[signature] = { done: !unresolved, at: now().toISOString(), by: hit.name, result }
    log(`플레이북 — ${hit.name}: ${result}${unresolved ? ' (미해소 — 재시도 대상)' : ''}`)
    notify(unresolved
      ? `반복 정지 — ${hit.name} 수리 실패: ${result} · ${RETRY_AFTER_MIN}분 뒤 재시도`
      : `반복 정지 자동 수리 — ${exitInfo?.story ?? '?'} ${exitInfo?.stage ?? ''}: ${hit.name} → ${result}. 러너 재기동.`)
    // 같은 서명 2회 = 차단기도 2회를 세어 이미 잠겨 있다 — 고친 뒤의 재기동이 「이 창 차단」으로 즉시 죽지 않게 연다(09-10 05:21 실사고).
    if (!/^breaker\|/.test(signature)) log(`차단기 — ${resetBreaker(stopWindowId(now()), `수리 뒤 재기동(${hit.name})`)}`)
    startRunner('플레이북 수리 뒤')
  } else {
    const res = claudeDiagnose(signature + ' | ' + lastHold)
    wd.fixed[signature] = { done: res === 'fixed', at: now().toISOString(), by: 'claude-diagnose', result: res }
    notify(`반복 정지(플레이북 밖) — ${signature.slice(0, 100)} → Claude 진단 ${res}. ${res === 'fixed' ? '러너 재기동.' : '다음 반복 시 그 스토리만 편성 제외.'}`)
    if (res === 'fixed') { log(`차단기 — ${resetBreaker(stopWindowId(now()), 'Claude 진단 수리 뒤 재기동')}`); startRunner('Claude 진단 수리 뒤') }
  }
} else if (verdict === 'repeat-after-fix') {
  // ⚠ 2026-09-22 실사고: 스토리 **이전 단계**(pre-engine — 워크트리 새로고침·하향 동기 등)의 정지에는
  //    뺄 스토리가 없다. 그런데도 낡은 exitInfo.story(13-17)를 빼려다 「스토리 파일 없음」으로 실패하고
  //    같은 알림만 7슬롯 반복했다. 스토리 이전 단계면 **실제 오류 줄 그대로** 진단에 넘기고 사람에게도 원문으로 알린다.
  const noStory = preEngineStop || !exitInfo?.story || !existsSync(join(STORIES, `${exitInfo.story}.md`))
  if (noStory) {
    const res = claudeDiagnose(`pre-engine 반복 정지(수리 뒤에도 재발) — ${lastFatal}`)
    wd.fixed[signature] = { done: res === 'fixed', at: now().toISOString(), by: 'claude-diagnose(pre-engine)', result: res }
    notify(`러너 정지 반복(스토리 이전 단계) — ${String(lastFatal).slice(0, 180)} → Claude 진단 ${res}`)
    log(`pre-engine 재진단 — ${res}`)
    if (res === 'fixed') { log(`차단기 — ${resetBreaker(stopWindowId(now()), 'pre-engine 진단 수리 뒤 재기동')}`); startRunner('pre-engine 진단 수리 뒤') }
  } else {
    gateStory(exitInfo.story, `${exitInfo.kind}: ${exitInfo.why}`)
    notify(`수리 뒤에도 반복 정지 — ${exitInfo.story} 를 편성에서 뺐습니다(BLOCKED-ON-HUMAN). 나머지 배치는 계속. 「내가 할 일 뭐야」에서 확인.`)
    log(`차단기 — ${resetBreaker(stopWindowId(now()), '스토리 편성 제외 뒤 재기동')}`)
    startRunner('스토리 편성 제외 뒤')
  }
} else if (verdict === 'downsync') {
  const r = resolveDownSyncConflicts()
  wd.fixed['downsync'] = { done: /완료$/.test(r), at: now().toISOString(), by: '하향 동기 충돌 자가 수리', result: r }
  log(`하향 동기 휴면 — ${r}`)
  notify(`하향 동기 충돌로 러너가 일을 못 받고 있었습니다 — ${r}${/완료$/.test(r) ? ' · 러너 재기동.' : ''}`)
  if (/완료$/.test(r)) startRunner('하향 동기 충돌 해소 뒤')
} else if (verdict === 'shell-stuck') {
  notify(`예약작업은 실행 중(${taskInfo})인데 lock 없이 일지가 ${slotsMtimeMin.toFixed(0)}분째 그대로 — 슬롯 껍데기 정지로 보고 스케줄러로 끝낸 뒤 다시 기동합니다.`)
  if (has('--dry-run')) log('(리허설) Stop-ScheduledTask → Start-ScheduledTask')
  else {
    const s = ps(`Stop-ScheduledTask -TaskName ${RUNNER_TASK}`)
    log(`껍데기 정지 종료(Stop-ScheduledTask) exit ${s.status}`)
    startRunner('껍데기 정지 뒤')
  }
} else if (verdict === 'silent') {
  notify(`러너 침묵 ${slotsMtimeMin.toFixed(0)}분(예약작업 ${taskState} · ${taskInfo}) — 즉시 기동합니다.`)
  startRunner('침묵')
} else if (verdict === 'lock-stale') {
  notify(`runner.lock 이 ${slotsMtimeMin.toFixed(0)}분째 로그 없이 남아 있습니다 — 정체 의심. Claude 진단 세션을 부릅니다.`)
  const res = claudeDiagnose(`lock-stale ${slotsMtimeMin.toFixed(0)}분 · ${signature}`)
  if (res === 'fixed') startRunner('lock 정체 수리 뒤')
} else if (verdict === 'weather') {
  log(`한도 대기 — ${signature.slice(0, 100)} (반복 ${repeats}회 · 조치 0 · 리셋/크레딧 뒤 다음 슬롯이 다시 집는다)`)
} else if (verdict === 'retry-wait') {
  log(`재시도 대기 — 같은 서명 미해소 시도 ${wd.fixed[signature]?.at ?? '?'} (${RETRY_AFTER_MIN}분 간격)`)
} else {
  log('행동 없음 — 정상(또는 첫 관측)')
}
if (!DRY) writeFileSync(WD_STATE, JSON.stringify(wd, null, 2))
