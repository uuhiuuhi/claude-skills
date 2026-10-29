// 워크트리 간 qa 직렬 잠금 — 자원표 1줄(qa=1)의 규칙 검사. 실제 파일 잠금(openSync wx) 위에서 시계·pid·sleep 만 가짜로 돈다.
// Astra 10-29 리뷰 #3(회수 경쟁 · 기록 중 lock 오판 · 남의 lock release) · #5(fail-open 금지)를 재현 검사로 박는다.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireQaMutex, QA_MUTEX_STALE_MS } from './qa-mutex.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'qa-mutex-'))
const holder = (path) => JSON.parse(readFileSync(path, 'utf8'))

describe('[자원표] qa 직렬 잠금 — 병렬 워커의 동시 qa 를 한 번에 하나로', () => {
  it('빈 자리면 즉시 잠그고(pid 기록) release 가 lock 을 지운다 · 경로 없음 = 잠금 없음(무해)', () => {
    const d = tmp(); const path = join(d, 'locks', 'qa.lock')
    try {
      const h = acquireQaMutex({ path, now: () => 0 })
      assert.equal(h.timedOut, false); assert.equal(h.waitedMs, 0)
      assert.equal(holder(path).pid, process.pid)
      h.release(); assert.ok(!existsSync(path))
      const none = acquireQaMutex({ path: '' }); assert.equal(none.path, null); none.release()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('살아 있는 보유자가 있으면 기다렸다가(sleep) 풀린 뒤 잠근다 — 대기 시간 기록 · 5분마다 진행 로그', () => {
    const d = tmp(); const path = join(d, 'qa.lock')
    try {
      writeFileSync(path, JSON.stringify({ pid: 4242, at: 'x' }))
      let t = 0; const slept = []; const logs = []
      const h = acquireQaMutex({ path, pollMs: 60_000, progressEveryMs: 120_000, now: () => t, pidAlive: () => true, log: (m) => logs.push(m), sleep: (ms) => { slept.push(ms); t += ms; if (slept.length === 5) rmSync(path) } })
      assert.equal(slept.length, 5); assert.equal(h.waitedMs, 300_000); assert.equal(h.timedOut, false)
      assert.equal(logs.filter((m) => /분째 대기/.test(m)).length, 2, logs.join('\n'))
      assert.equal(holder(path).pid, process.pid); h.release()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('죽은 pid 의 lock 은 회수한다 · 판정 불능(EPERM)은 stale 기한을 넘겼을 때만 회수 · 회수 lock 은 남지 않는다', () => {
    const d = tmp(); const path = join(d, 'qa.lock')
    try {
      writeFileSync(path, JSON.stringify({ pid: 4242 }))
      const logs = []
      const h = acquireQaMutex({ path, now: () => 0, pidAlive: () => false, log: (m) => logs.push(m), sleep: () => assert.fail('죽은 lock 앞에서 기다리면 안 된다') })
      assert.equal(h.waitedMs, 0); assert.match(logs.join('\n'), /죽은 lock 회수/); assert.ok(!existsSync(`${path}.reclaim`)); h.release()
      // EPERM(unknown) + 신선한 mtime → 기다린다(회수 금지) · stale 기한 뒤 → 회수
      writeFileSync(path, JSON.stringify({ pid: 4243 }))
      let t = Date.now(); const slept = []
      const h2 = acquireQaMutex({ path, pollMs: 60_000, now: () => t, pidAlive: () => 'unknown', sleep: (ms) => { slept.push(ms); t += ms; if (slept.length === 2) { const old = new Date(t - QA_MUTEX_STALE_MS - 1000); utimesSync(path, old, old) } } })
      assert.equal(slept.length, 2, '신선한 unknown lock 은 두 번 기다린 뒤 stale 로 회수'); assert.equal(h2.timedOut, false); h2.release()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('[Astra #3] 기록 중인 빈 lock(방금 생김)은 손상으로 보지 않고 기다린다 — 10초 유예', () => {
    const d = tmp(); const path = join(d, 'qa.lock')
    try {
      writeFileSync(path, '') // A 가 wx 로 만들고 아직 JSON 을 못 쓴 순간
      let t = Date.now(); const slept = []
      const h = acquireQaMutex({ path, pollMs: 1000, now: () => t, pidAlive: (pid) => { assert.ok(pid, '빈 lock 엔 pid 가 없다'); return false }, sleep: (ms) => { slept.push(ms); t += ms; if (slept.length === 3) writeFileSync(path, JSON.stringify({ pid: process.pid + 100000 })) } })
      // 3초 뒤 A 가 pid 를 썼고(죽은 pid) 그제야 회수된다 — 그 전엔 지우지 않았다
      assert.ok(slept.length >= 3, `유예 없이 지웠다: ${slept.length}`); assert.equal(h.timedOut, false); h.release()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('[Astra #3] 회수 직전 보유자가 바뀌면(남이 먼저 회수·획득) 그 새 lock 을 지우지 않는다 · 회수 lock 이 있으면 양보', () => {
    const d = tmp(); const path = join(d, 'qa.lock')
    try {
      writeFileSync(path, JSON.stringify({ pid: 4242, at: 'old' }))
      let calls = 0
      // pidAlive 1회째(대기자 판정) = 죽음 → 회수 lock 안에서 재확인하기 전에 C 가 lock 을 바꿔치기한다
      const h = acquireQaMutex({ path, pollMs: 1000, now: Date.now, sleep: () => {}, waitMs: 5000,
        pidAlive: (pid) => { calls++; if (calls === 1) { writeFileSync(path, JSON.stringify({ pid: 777, at: 'new' })); return false } return pid !== 777 ? false : true } })
      // C(777) 가 살아 있으므로 끝내 못 얻고 시한 초과 — 그래도 C 의 lock 은 그대로다
      assert.equal(h.timedOut, true); assert.equal(holder(path).pid, 777, '새 보유자의 lock 을 지우면 안 된다'); h.release(); assert.equal(holder(path).pid, 777)
      // 회수 lock 이 신선하게 존재하면 회수하지 않고 기다린다
      writeFileSync(path, JSON.stringify({ pid: 4242 })); writeFileSync(`${path}.reclaim`, '')
      let t = 0; const slept = []
      const h2 = acquireQaMutex({ path, pollMs: 1000, waitMs: 3000, now: () => t, pidAlive: () => false, sleep: (ms) => { slept.push(ms); t += ms } })
      assert.equal(h2.timedOut, true); assert.ok(existsSync(path), '남이 회수 중인 lock 은 건드리지 않는다'); assert.ok(slept.length >= 3)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('[Astra #5] 시한(waitMs)을 넘기면 timedOut — release 는 남의 lock 을 지우지 않는다(호출부가 qa 를 돌리지 않고 STOP)', () => {
    const d = tmp(); const path = join(d, 'qa.lock')
    try {
      writeFileSync(path, JSON.stringify({ pid: 4242 }))
      let t = 0; const logs = []
      const h = acquireQaMutex({ path, waitMs: 5000, pollMs: 2000, now: () => t, pidAlive: () => true, sleep: (ms) => { t += ms }, log: (m) => logs.push(m) })
      assert.equal(h.timedOut, true); assert.ok(h.waitedMs >= 5000); assert.match(logs.join('\n'), /시한 초과/)
      h.release(); assert.equal(holder(path).pid, 4242, '남의 lock 은 그대로')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
