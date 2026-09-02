#!/usr/bin/env node
// 야간 무인 배치 러너 (상시) — 날짜·스토리를 **하드코딩하지 않는다**.
// 이식판: 프로젝트 고유값은 `tools/auto/auto.config.json` 이 소유한다.
//
// 실행:
//   node tools/auto/run-night.mjs                # 큐 그대로 (수동 실행 형태)
//   node tools/auto/run-night.mjs --auto-plan    # 슬롯 모드(예약 실행) — 편성→실행을 큐가 마를 때까지 반복
//   node tools/auto/run-night.mjs --dry-run      # 엔진에 --dry-run 전달(무엇을 돌릴지만 본다)
//   node tools/auto/run-night.mjs --only A       # label 이 A 로 시작하는 배치만
//   node tools/auto/run-night.mjs --queue <경로> # 다른 큐 파일
//
// ⚠️ 커밋·푸시는 큐의 `defaults.commit/push` 옵트인이며 브랜치는 **항상 `auto/<날짜>`** 다.
//    정본 main 머지는 사람 승인이다.
// ⚠️ cmd 배치 파일이 아니라 .mjs 인 이유: 한글 스토리 키가 cmd.exe 코드페이지(CP949)에서 깨진다(실측).
// 핵심 설계(원 출처: 2026-08 야간 운영 실사고와 개선 원탁 수렴):
// ① 연속 실행 루프 — 시계가 아니라 작업 종료가 다음 배치를 연다(자정엔 고정 날짜로 종료)
// ② 슬롯 한도 대기 30분 — lock 인질 방지, 이어하기는 state.json ③ 차단기에서 exit 5 제외
// ④ 알림 텔레그램 정본(공개 ntfy 폴백) ⑤ 상태 폴더 = 프로젝트별(~/.claude-auto/<이름>)
// 무정지(Non-Stop) 개편 — 「밤이 서 있는 시간」을 없앤 5가지:
// ⑥ lock v2 — **모든 모드**가 잡는다(수동도) · 원자 생성(wx) · 심박(hb)으로 죽은 lock 을 가르고
//    판정 불능은 물러나되 알린다(무음 skip 금지) · 해제는 자기 토큰일 때만(ABA 차단)
// ⑦ 선형 승계 — 미머지 auto/* 가 남아도 쉬지 않는다. 최신 미머지 tip 위에서 오늘 브랜치를 시작한다
//    (main 무접촉 = 사람 머지 원칙 불변 · 아침엔 최신 브랜치 1개만 머지하면 체인 전체가 들어온다)
// ⑧ 하향 동기 — 라운드마다 origin/main 을 작업 브랜치로 가져와, 낮의 확정·큐·승인이 밤에 보이게 한다
// ⑨ 체인 나이 기록(chain-info.json) — 편성기의 체인 게이트(신규 착수 보류) 재료
// ⑩ STOP 차단기 v2 — 「원인 서명」 단위 차단(다른 원인은 계속) · exit 5(한도)는 종전대로 날씨
// 판정 규칙은 전부 runner-rules.mjs 소유(순수 함수 — 테스트가 문다).
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { loadConfig } from './plan-queue.mjs'
import { conflictFingerprint, downSyncDecision, fileListConflicts, inheritPlan, landingResolution, limitRefundKeys, lockAction, notifyChannel, parallelPlan, parseFileList, progressedStoryKeys, refundUnrun, roundDidRealWork, shouldContinueLoop, spendBlockNotice, stopBlocked, stopRecord, stopWindowId, stripConflictMarkers, waitAuthMin } from './runner-rules.mjs'

const ENGINE = join(homedir(), '.claude', 'skills', 'auto-story-finish', 'auto-story-pipeline.mjs')
const ART = resolve('_bmad-output/implementation-artifacts')
const LOG_DIR = join(ART, 'auto-pipeline-logs')
const SUMMARY = join(LOG_DIR, 'night-last-run.md')

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes(`--${name}`)

const manualQueuePath = resolve(opt('queue', 'tools/auto/night-queue.json'))
const only = opt('only', '')
const dryRun = has('dry-run')
const autoPlan = has('auto-plan') // 없으면 단일 실행 — 수동 경로를 깨지 않는다

/** 로컬 날짜 YYYY-MM-DD — 브랜치 이름이 실행일과 어긋나지 않게 UTC 를 쓰지 않는다 */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fail(message, code = 2) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

if (!existsSync(ENGINE)) fail(`auto-story-finish 엔진을 찾지 못했다: ${ENGINE}`)
if (!existsSync(resolve('package.json'))) fail('저장소 루트에서 실행해야 한다(package.json 없음)')

// 프로젝트 식별 + 상태 폴더 — 프로젝트별 분리(lock·원장 교차 오염 방지)
const CFG = loadConfig(process.cwd())
const PROJECT = CFG.project || basename(resolve('.'))
const STATE_DIR = process.env.AUTO_BATCH_STATE_DIR || CFG.stateDir || join(homedir(), '.claude-auto', PROJECT)

/** 알림 — 텔레그램(비공개) 정본, 공개 ntfy 폴백, 둘 다 없으면 무음.
 *  토큰·chat_id 는 저장소 밖: 프로젝트 상태 폴더 → 공용(~/.claude-auto/) 순으로 찾는다.
 *
 *  전송은 Node 빌트인 `fetch` 다(외부 의존성 0). 예전 `curl` + `shell:true` 경로는 두 가지가
 *  잘못돼 있었다 — ① 봇 토큰이 **명령줄 인자**에 실려 프로세스 목록(ps·작업 관리자)에 노출됐고
 *  ② title·chat_id·프로젝트명이 이스케이프 없이 셸 문자열에 보간됐다.
 *
 *  ⚠️ 공개 ntfy 는 **토픽만 알면 누구나 읽는다** — 폴백으로 나갈 때는 제목·건수·exit 코드 수준의
 *  `brief` 만 싣는다(브랜치명·파일 경로·배치 라벨 금지). 상세 본문은 텔레그램에만 간다.
 *
 *  fetch 는 비동기라, 알림 직후 종료하는 자리(lock 후퇴·휴면·차단·마지막 exit)에서는
 *  `await flushNotify()` 로 배출을 기다린다 — 안 그러면 종료가 전송을 잘라먹는다. */
const NTFY_BRIEF = '상세는 상태 폴더 로그를 확인한다.'
const pendingNotifies = new Set()
const flushNotify = () => Promise.allSettled([...pendingNotifies])
const notify = (title, body, brief) => {
  const send = async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    try { await res.arrayBuffer() } catch { /* 응답 본문은 쓰지 않는다 — 소켓만 비운다 */ }
  }
  const task = (async () => {
    try {
      const findFile = (name) => [join(STATE_DIR, name), join(homedir(), '.claude-auto', name)].find((p) => existsSync(p))
      const tokenPath = findFile('telegram-token.txt')
      const chatPath = findFile('telegram-chat.json')
      const token = tokenPath ? readFileSync(tokenPath, 'utf8').trim() : ''
      // 토큰에 URL 구조를 바꾸는 문자가 섞였으면 보내지 않는다(경로 주입 차단). 정상 토큰엔 없다.
      const tokenOk = token !== '' && !/[/?#\s]/.test(token)
      // BOM 내성 — PowerShell 저장 JSON 은 EF BB BF 로 시작해 parse 가 죽고, 이 catch 는
      // 무음이라 알림이 조용히 증발한다(실기 테스트에서 실발생).
      const chatId = chatPath ? JSON.parse(readFileSync(chatPath, 'utf8').replace(/^\uFEFF/, '')).chat_id : null
      const topicPath = join(homedir(), '.claude', 'ntfy-topic.txt')
      const topic = existsSync(topicPath) ? readFileSync(topicPath, 'utf8').trim() : ''
      const channel = notifyChannel({ telegramReady: Boolean(tokenOk && chatId), ntfyReady: Boolean(topic) })
      if (channel === 'telegram') {
        await send(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `[${PROJECT}] ${title}\n${body}` }),
        })
      } else if (channel === 'ntfy') {
        // 제목은 헤더(Title)가 아니라 본문에 넣는다 — HTTP 헤더는 한글을 그대로 실을 수 없다.
        await send(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
          method: 'POST',
          body: `[${PROJECT}] ${title}\n${brief ?? NTFY_BRIEF}`,
        })
      }
    } catch { /* 무음 — 알림 실패는 배치에 영향 없음 */ }
  })()
  pendingNotifies.add(task)
  task.finally(() => pendingNotifies.delete(task))
  return task
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const loadState = () => {
  const p = join(STATE_DIR, 'auto-plan-state.json')
  const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  s.days ??= {}
  s.consumed ??= {} // 수동 큐 소비 표식은 **전역**이다 — 날짜별로 두면 자정이 지나는 순간 어제 큐가
  // "새 큐"로 보여 통째로 재실행된다(실사고 — 7커밋 중복)
  s.days[today()] ??= { planned: [], stops: 0, consumed: {} }
  // 차단기는 달력일이 아니라 낮/밤 창 단위 — 낮 사고가 밤 몫을 잠그지 않게(stopWindowId 소유).
  s.windows ??= {}
  s.windows[stopWindowId(new Date())] ??= { stops: 0 }
  return { s, day: s.days[today()], win: s.windows[stopWindowId(new Date())], save: () => writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8') }
}

// 자정 가드: 루프·브랜치는 시작 시점 날짜에 고정된다. 자정을 넘기면 루프를 끝내고
// 다음 슬롯의 새 프로세스가 (하루 몫 브랜치 판정부터) 이어받는다.
const START_DATE = today()
const BRANCH = `auto/${START_DATE}`

// ── ① lock v2 ─────────────────────────────────────────────────────────────────────────
// **모든 모드**가 lock 을 잡는다 — 「수동 실행은 lock 밖」이 이중 기동 실사고의 한 축이었다.
// 판정: ESRCH(pid 사망)만 사망 · EPERM 등 권한 오류와 JSON 손상은 「판정 불능」이며 심박(6h)으로만
// 보조 탈취한다(살아 있는 러너를 남이 죽었다고 밀어내지 않는다).
// 획득은 wx(원자 생성) · 해제는 자기 토큰 확인 후에만 — 탈취당한 구 프로세스가 종료하면서 새 lock 을
// 지우는 ABA 를 막는다. 연속 루프가 도는 동안 lock 이 유지되므로 다음 정시 슬롯은 자동으로 겹침 회피.
const lockPath = join(STATE_DIR, 'runner.lock')
const LOCK_TOKEN = randomUUID()
function readLockInfo() {
  if (!existsSync(lockPath)) return { exists: false }
  let parsed = null
  try { parsed = JSON.parse(readFileSync(lockPath, 'utf8')) } catch { /* 손상 */ }
  if (!parsed) return { exists: true, parseOk: false, hbAgeMs: Infinity }
  let pidAlive
  try { process.kill(parsed.pid, 0); pidAlive = true } catch (e) { pidAlive = e?.code === 'ESRCH' ? false : 'unknown' }
  const hb = Date.parse(parsed.hb ?? parsed.at ?? '') || 0
  return { exists: true, parseOk: true, pidAlive, hbAgeMs: hb ? Date.now() - hb : Infinity, parsed }
}
function touchLock() { // 심박 — 라운드 시작·배치 경계마다. 자기 토큰일 때만 쓴다.
  // ⚠️ 제자리 덮어쓰기 금지 — 쓰는 순간 다른 슬롯이 **잘린 JSON** 을 읽으면 readLockInfo 가
  // parseOk:false → hbAgeMs Infinity 로 판정해 살아 있는 러너를 takeover 로 밟는다.
  // tmp 파일에 다 쓴 뒤 rename(원자 교체) — 읽는 쪽은 언제 읽어도 완전한 JSON 만 본다.
  const tmp = `${lockPath}.${process.pid}.tmp`
  try {
    const cur = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (cur.token !== LOCK_TOKEN) return
    writeFileSync(tmp, JSON.stringify({ ...cur, hb: new Date().toISOString() }))
    renameSync(tmp, lockPath)
  } catch { /* lock 이 사라졌으면 다음 라운드 판정이 잡는다 */
    try { unlinkSync(tmp) } catch { /* tmp 잔재 없음 */ }
  }
}
{
  mkdirSync(STATE_DIR, { recursive: true })
  const info = readLockInfo()
  const action = lockAction(info)
  if (action === 'skip-alive') {
    console.log('이미 실행 중 — ' + (autoPlan ? '이 슬롯은 건너뛴다(lock)' : '수동 실행을 중단한다(lock — 동시 실행은 같은 트리를 오염시킨다)'))
    process.exit(autoPlan ? 0 : 1)
  }
  if (action === 'skip-unknown') {
    // 판정 불능 + 심박 신선 — 보수적으로 물러나되 **무음 금지**. 죽은 lock 이 「생존」으로 굳으면
    // 밤새 아무 알림 없이 skip 만 반복된다. 하루 1회 알린다.
    const { day, save } = loadState()
    day.notified ??= {}
    console.log('lock 판정 불능(권한/손상) — 이 슬롯은 물러난다. 심박이 6시간 지나면 자동 교체된다')
    if (!day.notified.lockUnknown && !dryRun) {
      notify('lock 판정 불능', `runner.lock 을 판정할 수 없다(권한/손상). 심박 6h 초과 시 자동 교체 — 계속되면 ${lockPath} 확인`)
      day.notified.lockUnknown = true
      save()
    }
    await flushNotify()
    process.exit(autoPlan ? 0 : 1)
  }
  if (action === 'takeover') {
    console.log('죽은 lock 교체(pid ' + (info.parsed?.pid ?? '?') + ' 사망/심박 초과)')
    try { unlinkSync(lockPath) } catch { /* 경합 — wx 가 잡는다 */ }
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: LOCK_TOKEN, at: new Date().toISOString(), hb: new Date().toISOString() }), { flag: 'wx' })
  } catch {
    console.log('lock 원자 획득 실패(동시 기동 경합) — 이 프로세스는 물러난다')
    process.exit(autoPlan ? 0 : 1)
  }
  process.on('exit', () => {
    try {
      const cur = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (cur.token === LOCK_TOKEN) unlinkSync(lockPath) // 자기 lock 만 지운다(ABA 차단)
    } catch { /* 이미 없음/손상 */ }
  })
}

if (autoPlan) {
  // ② 전용 워크트리 새로고침(marker 있을 때만) — 본 트리(대화 세션)의 발밑을 절대 바꾸지 않는다.
  //    기준 ref = 오늘 auto 브랜치가 원격에 있으면 그것(같은 날 앞 슬롯의 연속), 없으면 origin/main.
  if (existsSync(resolve('.auto-batch-worktree'))) {
    // 미커밋 로그(run-summary.log 등)는 checkout -f 에 쓸리므로 먼저 보관한다(정직 기록 보존)
    const st = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    const floating = (st.stdout ?? '').split('\n').map((l) => l.slice(3).trim()).filter((f) => f.includes('auto-pipeline-logs/'))
    if (floating.length > 0) {
      const arc = join(STATE_DIR, 'archive', today() + '-' + Date.now())
      mkdirSync(arc, { recursive: true })
      for (const f of floating) { try { cpSync(resolve(f), join(arc, basename(f))) } catch { /* 삭제분 */ } }
    }
    // 미커밋 작업 보존 — checkout -f/clean 은 앞 배치가 STOP 으로 커밋 못 한 소스·테스트
    // 수정을 지운다(실사고: dev 산출물이 리셋에 유실돼 원인 분석 물증까지 소실). 로그·marker·
    // 잔재 로그를 뺀 변경이 있으면 stash 로 보관한다.
    const valuable = (st.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
      .filter((l) => !l.includes('auto-pipeline-logs/'))
      .filter((l) => !l.includes('.auto-batch-worktree'))
      .filter((l) => !/_qa-[^/]*\.log/.test(l))
    if (valuable.length > 0) {
      const stashed = spawnSync('git', ['stash', 'push', '-u', '-m', `slot-preserve ${new Date().toISOString()}`,
        '--', '.', ':(exclude).auto-batch-worktree', ':(exclude)_bmad-output/implementation-artifacts/auto-pipeline-logs'], { encoding: 'utf8' })
      if (stashed.status === 0) {
        console.log(`미커밋 변경 ${valuable.length}건 stash 보관(slot-preserve) — 아침에 사람이 확인 후 pop/drop`)
        notify('미커밋 작업 stash 보관', `앞 배치가 커밋 못 한 변경 ${valuable.length}건을 stash 에 보관했다.\n${valuable.slice(0, 10).join('\n')}`,
          `미커밋 변경 ${valuable.length}건 보관. ${NTFY_BRIEF}`)
      } else {
        console.log(`⚠ stash 보관 실패(${(stashed.stderr ?? '').trim().split('\n')[0]}) — 종전대로 리셋 진행(유실 가능)`)
      }
    }
    // 엔진이 저장소 루트에 남기는 _qa-*.log 류 미추적 잔재를 치운다 — 안 치우면 다음 슬롯의
    // dirty 검사가 exit 4 로 멈춘다. ⚠️ 이 아래 checkout -f 는 이 파일 자신의 미커밋 수정도
    // 지운다 — 러너 수정은 반드시 커밋을 먼저 하고 실행한다(실측).
    spawnSync('git', ['clean', '-fdq', '-e', '.auto-batch-worktree'])
    spawnSync('git', ['fetch', 'origin'], { stdio: 'inherit' })
    const hasToday = spawnSync('git', ['ls-remote', '--exit-code', 'origin', BRANCH], { encoding: 'utf8' }).status === 0
    let ref = `origin/${BRANCH}`
    if (!hasToday) {
      // 오늘 몫 브랜치가 없다 — 미머지 auto/* 를 먼저 실측한다. 원격만 보면 안 된다:
      // 같은 PC 의 대화 세션이 **푸시 전** 로컬 브랜치에서 작업 중일 수 있다(실측). 로컬+원격을 다 본다.
      const list = spawnSync('git', ['for-each-ref', 'refs/heads/auto', 'refs/remotes/origin/auto', '--format=%(refname:short)'], { encoding: 'utf8' })
      const unmerged = [...new Set((list.stdout ?? '').split('\n').filter(Boolean))].filter((b) => {
        const n = spawnSync('git', ['rev-list', '--count', `origin/main..${b}`], { encoding: 'utf8' })
        return Number((n.stdout ?? '0').trim()) > 0
      })
      if (unmerged.length > 0) {
        // ── 선형 승계 — 종전 「휴면」의 대체 ──
        // 미머지 브랜치가 남았다고 쉬면 밤이 통째로 빈다(실측: 하룻밤 9.5시간 유휴). 최신 미머지
        // auto/<날짜> tip 위에서 오늘 브랜치를 시작한다 — main 은 무접촉(사람 머지 원칙 불변)이고,
        // 아침 머지는 최신 브랜치 1개만 합치면 체인 전체가 포함된다(선형). 자정 롤오버 중복 실행
        // 사고는 「안 보이는 베이스(main)로 재시작」이 원인이었으므로, 승계는 그 반대 방향이다.
        // 체인이 길어지는 위험은 편성기의 체인 게이트(신규 착수 보류)가 본다.
        const inh = inheritPlan(unmerged, START_DATE)
        if (inh) {
          ref = inh.ref
          const { day, save } = loadState()
          day.notified ??= {}
          console.log(`선형 승계 — ${inh.ref} 위에서 ${BRANCH} 시작(체인 ${inh.chainAgeDays}일 · 미머지 ${inh.branches.length}브랜치)`)
          if (!day.notified.inherit && !dryRun) {
            notify('선형 승계로 밤 계속', `미머지 ${inh.branches.join(', ')} 위에서 ${BRANCH} 시작.\n체인 ${inh.chainAgeDays}일차${inh.chainAgeDays >= 2 ? ' — 신규 착수는 보류(회수·재검수만). /merge 로 체인을 비우면 전부 재개' : ''}.\n아침 /merge 는 최신 브랜치 1개면 된다(선형)`,
              `미머지 ${inh.branches.length}건 위에서 계속(체인 ${inh.chainAgeDays}일차). ${NTFY_BRIEF}`)
            day.notified.inherit = true
          }
          save()
        } else {
          // 날짜형 이름이 하나도 없다(비정형 브랜치) — 승계 기준을 정할 수 없으니 종전대로 휴면
          const { day, save } = loadState()
          day.notified ??= {}
          console.log(`미머지 비정형 auto 브랜치(${unmerged.join(', ')}) — 승계 기준 불명, 슬롯 휴면`)
          if (!day.notified.unmerged && !dryRun) {
            notify('슬롯 휴면 — 비정형 브랜치', `미머지: ${unmerged.join(', ')} — 사람 확인 필요`,
              `미머지 ${unmerged.length}건 — 사람 확인 필요. ${NTFY_BRIEF}`)
            day.notified.unmerged = true
          }
          save()
          await flushNotify()
          process.exit(0)
        }
      } else {
        ref = 'origin/main'
      }
    }
    const co = spawnSync('git', ['checkout', '-f', '--detach', ref], { stdio: 'inherit' })
    if (co.status !== 0) fail(`워크트리 새로고침 실패(${ref}) — 이 슬롯 중단`, 3)
    console.log(`워크트리 기준: ${ref}`)
  }

  // ③ 연속 중단 차단기 v2 — 「원인 서명」(exit 코드 + 배치 라벨) 2회만 차단하고 **다른 원인은
  //    계속**한다. 종전 단순 카운터는 서로 무관한 STOP 2건에도 밤 전체를 잠갔다. 창 누적 4회는
  //    폭주 백스톱. exit 5(한도)는 종전대로 세지 않는다(고장이 아니라 날씨).
  //    창(낮/밤) 단위로 센다 — 낮 사고가 밤 몫을 잠그지 않게(stopWindowId).
  const { day, win, save } = loadState()
  const winId = stopWindowId(new Date())
  if (stopBlocked(win)) {
    console.log(`이 창(${winId}) 차단 — 같은 원인 STOP 2회 또는 창 누적 4회(아침에 사람이 본다 · /resume 으로 열 수 있다)`)
    // ⚠️ 30분 슬롯이 무기한 반복하므로, 차단이 하루 유지되면 알림 없는 억제가 없을 때 같은 문구가
    // 수십 번 나간다(4시간 슬롯 시절엔 드러나지 않던 결함). 창당 1회로 묶고 리허설은 무발신.
    day.notified ??= {}
    if (day.notified.stopBlocked !== winId && !dryRun) {
      notify('슬롯 중단', `같은 원인 STOP 반복(창 ${winId}) — 자동 편성을 멈췄다. run-summary.log 확인 · /resume 으로 재개 가능.`)
      day.notified.stopBlocked = winId
      save()
    }
    await flushNotify()
    process.exit(0)
  }
}

/** 미머지 auto 체인 실측 → chain-info.json — 편성기의 체인 게이트(신규 착수 보류) 재료.
 *  오늘 것만 미머지면 ageDays=0 이라 게이트는 열린 상태다. */
function writeChainInfo() {
  try {
    const list = spawnSync('git', ['for-each-ref', 'refs/heads/auto', 'refs/remotes/origin/auto', '--format=%(refname:short)'], { encoding: 'utf8' })
    const unmerged = [...new Set((list.stdout ?? '').split('\n').filter(Boolean))].filter((b) => {
      const n = spawnSync('git', ['rev-list', '--count', `origin/main..${b}`], { encoding: 'utf8' })
      return Number((n.stdout ?? '0').trim()) > 0
    })
    const inh = inheritPlan(unmerged, START_DATE)
    writeFileSync(join(STATE_DIR, 'chain-info.json'), JSON.stringify({ ageDays: inh?.chainAgeDays ?? 0, branches: inh?.branches ?? [], at: new Date().toISOString() }) + '\n')
  } catch { /* 체인 실측 실패 = 게이트 0일(신규 허용) — 밤을 세우지 않는다 */ }
}

/** 하향 동기 — 라운드 시작마다 origin/main 을 오늘 브랜치로 가져온다. 낮에 확정·머지된 결정과
 *  큐·승인이 밤 배치에 보이게 하는 통로다. main 은 **무접촉**(가져오기만 · 사람 머지 원칙 불변).
 *  충돌 처분은 runner-rules.downSyncDecision 이 정한다:
 *  resolve(로그·장부 클래스 자동 해소) · defer(문서 충돌 — 동기 없이 라운드 계속, 아침 정식 머지가
 *  합침) · halt(코드 충돌 — 이 라운드 휴면). 같은 지문 2회면 그날은 동기 재시도를 멈춘다(반복 백스톱). */
function doDownSync() {
  if (!existsSync(resolve('.auto-batch-worktree'))) return { ok: true, note: null } // 실행 전용 클론에서만
  spawnSync('git', ['fetch', 'origin', '--quiet'])
  // 브랜치 확립 — detach 상태면 로컬 BRANCH 로(있으면 승계 — 미푸시 커밋 보존, 없으면 HEAD 에서 생성)
  const cur = (spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim()
  if (cur !== BRANCH) {
    const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status === 0
    const sw = spawnSync('git', exists ? ['switch', BRANCH] : ['switch', '-c', BRANCH], { encoding: 'utf8' })
    if (sw.status !== 0) return { ok: true, note: `하향 동기 보류 — 브랜치 전환 실패(${(sw.stderr ?? '').trim().split('\n')[0]})` }
  }
  const behind = Number((spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], { encoding: 'utf8' }).stdout ?? '0').trim())
  if (behind === 0) return { ok: true, note: null }
  const { day, save } = loadState()
  if (day.d2halt) return { ok: true, note: '하향 동기 중단 상태(오늘 반복 충돌) — pre-merge 베이스로 계속' }
  const mg = spawnSync('git', ['-c', 'core.editor=true', 'merge', '--no-edit', '-m', `sync: main→${BRANCH} 하향 동기(낮 확정·큐 반영)`, 'origin/main'], { encoding: 'utf8' })
  if (mg.status === 0) return { ok: true, note: `하향 동기 — origin/main ${behind}커밋 반영` }
  // core.quotePath=false — 기본값이면 한글 경로가 8진 이스케이프 + 따옴표로 나와 `_bmad-output/` 접두
  // 판정이 빗나가고, 문서 충돌(defer)이 코드 충돌(halt)로 오분류돼 라운드가 불필요하게 선다.
  const conflicted = (spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).stdout ?? '')
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  // merge 가 **충돌이 아닌 사유**로 거부될 수 있다(작업 트리 dirty·untracked 덮어쓰기 등). 그때 충돌
  // 목록은 비고, downSyncDecision([]) 은 「해소할 것 없음」으로 resolve + 빈 plan 을 준다 —
  // 그대로 두면 아무것도 안 고친 채 `commit --no-edit` 을 때리는 헛된 경로로 들어간다.
  if (conflicted.length === 0) {
    spawnSync('git', ['merge', '--abort'])
    return { ok: true, note: `하향 동기 보류 — merge 거부(충돌 아님): ${(mg.stderr ?? '').trim().split('\n')[0]}` }
  }
  const dec = downSyncDecision(conflicted)
  if (dec.mode === 'resolve') {
    let landed = true
    for (const [file, how] of Object.entries(dec.plan)) {
      if (how === 'ours') { if (spawnSync('git', ['checkout', '--ours', '--', file]).status !== 0) { landed = false; break } }
      else {
        let merged
        try { merged = stripConflictMarkers(readFileSync(file, 'utf8')) } catch { merged = null }
        if (merged == null) { landed = false; break }
        writeFileSync(file, merged)
      }
      if (spawnSync('git', ['add', '--', file]).status !== 0) { landed = false; break }
    }
    if (landed && spawnSync('git', ['-c', 'core.editor=true', 'commit', '--no-edit'], { encoding: 'utf8' }).status === 0) {
      return { ok: true, note: `하향 동기 — 충돌 ${conflicted.length}파일 자동 해소(로그·장부 클래스)` }
    }
    spawnSync('git', ['merge', '--abort'])
    // 자동 해소 실패는 defer 로 강등 — 밤을 막지 않는다
  } else {
    spawnSync('git', ['merge', '--abort'])
  }
  const fp = conflictFingerprint(conflicted)
  day.d2fp ??= {}
  // 2026-09-02 개정: 백스톱은 halt(코드 충돌)만 센다 — defer/문서 해소 실패까지 세면
  // 무해한 문서 충돌 2회 만에 하루치 동기를 통째로 끈다(19시간 38분 미동기 실사고).
  if (dec.mode === 'halt') {
    day.d2fp[fp] = (day.d2fp[fp] ?? 0) + 1
    if (day.d2fp[fp] >= 2) day.d2halt = true // 같은 코드 충돌 2회 — 오늘 동기 재시도 중단
  }
  day.notified ??= {}
  const first = !day.notified.d2conflict
  day.notified.d2conflict = true
  save()
  if (dec.mode === 'halt') {
    if (first && !dryRun) notify('하향 동기 충돌(코드) — 이 라운드 휴면', `충돌: ${conflicted.slice(0, 6).join(', ')}\n아침 사람 머지가 정식으로 합친다. 밤당 이 알림 1회.`,
      `충돌 ${conflicted.length}파일. ${NTFY_BRIEF}`)
    return { ok: false, note: `하향 동기 코드 충돌(${conflicted.length}파일) — 이 라운드 휴면` }
  }
  if (first && !dryRun) notify('하향 동기 보류(문서 충돌)', `충돌: ${conflicted.slice(0, 6).join(', ')}\n동기 없이 계속 — 아침 사람 머지가 정식으로 합친다.`,
    `충돌 ${conflicted.length}파일. ${NTFY_BRIEF}`)
  return { ok: true, note: `하향 동기 보류 — 문서 충돌 ${conflicted.length}파일(아침 정식 머지 몫), pre-merge 베이스로 계속` }
}

// ④ 큐 선택 — 사람이 쓴 큐(planned!=='auto')가 항상 이긴다. 단 하루 1회(소비 표식).
//    반환: 큐 경로(자동 편성 0건이면 null — 오늘 몫 소진).
function selectQueue() {
  const { s, save } = loadState()
  if (existsSync(manualQueuePath)) {
    try {
      const q = JSON.parse(readFileSync(manualQueuePath, 'utf8'))
      const h = sha(manualQueuePath)
      const consumedBefore = s.consumed[h] || Object.values(s.days).some((d) => d.consumed?.[h])
      if (q.planned !== 'auto' && !consumedBefore) {
        // 리허설은 큐를 **소모하지 않는다** — 같은 함수의 `--no-ledger`(하루 상한 원장 불소모)와
        // 같은 규율이다. 표식을 남기면 리허설 한 번이 그날 수동 큐를 통째로 삼킨다.
        if (!dryRun) {
          s.consumed[h] = new Date().toISOString()
          save()
        }
        return { path: manualQueuePath, meta: null }
      }
    } catch { /* 깨진 큐는 수동으로 안 친다 */ }
  }
  const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '')
  const autoOut = join(STATE_DIR, `auto-queue-${today()}-${hhmm}.json`)
  const planArgs = [resolve('tools/auto/plan-queue.mjs'), '--out', autoOut, '--state', STATE_DIR]
  if (dryRun) planArgs.push('--no-ledger') // 리허설이 하루 상한 원장을 소모하지 않는다
  const planRun = spawnSync(process.execPath, planArgs, { stdio: 'inherit' })
  if (planRun.status !== 0) fail('편성기 실패 — 이 슬롯 중단(빈 큐를 정상인 척 돌리지 않는다)', 3)
  const q = JSON.parse(readFileSync(autoOut, 'utf8'))
  const meta = q._편성 ?? null
  if ((q.batches ?? []).length === 0) {
    console.log('편성 결과 0건 — 이 슬롯은 할 일이 없다')
    const blocked = (meta?.excluded ?? []).filter((e) => e.why.includes('결정 대기')).length
    if (blocked > 0 && !dryRun) notify('할 일 0 · 결정 대기', `결정 대기가 스토리 ${blocked}개를 막고 있다 — DECISIONS-INBOX.md`,
      `결정 대기가 스토리 ${blocked}개를 막는 중. ${NTFY_BRIEF}`)
    return null
  }
  return { path: autoOut, meta }
}

// 병렬 실행 — File List 가 겹치지 않는 dev 전용 배치를 워크트리 분리로 동시 실행한다.
// 흐름: ① 실측 File List 대조(수동 큐 방어) ② 스토리별 임시 워크트리(detached · node_modules
// junction · env 복사) ③ 엔진을 워크트리 cwd 로 병렬 spawn — `--commit` 만 켜서 **엔진 가드
// (화이트리스트·시크릿 스캔) 그대로 detached HEAD 에 커밋** ④ landing = 러너가 배치 트리에서
// cherry-pick 직렬(공유 장부는 3-way 가 합침 · 충돌 = 그 스토리만 실패 + archive/parallel-* 태그
// 보존) ⑤ push 1회 ⑥ 워크트리 제거. 엔진 무수정. 점화 = 큐 defaults.parallel ≥ 2.
// 반환: { code } 또는 null(병렬 조건 미충족 — 호출부가 순차 폴백).
async function runBatchParallel({ batch, defaults, workers, record }) {
  const storyList = batch.stories
  const lists = storyList.map((s) => {
    const f = readdirSync(ART).find((n) => n.startsWith(s) && n.endsWith('.md'))
    return f ? parseFileList(readFileSync(join(ART, f), 'utf8')) : null
  })
  // 빈 목록(절은 있는데 항목 0 — 아직 dev 안 돈 스펙)도 「모르는 것」이다 — 파일을 모르는 채
  // 병렬로 돌리면 겹침 판정이 무의미하다. 신규 스토리를 병렬로 돌리려면 지시서에 예상 File List 를 채운다.
  if (lists.some((l) => l == null || l.length === 0)) { record('· 병렬 폴백 — File List 부재/빈 목록 스토리 존재(모르는 채 병렬 금지)'); return null }
  if (fileListConflicts(lists)) { record('· 병렬 폴백 — File List 실측 겹침'); return null }

  // 배치 트리를 오늘 브랜치로(순차 경로에선 엔진 ensureBranch 몫 — 병렬은 러너가 선다)
  const cur = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  if (cur !== BRANCH) {
    const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status === 0
    const sw = spawnSync('git', exists ? ['switch', BRANCH] : ['switch', '-c', BRANCH], { encoding: 'utf8' })
    if (sw.status !== 0) { record(`· 병렬 폴백 — 브랜치 전환 실패: ${(sw.stderr ?? '').trim().split('\n')[0]}`); return null }
  }

  const wtBase = resolve('..')
  const myName = basename(process.cwd())
  const wts = []
  const cleanup = () => {
    for (const w of wts) spawnSync('git', ['worktree', 'remove', '--force', w.dir])
    spawnSync('git', ['worktree', 'prune'])
  }
  for (let i = 0; i < storyList.length; i++) {
    const dir = join(wtBase, `${myName}-wt${i}`)
    spawnSync('git', ['worktree', 'remove', '--force', dir]) // 잔재 정리(없으면 무해)
    const add = spawnSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { encoding: 'utf8' })
    if (add.status !== 0) { record(`· 병렬 폴백 — worktree 생성 실패: ${(add.stderr ?? '').trim().split('\n')[0]}`); cleanup(); return null }
    wts.push({ story: storyList[i], dir, base: spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() })
    try {
      symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'junction') // 워크트리별 npm ci 회피
    } catch (e) {
      record(`· 병렬 폴백 — node_modules 연결 실패: ${e?.message ?? e}`); cleanup(); return null
    }
    for (const f of ['.env.local', '.env.production']) if (existsSync(resolve(f))) cpSync(resolve(f), join(dir, f)) // qa 스모크·배포 가드용(gitignore)
  }
  record(`· 병렬 실행 ${workers}폭 — dev 만 병렬, 커밋 가드는 엔진 그대로, landing·push 는 직렬`)

  const engineArgsFor = (story) => {
    // 배치의 stages 그대로 — dev 전용(회수)뿐 아니라 dev+review(신규)도 워크트리 안에서 완주하고
    // 커밋 1개로 landing 한다(리뷰 findings 도 그 커밋의 스토리 md 에 실린다).
    const a = [ENGINE, '--stories', story, '--stages', (batch.stages ?? ['dev']).join(','),
      '--stage-timeout-min', String(batch.stageTimeoutMin ?? defaults.stageTimeoutMin ?? 120),
      '--wait-auth-min', String(waitAuthMin(autoPlan, batch.waitAuthMin, defaults.waitAuthMin))]
    for (const [stage, model] of Object.entries(batch.models ?? {})) if (model) a.push(`--${stage}-model`, model)
    if (batch.force) a.push('--force')
    a.push('--commit') // 브랜치·푸시 없음 — detached HEAD 커밋(엔진 기존 지원 경로). landing 은 아래 직렬.
    return a
  }
  const runOne = (wt) => new Promise((done) => {
    const child = spawn(process.execPath, engineArgsFor(wt.story), { cwd: wt.dir, stdio: 'inherit' })
    child.on('close', (c) => done({ story: wt.story, code: c ?? 1 }))
    child.on('error', () => done({ story: wt.story, code: 1 }))
  })
  const queue = [...wts]
  const outs = []
  await Promise.all(Array.from({ length: Math.min(workers, wts.length) }, async () => {
    while (queue.length > 0) outs.push(await runOne(queue.shift()))
  }))

  // landing — 원래 배치 순서 그대로 직렬(같은 브랜치 커밋 경합 방지). 실패 스토리는 건너뛰되
  // 나머지는 마저 반영한다(성공분을 버리지 않는다), 끝에 배치 STOP 으로 보고.
  let worst = 0
  for (const wt of wts) {
    const r = outs.find((o) => o.story === wt.story)
    if (!r || r.code !== 0) { record(`- **중단(exit ${r?.code ?? '?'}): ${wt.story} (병렬 dev)** — 성공분 landing 후 배치 STOP`); worst ||= r?.code ?? 1; continue }
    const head = spawnSync('git', ['-C', wt.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    if (head === wt.base) { record(`- 완주(커밋 없음): ${wt.story}`); continue }
    const pick = spawnSync('git', ['cherry-pick', head], { encoding: 'utf8' })
    if (pick.status !== 0) {
      // 자동 해소 가능한 충돌 클래스(엔진 자기 로그 append·state.json·공유 장부 append)만 풀어 landing 을
      // 살린다 — 그 외 파일이 섞이면 손대지 않고 종전 보존 폴백(archive 태그).
      // core.quotePath=false — 하향 동기·라운드 커밋과 같은 이유다. 기본값이면 한글 경로가 8진
      // 이스케이프 + 따옴표로 나와 landingResolution 의 클래스 판정이 통째로 빗나가고, 자동 해소
      // 가능한 충돌까지 「해소 불가」로 떨어져 산출물이 archive 태그로 밀린다.
      const conflicted = (spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).stdout ?? '')
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const plan = landingResolution(conflicted)
      let landed = plan != null
      if (landed) {
        for (const [file, how] of Object.entries(plan)) {
          if (how === 'ours') {
            if (spawnSync('git', ['checkout', '--ours', '--', file]).status !== 0) { landed = false; break }
          } else {
            let merged
            try { merged = stripConflictMarkers(readFileSync(file, 'utf8')) } catch { merged = null }
            if (merged == null) { landed = false; break }
            writeFileSync(file, merged)
          }
          if (spawnSync('git', ['add', '--', file]).status !== 0) { landed = false; break }
        }
        if (landed) landed = spawnSync('git', ['-c', 'core.editor=true', 'cherry-pick', '--continue'], { encoding: 'utf8' }).status === 0
      }
      if (!landed) {
        spawnSync('git', ['cherry-pick', '--abort'])
        spawnSync('git', ['tag', `archive/parallel-${wt.story}-${Date.now()}`, head]) // 산출물 보존 — 유실 금지
        record(`- **landing 실패(자동 해소 불가 충돌): ${wt.story}** — 산출물은 archive/parallel-* 태그 보존 · 다음 순차 라운드가 회수`)
        worst ||= 1
        continue
      }
      record(`- 완주: ${wt.story} (병렬 dev → landing · 충돌 자동 해소 ${Object.keys(plan).length}파일)`)
      continue
    }
    record(`- 완주: ${wt.story} (병렬 dev → landing)`)
  }
  if (defaults.push && !dryRun) {
    const p = spawnSync('git', ['push', '-u', 'origin', BRANCH], { encoding: 'utf8' })
    if (p.status !== 0) record(`⚠ push 실패(계속): ${(p.stderr ?? '').trim().split('\n').slice(-1)[0]} — 아침에 사람 재시도`)
  }
  cleanup()
  return { code: worst }
}

// ⑤ 큐 1개 실행 = 1라운드 — 엔진 배치를 순차로 돌리고 요약을 남긴다.
//    roundBaseShaForLedger = 라운드 시작 HEAD(진전 원장 재료 — 이 라운드 커밋이 만진 스토리를 센다).
async function runQueue(queuePath, autoQueueMeta, round, roundBaseShaForLedger = '') {
  let queue
  try {
    queue = JSON.parse(readFileSync(queuePath, 'utf8'))
  } catch (error) {
    fail(`큐 파일 JSON 을 읽지 못했다: ${error.message}`)
  }

  const defaults = queue.defaults ?? {}
  const batches = (queue.batches ?? [])
    .filter((batch) => batch.enabled !== false)
    .filter((batch) => (only === '' ? true : String(batch.label ?? '').startsWith(only)))

  const lines = []
  const record = (message) => {
    console.log(message)
    lines.push(message)
  }
  const writeSummary = () => {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(SUMMARY, lines.join('\n') + '\n', 'utf8')
  }

  record(`# 야간 배치 ${START_DATE}${autoPlan ? ` — 라운드 ${round}` : ''}`)
  record('')
  record(`- 큐: \`${queuePath}\``)
  record(`- 브랜치: \`${BRANCH}\`${defaults.push ? ' (푸시 켬)' : ' (푸시 끔)'}`)
  record(`- 실행 대상 배치: ${batches.length}건${only ? ` (--only ${only})` : ''}`)

  if (batches.length === 0) {
    record('')
    record('**돌릴 배치가 없다** — 큐가 비었거나 전부 `enabled: false` 다. 아침 브리핑에서 큐를 채운다.')
    writeSummary()
    return { worstCode: null, ranCount: 0, note: (message) => { record(message); writeSummary() } }
  }

  // 엔진은 시작 시 작업 트리 clean 을 요구한다(커밋 가드) — 먼저 확인해 원인을 분명히 남긴다.
  if (defaults.commit || defaults.push) {
    const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    const dirty = (status.stdout ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !line.includes('auto-pipeline-logs/'))
      .filter((line) => !line.includes('.auto-batch-worktree'))
    if (dirty.length > 0) {
      record('')
      record('**중단: 작업 트리가 clean 이 아니다** — 커밋 배치는 남의 변경을 자기 커밋에 쓸어 담는다.')
      dirty.slice(0, 20).forEach((line) => record(`  ${line}`))
      writeSummary()
      await flushNotify()
      process.exit(4)
    }
  }

  const results = []
  const ranStories = new Set() // 실행을 **시작한** 배치의 스토리 — 원장 환불 판정 재료
  for (const batch of batches) {
    const label = batch.label ?? '(무제)'
    const stories = (batch.stories ?? []).join(',')
    if (stories === '') {
      record(`- 건너뜀: ${label} — stories 비어 있음`)
      continue
    }
    for (const k of batch.stories) ranStories.add(k)

    // 병렬 경로 — 큐가 parallel 을 켠 dev 전용 다스토리 배치만. 조건 미달·리허설은 순차 그대로.
    const par = parallelPlan({
      storyCount: (batch.stories ?? []).length,
      stages: batch.stages ?? ['create', 'dev', 'review'],
      parallel: batch.parallel ?? defaults.parallel,
    })
    if (par > 1 && !dryRun) {
      console.log(`\n==== ${label} (병렬 ${par}폭 시도) ====`)
      if (autoPlan) touchLock()
      const started = new Date().toISOString()
      const batchBase = headSha()
      const pr = await runBatchParallel({ batch, defaults, workers: par, record })
      if (pr !== null) {
        results.push({ label, code: pr.code, started, batchBase, stories: batch.stories ?? [] })
        record(`- ${pr.code === 0 ? '완주' : `**중단(exit ${pr.code})**`}: ${label} (병렬)`)
        if (pr.code !== 0) {
          record(`- 남은 배치는 실행하지 않았다 — \`auto-pipeline-logs/run-summary.log\` 확인`)
          break
        }
        continue
      }
      // null = 조건 미충족 — 아래 순차 경로로 그대로 진행(폴백 사유는 record 됨)
    }

    const args = [
      ENGINE,
      '--stories',
      stories,
      '--stages',
      (batch.stages ?? ['create', 'dev', 'review']).join(','),
      '--stage-timeout-min',
      String(batch.stageTimeoutMin ?? defaults.stageTimeoutMin ?? 120),
      '--wait-auth-min',
      String(waitAuthMin(autoPlan, batch.waitAuthMin, defaults.waitAuthMin)),
    ]
    for (const [stage, model] of Object.entries(batch.models ?? {})) {
      if (model) args.push(`--${stage}-model`, model)
    }
    if (batch.force) args.push('--force')
    if (defaults.commit || defaults.push) args.push('--commit', '--branch', BRANCH)
    if (defaults.push) args.push('--push')
    if (dryRun) args.push('--dry-run')

    console.log(`\n==== ${label} ====`)
    if (autoPlan) touchLock() // 심박 — 라운드가 아니라 **배치 경계**여야 6h 판정 창과 정합한다
    const batchBase = headSha() // exit 5 환불 판정 재료(이 배치가 실제로 무엇을 커밋했나)
    const started = new Date().toISOString()
    const run = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() })
    const code = run.status ?? 1
    results.push({ label, code, started, batchBase, stories: batch.stories ?? [] })
    record(`- ${code === 0 ? '완주' : `**중단(exit ${code})**`}: ${label}`)
    if (code !== 0) {
      // 앞 배치가 멈췄는데 뒤를 돌리면 원인이 섞인다.
      record(`- 남은 배치는 실행하지 않았다 — \`auto-pipeline-logs/run-summary.log\` 확인`)
      break
    }
  }

  // 자동 편성이면 근거를 아침 브리핑이 읽는 그 파일에 남긴다
  if (autoQueueMeta) {
    record('')
    record('## 편성 (자동 — plan-queue)')
    for (const p of autoQueueMeta.picked ?? []) record(`- ✔ ${p.key} — ${p.why}`)
    for (const e of autoQueueMeta.excluded ?? []) record(`- ✖ ${e.key} — ${e.why}`)
  }

  record('')
  record('## 아침에 할 일')
  record('- 아침 브리핑: 배치 결과 → 현황판 → **결정 인박스** 순으로 읽는다.')
  record(`- 이 배치의 커밋은 \`${BRANCH}\` 에 있다. **main 머지는 사람 승인**이다.`)
  writeSummary()

  const worst = results.find((entry) => entry.code !== 0)

  // 조기 종료(STOP) 시 하루 상한 원장 환불 — 미실행 배치가 기록만 남아 이후 슬롯의
  // remaining 을 0 으로 만드는 결함 봉쇄(실사고 2026-08-27). 자동 편성 라운드에만 의미가 있다.
  if (worst && autoPlan && !dryRun && autoQueueMeta) {
    const unrun = batches.flatMap((b) => b.stories ?? []).filter((k) => !ranStories.has(k))
    // exit 5(한도) 환불 확장: 멈춘 배치의 스토리 중 라운드 커밋이 그 스토리 md 를 한 번도 안 만졌으면
    // 실작업 0 이다 — 한도가 원장·비수렴 상한을 공짜로 소모하지 않게 환불한다.
    // 그 외 exit 코드는 종전대로 보수적으로 남긴다(일부라도 실행됐을 수 있다).
    if (worst.code === 5 && worst.batchBase) {
      unrun.push(...limitRefundKeys(worst.stories ?? [], roundCommitFileLists(worst.batchBase)))
    }
    if (unrun.length > 0) {
      const { s, save } = loadState()
      const day = s.days[START_DATE]
      if (day && Array.isArray(day.planned)) {
        const before = day.planned.length
        day.planned = refundUnrun(day.planned, unrun)
        save()
        record(`- 원장 환불: 미실행/한도 무작업 ${unrun.length}건을 하루 상한 기록에서 제외(${before} → ${day.planned.length}) — 다음 슬롯이 다시 집는다`)
        writeSummary()
      }
    }
  }
  const done = results.filter((r) => r.code === 0).length

  // 차단기 v2 갱신 + 진전 원장 + 슬롯 요약 푸시 — 리허설(dry-run)은 무음·무기록
  if (autoPlan && !dryRun) {
    const { s, win, save } = loadState()
    // 차단기 v2: 원인 서명(exit 코드 + 배치 라벨) 단위. stops 필드는 원격 명령 /status·/resume 호환용으로 유지된다.
    Object.assign(win, stopRecord(win, worst ? worst.code : null, worst?.label))
    // 진전 원장 — 이 라운드 커밋이 만진 스토리 md 키를 남긴다. 편성기의 「무진전 편성 연속」 상한 재료다
    // (같은 스토리를 몇 번 편성했나가 아니라, 편성하고도 아무것도 못 만졌나를 센다).
    const day = s.days[START_DATE]
    if (day) {
      day.progressed ??= []
      for (const k of progressedStoryKeys(roundCommitFileLists(roundBaseShaForLedger))) {
        if (!day.progressed.includes(k)) day.progressed.push(k)
      }
    }
    save()
    const blocked = (autoQueueMeta?.excluded ?? []).filter((e) => e.why.includes('결정 대기')).length
    const exhausted = (autoQueueMeta?.excluded ?? []).filter((e) => e.why.includes('소진')).length
    // 지출 한도 차단(2026-08-30 회수) — 한 건도 못 한 exit 5 라운드는 **원인을 이름으로** 말하고
    // 매 라운드 같은 말을 반복하지 않는다. 성공 라운드가 나오면 연속 카운트를 0 으로 되돌린다.
    const nowIso = new Date().toISOString()
    const spendBlocked = worst?.code === 5 && done === 0
    s.spendBlock = spendBlocked
      ? { streak: (s.spendBlock?.streak ?? 0) + 1, firstIso: s.spendBlock?.firstIso ?? nowIso }
      : { streak: 0, firstIso: null }
    save()
    const spend = spendBlocked ? spendBlockNotice({ streak: s.spendBlock.streak, firstIso: s.spendBlock.firstIso, nowIso }) : { speak: false }
    if (spendBlocked) record(`- 무인 실행 지출 한도 차단 — 연속 ${s.spendBlock.streak}회 무작업(최초 ${s.spendBlock.firstIso})${spend.speak ? ' · 알림 발신' : ' · 알림 억제(반복)'}`)
    if (spend.speak) notify(spend.title, spend.body)
    else if (!spendBlocked) notify(worst ? `슬롯 STOP(exit ${worst.code}) · 라운드 ${round}` : `슬롯 완주 ${done}배치 · 라운드 ${round}`,
      `${results.map((r) => `${r.code === 0 ? 'OK' : 'STOP'} ${r.label}`).join('\n')}${blocked ? `\n결정 대기가 스토리 ${blocked}개를 막는 중 — DECISIONS-INBOX.md` : ''}${exhausted ? `\n무인 소진 ${exhausted}건 — 사람 판단 필요(아침 브리핑)` : ''}`,
      // 공개 폴백에는 배치 라벨을 싣지 않는다 — 건수·exit 코드까지만.
      `완주 ${done}건${worst ? ` · STOP exit ${worst.code}` : ''}${blocked ? ` · 결정 대기 ${blocked}건` : ''}. ${NTFY_BRIEF}`)
  }

  return {
    worstCode: worst ? worst.code : null,
    ranCount: results.length,
    // 라운드가 끝난 뒤에도 요약에 한 줄 더 남길 수 있게 열어 둔다(공회전 종료 사유).
    note: (message) => { record(message); writeSummary() },
  }
}

/** 라운드(또는 배치)가 만든 새 커밋들의 변경 파일을 커밋당 배열로 모은다 — 판정은 runner-rules 몫.
 *  기준 SHA 를 못 잡았거나 rev-list 가 실패하면 빈 배열 = 실작업 0(보수 방향).
 *  ⚠️ core.quotePath=false 필수 — git 은 기본값에서 비ASCII 경로를 `"…\354\212\244…"` 로 8진 이스케이프해
 *  내보낸다. 스토리 키에 한글을 쓰면 스토리 md 정규식이 전부 빗나가고, 그 결과 ① 진전 원장이 늘 비어
 *  무진전 연속 상한이 리셋되지 않으며(정상 진행 스토리가 영구 제외) ② exit 5 환불이 실작업분까지
 *  돌려준다. 실측으로 확인한 결함이다. */
function roundCommitFileLists(baseSha) {
  if (!baseSha) return []
  const rev = spawnSync('git', ['rev-list', `${baseSha}..HEAD`], { encoding: 'utf8' })
  if (rev.status !== 0) return []
  const shas = (rev.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean)
  return shas.map((x) => (spawnSync('git', ['-c', 'core.quotePath=false', 'show', '--name-only', '--format=', x], { encoding: 'utf8' }).stdout ?? '')
    .split('\n').map((l) => l.trim()).filter(Boolean))
}

const headSha = () => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout ?? '').trim() : ''
}

// ⑥ 실행 — 수동은 단일 실행, 슬롯 모드는 큐가 마를 때까지 연속.
if (!autoPlan) {
  const r = await runQueue(manualQueuePath, null, 1)
  console.log(`\n==== 야간 배치 종료 — ${SUMMARY} ====`)
  await flushNotify()
  process.exit(r.worstCode ?? 0)
}

let lastWorst = null
for (let round = 1; ; round++) {
  touchLock() // 심박 — 라운드 경계
  writeChainInfo() // 체인 게이트 재료 — 편성 전에 최신 실측
  const ds = doDownSync() // 하향 동기 — 낮의 결정·큐·목업 승인이 밤에 보인다
  if (ds.note) console.log(`· ${ds.note}`)
  if (!ds.ok) break // 코드 충돌 — 이 라운드 휴면(다음 슬롯이 재판정 · 같은 지문 2회면 오늘 동기 중단)
  const sel = selectQueue()
  if (!sel) break // 오늘 몫 소진(편성 0) — 다음 정시 슬롯이 새로 판단한다
  const baseSha = headSha() // 라운드 전 HEAD — 끝나고 새 커밋이 만진 스토리를 본다(진전 원장)
  const r = await runQueue(sel.path, sel.meta, round, baseSha)
  lastWorst = r.worstCode
  // 공회전 가드 — 라운드가 만든 커밋이 자기 로그뿐이면(또는 커밋 0) 실작업 0 이다. 엔진이
  // state.json skip 으로 전 단계를 건너뛰고 로그만 커밋한 뒤 exit 0 을 내면, 러너는 그걸 「완주」로
  // 세어 같은 편성을 밤새 반복한다(커밋 오염 + 알림 폭주). 모르면 멈추는 쪽이 싸다 — 다음 정시
  // 슬롯이 새 프로세스로 이어받는다.
  const didRealWork = roundDidRealWork(roundCommitFileLists(baseSha))
  const contArgs = {
    autoPlan, dryRun, worstCode: r.worstCode, ranCount: r.ranCount,
    startDate: START_DATE, nowDate: today(),
  }
  const cont = shouldContinueLoop({ ...contArgs, roundDidRealWork: didRealWork })
  if (!cont) {
    // 공회전(다른 조건은 전부 계속인데 실작업만 0)일 때만 그 사유를 적는다 — STOP·자정·편성 0
    // 종료에 엉뚱한 사유를 덧씌우지 않는다. 알림은 종료와 함께 1회뿐이다.
    if (!didRealWork && shouldContinueLoop({ ...contArgs, roundDidRealWork: true })) {
      const why = '라운드 실작업 0 — 공회전 종료(같은 편성이 반복되면 원장·편성 규칙을 사람이 확인)'
      r.note(`- **${why}**`)
      if (!dryRun) notify(`공회전 종료 · 라운드 ${round}`, why)
    } else if (r.worstCode == null && r.ranCount > 0 && START_DATE !== today()) {
      console.log('자정 경과 — 루프를 끝내고 다음 슬롯에 넘긴다(날짜 고정 가드)')
    }
    break
  }
  console.log(`\n──── 라운드 ${round} 완주 — 남은 일이 있는지 다시 편성한다(연속 실행) ────`)
}

console.log(`\n==== 야간 배치 종료 — ${SUMMARY} ====`)
await flushNotify() // fetch 알림 배출 — process.exit 이 전송을 잘라먹지 않게
process.exit(lastWorst ?? 0)
