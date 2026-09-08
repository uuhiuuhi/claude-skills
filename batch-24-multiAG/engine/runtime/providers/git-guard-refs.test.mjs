// COMMIT GUARD 사후 지문(N2) — 도구 네임스페이스 ref 오탐 재현·수정 회귀 (2026-09-06)
//
// 실사고: Codex Desktop 이 같은 `.git` 에 `refs/codex/turn-diffs/checkpoints/…` 체크포인트 ref 를 남기자
// 워커 실행 중이던 운영 러너가 「로컬 reflog/ref 지문이 달라졌다」로 exit 6 STOP 3회(08:07·09:37·10:27) →
// 낮 창 차단. 수정 = show-ref 지문에서 `refs/codex/` 만 뺀다. HEAD reflog·브랜치·태그·stash·commit→reset 탐지는 그대로.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { GUARD_IGNORED_REF_NAMESPACES, filterGuardRefs, localGitFingerprintFor } from './git-guard.mjs'

const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`)
  return r.stdout.trim()
}
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'guard-refs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, ['init', '-q', '-b', 'main'])
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, ['add', 'a.txt'])
  git(root, ['commit', '-qm', 'base'])
  return root
}
// 실물은 `…/checkpoints/<64hex>/<64hex>/<ms>/<uuid>` 다. 임시 폴더에서 Windows MAX_PATH(260) 에 걸리지 않도록 해시만 줄인다 — 네임스페이스·깊이·꼬리 형식은 같다.
const CODEX_REF = 'refs/codex/turn-diffs/checkpoints/52cbacf4d3438062/9289b4570fdb9831/1788679041436/afdd6895-8bfd-48e0-8c57-664e6c3e8bb1'

describe('[git-guard-refs] 순수 필터', () => {
  it('무시 네임스페이스는 refs/codex/ 뿐이고 heads·tags·remotes·stash 는 절대 목록에 없다', () => {
    assert.deepEqual([...GUARD_IGNORED_REF_NAMESPACES], ['refs/codex/'])
    for (const keep of ['refs/heads/', 'refs/tags/', 'refs/remotes/', 'refs/stash']) assert.ok(!GUARD_IGNORED_REF_NAMESPACES.some((p) => keep.startsWith(p) || p.startsWith(keep)))
  })
  it('show-ref 출력에서 refs/codex/* 줄만 빠지고 나머지 줄·순서는 그대로다', () => {
    const out = ['1111 refs/heads/main', `2222 ${CODEX_REF}`, '3333 refs/remotes/origin/main', '4444 refs/stash', '5555 refs/tags/v1', '6666 refs/notes/commits', ''].join('\n')
    assert.equal(filterGuardRefs(out), ['1111 refs/heads/main', '3333 refs/remotes/origin/main', '4444 refs/stash', '5555 refs/tags/v1', '6666 refs/notes/commits'].join('\n'))
    assert.equal(filterGuardRefs(''), '')
    assert.equal(filterGuardRefs(`2222 ${CODEX_REF}`), '')
  })
})

describe('[git-guard-refs] 실저장소 재현 — 체크포인트 ref 는 지문을 바꾸지 않고, 실제 git 이동은 바꾼다', () => {
  it('재현: refs/codex/turn-diffs/… 생성·갱신·삭제 전후 지문이 같다(옛 구현은 달랐다)', (t) => {
    const root = repo(t)
    const head = git(root, ['rev-parse', 'HEAD'])
    const before = localGitFingerprintFor(root)
    assert.match(before, /^reflog=1\n/)
    // 옛 구현(무필터 show-ref)은 이 ref 만으로 지문이 달라졌다 — 그것이 STOP 3회의 원인.
    git(root, ['update-ref', CODEX_REF, head])
    const raw = localGitFingerprintFor(root, { ignored: [] })
    assert.notEqual(raw, before, '무필터 지문은 체크포인트 ref 때문에 달라진다(재현)')
    assert.equal(localGitFingerprintFor(root), before, '수정된 지문은 같다')
    git(root, ['update-ref', CODEX_REF.replace(/[^/]+$/, 'ffffffff-0000-4000-8000-000000000000'), head])
    assert.equal(localGitFingerprintFor(root), before)
    git(root, ['update-ref', '-d', CODEX_REF])
    assert.equal(localGitFingerprintFor(root), before)
  })
  it('유지: 브랜치 생성은 지문을 바꾼다', (t) => {
    const root = repo(t)
    const before = localGitFingerprintFor(root)
    git(root, ['branch', 'feature-x'])
    assert.notEqual(localGitFingerprintFor(root), before)
  })
  it('유지: 태그 생성은 지문을 바꾼다', (t) => {
    const root = repo(t)
    const before = localGitFingerprintFor(root)
    git(root, ['tag', 'v-sneak'])
    assert.notEqual(localGitFingerprintFor(root), before)
  })
  it('유지: commit → reset --hard 로 HEAD 를 원상복구해도 reflog 가 자라 지문이 바뀐다', (t) => {
    const root = repo(t)
    const head = git(root, ['rev-parse', 'HEAD'])
    const before = localGitFingerprintFor(root)
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git(root, ['add', 'b.txt'])
    git(root, ['commit', '-qm', 'sneak'])
    git(root, ['reset', '-q', '--hard', head])
    assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'HEAD 는 원상복구됐다')
    const after = localGitFingerprintFor(root)
    assert.notEqual(after, before)
    assert.match(after, /^reflog=3\n/)
  })
  it('유지: stash 는 refs/stash 로 잡힌다', (t) => {
    const root = repo(t)
    const before = localGitFingerprintFor(root)
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    git(root, ['stash', 'push', '-q', '-m', 'sneak'])
    assert.notEqual(localGitFingerprintFor(root), before)
  })
  it('유지: 저장소가 아니면 reflog=-1 + 빈 목록으로 전후가 같다', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'guard-norepo-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const fp = localGitFingerprintFor(root)
    assert.ok(fp.startsWith('reflog=-1\n') || /^reflog=-?\d+\n/.test(fp))
    assert.equal(localGitFingerprintFor(root), fp)
  })
})
