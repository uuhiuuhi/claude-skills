// 2026-11-11 깃러너: 하향 동기 코드 충돌 처분 — 설정 downSyncCodeConflict="continue" 면 라운드를 쉬지 않고
// <stateDir>/downsync-conflict.json 에 해소 요청을 남긴다 · 설정이 없으면 종전대로 휴면(ok:false).
// 2026-11-12: 부분 자동 해소(장부·생성물은 엔진이 풀고 코드만 남긴다) · 생성물 재생성(downSyncRegenerate) ·
// 반복 백스톱을 main 해시 단위로 · 감시자 사람 질문 1건 · 편성기 「⏸ 러너 편성 제외」 주석.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  downSyncDecision, conflictFingerprint, stripConflictMarkers, resolveSprintStatusConflict, downSyncRegenerateMap,
  downSyncSprintPick, downSyncGateUpdate, DOWNSYNC_GATE_KEY,
} from './runner-rules.mjs'
import { plan, parseSprint } from './plan-queue.mjs'

const SPRINT = '_bmad-output/implementation-artifacts/sprint-status.yaml'
const DEFERRED = '_bmad-output/implementation-artifacts/deferred-work.md'
const QCFG = 'tools/auto/quality.config.json'
const REGEN = { [QCFG]: 'npm run api:inventory' }

function runnerFunction(name) {
  const runner = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = runner.indexOf('function ' + name + '(')
  const end = runner.indexOf('\n}\n', start)
  assert.ok(start > 0 && end > start, `${name} 를 찾지 못함`)
  return runner.slice(start, end + 2)
}

/** doDownSync 를 vm 에서 돌린다 — git 은 가짜(호출 기록) · 충돌 파일은 메모리 · 상태 폴더는 실제 임시 폴더. */
function run(cfg, { conflicted = ['src/app.ts'], files = {}, sha = 'aaaa1111', day = {}, regenStatus = 0, dir = mkdtempSync(join(tmpdir(), 'ds-cont-')) } = {}) {
  let notified = 0
  const calls = []
  const mem = { ...files }
  const ctx = {
    CFG: cfg, STATE_DIR: dir, BRANCH: 'auto/test', dryRun: false, NTFY_BRIEF: '',
    existsSync: () => true, resolve: (p) => p, join,
    readFileSync: (p, e) => (Object.hasOwn(mem, p) ? mem[p] : readFileSync(p, e)),
    writeFileSync: (p, s) => (Object.hasOwn(mem, p) ? (mem[p] = s) : writeFileSync(p, s)),
    unlinkSync,
    loadState: () => ({ day, save() {} }),
    assertOperationalRuntime: () => null, assertIncomingToolingStable: () => {},
    downSyncDecision, conflictFingerprint, stripConflictMarkers, resolveSprintStatusConflict, downSyncRegenerateMap, downSyncSprintPick,
    notify: () => { notified++ },
    spawnSync: (cmd, args, opts) => {
      if (typeof cmd === 'string' && cmd !== 'git') { calls.push(['shell', cmd, args?.shell]); return { status: regenStatus } }
      calls.push(args)
      if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'auto/test' }
      if (args.includes('rev-list')) return { status: 0, stdout: '3' }
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { status: 0, stdout: sha + '\n' }
      if (args.includes('merge') && args.includes('origin/main')) return { status: 1, stderr: 'conflict' }
      if (args.includes('--diff-filter=U')) return { status: 0, stdout: conflicted.join('\n') + '\n' }
      return { status: 0, stdout: '' }
    },
  }
  const src = runnerFunction('doDownSync').replaceAll('import.meta.dirname', 'TOOLING_DIR')
  const r = runInNewContext(src + '\ndoDownSync()', { ...ctx, TOOLING_DIR: dir })
  const req = existsSync(join(dir, 'downsync-conflict.json')) ? JSON.parse(readFileSync(join(dir, 'downsync-conflict.json'), 'utf8')) : null
  return { r, dir, notified, calls, mem, day, req }
}
const has = (calls, ...want) => calls.some((a) => Array.isArray(a) && a[0] !== 'shell' && want.every((w) => a.includes(w)))

test('코드 충돌 + continue 설정 → 쉬지 않고 해소 요청 파일을 남긴다', () => {
  const { r, req, notified } = run({ downSyncCodeConflict: 'continue' })
  assert.equal(r.ok, true)
  assert.match(r.note, /해소 요청 기록/)
  assert.deepEqual(req.conflicted, ['src/app.ts'])
  assert.equal(req.behind, 3)
  assert.equal(req.main, 'aaaa1111')
  assert.equal(notified, 0)
})

test('코드 충돌 + 설정 없음 → 종전대로 이 라운드 휴면', () => {
  const { r, req } = run({})
  assert.equal(r.ok, false)
  assert.equal(req, null)
})

describe('① 부분 자동 해소 — 장부·생성물은 엔진이 풀고 진짜 코드만 남긴다', () => {
  test('분류: 장부(sprint=키 단위 · deferred=union) · 스토리 문서 · 생성물 → plan, 코드만 remaining', () => {
    const d = downSyncDecision([SPRINT, DEFERRED, '_bmad-output/implementation-artifacts/1-9-x.md', QCFG, 'src/a.ts', 'tests/b.test.ts'], { regenerate: REGEN })
    assert.equal(d.mode, 'halt')
    assert.deepEqual(d.remaining, ['src/a.ts', 'tests/b.test.ts'])
    assert.deepEqual(d.plan, { [SPRINT]: 'sprint', [DEFERRED]: 'union', '_bmad-output/implementation-artifacts/1-9-x.md': 'ours', [QCFG]: 'regen' })
    // 생성물 설정이 없으면 그 파일은 코드로 남는다
    assert.deepEqual(downSyncDecision([SPRINT, QCFG]).remaining, [QCFG])
    // 코드가 없으면 전부 해소
    assert.deepEqual(downSyncDecision([SPRINT, DEFERRED, QCFG], { regenerate: REGEN }), { mode: 'resolve', plan: { [SPRINT]: 'sprint', [DEFERRED]: 'union', [QCFG]: 'regen' } })
    assert.deepEqual(downSyncRegenerateMap({ 'a\\b.json': ' x ', c: '', d: 3 }), { 'a/b.json': 'x' })
    assert.deepEqual(downSyncRegenerateMap(null), {})
  })

  test('코드가 남으면 merge --abort · 해소 요청에는 남은 코드만(장부·생성물은 autoResolvable)', () => {
    const { r, req, calls } = run({ downSyncCodeConflict: 'continue', downSyncRegenerate: REGEN }, { conflicted: [SPRINT, DEFERRED, QCFG, 'src/app.ts'] })
    assert.equal(r.ok, true)
    assert.deepEqual(req.conflicted, ['src/app.ts'])
    assert.deepEqual(req.autoResolvable.sort(), [DEFERRED, QCFG, SPRINT].sort())
    assert.ok(has(calls, 'merge', '--abort'))
    assert.ok(!calls.some((c) => c[0] === 'shell'), '코드가 남으면 재생성 명령을 돌리지 않는다')
    assert.ok(!has(calls, 'commit'))
  })

  test('장부만 충돌 → sprint 는 키 단위(중복 키 없음) · deferred 는 양쪽 유지 · 커밋 · 해소 요청 파일을 지운다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-cont-'))
    writeFileSync(join(dir, 'downsync-conflict.json'), '{"conflicted":["x"]}')
    const sprint = 'development_status:\n<<<<<<< HEAD\n  1-1-a: review\n  1-2-b: done\n=======\n  1-1-a: done\n  1-2-b: in-progress\n  1-3-c: backlog # ⏸ 러너 편성 제외\n>>>>>>> origin/main\n'
    const deferred = '# 원장\n<<<<<<< HEAD\n- 체인 쪽 항목\n=======\n- main 쪽 항목\n>>>>>>> origin/main\n'
    const { r, mem, calls } = run({ downSyncCodeConflict: 'continue' }, { dir, conflicted: [SPRINT, DEFERRED], files: { [SPRINT]: sprint, [DEFERRED]: deferred } })
    assert.equal(r.ok, true)
    assert.match(r.note, /자동 해소/)
    assert.equal(mem[SPRINT], 'development_status:\n  1-1-a: done\n  1-2-b: done\n  1-3-c: backlog # ⏸ 러너 편성 제외\n')
    assert.equal(mem[DEFERRED], '# 원장\n- 체인 쪽 항목\n- main 쪽 항목\n')
    assert.ok(has(calls, 'commit', '--no-edit'))
    assert.ok(!has(calls, 'merge', '--abort'))
    assert.equal(existsSync(join(dir, 'downsync-conflict.json')), false)
  })

  test('sprint 승자 — 더 나아간 상태 · 같으면 main(⏸ 주석) · 체인이 앞서면 체인', () => {
    assert.equal(downSyncSprintPick('k', '  k: review', '  k: done'), 'theirs')
    assert.equal(downSyncSprintPick('k', '  k: done', '  k: review'), 'ours')
    assert.equal(downSyncSprintPick('k', '  k: backlog', '  k: backlog # ⏸ 러너 편성 제외'), 'theirs')
    assert.equal(resolveSprintStatusConflict('<<<<<<< HEAD\n  k: done\n=======\n  k: review\n>>>>>>> x\n', { pick: downSyncSprintPick }), '  k: done\n')
  })
})

describe('② 생성물은 다시 만든다(downSyncRegenerate)', () => {
  test('생성물 충돌 → theirs 받고 다른 충돌을 푼 뒤 명령 실행 · add · 커밋', () => {
    const { r, calls } = run({ downSyncCodeConflict: 'continue', downSyncRegenerate: REGEN }, { conflicted: [DEFERRED, QCFG], files: { [DEFERRED]: '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n' } })
    assert.equal(r.ok, true)
    assert.match(r.note, /재생성 1/)
    const iTheirs = calls.findIndex((c) => Array.isArray(c) && c.includes('--theirs') && c.includes(QCFG))
    const iShell = calls.findIndex((c) => c[0] === 'shell')
    const iAddDeferred = calls.findIndex((c) => Array.isArray(c) && c[0] === 'add' && c.includes(DEFERRED))
    const iCommit = calls.findIndex((c) => Array.isArray(c) && c.includes('commit'))
    assert.ok(iTheirs >= 0 && iShell > iTheirs && iShell > iAddDeferred && iCommit > iShell, '순서: theirs → 다른 충돌 해소 → 명령 → 커밋')
    assert.deepEqual(calls[iShell], ['shell', 'npm run api:inventory', true])
    assert.ok(calls.slice(iShell).some((c) => Array.isArray(c) && c[0] === 'add' && c.includes(QCFG)))
  })

  test('재생성 명령 실패 → halt 로 강등(merge --abort · 해소 요청에 그 생성물)', () => {
    const { r, req, calls, day } = run({ downSyncCodeConflict: 'continue', downSyncRegenerate: REGEN }, { conflicted: [QCFG], regenStatus: 1 })
    assert.equal(r.ok, true)
    assert.match(r.note, /해소 요청 기록/)
    assert.deepEqual(req.conflicted, [QCFG])
    assert.ok(has(calls, 'merge', '--abort'))
    assert.ok(!has(calls, 'commit'))
    assert.equal(Object.values(day.d2fp)[0], 1, 'halt 로 센다')
  })
})

describe('③ 반복 백스톱은 main 해시 단위', () => {
  test('지문에 main 해시 — 같은 파일 집합이어도 main 이 다르면 다른 지문', () => {
    assert.notEqual(conflictFingerprint(['a', 'b'], 'sha1'), conflictFingerprint(['b', 'a'], 'sha2'))
    assert.equal(conflictFingerprint(['a', 'b'], 'sha1'), conflictFingerprint(['b', 'a'], 'sha1'))
    assert.equal(conflictFingerprint(['a']), 'a')
  })

  test('같은 main 으로 2회 실패 → 그 해시만 재시도 중단 · main 이 움직이면 다시 시도 · 옛 하루 중단 표식은 무시', () => {
    const day = { d2halt: true }
    const a = run({ downSyncCodeConflict: 'continue' }, { day, sha: 'aaaa1111' })
    assert.match(a.r.note, /해소 요청 기록/, '옛 d2halt 가 있어도 다시 시도한다')
    assert.equal(day.d2halt, undefined)
    run({ downSyncCodeConflict: 'continue' }, { day, sha: 'aaaa1111' })
    assert.equal(day.d2haltMain, 'aaaa1111')
    const c = run({ downSyncCodeConflict: 'continue' }, { day, sha: 'aaaa1111' })
    assert.match(c.r.note, /하향 동기 중단 상태\(같은 main aaaa1111/)
    assert.ok(!has(c.calls, 'merge', 'origin/main'), '같은 해시면 merge 를 시도하지 않는다')
    const d = run({ downSyncCodeConflict: 'continue' }, { day, sha: 'bbbb2222' })
    assert.ok(has(d.calls, 'merge', 'origin/main'), 'main 이 움직이면 다시 시도')
    assert.match(d.r.note, /해소 요청 기록/)
  })
})

describe('④ 편성기 — sprint-status 값 줄 주석의 ⏸ 러너 편성 제외', () => {
  test('parseSprint 가 표식을 읽고 편성기가 이유와 함께 뺀다', () => {
    const sprint = '  1-180-a: backlog # ⏸ 러너 편성 제외(대화형 ○○ 창 전담)\n  1-181-b: backlog\n'
    assert.deepEqual(parseSprint(sprint), [
      { key: '1-180-a', status: 'backlog', epic: 1, optOut: true },
      { key: '1-181-b', status: 'backlog', epic: 1 },
    ])
    const root = mkdtempSync(join(tmpdir(), 'pq-optout-'))
    const art = join(root, '_bmad-output', 'implementation-artifacts')
    mkdirSync(art, { recursive: true }); mkdirSync(join(root, '_bmad-output', 'planning-artifacts'), { recursive: true }); mkdirSync(join(root, 'tools', 'dev-status'), { recursive: true })
    writeFileSync(join(art, 'sprint-status.yaml'), sprint)
    writeFileSync(join(root, '_bmad-output', 'planning-artifacts', 'epics.md'), '### Story 1.180: a\n본문\n### Story 1.181: b\n본문\n## 끝')
    writeFileSync(join(art, 'DECISIONS-INBOX.md'), '')
    writeFileSync(join(root, 'tools', 'dev-status', 'mockup-verdicts.json'), '{"items":{}}')
    const { queue } = plan({ root, stateDir: mkdtempSync(join(tmpdir(), 'pq-state-')), config: { epicOrder: [1], dailyCap: 30 }, max: 12, today: '2026-11-12' })
    assert.deepEqual(queue._편성.picked.map((p) => p.key), ['1-181-b'])
    assert.equal(queue._편성.excluded.find((e) => e.key === '1-180-a')?.why, 'sprint-status ⏸ 러너 편성 제외 주석 — 대화형 창 전담')
  })
})

describe('⑤ 감시자 — 해소 요청이 30분 넘게 남으면 사람 질문 1건(중복 없음 · 사라지면 닫기)', () => {
  const NOW = Date.parse('2026-11-12T10:00:00Z')
  const conflict = { at: '2026-11-12T09:00:00Z', conflicted: ['src/a.ts', 'src/b.ts'] }
  const base = { at: 'x', humanGates: [{ key: '7-23-x', type: 'question', text: '기존' }], excluded: [] }

  test('30분 지나면 1건 올림 · 같은 내용이면 그대로(null) · 기존 항목 보존', () => {
    const next = downSyncGateUpdate(base, conflict, { nowMs: NOW })
    assert.equal(next.humanGates.length, 2)
    const g = next.humanGates.find((x) => x.key === DOWNSYNC_GATE_KEY)
    assert.equal(g.type, 'question'); assert.equal(g.source, 'watchdog')
    assert.match(g.text, /^하향 동기 충돌 2파일 — 러너 지휘 창이 풀 것\(CLAUDE\.md 운영 방식 8\)/)
    assert.equal(downSyncGateUpdate(next, conflict, { nowMs: NOW }), null, '중복 금지')
    assert.equal(next.humanGates[0].text, '기존')
  })

  test('30분 전이면 올리지 않는다 · 파일이 사라지면 닫는다 · 문서가 없어도 만든다', () => {
    assert.equal(downSyncGateUpdate(base, { ...conflict, at: '2026-11-12T09:45:00Z' }, { nowMs: NOW }), null)
    const open = downSyncGateUpdate(base, conflict, { nowMs: NOW })
    const closed = downSyncGateUpdate(open, null, { nowMs: NOW })
    assert.deepEqual(closed.humanGates, base.humanGates)
    assert.equal(downSyncGateUpdate(base, null, { nowMs: NOW }), null)
    assert.equal(downSyncGateUpdate(null, conflict, { nowMs: NOW }).humanGates.length, 1)
  })

  test('러너의 human-gates 덮어쓰기는 감시자 항목을 이어 둔다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-keep-'))
    writeFileSync(join(dir, 'human-gates.json'), JSON.stringify({ humanGates: [{ key: DOWNSYNC_GATE_KEY, source: 'watchdog', text: 'w' }, { key: 'old', text: '편성기 옛 항목' }] }))
    let written = null
    const ctx = {
      STATE_DIR: dir, PROJECT: 'p', PLAN_SOURCE: 's', join, readFileSync,
      spawnSync: () => ({ status: 0, stdout: '' }),
      writeJsonAtomic: (_p, v) => { written = v },
      console,
    }
    runInNewContext(runnerFunction('writeHumanGates') + '\nwriteHumanGates({ humanGates: [{ key: "new", text: "편성기 새 항목" }] }, null)', ctx)
    assert.deepEqual(JSON.parse(JSON.stringify(written.humanGates.map((g) => g.key))), ['new', DOWNSYNC_GATE_KEY])
  })

  test('감시자 소스가 이 규칙을 매 회차 부르고 알림은 보내지 않는다', () => {
    const src = readFileSync(new URL('./watchdog.mjs', import.meta.url), 'utf8')
    const block = src.slice(src.indexOf('downSyncGateUpdate(readJson'), src.indexOf('const lockInfo = readLockInfo()'))
    assert.ok(block.length > 0)
    assert.ok(!/notify\(/.test(block), '텔레그램 알림 없음(👤 중단 지시)')
  })
})
