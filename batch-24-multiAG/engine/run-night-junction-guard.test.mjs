// 2026-10-08 — 공유 node_modules 링크 해제가 실패하면 그 워크트리 폴더를 지우지 않는다(5범주 · 2026-10-03 Inspectir 실사고 재발 방지).
// detachSharedLink 는 run-night 의 안쪽 함수라 직접 못 부른다 → 원문 계약을 래칫으로 고정한다.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'run-night.mjs'), 'utf8')

describe('[run-night] node_modules 링크 해제 실패 = 삭제 건너뜀', () => {
  it('해제 함수가 실패를 삼키지 않고 false 를 돌려준다', () => {
    assert.match(src, /try \{ unlinkSync\(link\); return true \} catch \(e\) \{[\s\S]{0,400}return false/)
  })
  it('cleanup 과 잔재 정리 둘 다 false 면 worktree remove --force · rmSync 로 가지 않는다', () => {
    assert.match(src, /if \(!detachSharedLink\(w\.dir\)\) continue\s*\n\s*spawnSync\('git', \['worktree', 'remove', '--force', w\.dir\]\)/)
    assert.match(src, /if \(!detachSharedLink\(dir\)\) \{ cleanup\(\); return null \}/)
  })
})
