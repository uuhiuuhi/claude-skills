import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshWorktree } from './worktree-refresh.mjs'

const branch = 'auto/2026-09-06'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'refresh-isolated-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work')
  const remote = join(root, 'remote.git')
  mkdirSync(cwd)
  const calls = []
  const invoke = (file, args, options) => spawnSync(file, args, {
    ...options, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  })
  const git = (...args) => {
    const r = invoke('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const write = (path, value) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), value)
  }
  const commit = (message) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  git('init', '--bare', remote)
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Refresh Test')
  git('config', 'user.email', 'refresh@example.invalid')
  write('source.txt', 'base\n')
  write('tools/auto/runtime.mjs', 'export const version = 1\n')
  write('tools/auto/runtime/helper.mjs', 'export const helper = true\n')
  write('.gitignore', '.auto-batch-worktree\nignored.log\n')
  const base = commit('baseline')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', 'origin', 'main', `HEAD:refs/heads/${branch}`)
  write('.auto-batch-worktree', '')
  const options = { cwd, branch, date: '2026-09-06', toolingDir: join(cwd, 'tools/auto'), runGit: (file, args, opts) => {
    calls.push(args.slice(2))
    return invoke(file, args, opts)
  } }
  return { cwd, remote, git, write, commit, base, calls, options, run: (extra) => refreshWorktree({ ...options, ...extra }) }
}

test('dry-run and absent marker never call git', () => {
  const runGit = () => { throw new Error('git must not run') }
  assert.deepEqual(refreshWorktree({ dryRun: true, runGit }), { skipped: 'dry-run' })
  assert.deepEqual(refreshWorktree({ cwd: join(tmpdir(), 'nonexistent-refresh-marker'), runGit }), { skipped: 'no-marker' })
})

test('dirty source, Korean story, logs, staged changes and stash remain byte-for-byte in place', (t) => {
  const f = fixture(t)
  f.write('source.txt', 'earlier saved work\n')
  f.git('stash', 'push', '-qm', 'existing user stash')
  const stash = f.git('rev-parse', 'refs/stash')
  f.write('source.txt', 'unfinished source\n')
  f.git('add', 'source.txt')
  const paths = ['_bmad-output/한글 story.md', '_bmad-output/implementation-artifacts/auto-pipeline-logs/run-summary.log', '_qa-result.log']
  for (const path of paths) f.write(path, `unfinished ${path}\n`)
  const before = f.git('status', '--porcelain=v1', '-z')
  assert.throws(() => f.run(), /unfinished changes preserved in place/)
  assert.equal(f.git('status', '--porcelain=v1', '-z'), before)
  assert.equal(f.git('rev-parse', 'refs/stash'), stash)
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
  for (const path of paths) assert.equal(readFileSync(join(f.cwd, path), 'utf8'), `unfinished ${path}\n`)
  assert.equal(readFileSync(join(f.cwd, 'source.txt'), 'utf8'), 'unfinished source\n')
  assert.deepEqual(f.calls.map((args) => args[0]), ['status'])
})

test('untracked marker alone permits safe detached refresh', (t) => {
  const f = fixture(t)
  f.write('.gitignore', 'ignored.log\n')
  f.commit('unignore marker')
  f.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  const result = f.run()
  assert.equal(result.ref, `origin/${branch}`)
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD')
  assert.equal(f.calls.some((args) => ['reset', 'clean', 'stash', 'merge'].includes(args[0])), false)
  assert.deepEqual(f.calls.find((args) => args[0] === 'checkout').slice(0, 3), ['checkout', '--no-overwrite-ignore', '--detach'])
})

test('reviewed local tooling commit survives remote lag, next slot, and date rollover without push', (t) => {
  const f = fixture(t)
  f.git('checkout', '-qb', branch)
  f.write('tools/auto/runtime.mjs', 'export const version = 2 // reviewed local pin\n')
  const pin = f.commit('reviewed tooling pin')
  for (const options of [{ toolingCommit: pin }, { toolingCommit: pin }, { branch: 'auto/2026-09-07', date: '2026-09-07', toolingCommit: pin }]) {
    const result = f.run(options)
    assert.equal(result.head, pin)
    assert.equal(result.ref, branch)
    assert.equal(f.git('rev-parse', 'HEAD'), pin)
  }
  assert.equal(f.git('rev-parse', `refs/remotes/origin/${branch}`), f.base)
  assert.equal(f.calls.some((args) => args[0] === 'push'), false)
})

test('remote source advance refreshes when no stale local today branch exists', (t) => {
  const f = fixture(t)
  f.write('source.txt', 'remote source\n')
  const next = f.commit('remote source')
  f.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  f.git('reset', '--hard', f.base) // isolated fixture only
  assert.equal(f.run().head, next)
  assert.equal(readFileSync(join(f.cwd, 'source.txt'), 'utf8'), 'remote source\n')
})

test('stale local today branch cannot undo selected remote tip in downstream switch', (t) => {
  const f = fixture(t)
  f.git('branch', branch)
  f.write('source.txt', 'remote advance\n')
  f.commit('remote advance')
  f.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  f.git('reset', '--hard', f.base)
  assert.throws(() => f.run(), /fast-forward\/reconcile/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
  assert.equal(f.calls.some((args) => args[0] === 'checkout'), false)
})

test('divergent local and remote auto branches fail closed', (t) => {
  const f = fixture(t)
  f.write('source.txt', 'remote fork\n')
  f.commit('remote fork')
  f.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  f.git('reset', '--hard', f.base)
  f.git('checkout', '-qb', branch)
  f.write('source.txt', 'local fork\n')
  const local = f.commit('local fork')
  assert.throws(() => f.run(), /divergent or unrelated/)
  assert.equal(f.git('rev-parse', 'HEAD'), local)
  assert.equal(f.calls.some((args) => args[0] === 'checkout'), false)
})

test('fetch and status failure stop before checkout', (t) => {
  const f = fixture(t)
  f.git('remote', 'set-url', 'origin', join(f.cwd, 'missing-remote'))
  assert.throws(() => f.run(), /git fetch failed/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
  assert.equal(f.calls.some((args) => args[0] === 'checkout'), false)
  assert.throws(() => f.run({ runGit: () => ({ status: null, error: new Error('spawn failure') }) }), /git status failed/)
  assert.throws(() => f.run({ runGit: () => ({ status: 128 }) }), /git status failed \(128\)/)
})

test('target changing installed runtime stops before touching loaded code', (t) => {
  const f = fixture(t)
  f.write('tools/auto/runtime.mjs', 'export const version = 99\n')
  f.commit('different runtime')
  f.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  f.git('reset', '--hard', f.base)
  assert.throws(() => f.run(), /target changes running tooling/)
  assert.equal(readFileSync(join(f.cwd, 'tools/auto/runtime.mjs'), 'utf8'), 'export const version = 1\n')
  assert.equal(f.calls.some((args) => args[0] === 'checkout'), false)
})

test('ignored file collision is preserved and safe checkout fails', (t) => {
  const f = fixture(t)
  f.write('ignored.log', 'tracked remote file\n')
  f.git('add', '-f', 'ignored.log')
  f.commit('remote tracked collision')
  f.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  f.git('reset', '--hard', f.base)
  f.write('ignored.log', 'local ignored evidence\n')
  assert.throws(() => f.run(), /git checkout failed/)
  assert.equal(readFileSync(join(f.cwd, 'ignored.log'), 'utf8'), 'local ignored evidence\n')
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
})

test('runtime modification racing inspection is detected even when git ignores it', (t) => {
  const f = fixture(t)
  f.write('.gitignore', '.auto-batch-worktree\ntools/auto/local.mjs\n')
  f.commit('ignore runtime overlay')
  f.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  f.write('tools/auto/local.mjs', 'before\n')
  const runGit = (file, args, opts) => {
    const r = f.options.runGit(file, args, opts)
    if (args[2] === 'fetch') f.write('tools/auto/local.mjs', 'concurrent replacement\n')
    return r
  }
  assert.throws(() => f.run({ runGit }), /running tooling changed during inspection/)
  assert.equal(f.calls.some((args) => args[0] === 'checkout'), false)
})

test('run-night startup delegates dry-run and has no destructive git fallback', () => {
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'run-night.mjs'), 'utf8')
  const startup = runner.slice(runner.indexOf('  // ② Marker'), runner.indexOf('  // ③ 연속 중단 차단기'))
  assert.match(startup, /const toolingCommit = assertOperationalRuntime\(\)[\s\S]*refreshWorktree\(\{ branch: BRANCH, date: START_DATE, dryRun, toolingCommit \}\)[\s\S]*assertOperationalRuntime\(\)/)
  assert.doesNotMatch(startup.replace(/^\s*\/\/.*$/gm, ''), /spawnSync|stash|checkout|clean|reset/)
})

test('runtime pin boundary allows application descendants but rejects unreviewed tooling descendants', (t) => {
  const f = fixture(t)
  f.git('checkout', '-qb', branch)
  f.write('tools/auto/runtime.mjs', 'export const version = 2\n')
  const pin = f.commit('reviewed tooling')
  f.write('source.txt', 'reviewed application work\n')
  const app = f.commit('application descendant')
  assert.equal(f.run({ toolingCommit: pin }).head, app)
  f.git('checkout', branch)
  f.write('tools/auto/runtime.mjs', 'export const version = 3\n')
  const unreviewed = f.commit('unreviewed tooling descendant')
  assert.throws(() => f.run({ toolingCommit: pin }), /differs from the reviewed runtime pin/)
  assert.equal(f.git('rev-parse', 'HEAD'), unreviewed)
  assert.equal(readFileSync(join(f.cwd, 'tools/auto/runtime.mjs'), 'utf8'), 'export const version = 3\n')
})

test('tooling directory cannot be the worktree root or escape the worktree', (t) => {
  const f = fixture(t)
  for (const toolingDir of [f.cwd, dirname(f.cwd), join(dirname(f.cwd), 'sibling-tooling')]) {
    assert.throws(() => f.run({ toolingDir }), /tooling directory must be inside the worktree/)
  }
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
  assert.equal(f.calls.some(args => ['fetch', 'checkout'].includes(args[0])), false)
})

test('an empty auto chain starts from origin main without inventing a local branch', (t) => {
  const f = fixture(t)
  f.git('push', '-q', 'origin', '--delete', branch) // only this isolated fixture's bare remote
  const result = f.run()
  assert.equal(result.ref, 'origin/main')
  assert.equal(result.head, f.base)
  assert.equal(result.inheritance, null)
  assert.equal(f.git('for-each-ref', 'refs/heads/auto', '--format=%(refname)'), '')
})

test('a non-date unfinished auto branch is preserved and requires explicit reconciliation', (t) => {
  const f = fixture(t)
  f.git('push', '-q', 'origin', '--delete', branch)
  f.git('checkout', '-qb', 'auto/review-needed')
  f.write('source.txt', 'unfinished chain\n')
  const head = f.commit('non-date chain')
  assert.throws(() => f.run(), /non-date auto branches need explicit reconciliation/)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(readFileSync(join(f.cwd, 'source.txt'), 'utf8'), 'unfinished chain\n')
  assert.equal(f.calls.some(args => args[0] === 'checkout'), false)
})

test('ahead HEAD preserves its older auto anchor and refuses continuation after losing that anchor', (t) => {
  const f = fixture(t)
  const previous = 'auto/2026-09-05'
  f.git('checkout', '-qb', previous)
  f.write('source.txt', 'unpublished local work\n')
  const head = f.commit('unpublished local work')
  const result = f.run()
  assert.equal(result.ref, previous)
  assert.equal(result.head, head)
  assert.equal(f.git('rev-parse', `refs/remotes/origin/${branch}`), f.base)
  // Keep the commit reachable, but remove the auto-chain anchor required by downstream branch switches.
  f.git('branch', '-m', previous, 'reviewed-local')
  const checkouts = f.calls.filter(args => args[0] === 'checkout').length
  assert.throws(() => f.run(), /ahead HEAD has no local auto branch anchor/)
  assert.equal(f.calls.filter(args => args[0] === 'checkout').length, checkouts)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(f.git('rev-parse', 'reviewed-local'), head)
})

test('a reviewed commit absent from the selected history cannot authorize refresh', (t) => {
  const f = fixture(t)
  f.write('source.txt', 'future reviewed work\n')
  const pin = f.commit('reviewed but unapplied commit')
  f.git('checkout', '--detach', f.base)
  assert.throws(() => f.run({ toolingCommit: pin }), /does not contain reviewed tooling commit/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
  assert.equal(f.git('rev-parse', 'main'), pin)
  assert.equal(f.calls.some(args => args[0] === 'checkout'), false)
})

test('runtime replacement during checkout is detected and left intact for review', (t) => {
  const f = fixture(t)
  const runGit = (file, args, opts) => {
    const result = f.options.runGit(file, args, opts)
    if (args[2] === 'checkout') f.write('tools/auto/runtime/helper.mjs', 'export const helper = false // concurrent update\n')
    return result
  }
  assert.throws(() => f.run({ runGit }), /running tooling changed during checkout/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.base)
  assert.equal(readFileSync(join(f.cwd, 'tools/auto/runtime/helper.mjs'), 'utf8'), 'export const helper = false // concurrent update\n')
  assert.equal(f.calls.some(args => ['reset', 'clean', 'stash'].includes(args[0])), false)
})
