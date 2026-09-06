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
