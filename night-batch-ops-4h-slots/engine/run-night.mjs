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
// ⑥ 미머지 auto/* 잔존 시 슬롯 휴면(자정 롤오버 중복 실행 사고 방지) — 판정 규칙은 runner-rules.mjs 소유.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { loadConfig } from './plan-queue.mjs'
import { fileListConflicts, landingResolution, nextStops, notifyChannel, parallelPlan, parseFileList, refundUnrun, shouldContinueLoop, stopWindowId, stripConflictMarkers, waitAuthMin } from './runner-rules.mjs'

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
 *  토큰·chat_id 는 저장소 밖: 프로젝트 상태 폴더 → 공용(~/.claude-auto/) 순으로 찾는다. */
const notify = (title, body) => {
  try {
    const bodyFile = join(STATE_DIR, 'notify-body.txt')
    const findFile = (name) => [join(STATE_DIR, name), join(homedir(), '.claude-auto', name)].find((p) => existsSync(p))
    const tokenPath = findFile('telegram-token.txt')
    const chatPath = findFile('telegram-chat.json')
    const token = tokenPath ? readFileSync(tokenPath, 'utf8').trim() : ''
    // BOM 내성 — PowerShell 저장 JSON 은 EF BB BF 로 시작해 parse 가 죽고, 이 catch 는
    // 무음이라 알림이 조용히 증발한다(실기 테스트에서 실발생).
    const chatId = chatPath ? JSON.parse(readFileSync(chatPath, 'utf8').replace(/^\uFEFF/, '')).chat_id : null
    const topicPath = join(homedir(), '.claude', 'ntfy-topic.txt')
    const topic = existsSync(topicPath) ? readFileSync(topicPath, 'utf8').trim() : ''
    const channel = notifyChannel({ telegramReady: Boolean(token && chatId), ntfyReady: Boolean(topic) })
    if (channel === 'telegram') {
      writeFileSync(bodyFile, `[${PROJECT}] ${title}\n${body}`, 'utf8')
      spawnSync(`curl -s -m 10 -X POST --data-urlencode chat_id=${chatId} --data-urlencode "text@${bodyFile}" https://api.telegram.org/bot${token}/sendMessage`, { shell: true })
    } else if (channel === 'ntfy') {
      writeFileSync(bodyFile, body, 'utf8')
      spawnSync(`curl -s -m 10 -H "Title: [${PROJECT}] ${title}" -d @"${bodyFile}" https://ntfy.sh/${topic}`, { shell: true })
    }
  } catch { /* 무음 — 알림 실패는 배치에 영향 없음 */ }
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

if (autoPlan) {
  mkdirSync(STATE_DIR, { recursive: true })
  // ① lock — 겹치는 슬롯은 no-op. 연속 루프가 도는 동안에도 유지되므로 다음 정시 슬롯은
  //   자동으로 겹침 회피한다.
  const lockPath = join(STATE_DIR, 'runner.lock')
  if (existsSync(lockPath)) {
    let alive = false
    try { process.kill(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 0); alive = true } catch { /* 죽은 lock */ }
    if (alive) { console.log('이미 실행 중 — 이 슬롯은 건너뛴다(lock)'); process.exit(0) }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  process.on('exit', () => { try { unlinkSync(lockPath) } catch { /* 이미 없음 */ } })

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
        notify('미커밋 작업 stash 보관', `앞 배치가 커밋 못 한 변경 ${valuable.length}건을 stash 에 보관했다.\n${valuable.slice(0, 10).join('\n')}`)
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
      // 오늘 몫 브랜치가 없으면: **미머지 auto/* 가 하나라도 남아 있는 동안 슬롯은 쉰다.**
      // 자정 롤오버 사고 방지 — 어제의 미머지 작업이 안 보이는 베이스(main)에서 같은 스토리를
      // 다시 하게 된다. 원격만 보면 안 된다 — 같은 PC 의 대화 세션이 **푸시 전** 로컬 브랜치에서
      // 작업 중일 수 있다(실측). 로컬+원격을 다 본다.
      const list = spawnSync('git', ['for-each-ref', 'refs/heads/auto', 'refs/remotes/origin/auto', '--format=%(refname:short)'], { encoding: 'utf8' })
      const unmerged = [...new Set((list.stdout ?? '').split('\n').filter(Boolean))].filter((b) => {
        const n = spawnSync('git', ['rev-list', '--count', `origin/main..${b}`], { encoding: 'utf8' })
        return Number((n.stdout ?? '0').trim()) > 0
      })
      if (unmerged.length > 0) {
        const { day, save } = loadState()
        console.log(`미머지 auto 브랜치 잔존(${unmerged.join(', ')}) — 사람 머지 전까지 슬롯 휴면`)
        day.notified ??= {}
        if (!day.notified.unmerged && !dryRun) {
          notify('슬롯 휴면 — 머지 대기', `미머지 브랜치: ${unmerged.join(', ')}\n머지가 끝나면 다음 슬롯부터 자동 재개된다`)
          day.notified.unmerged = true
        }
        save()
        process.exit(0)
      }
      ref = 'origin/main'
    }
    const co = spawnSync('git', ['checkout', '-f', '--detach', ref], { stdio: 'inherit' })
    if (co.status !== 0) fail(`워크트리 새로고침 실패(${ref}) — 이 슬롯 중단`, 3)
    console.log(`워크트리 기준: ${ref}`)
  }

  // ③ 연속 중단 차단기 — 같은 원인으로 밤새 헛돌지 않는다. exit 5(한도)는 세지 않는다.
  //    창(낮/밤) 단위로 센다 — 낮 사고가 밤 몫을 잠그지 않게(stopWindowId).
  const { win } = loadState()
  if (win.stops >= 2) {
    console.log(`이 창(${stopWindowId(new Date())}) STOP ${win.stops}회 연속 — 남은 슬롯 자동 편성 중단(아침에 사람이 본다)`)
    notify('슬롯 중단', `연속 STOP ${win.stops}회(창 단위) — 이 창의 자동 편성을 멈췄다. run-summary.log 확인.`)
    process.exit(0)
  }
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
        s.consumed[h] = new Date().toISOString()
        save()
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
    if (blocked > 0 && !dryRun) notify('할 일 0 · 결정 대기', `결정 대기가 스토리 ${blocked}개를 막고 있다 — DECISIONS-INBOX.md`)
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
      const conflicted = (spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).stdout ?? '')
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
async function runQueue(queuePath, autoQueueMeta, round) {
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
    return { worstCode: null, ranCount: 0 }
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
      const started = new Date().toISOString()
      const pr = await runBatchParallel({ batch, defaults, workers: par, record })
      if (pr !== null) {
        results.push({ label, code: pr.code, started })
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
    const started = new Date().toISOString()
    const run = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() })
    const code = run.status ?? 1
    results.push({ label, code, started })
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
    if (unrun.length > 0) {
      const { s, save } = loadState()
      const day = s.days[START_DATE]
      if (day && Array.isArray(day.planned)) {
        const before = day.planned.length
        day.planned = refundUnrun(day.planned, unrun)
        save()
        record(`- 원장 환불: 미실행 ${unrun.length}건을 하루 상한 기록에서 제외(${before} → ${day.planned.length}) — 다음 슬롯이 다시 집는다`)
        writeSummary()
      }
    }
  }
  const done = results.filter((r) => r.code === 0).length

  // 차단기 갱신 + 슬롯 요약 푸시 — 리허설(dry-run)은 무음·무기록
  if (autoPlan && !dryRun) {
    const { win, save } = loadState()
    win.stops = nextStops(win.stops, worst ? worst.code : null) // exit 5(한도)는 고장이 아니라 날씨 · 창 단위
    save()
    const blocked = (autoQueueMeta?.excluded ?? []).filter((e) => e.why.includes('결정 대기')).length
    notify(worst ? `슬롯 STOP(exit ${worst.code}) · 라운드 ${round}` : `슬롯 완주 ${done}배치 · 라운드 ${round}`,
      `${results.map((r) => `${r.code === 0 ? 'OK' : 'STOP'} ${r.label}`).join('\n')}${blocked ? `\n결정 대기가 스토리 ${blocked}개를 막는 중 — DECISIONS-INBOX.md` : ''}`)
  }

  return { worstCode: worst ? worst.code : null, ranCount: results.length }
}

// ⑥ 실행 — 수동은 단일 실행, 슬롯 모드는 큐가 마를 때까지 연속.
if (!autoPlan) {
  const r = await runQueue(manualQueuePath, null, 1)
  console.log(`\n==== 야간 배치 종료 — ${SUMMARY} ====`)
  process.exit(r.worstCode ?? 0)
}

let lastWorst = null
for (let round = 1; ; round++) {
  const sel = selectQueue()
  if (!sel) break // 오늘 몫 소진(편성 0) — 다음 정시 슬롯이 새로 판단한다
  const r = await runQueue(sel.path, sel.meta, round)
  lastWorst = r.worstCode
  const cont = shouldContinueLoop({
    autoPlan, dryRun, worstCode: r.worstCode, ranCount: r.ranCount,
    startDate: START_DATE, nowDate: today(),
  })
  if (!cont) {
    if (r.worstCode == null && r.ranCount > 0 && START_DATE !== today()) {
      console.log('자정 경과 — 루프를 끝내고 다음 슬롯에 넘긴다(날짜 고정 가드)')
    }
    break
  }
  console.log(`\n──── 라운드 ${round} 완주 — 남은 일이 있는지 다시 편성한다(연속 실행) ────`)
}

console.log(`\n==== 야간 배치 종료 — ${SUMMARY} ====`)
process.exit(lastWorst ?? 0)
