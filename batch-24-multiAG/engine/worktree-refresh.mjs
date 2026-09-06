import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inheritPlan } from './runner-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Startup must never hide unfinished work, discard local commits, or replace loaded code. */
export function refreshWorktree({ cwd = process.cwd(), branch, date, dryRun = false,
  toolingDir = HERE, toolingCommit, runGit = spawnSync } = {}) {
  // A rehearsal does not even fetch or inspect git. Keep this before every side effect.
  if (dryRun) return { skipped: 'dry-run' }
  if (!existsSync(join(cwd, '.auto-batch-worktree'))) return { skipped: 'no-marker' }
  const git = (args, allowed = [0]) => {
    const r = runGit('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    if (r.error || !allowed.includes(r.status)) {
      throw new Error(`worktree refresh: git ${args[0]} failed (${r.status ?? r.error?.code}): ${String(r.stderr ?? r.error?.message ?? '').trim()}`)
    }
    return r
  }
  const output = (args) => git(args).stdout.trim()
  const ancestor = (a, b) => git(['merge-base', '--is-ancestor', a, b], [0, 1]).status === 0
  const tip = (ref) => output(['rev-parse', '--verify', `${ref}^{commit}`])
  const later = (a, b) => {
    if (ancestor(a, b)) return b
    if (ancestor(b, a)) return a
    throw new Error(`worktree refresh: divergent or unrelated refs (${a}, ${b}); reconcile explicitly before restarting`)
  }
  const clean = () => {
    // -z avoids treating quoted names, spaces, Korean paths, or rename pairs as disposable logs.
    const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout.split('\0').filter(Boolean)
    const dirty = entries.filter((entry) => entry !== '?? .auto-batch-worktree')
    if (dirty.length) throw new Error(`worktree refresh: unfinished changes preserved in place (${dirty.length} entries); finish or review them before restarting`)
  }
  clean()
  const initialHead = tip('HEAD')
  const root = output(['rev-parse', '--show-toplevel'])
  const toolingPath = relative(root, resolve(toolingDir)).replaceAll('\\', '/')
  if (!toolingPath || toolingPath === '..' || toolingPath.startsWith('../') || isAbsolute(toolingPath)) {
    throw new Error('worktree refresh: tooling directory must be inside the worktree')
  }
  // Capture every installed file, including untracked/ignored modules loaded dynamically later.
  const fingerprint = () => {
    const hash = createHash('sha256')
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name)
        hash.update(relative(toolingDir, path)).update('\0')
        if (entry.isDirectory()) walk(path)
        else hash.update(readFileSync(path)).update('\0')
      }
    }
    walk(toolingDir)
    return hash.digest('hex')
  }
  const loadedTooling = fingerprint()
  git(['fetch', '--prune', 'origin'])
  const refs = output(['for-each-ref', 'refs/heads/auto', 'refs/remotes/origin/auto', '--format=%(refname:short)']).split('\n').filter(Boolean)
  const byName = new Set(refs)
  const localToday = byName.has(branch) ? branch : null
  const remoteToday = byName.has(`origin/${branch}`) ? `origin/${branch}` : null
  let ref = localToday && remoteToday ? later(localToday, remoteToday) : localToday ?? remoteToday
  let inheritance = null
  if (!ref) {
    // Preserve date-based chain inheritance, but choose the ahead local/remote tip for that date.
    const unmerged = refs.filter((name) => Number(output(['rev-list', '--count', `origin/main..${name}`])) > 0)
    inheritance = inheritPlan(unmerged, date)
    if (unmerged.length && !inheritance) {
      throw new Error(`worktree refresh: non-date auto branches need explicit reconciliation (${unmerged.join(', ')})`)
    }
    ref = inheritance?.ref ?? 'origin/main'
    if (inheritance) {
      const local = ref.replace(/^origin\//, '')
      if (byName.has(local) && byName.has(`origin/${local}`)) ref = later(local, `origin/${local}`)
      inheritance = { ...inheritance, ref }
    }
  }
  let target = tip(ref)
  // Local commits (including the reviewed tooling pin) cannot be rolled back to a remote tip.
  const selected = later(initialHead, target)
  if (selected === initialHead && initialHead !== target) {
    const localAnchor = refs.find((name) => !name.startsWith('origin/') && tip(name) === initialHead)
    if (!localAnchor) throw new Error('worktree refresh: ahead HEAD has no local auto branch anchor; preserve it on the intended auto branch before restarting')
    ref = localAnchor
    target = initialHead
  }
  if (localToday && tip(localToday) !== target) {
    // Downstream stages switch to today's existing local branch. Never let that undo this refresh.
    throw new Error(`worktree refresh: ${localToday} does not contain selected tip ${ref}; fast-forward/reconcile the local branch before restarting`)
  }
  if (toolingCommit && !ancestor(tip(toolingCommit), target)) {
    throw new Error(`worktree refresh: selected tip does not contain reviewed tooling commit ${toolingCommit}`)
  }
  if (toolingCommit && output(['diff', '--name-only', tip(toolingCommit), target, '--', toolingPath])) {
    throw new Error('worktree refresh: installed tooling differs from the reviewed runtime pin; review and repin at a stopped batch boundary')
  }
  const toolingDiff = output(['diff', '--name-only', initialHead, target, '--', toolingPath])
  if (toolingDiff) throw new Error(`worktree refresh: target changes running tooling; apply reviewed tooling at a stopped batch boundary and restart (${toolingDiff.split('\n')[0]})`)
  clean()
  if (tip('HEAD') !== initialHead || fingerprint() !== loadedTooling) {
    throw new Error('worktree refresh: HEAD or running tooling changed during inspection; restart from a stable installation')
  }
  // No --force, reset, clean, stash, or implicit merge. Ignored collisions must also be protected.
  git(['checkout', '--no-overwrite-ignore', '--detach', target])
  if (tip('HEAD') !== target || fingerprint() !== loadedTooling) {
    throw new Error('worktree refresh: running tooling changed during checkout; stop and restart from a reviewed installation')
  }
  clean()
  return { ref, head: target, inheritance }
}

/**
 * End-of-run housekeeping: commit the engine-owned run report (night-last-run.md, integration-gate.log, batch/metrics
 * manifests, landing-quality, quality-cache) so the next slot's `refreshWorktree()` does not refuse to start.
 *
 * Why: `refreshWorktree()` deliberately treats *every* dirty entry as unfinished work and aborts. The runner itself writes
 * its report after the last landing commit, so without this step each real run left 4~6 dirty entries and every following
 * slot aborted with "unfinished changes preserved in place" (2026-09-06 operational incident: 3 consecutive idle slots).
 *
 * Scope is the log directory only (`-- <logDir>`): unfinished story work outside it stays exactly where it is and still
 * blocks the next refresh, which is the intended protection. Ignored files stay ignored (`git add -A` honours .gitignore).
 * Dry runs and checkouts without the execution marker never commit.
 */
export function preserveRunReport({ cwd = process.cwd(), logDir, label = '', dryRun = false, branchPrefix = 'auto/', runGit = spawnSync } = {}) {
  if (dryRun) return { skipped: 'dry-run' }
  if (!existsSync(join(cwd, '.auto-batch-worktree'))) return { skipped: 'no-marker' }
  if (!logDir) return { skipped: 'no-log-dir' }
  // Housekeeping must never throw — a finished run must not turn into a crash because git or the executor misbehaved
  // (Sol-high round 12 M2). Git non-zero exits are reported as {failed}; so are executor exceptions.
  try {
    return preserveRunReportUnsafe({ cwd, logDir, label, branchPrefix, runGit })
  } catch (error) {
    return { failed: `exception: ${error?.message ?? String(error)}` }
  }
}

function preserveRunReportUnsafe({ cwd, logDir, label, branchPrefix, runGit }) {
  const git = (args) => runGit('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  const top = git(['rev-parse', '--show-toplevel'])
  if (top.status !== 0) return { failed: `rev-parse --show-toplevel: ${(top.stderr ?? '').trim() || `exit ${top.status}`}` }
  const root = (top.stdout ?? '').trim()
  if (!root) return { skipped: 'not-a-repository' }
  // Only the runner's own `auto/<date>` branch may receive the housekeeping commit (Sol-high round 12 H1): a manual run in
  // a marker clone left on `main` or a detached HEAD would otherwise commit there and make the next slot's refresh stop on an
  // unanchored ahead HEAD / divergent refs. Off-branch reports stay dirty on purpose — the operator sees the refusal.
  const headRef = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (headRef.status !== 0) return { failed: `rev-parse --abbrev-ref HEAD: ${(headRef.stderr ?? '').trim() || `exit ${headRef.status}`}` }
  const branch = (headRef.stdout ?? '').trim()
  if (!branch || branch === 'HEAD' || !branch.startsWith(branchPrefix)) return { skipped: 'not-on-runner-branch', branch }
  const rel = relative(root, resolve(cwd, logDir)).replaceAll('\\', '/')
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return { skipped: 'log-dir-outside-worktree' }
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel])
  if (status.status !== 0) return { failed: `status: ${(status.stderr ?? '').trim()}` }
  const entries = (status.stdout ?? '').split('\0').filter(Boolean)
  if (!entries.length) return { skipped: 'clean' }
  const add = git(['add', '-A', '--', rel])
  if (add.status !== 0) return { failed: `add: ${(add.stderr ?? '').trim()}`, entries: entries.length }
  const message = `chore(batch): 실행 보고·게이트 로그 보존${label ? ` (${label})` : ''}`
  const commit = git(['-c', 'core.editor=true', 'commit', '-q', '-m', message, '--', rel])
  if (commit.status !== 0) return { failed: `commit: ${(commit.stderr ?? commit.stdout ?? '').trim()}`, entries: entries.length }
  const head = (git(['rev-parse', 'HEAD']).stdout ?? '').trim()
  return { committed: head, entries: entries.length, message }
}
