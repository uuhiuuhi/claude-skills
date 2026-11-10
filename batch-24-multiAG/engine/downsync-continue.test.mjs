// 2026-11-11 깃러너: 하향 동기 코드 충돌 처분 — 설정 downSyncCodeConflict="continue" 면 라운드를 쉬지 않고
// <stateDir>/downsync-conflict.json 에 해소 요청을 남긴다 · 설정이 없으면 종전대로 휴면(ok:false).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { downSyncDecision, conflictFingerprint, stripConflictMarkers } from './runner-rules.mjs'

function runnerFunction(name) {
  const runner = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = runner.indexOf('function ' + name + '(')
  const end = runner.indexOf('\n}\n', start)
  assert.ok(start > 0 && end > start, `${name} 를 찾지 못함`)
  return runner.slice(start, end + 2)
}

function run(cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-cont-'))
  let notified = 0
  const ctx = {
    CFG: cfg, STATE_DIR: dir, BRANCH: 'auto/test', dryRun: false, NTFY_BRIEF: '',
    existsSync: () => true, resolve: (p) => p, join, writeFileSync, readFileSync,
    loadState: () => ({ day: {}, save() {} }),
    assertOperationalRuntime: () => null, assertIncomingToolingStable: () => {},
    downSyncDecision, conflictFingerprint, stripConflictMarkers,
    notify: () => { notified++ },
    spawnSync: (_f, args) => {
      if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'auto/test' }
      if (args.includes('rev-list')) return { status: 0, stdout: '3' }
      if (args.includes('merge') && args.includes('origin/main')) return { status: 1, stderr: 'conflict' }
      if (args.includes('--diff-filter=U')) return { status: 0, stdout: 'src/app.ts\n' }
      return { status: 0, stdout: '' }
    },
  }
  const src = runnerFunction('doDownSync').replaceAll('import.meta.dirname', 'TOOLING_DIR')
  const r = runInNewContext(src + '\ndoDownSync()', { ...ctx, TOOLING_DIR: dir })
  return { r, dir, notified }
}

test('코드 충돌 + continue 설정 → 쉬지 않고 해소 요청 파일을 남긴다', () => {
  const { r, dir, notified } = run({ downSyncCodeConflict: 'continue' })
  assert.equal(r.ok, true)
  assert.match(r.note, /해소 요청 기록/)
  const req = JSON.parse(readFileSync(join(dir, 'downsync-conflict.json'), 'utf8'))
  assert.deepEqual(req.conflicted, ['src/app.ts'])
  assert.equal(req.behind, 3)
  assert.equal(notified, 0)
})

test('코드 충돌 + 설정 없음 → 종전대로 이 라운드 휴면', () => {
  const { r, dir } = run({})
  assert.equal(r.ok, false)
  assert.equal(existsSync(join(dir, 'downsync-conflict.json')), false)
})
