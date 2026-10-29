// 워크트리 간 qa 직렬 잠금 — 병렬 워커 N 개가 **동시에** qa(vitest 워커 × N · 개발 DB 실검사 · Supabase Auth 로그인)를 돌리면 공유
// 개발 DB 가 경합하고 Auth 가 429 를 낸다(2026-09-16 Auth 429 · 2026-09-30 통합 게이트 vitest 16 워커 과부하 · 2026-10-28 1-121
// 「공유 개발 DB 경합 의심」). dev(LLM 구현)는 병렬로 두고 **엔진이 띄우는 qa 게이트만 한 번에 하나**로 세운다 — 자원표의 첫 줄(qa=1).
// 러너가 워크트리 env 에 AUTO_QA_MUTEX=<상태 폴더>/locks/qa.lock 을 넣고, 엔진(auto-story-pipeline runQualityLoop)이 게이트 프로세스를
// 띄우기 **전에** 잠근다 — 게이트 프로세스의 stage 타임아웃이 대기 시간을 먹지 않게(Astra 10-29 #6).
// 잠금 = `openSync(path, 'wx')`(원자적) · 내용 {pid, at} · 죽은 pid 나 stale lock 은 **회수 lock(path.reclaim · 역시 wx)** 을 쥔 쪽만 재확인 뒤
// 지운다(두 대기자가 같은 lock 을 번갈아 지우는 경쟁 차단 · Astra #3) · release 는 자기 pid 가 적힌 lock 만 지운다.
// 시한(waitMs)을 넘기면 timedOut 으로 돌려주고 **호출부가 fail-closed**(qa 를 돌리지 않고 STOP) — 잠금 없이 진행하지 않는다(Astra #5).
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export const QA_MUTEX_WAIT_MS = 3 * 60 * 60_000 // 최장 대기 — 앞 워커의 qa 한 바퀴(전량 17k 검사)보다 훨씬 길게 · 넘기면 호출부 STOP
export const QA_MUTEX_STALE_MS = 2 * 60 * 60_000 // pid 판정 불능(EPERM)일 때만 쓰는 보조 기한
const RECLAIM_STALE_MS = 60_000 // 회수 lock 자체가 이보다 오래되면 죽은 회수자로 본다
const WRITE_GRACE_MS = 10_000 // 방금 생긴 빈/손상 lock = 다른 프로세스가 기록 중

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 환경이 막으면 즉시 */ } }
const defaultPidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' ? 'unknown' : false } }
const readLock = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const ageOf = (path, now) => { try { return now() - statSync(path).mtimeMs } catch { return null } } // null = 없음

/** 잠금 획득. 반환 { release(), waitedMs, timedOut, path } — timedOut=true 면 잠그지 못했다(호출부가 qa 를 돌리지 말 것). */
export function acquireQaMutex({ path, waitMs = QA_MUTEX_WAIT_MS, pollMs = 5_000, staleMs = QA_MUTEX_STALE_MS, now = Date.now, pidAlive = defaultPidAlive, sleep = sleepSync, log = () => {}, progressEveryMs = 5 * 60_000 } = {}) {
  if (!path) return { release() {}, waitedMs: 0, timedOut: false, path: null }
  const started = now()
  let lastProgress = started
  mkdirSync(dirname(path), { recursive: true })
  const release = () => { if (readLock(path)?.pid === process.pid) { try { unlinkSync(path) } catch { /* 이미 없음 */ } } }
  for (;;) {
    let fd
    try { fd = openSync(path, 'wx') } catch (e) { if (e?.code !== 'EEXIST') throw e }
    if (fd !== undefined) {
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() })) } finally { closeSync(fd) }
      return { path, waitedMs: now() - started, timedOut: false, release }
    }
    // 남의 lock — 나이는 JSON 과 무관하게 mtime 으로 먼저 잰다(기록 중인 빈 파일을 「손상 = 즉시 회수」로 오판하지 않게)
    const ageMs = ageOf(path, now)
    if (ageMs === null) continue // 그 사이 풀렸다 — 바로 재시도
    const holder = readLock(path)
    const alive = holder?.pid ? pidAlive(holder.pid) : (ageMs < WRITE_GRACE_MS ? 'unknown' : false)
    const dead = alive === false || (alive === 'unknown' && ageMs > staleMs)
    if (dead && reclaim(path, holder, { now, pidAlive, staleMs, log })) continue
    if (now() - started >= waitMs) { log(`qa mutex: ${Math.round(waitMs / 60_000)}분 시한 초과 — 잠그지 못함(pid ${holder?.pid ?? '?'} 보유) · qa 를 돌리지 않는다`); return { path, waitedMs: now() - started, timedOut: true, release() {} } }
    if (now() - lastProgress >= progressEveryMs) { lastProgress = now(); log(`qa mutex: ${Math.round((now() - started) / 60_000)}분째 대기 — pid ${holder?.pid ?? '?'} 가 qa 실행 중(${path})`) }
    sleep(pollMs)
  }
}

/** 죽은 lock 회수 — 회수 lock(wx)을 쥔 하나만 **다시 읽어 같은 보유자인지 확인한 뒤** 지운다. 반환 true = 지웠다(재시도) · false = 남이 회수 중/보유자 바뀜. */
function reclaim(path, judged, { now, pidAlive, staleMs, log }) {
  const rp = `${path}.reclaim`
  let fd
  try { fd = openSync(rp, 'wx') } catch (e) {
    if (e?.code !== 'EEXIST') throw e
    const a = ageOf(rp, now)
    if (a !== null && a > RECLAIM_STALE_MS) { try { unlinkSync(rp) } catch { /* 경쟁 */ } } // 죽은 회수자의 lock — 다음 바퀴에 재시도
    return false
  }
  try {
    closeSync(fd)
    const cur = readLock(path)
    const same = (cur?.pid ?? null) === (judged?.pid ?? null) && (cur?.at ?? null) === (judged?.at ?? null)
    if (!same) return false // 그 사이 새 보유자 — 살아 있는 lock 을 지우지 않는다
    const ageMs = ageOf(path, now)
    if (ageMs === null) return false
    const alive = cur?.pid ? pidAlive(cur.pid) : (ageMs < WRITE_GRACE_MS ? 'unknown' : false)
    if (!(alive === false || (alive === 'unknown' && ageMs > staleMs))) return false
    log(`qa mutex: 죽은 lock 회수(pid ${cur?.pid ?? '?'} · ${Math.round(ageMs / 1000)}s)`)
    try { unlinkSync(path) } catch { /* 경쟁자가 먼저 */ }
    return true
  } finally { try { unlinkSync(rp) } catch { /* 이미 없음 */ } }
}
