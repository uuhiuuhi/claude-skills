// 2026-10-08 — 죽은 Codex 워커가 남긴 격리본(.env.local)을 다음 격리 전에 되돌린다(출처 표식이 이 cwd 인 것만).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { recoverOrphanedHolds, hideSensitiveFiles, restoreEnvFiles } from './codex.mjs'

const DEAD_PID = 4000000 // Windows·리눅스 모두 존재하지 않는 PID

describe('[codex] 고아 격리본 회수', () => {
  it('죽은 PID + 출처가 이 cwd 인 보관본은 되돌리고 폴더를 지운다 · 출처 없는 옛 보관본은 건드리지 않는다 · 살아 있는 PID 는 건너뛴다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orphan-cwd-'))
    const holdRoot = mkdtempSync(join(tmpdir(), 'orphan-hold-'))
    const mine = join(holdRoot, `${DEAD_PID}-1`); mkdirSync(mine)
    writeFileSync(join(mine, '.hold-origin'), resolve(cwd)); writeFileSync(join(mine, '.env.local'), 'VITE_X=1')
    const other = join(holdRoot, `${DEAD_PID}-2`); mkdirSync(other); writeFileSync(join(other, '.env.local'), 'VITE_Y=2') // 출처 표식 없음
    const alive = join(holdRoot, `${process.pid}-3`); mkdirSync(alive); writeFileSync(join(alive, '.hold-origin'), resolve(cwd)); writeFileSync(join(alive, '.env.local'), 'VITE_Z=3')
    const r = recoverOrphanedHolds(cwd, { holdRoot })
    assert.deepEqual(r.recovered, ['.env.local'])
    assert.equal(readFileSync(join(cwd, '.env.local'), 'utf8'), 'VITE_X=1')
    assert.ok(!existsSync(mine), '회수한 보관 폴더는 지운다')
    assert.ok(existsSync(join(other, '.env.local')), '출처 없는 보관본은 그대로')
    assert.deepEqual(r.stale, [other])
    assert.ok(existsSync(join(alive, '.env.local')), '살아 있는 PID 의 보관본은 그대로')
  })
  it('격리할 때 출처 표식을 남기고, 복원하면 표식까지 사라진다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orphan-cwd2-'))
    const holdRoot = mkdtempSync(join(tmpdir(), 'orphan-hold2-'))
    writeFileSync(join(cwd, '.env.local'), 'VITE_A=1')
    const hold = hideSensitiveFiles(cwd, { holdRoot, files: ['.env.local'] })
    assert.equal(readFileSync(join(hold.holdDir, '.hold-origin'), 'utf8'), resolve(cwd))
    assert.ok(!existsSync(join(cwd, '.env.local')))
    restoreEnvFiles(cwd, hold)
    assert.equal(readFileSync(join(cwd, '.env.local'), 'utf8'), 'VITE_A=1')
    assert.equal(readdirSync(holdRoot).length, 0, '보관 폴더는 표식과 함께 사라진다')
  })
})
