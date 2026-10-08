// 2026-10-06 19:30~10-08 11:30 실사고 — 「워크트리 새로고침 중단」 슬롯 191회 동안 알림 0건. 2슬롯을 넘기면 창당 1회 알린다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { refreshStall, REFRESH_STALL_NOTIFY_AFTER } from './runner-rules.mjs'

test('refreshStall notifies from the 3rd consecutive failed slot, once per window, across midnight, and resets on success', () => {
  assert.equal(REFRESH_STALL_NOTIFY_AFTER, 2)
  const at = '2026-10-06T19:30:00Z'
  let s = refreshStall(undefined, { ok: false, at, winId: 'night-2026-10-06' })
  assert.deepEqual([s.count, s.notify], [1, false])
  s = refreshStall(s, { ok: false, at: 'later', winId: 'night-2026-10-06' })
  assert.deepEqual([s.count, s.notify], [2, false], '2슬롯까지는 일시적일 수 있다')
  s = refreshStall(s, { ok: false, at: 'later', winId: 'night-2026-10-06' })
  assert.deepEqual([s.count, s.notify, s.since], [3, true, at])
  s = refreshStall(s, { ok: false, at: 'later', winId: 'night-2026-10-06' })
  assert.equal(s.notify, false, '같은 창에서는 다시 알리지 않는다')
  s = refreshStall(s, { ok: false, at: 'later', winId: 'day-2026-10-07' })
  assert.deepEqual([s.count, s.notify, s.since], [5, true, at], '자정·창을 넘기면 스트릭을 이어 세고 새 창에서 다시 알린다')
  s = refreshStall(s, { ok: true })
  assert.deepEqual([s.count, s.notify], [0, false])
})

test('run-night wires the refresh-stall alert and the STOP-preserve failure alarm', () => {
  const src = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8')
  const catchAt = src.indexOf('워크트리 새로고침 중단 —')
  assert.ok(src.indexOf('refreshStall(s.refreshStall') > 0 && src.indexOf('refreshStall(s.refreshStall') < catchAt, 'refresh catch must count the stall')
  assert.ok(!/fail\(`워크트리 새로고침 중단/.test(src), 'refresh abort must drain notifications (shutdown), not process.exit via fail()')
  assert.match(src, /console\.error\(`✖ 워크트리 새로고침 중단 — \$\{error\.message\}`\)\s*\n\s*await shutdown\(3\)/)
  const failedAt = src.indexOf('else if (kept?.failed) {')
  assert.ok(failedAt > 0, 'preserve failure must be its own branch')
  const branch = src.slice(failedAt, src.indexOf('} else if (kept?.skipped', failedAt))
  assert.match(branch, /notify\('러너 정지 — STOP 잔여물 보존 실패'/)
  assert.match(branch, /\r?\n\s*break\r?\n/, 'preserve failure must stop the remaining batches')
})
