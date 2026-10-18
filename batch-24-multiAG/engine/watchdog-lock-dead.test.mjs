// 감시자 「죽은 lock」 — 2026-10-18 14:2x 실사고: 러너 node(pid 29380)가 데스크톱 앱 재시작과 함께 사라졌는데 runner.lock 이 남아
// 감시자가 lock 이 있다는 이유로 「ok」를 내고 lock-stale(3시간)까지 기다렸다. 주인 pid 사망 + 심박 30분 초과면 바로 잡아
// 잔여물 보존 커밋 → lock archive → 재기동한다.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockDead, WD_LOCK_DEAD_HB_MS } from './runner-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIN = 60000

describe('lockDead — 주인 pid 사망 + 심박 기한 초과만 「죽은 lock」', () => {
  it('pid 사망(ESRCH) + 심박 낡음 → true', () => {
    assert.equal(lockDead({ exists: true, parseOk: true, pidAlive: false, hbAgeMs: 45 * MIN }), true)
    assert.equal(lockDead({ exists: true, parseOk: true, pidAlive: false, hbAgeMs: Infinity }), true)
  })
  it('pid 생존이면 심박이 아무리 낡아도 false(dev 단계는 심박이 1시간 넘게 조용하다)', () => {
    assert.equal(lockDead({ exists: true, parseOk: true, pidAlive: true, hbAgeMs: 5 * 60 * MIN }), false)
  })
  it('pid 판정 불능(EPERM)·JSON 손상·lock 없음은 false — 살아 있는 러너를 밀어내지 않는다', () => {
    assert.equal(lockDead({ exists: true, parseOk: true, pidAlive: 'unknown', hbAgeMs: 5 * 60 * MIN }), false)
    assert.equal(lockDead({ exists: true, parseOk: false, hbAgeMs: Infinity }), false)
    assert.equal(lockDead({ exists: false }), false)
    assert.equal(lockDead(), false)
  })
  it('pid 사망이어도 심박이 기한 안이면 false(막 죽은 순간 · 재기동 중 경합)', () => {
    assert.equal(lockDead({ exists: true, parseOk: true, pidAlive: false, hbAgeMs: 10 * MIN }), false)
    assert.equal(WD_LOCK_DEAD_HB_MS, 30 * MIN)
    assert.equal(lockDead({ exists: true, parseOk: true, pidAlive: false, hbAgeMs: 10 * MIN }, { hbStaleMs: 5 * MIN }), true)
  })
})

// ── 리허설(Windows 전용 — 감시자가 예약작업 조회에 powershell 을 쓴다): 사본 러너 저장소 + 사본 상태 폴더에서 감시자를 실제로 돌린다.
function makeRig({ leftoverAgeMin = 60, pid, hbAgeMin = 120 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wd-lockdead-'))
  const runner = join(root, 'runner'); const state = join(root, 'state')
  mkdirSync(join(runner, 'tools', 'auto'), { recursive: true }); mkdirSync(state, { recursive: true })
  mkdirSync(join(runner, '_bmad-output', 'implementation-artifacts'), { recursive: true })
  const g = (...a) => { const r = spawnSync('git', ['-C', runner, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout }
  g('init', '-q', '-b', 'auto/2026-10-18'); g('config', 'user.email', 'wd@test'); g('config', 'user.name', 'wd-test'); g('config', 'core.autocrlf', 'false')
  writeFileSync(join(runner, 'tools', 'auto', 'auto.config.json'), JSON.stringify({ project: 'wdtest', stateDir: state }))
  writeFileSync(join(runner, '_bmad-output', 'implementation-artifacts', '1-76-x.md'), '# 1-76\n')
  g('add', '-A'); g('commit', '-q', '-m', 'base')
  writeFileSync(join(runner, '.auto-batch-worktree'), ''); writeFileSync(join(runner, '.git', 'info', 'exclude'), '.auto-batch-worktree\n')
  // 죽은 러너가 남긴 잔여물(추적 파일 수정 + 새 파일)
  const a = join(runner, '_bmad-output', 'implementation-artifacts', '1-76-x.md'); const b = join(runner, 'src-left.ts')
  writeFileSync(a, '# 1-76\n- [x] dev 수리 도중\n'); writeFileSync(b, 'export const half = 1\n')
  const t = (Date.now() - leftoverAgeMin * MIN) / 1000; utimesSync(a, t, t); utimesSync(b, t, t)
  writeFileSync(join(state, 'runner.lock'), JSON.stringify({ pid, token: 'tok-dead', at: new Date(Date.now() - 3 * 60 * MIN).toISOString(), hb: new Date(Date.now() - hbAgeMin * MIN).toISOString() }))
  const run = () => spawnSync(process.execPath, [join(HERE, 'watchdog.mjs'), '--no-claude'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, AUTO_RUNNER_DIR: runner, AUTO_BATCH_STATE_DIR: state, AUTO_RUNNER_TASK: 'wd-lockdead-test-no-such-task', BAROOS_RUNNER_DIR: '', BAROOS_STATE_DIR: '' },
  })
  return { root, runner, state, g, run }
}
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid // 끝난 프로세스의 pid — 지금은 없다

describe('감시자 리허설 — 가짜 죽은 lock', { skip: process.platform !== 'win32' && '감시자는 Windows 예약작업 전용' }, () => {
  it('죽은 lock → 판정 lock-dead · 잔여물 보존 커밋 · lock 은 archive 로 · 트리 깨끗', () => {
    const rig = makeRig({ pid: deadPid() })
    try {
      const r = rig.run()
      assert.equal(r.status, 0, r.stderr)
      const wdlog = readFileSync(join(rig.state, 'watchdog.log'), 'utf8')
      assert.match(wdlog, /판정 — lock-dead/)
      assert.match(wdlog, /pid \d+ 없음 · 심박 1\d\d분 전/)
      assert.match(wdlog, /죽은 lock — 잔여물 보존 커밋 [0-9a-f]{8}\(2건\) · 죽은 lock → runner\.lock\.dead-/)
      assert.equal(existsSync(join(rig.state, 'runner.lock')), false)
      assert.ok(readdirSync(join(rig.state, 'archive')).some((n) => /^runner\.lock\.dead-.*-pid\d+\.json$/.test(n)))
      assert.match(rig.g('log', '-1', '--format=%s'), /STOP 잔여물 보존 — 감시자 — 죽은 lock\(pid \d+\)/)
      assert.equal(rig.g('status', '--porcelain').trim(), '')
    } finally { rmSync(rig.root, { recursive: true, force: true }) }
  })
  it('잔여물이 방금 바뀌었으면(고아 워커가 쓰는 중) 아무것도 건드리지 않는다', () => {
    const rig = makeRig({ pid: deadPid(), leftoverAgeMin: 1 })
    try {
      assert.equal(rig.run().status, 0)
      assert.match(readFileSync(join(rig.state, 'watchdog.log'), 'utf8'), /아직 누가 쓰는 중.*다음 회차/)
      assert.equal(existsSync(join(rig.state, 'runner.lock')), true)
      assert.equal(rig.g('log', '-1', '--format=%s').trim(), 'base')
    } finally { rmSync(rig.root, { recursive: true, force: true }) }
  })
  it('러너 클론 git status 가 실패하면 「깨끗함」으로 보지 않고 lock 을 그대로 둔다', () => {
    const rig = makeRig({ pid: deadPid() })
    try {
      rmSync(join(rig.runner, '.git'), { recursive: true, force: true })
      assert.equal(rig.run().status, 0)
      assert.match(readFileSync(join(rig.state, 'watchdog.log'), 'utf8'), /죽은 lock — 러너 클론 git status 실패 — 손대지 않음/)
      assert.equal(existsSync(join(rig.state, 'runner.lock')), true)
    } finally { rmSync(rig.root, { recursive: true, force: true }) }
  })
  it('주인 pid 가 살아 있으면 심박이 2시간 낡아도 lock-dead 가 아니다(lock 무접촉)', () => {
    const rig = makeRig({ pid: process.pid })
    try {
      assert.equal(rig.run().status, 0)
      const wdlog = readFileSync(join(rig.state, 'watchdog.log'), 'utf8')
      assert.doesNotMatch(wdlog, /판정 — lock-dead/)
      assert.match(wdlog, /pid \d+ 생존/)
      assert.equal(existsSync(join(rig.state, 'runner.lock')), true)
    } finally { rmSync(rig.root, { recursive: true, force: true }) }
  })
})
