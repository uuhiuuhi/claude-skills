#!/usr/bin/env node
// 텔레그램 원격 명령 폴러 — 「머지 + 재개」 만. 러너(run-night.mjs) 무수정.
//
// 왜 생겼나(실사고): 미머지 auto/* 잔존으로 슬롯이 밤새 휴면했다. 휴면 해제의 유일한 열쇠
// (main 머지)가 PC 앞 승인뿐이라 저녁에 자리에 없으면 밤을 통째로 잃는다.
// **무정지 개편 후 「미머지 = 휴면」은 폐지됐다** — 밤은 선형 승계로 계속 돌고, 미머지 체인이
// CHAIN_MAX_AGE_DAYS 일 이상일 때 **신규 착수만** 보류된다(회수·마감 재검수는 계속). 따라서
// /merge 의 값어치는 「휴면 해제」가 아니라 「체인 비우기 = 신규 착수 재개」로 바뀌었다.
// 알림은 이미 텔레그램(비공개 봇)으로 나가므로 **회신 방향만 연다** — getUpdates 폴링(웹훅 없음).
// 실행 위치 = 슬롯 워크트리(예약 작업: 10분 간격 · Interactive · cd 후 `--once`).
//
// 실행:
//   node tools/auto/telegram-commands.mjs --once     # 1회 폴링(수동 검증 · 예약 작업도 이 형태)
//   node tools/auto/telegram-commands.mjs --dry-run  # 판정·원장 기록만 — 발신·push·기동·offset/pending/state 쓰기·lock 삭제 전부 없음(리뷰 5번)
// 상주 프로세스 없음 — Windows 예약 작업이 10분마다 --once 로 띄운다(등록은 install.mjs --register-tasks).
//
// 명령(등급표 허용분만 · 나머지는 파서에 없음 = 거부):
//   /status  읽기 전용 — 미머지 auto/* · 이 창 STOP 카운트 · lock 유무
//   /merge   4자리 코드 되묻기 → 30분(TTL) 안에 같은 chat 에서 코드 답장 → `git push origin origin/auto/X:main`
//            (원격 ff 전용 · 작업 트리 접촉 0 · non-ff 면 강제하지 않고 「아침에 사람 머지」 회신 · 배포 안 함)
//   /resume  코드 되묻기 → 이 창 차단기 리셋 · 죽은 lock 제거 · run-night.mjs --auto-plan 1회 기동
//   /extend N  코드 되묻기 → 오늘 하루 상한을 N(1~30) 만큼 올린다(누적). 유일하게 인자를 받는 명령.
//            원장(auto-plan-state.json)은 만지지 않는다 — 폴러 전용 파일 cap-extend-<날짜>.json 에만
//            쓰고 편성기가 읽기 전용으로 가산한다(단일 작성자 원칙).
// 발신자 검증: telegram-chat.json 의 chat_id 외는 무응답(존재 노출 금지) + 원장 「외부 발신 차단」.
// 원장: <상태 폴더>/telegram-commands.log (수신·판정·실행 결과 1행씩 · 저장소 밖).
// 토큰·chat_id 는 상태 폴더(~/.claude-auto/)에만 있다 — 저장소 반입 절대 금지. 러너 notify 와 같은 경로를
// 읽되 코드는 복사·import 하지 않는다(러너는 import 즉시 실행되는 스크립트).
import { randomInt } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, todayStr } from './plan-queue.mjs'
// 러너 규칙은 네임스페이스로 받는다 — 상수 하나가 없어도 링크가 깨지지 않는다(plan-queue 와 같은 관례).
import * as RULES from './runner-rules.mjs'
import { CONFIRM_TTL_MS, EXTEND_MAX, classifyPush, judgeMessage, mergeRefspec, newPending, parseExtend, partitionUnmerged, resetWindowStops } from './telegram-rules.mjs'

const stopWindowId = RULES.stopWindowId
/** 체인 게이트 상한(일) — 러너 규칙이 SoT. 회신 문구 계산용일 뿐, 판정은 편성기가 한다. */
const CHAIN_MAX_AGE_DAYS = Number(RULES.CHAIN_MAX_AGE_DAYS ?? 2)

// 상태 폴더 — 러너(run-night.mjs)와 동일 규약. 토큰·chat_id 는 프로젝트 상태 폴더 → 공용 순.
const CFG = loadConfig(process.cwd())
const PROJECT = CFG.project || basename(resolve('.'))
const STATE_DIR = process.env.AUTO_BATCH_STATE_DIR || CFG.stateDir || join(homedir(), '.claude-auto', PROJECT)
const findFile = (name) => [join(STATE_DIR, name), join(homedir(), '.claude-auto', name)].find((p) => existsSync(p)) ?? join(STATE_DIR, name)
const P = {
  token: findFile('telegram-token.txt'),
  chat: findFile('telegram-chat.json'),
  offset: join(STATE_DIR, 'telegram-offset.json'),
  pending: join(STATE_DIR, 'telegram-pending.json'),
  log: join(STATE_DIR, 'telegram-commands.log'),
  state: join(STATE_DIR, 'auto-plan-state.json'),
  lock: join(STATE_DIR, 'runner.lock'),
  chain: join(STATE_DIR, 'chain-info.json'), // 러너가 라운드마다 남기는 선형 승계 정보 {ageDays, branches, at}
}
/** /extend 보너스 원장 — 당일 한정(자정이면 새 상한이라 이월 불요). 편성기는 읽기만 한다. */
const capExtendPath = (ymd) => join(STATE_DIR, `cap-extend-${ymd}.json`)
/** 기본 하루 상한 — 편성기(plan-queue.plan)의 `cfg.dailyCap ?? 30` 과 같은 값. 회신 문구 계산용일 뿐,
 *  실제 상한 판정은 편성기가 한다(여기서 상한을 정하지 않는다). */
const DAILY_CAP = Number(CFG.dailyCap ?? 30)

// BOM 제거 — PowerShell 이 쓴 JSON(예: telegram-chat.json)은 EF BB BF 로 시작해 JSON.parse 가 죽는다
// (실기 테스트에서 실발생 · Windows 파일 교훈). 러너 notify 도 같은 내성을 갖는다.
const readJson = (p, def) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : def)
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8')

/** 원장 1행 — 수신·판정·실행 결과 전부 */
function logLine(kind, detail = '') {
  mkdirSync(STATE_DIR, { recursive: true })
  appendFileSync(P.log, `${new Date().toISOString()}\t${kind}\t${detail.replace(/\s+/g, ' ').trim()}\n`, 'utf8')
}

/** 기본 의존성 — 테스트·dry-run 에서 주입으로 갈아끼운다(실호출 0) */
export function defaultDeps({ dryRun = false } = {}) {
  const git = (args) => spawnSync('git', args, { encoding: 'utf8', cwd: process.cwd() })
  return {
    now: () => Date.now(),
    code: () => randomInt(0, 10000),
    async getUpdates(token, offset) {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=0&allowed_updates=%5B%22message%22%5D`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }) // long-poll 금지 · ≤10초 1회
      const body = await res.json()
      if (!body.ok) throw new Error(`getUpdates 실패: ${body.description ?? res.status}`)
      return body.result ?? []
    },
    async send(token, chatId, text) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `[${PROJECT}] ${text}` }), signal: AbortSignal.timeout(10_000),
      })
    },
    // 재검수 N-3: dry-run 은 원격 ref 도 만지지 않는다(리허설 중 러너와의 fetch 경합 원천 차단) —
    // 마지막으로 본 ref 로 판정하며, 그 사실은 리허설 성격상 허용(실행 경로는 항상 실제 fetch).
    fetchOrigin: () => (dryRun ? { status: 0 } : git(['fetch', 'origin', '--prune'])),
    // 러너와 같은 재료(리뷰 3번 — 로컬+원격 · run-night.mjs 휴면 판정과 동일). 분류는 판정부 소유.
    unmergedRefs() {
      const list = git(['for-each-ref', 'refs/heads/auto', 'refs/remotes/origin/auto', '--format=%(refname:short)'])
      const names = [...new Set((list.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
      return names.filter((b) => Number((git(['rev-list', '--count', `origin/main..${b}`]).stdout ?? '0').trim()) > 0)
    },
    countAhead: (b) => Number(git(['rev-list', '--count', `origin/main..origin/${b}`]).stdout.trim()) || 0,
    push: (b) => (dryRun ? { status: 0, stderr: '' } : git(['push', 'origin', mergeRefspec(b)])),
    lockAlive() {
      if (!existsSync(P.lock)) return null
      try { process.kill(readJson(P.lock, {}).pid, 0); return true } catch { return false }
    },
    removeLock: () => { try { unlinkSync(P.lock) } catch { /* 이미 없음 */ } },
    // 리뷰 2번: 기동 「성공」을 회신하지 않는다 — 존재 확인 + error 훅까지가 이 함수의 사실 범위.
    startRunner() {
      if (dryRun) return { started: false, reason: 'dry-run' }
      const runner = resolve('tools/auto/run-night.mjs')
      if (!existsSync(runner)) return { started: false, reason: `run-night.mjs 없음(cwd=${process.cwd()})` }
      const child = spawn(process.execPath, [runner, '--auto-plan'],
        { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (e) => logLine('error', `러너 기동 실패: ${e?.message ?? e}`))
      child.unref()
      return { started: true }
    },
  }
}

/** fetch 선행 — 리뷰 4번: 스테일 ref 로 답하지 않는다. 실패는 사실대로 회신에 싣는다. */
function freshRefs(deps) {
  const f = deps.fetchOrigin()
  const ok = (f?.status ?? 1) === 0
  if (!ok) logLine('error', 'fetch origin 실패 — 스테일 ref 주의')
  return { fetchOk: ok, ...partitionUnmerged(deps.unmergedRefs()) }
}
const localOnlyNote = (localOnly) =>
  localOnly.length ? `\n⚠️ 로컬 미푸시 auto/*: ${localOnly.join(', ')} — 원격 머지 불가, PC 에서 사람 필요` : ''

/** 체인 상태 읽기 — 러너가 라운드마다 남기는 chain-info.json({ageDays, branches, at}).
 *  파일이 없거나 나이가 숫자가 아니면 ageDays=null(모른다) — 추측해서 단정하지 않는다. */
function readChain() {
  const c = readJson(P.chain, null)
  if (!c || typeof c !== 'object') return null
  const n = Number(c.ageDays)
  return { ageDays: Number.isFinite(n) ? Math.max(0, n) : null, branches: Array.isArray(c.branches) ? c.branches : [] }
}
/** 미머지 잔존의 **현재** 의미 — 「휴면」이 아니라 「신규 착수만 보류」다(무정지 개편).
 *  체인 나이를 알면 그 값과 상한을, 모르면 모른다고 회신에 싣는다. */
function chainMeaning(chain) {
  if (!chain || chain.ageDays == null) {
    return `체인 나이 미상(러너 기록 없음·손상) — 밤은 선형 승계로 계속 돈다. 체인 ${CHAIN_MAX_AGE_DAYS}일 이상이면 신규 착수만 보류`
  }
  const head = `체인 ${chain.ageDays}일차(상한 ${CHAIN_MAX_AGE_DAYS}일)`
  return chain.ageDays >= CHAIN_MAX_AGE_DAYS
    ? `${head} — 신규 착수만 보류 중(회수·마감 재검수는 계속). /merge 로 체인을 비우면 전부 재개`
    : `${head} — 밤은 선형 승계로 계속 돈다. 신규 착수도 정상`
}

/** /status 본문 — 상한 보너스·체인 나이는 파일이 있을 때만 덧붙인다(없으면 줄 자체가 없다) */
function statusText(deps) {
  const { fetchOk, remote, localOnly } = freshRefs(deps)
  const win = stopWindowId(new Date(deps.now()))
  const stops = readJson(P.state, {}).windows?.[win]?.stops ?? 0
  const lock = deps.lockAlive()
  const bonus = Number(readJson(capExtendPath(todayStr()), {}).extra ?? 0) || 0
  const chain = readChain()
  const chainLine = chain
    ? `체인 승계: 브랜치 ${chain.branches.length}개${chain.branches.length ? ` (${chain.branches.join(', ')})` : ''}\n${chainMeaning(chain)}`
    : null
  return [
    ...(fetchOk ? [] : ['⚠️ fetch 실패 — 아래는 마지막으로 본 상태다(스테일 가능)']),
    `미머지 auto/*(원격): ${remote.length ? remote.join(', ') : '없음'}${localOnlyNote(localOnly)}`,
    ...(chainLine ? [chainLine] : []),
    `이 창(${win}) STOP: ${stops}회`,
    ...(bonus > 0 ? [`오늘 상한 보너스: +${bonus}(기본 ${DAILY_CAP} → ${DAILY_CAP + bonus})`] : []),
    `lock: ${lock === null ? '없음' : lock ? '실행 중' : '죽은 lock(pid 없음)'}`,
  ].join('\n')
}

/** /merge 실행 — 원격 ff 전용 · non-ff 는 강제 없음 · 배포 없음 */
function doMerge(deps) {
  const { fetchOk, remote, localOnly } = freshRefs(deps)
  if (!fetchOk) return '⛔ fetch 실패 — 네트워크·인증 확인. 스테일 판정으로 머지하지 않는다(리뷰 4번)'
  if (remote.length === 0) return `미머지 auto/*(원격) 없음 — 머지할 것이 없다${localOnlyNote(localOnly)}`
  const lines = []
  for (const b of remote) {
    const ahead = deps.countAhead(b)
    const r = classifyPush(deps.push(b))
    if (r === 'ok') lines.push(`✅ ${b} → main (${ahead}커밋)`)
    else if (r === 'non-ff') lines.push(`⛔ ${b} 갈라짐 — 아침에 사람 머지 필요(강제하지 않음)`)
    else lines.push(`✖ ${b} push 오류 — 원장 확인`)
    logLine('merge', `${b} ${r} ahead=${ahead}`)
  }
  return lines.join('\n') + localOnlyNote(localOnly) + '\n(배포는 하지 않았다 — 별도 명령)'
}

/** /extend N 실행 — 오늘 하루 상한 보너스를 누적한다.
 *  **원장(auto-plan-state.json)은 만지지 않는다**: 그 파일의 작성자는 러너·편성기뿐이고(단일 작성자
 *  원칙), 폴러가 끼어들면 편성 중 덮어쓰기로 하루 누계가 통째로 날아간다. 그래서 폴러 전용 파일
 *  cap-extend-<날짜>.json 에만 쓰고 편성기가 읽기 전용으로 가산한다(maxEff = 상한 + 보너스).
 *  **범위 검증은 판정부의 parseExtend 를 그대로 재사용한다** — 상한(EXTEND_MAX)이 두 곳에 살면
 *  한쪽만 바뀌어 「판정은 막았는데 실행은 통과」가 난다. 여기서 정규식을 다시 쓰지 않는다. */
function doExtend(command, { dryRun = false } = {}) {
  const n = parseExtend(String(command ?? ''))
  if (n == null) return `⛔ /extend 형식·범위 오류 — 「/extend N」 형태(N = 1~${EXTEND_MAX} 정수)`
  const ymd = todayStr()
  const path = capExtendPath(ymd)
  const prev = Number(readJson(path, {}).extra ?? 0) || 0
  const next = prev + n
  if (!dryRun) {
    mkdirSync(STATE_DIR, { recursive: true })
    writeJson(path, { extra: next, at: new Date().toISOString() })
  }
  return `오늘(${ymd}) 상한 +${n} — 누적 보너스 ${next}(기본 ${DAILY_CAP} → ${DAILY_CAP + next}). 다음 편성부터 반영${dryRun ? ' (dry-run — 실제 미기록)' : ''}`
}

/** /resume 실행 — 이 창 차단기 리셋 · 죽은 lock 제거 · 러너 1회 기동 「요청」(성공 단정 금지 — 리뷰 2번) */
function doResume(deps, { dryRun = false } = {}) {
  const win = stopWindowId(new Date(deps.now()))
  if (!dryRun) writeJson(P.state, resetWindowStops(readJson(P.state, {}), win))
  const dryTag = dryRun ? ' (dry-run — 실제 미변경)' : '' // 재검수 N-2: 원장에 하지 않은 일을 남기지 않는다
  const lock = deps.lockAlive()
  if (lock === false && !dryRun) deps.removeLock()
  if (lock === true) return `러너가 이미 실행 중(lock) — stops 만 0 으로 리셋했다(${win})${dryTag}`
  const started = deps.startRunner()
  const { fetchOk, remote, localOnly } = freshRefs(deps)
  const un = [...remote, ...localOnly]
  // 재검수 N-1: fetch 실패를 숨기면 「/merge 먼저」 경고가 스테일로 누락될 수 있다 — /status 와 같은 문구로 명시
  const staleNote = fetchOk ? '' : '\n⚠️ fetch 실패 — 아래는 마지막으로 본 상태다(스테일 가능)'
  // 무정지 개편: 미머지가 남아도 「휴면」하지 않는다(폐지). 선형 승계로 계속 돌고, 체인이 상한을
  // 넘긴 동안만 신규 착수가 보류된다 — 나이를 아는 만큼만 사실대로 싣는다.
  const chain = readChain()
  const chainBlocksNew = chain?.ageDays != null && chain.ageDays >= CHAIN_MAX_AGE_DAYS
  const unmergedNote = un.length
    ? `\n${chainBlocksNew ? '⚠️' : 'ℹ️'} 미머지 auto/* 잔존(${un.join(', ')}) — 휴면 아님. ${chainMeaning(chain)}${localOnlyNote(localOnly)}`
    : ''
  const note = `${staleNote}${unmergedNote}`
  const startMsg = started?.started
    ? 'run-night.mjs --auto-plan 기동 요청(성공 여부는 다음 /status·텔레그램 알림으로 확인)'
    : started?.reason === 'dry-run'
      ? '기동 생략(dry-run)'
      : `러너 기동 실패: ${started?.reason ?? '원인 불명'} — 원장 확인`
  return `${win} stops=0${dryTag} · ${lock === false && !dryRun ? '죽은 lock 제거 · ' : ''}${startMsg}${note}`
}

/** 폴링 1회 — 새 메시지 전부 처리. deps 주입 가능.
 *  dry-run(리뷰 5번): offset·pending·state 쓰기, lock 삭제, 텔레그램 발신 전부 없음 — 판정만 원장에.
 *  실패 격리(리뷰 7번): 업데이트 1건마다 offset 저장 + try/catch — 회신 1건 실패가 전체를 되감지 않는다. */
export async function pollOnce(deps = defaultDeps(), { dryRun = false } = {}) {
  const token = existsSync(P.token) ? readFileSync(P.token, 'utf8').trim() : ''
  const chatId = readJson(P.chat, {}).chat_id
  if (!token || chatId == null) { logLine('skip', '텔레그램 미구성(token/chat_id)'); return { handled: 0 } }

  const ttlMin = Math.round(CONFIRM_TTL_MS / 60_000)
  const send = async (text) => { if (dryRun) logLine('dry-send', text); else await deps.send(token, chatId, text) }
  const offsetState = readJson(P.offset, { offset: 0 })
  const saveOffset = () => { if (!dryRun) writeJson(P.offset, offsetState) }
  const updates = await deps.getUpdates(token, offsetState.offset)
  let handled = 0
  let failures = 0
  for (const u of updates) {
    offsetState.offset = u.update_id + 1
    try {
      const message = u.message
      if (!message) { saveOffset(); continue } // 재검수 N-4: continue 가 루프 끝 saveOffset 을 건너뛰면 이 업데이트를 매 폴링 재수신한다
      const pending = readJson(P.pending, null)
      const nowMs = deps.now()
      const v = judgeMessage({ message, chatId, pending, nowMs })
      const from = `chat=${message.chat?.id}`
      switch (v.kind) {
        case 'blocked': logLine('외부 발신 차단', from); break // 무응답 — 존재 노출 금지
        case 'ignore': logLine('ignore', `${from} ${message.text ?? ''}`); break
        case 'mismatch': logLine('code-mismatch', from); break // 무응답 — 코드 추측에 힌트 없음
        case 'status': {
          logLine('status', from)
          await send(statusText(deps))
          break
        }
        case 'challenge': {
          const p = newPending(v.command, deps.code(), nowMs)
          if (!dryRun) writeJson(P.pending, p)
          logLine('challenge', `${v.command} code=${p.code}${dryRun ? ' (dry-run)' : ''}`)
          await send(`${v.command} 실행하려면 ${ttlMin}분 안에 이 코드를 답장: ${p.code}`)
          break
        }
        case 'expired': {
          if (!dryRun) { try { unlinkSync(P.pending) } catch { /* 없음 */ } }
          logLine('expired', v.command)
          await send(`확인 코드 만료(${ttlMin}분) — ${v.command} 를 다시 보내라`)
          break
        }
        case 'execute': {
          if (!dryRun) { try { unlinkSync(P.pending) } catch { /* 없음 */ } }
          logLine('execute', `${v.command}${dryRun ? ' (dry-run)' : ''}`)
          // /extend 만 인자를 달고 온다(pending.command = '/extend N')
          const out = v.command === '/merge' ? doMerge(deps)
            : v.command.startsWith('/extend') ? doExtend(v.command, { dryRun })
              : doResume(deps, { dryRun })
          logLine('result', `${v.command} ${out}`)
          await send(`${v.command}${dryRun ? ' [dry-run]' : ''}\n${out}`)
          break
        }
      }
      handled++
    } catch (e) {
      failures++
      logLine('error', `update ${u.update_id}: ${e?.message ?? e}`)
    }
    saveOffset() // 건 단위 저장 — 실패해도 같은 업데이트를 재처리하지 않는다(원장 중복 오염 방지)
  }
  if (failures > 0) {
    // 사용자 무통보 방지(리뷰 7번) — 폴링당 1회만. 이 발신마저 실패하면 원장에만 남긴다.
    try { await send(`⚠️ 명령 처리 실패 ${failures}건 — telegram-commands.log 확인`) } catch (e) { logLine('error', `실패 통지 발신 불가: ${e?.message ?? e}`) }
  }
  return { handled }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const dryRun = process.argv.includes('--dry-run')
  pollOnce(defaultDeps({ dryRun }), { dryRun })
    .then((r) => console.log(`텔레그램 폴링 완료 — 처리 ${r.handled}건${dryRun ? ' (dry-run)' : ''}`))
    .catch((e) => { logLine('error', String(e?.message ?? e)); console.error(`✖ ${e?.message ?? e}`); process.exit(1) })
}
