import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inheritPlan } from './runner-rules.mjs'
import { isProjectOwned, toolingChanged } from './runtime-pin.mjs'
import { isDeniedPath, secretHits } from './runtime/push-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 날짜 체인이 아닌 「주제 갈래」(`auto/<날짜>-<주제>` · local 과 `origin/` 둘 다) — 승계 후보에서 제외한다.
 *  정확히 `auto/YYYY-MM-DD` 만 체인이고, 날짜조차 없는 `auto/<이름>` 은 종전대로 사람 reconcile 대상이다. */
const TOPIC_CHAIN_RE = /^(?:origin\/)?auto\/\d{4}-\d{2}-\d{2}-.+$/

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
    const unmergedAll = refs.filter((name) => Number(output(['rev-list', '--count', `origin/main..${name}`])) > 0)
    // 2026-09-20 09:20~09-21 07:xx 22시간 정지(09-15 에도 같은 사고): 지휘 세션의 수리 갈래 `auto/<날짜>-<주제>` 가 같은 날짜 체인 후보로
    // 섞여 `divergent or unrelated refs` 로 매 슬롯이 중단됐다. 체인 후보는 **정확히 `auto/YYYY-MM-DD`** 만이다. 주제 갈래는 후보에서도
    // divergent 판정에서도 빼고 무시한다(사람이 따로 소유하는 갈래이므로 러너가 reconcile 할 대상이 아니다).
    const topics = unmergedAll.filter((name) => TOPIC_CHAIN_RE.test(name))
    if (topics.length) console.log(`ℹ 체인 후보 제외(주제 갈래): ${topics.join(', ')}`)
    const unmerged = unmergedAll.filter((name) => !topics.includes(name))
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
  if (toolingCommit && toolingChanged(output(['diff', '--name-only', tip(toolingCommit), target, '--', toolingPath]), toolingPath)) {
    throw new Error('worktree refresh: installed tooling differs from the reviewed runtime pin; review and repin at a stopped batch boundary')
  }
  const toolingDiff = output(['diff', '--name-only', initialHead, target, '--', toolingPath])
  const changedTooling = toolingDiff.split(/\r?\n/).filter(Boolean).filter((file) => !isProjectOwned(file.replaceAll('\\', '/').slice(toolingPath.length + 1)))
  if (toolingChanged(toolingDiff, toolingPath)) throw new Error(`worktree refresh: target changes running tooling; apply reviewed tooling at a stopped batch boundary and restart (${changedTooling[0]})`)
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

/**
 * STOP housekeeping: a worker that ran **in the marker clone's main tree** (sequential batch) and stopped leaves its
 * unfinished story edits in place. `refreshWorktree()` treats them as unfinished human work and refuses every following
 * slot until a person commits them (2026-09-06/07: eight idle slots overnight over three replan files). In an
 * execution-only clone every leftover is engine-produced, so the runner itself "finishes" them: evidence is archived by
 * the caller first, then the leftovers are committed on the runner's `auto/*` branch with an explicit STOP marker so the
 * next replan/dev round (and a human) can see them in history instead of in a blocked tree.
 *
 * Safety: denied paths (env/keys/secret-shaped files, non-engine logs) are never staged and are reported; if the staged
 * diff contains a secret pattern nothing is committed (index reset) and the tree stays dirty on purpose — the refresh
 * refusal is then the correct outcome. Dry runs, no marker, and non-`auto/*` branches never commit.
 */
export function preserveStopLeftovers({ cwd = process.cwd(), label = '', exitCode = null, dryRun = false, branchPrefix = 'auto/', runGit = spawnSync } = {}) {
  if (dryRun) return { skipped: 'dry-run' }
  if (!existsSync(join(cwd, '.auto-batch-worktree'))) return { skipped: 'no-marker' }
  try {
    return preserveStopLeftoversUnsafe({ cwd, label, exitCode, branchPrefix, runGit })
  } catch (error) {
    return { failed: `exception: ${error?.message ?? String(error)}` }
  }
}

function preserveStopLeftoversUnsafe({ cwd, label, exitCode, branchPrefix, runGit }) {
  const git = (args) => runGit('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const headRef = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (headRef.status !== 0) return { failed: `rev-parse --abbrev-ref HEAD: ${(headRef.stderr ?? '').trim() || `exit ${headRef.status}`}` }
  const branch = (headRef.stdout ?? '').trim()
  if (!branch || branch === 'HEAD' || !branch.startsWith(branchPrefix)) return { skipped: 'not-on-runner-branch', branch }
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.status !== 0) return { failed: `status: ${(status.stderr ?? '').trim()}` }
  const entries = parsePorcelainZ(status.stdout ?? '').filter((p) => p && p !== '.auto-batch-worktree')
  if (!entries.length) return { skipped: 'clean' }
  const denied = entries.filter((p) => isDeniedPath(p.replaceAll('\\', '/')))
  const paths = entries.filter((p) => !denied.includes(p))
  if (!paths.length) return { skipped: 'only-denied-paths', denied }
  // 2026-09-08(같은 날 2회 실사고 · 18시간 + 2.5시간 정지): 스토리 워커가 엔진 사본(tools/auto/**)을 고치면 이 잔여물 커밋이 그 변경을
  // 브랜치 HEAD 에 실어 다음 슬롯부터 런타임 핀 불일치(exit 3)로 러너가 선다. 엔진 사본 변경은 잔여물에 싣지 않는다 — 추적 파일은 HEAD 로
  // 되돌리고 diff 를 로그 폴더에 patch 로 보존한다(아침에 정본 반영 여부는 사람이 판단). 미추적 파일은 그대로 둔다(핀 검사는 추적 파일만 본다).
  // 2026-09-19 밤 실사고(스토리 5건 · patch 5건 · 수리 횟수 소모): `tools/auto/quality.config.json` 은 엔진 사본이 아니라 **프로젝트 소유**다
  // (api 인벤토리 — 워커가 `npm run api:inventory` 로 갱신하는 것이 규약이고 runtime-pin 의 PROJECT_OWNED 예외). 이것까지 되돌리면 새 Edge
  // Function 이 러너 인벤토리에 영영 등록되지 않아 회수 라운드마다 api 게이트가 RED 로 재발한다. 프로젝트 소유 파일은 잔여물 커밋에 그대로 싣는다.
  const isEngine = (p) => {
    const u = p.replaceAll('\\', '/')
    return /^tools\/auto\//.test(u) && !isProjectOwned(u.slice('tools/auto/'.length))
  }
  const engineTracked = paths.filter((p) => isEngine(p) && git(['ls-files', '--error-unmatch', '--', literalPathspec(p)]).status === 0)
  let enginePatch = null
  if (engineTracked.length) {
    const diff = git(['diff', 'HEAD', '--', ...engineTracked.map(literalPathspec)])
    const rel = join('_bmad-output', 'implementation-artifacts', 'auto-pipeline-logs')
    mkdirSync(join(cwd, rel), { recursive: true })
    enginePatch = join(rel, `engine-drift-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`).replaceAll('\\', '/')
    writeFileSync(join(cwd, enginePatch), `# 워커가 남긴 엔진 사본 변경 ${engineTracked.length}건 — ${label || '(배치)'}${exitCode == null ? '' : ` (exit ${exitCode})`} · 잔여물에서 제외하고 HEAD 로 되돌림 · 정본 반영 여부는 사람 판단
` + (diff.stdout ?? ''))
    const restore = git(['checkout', 'HEAD', '--', ...engineTracked.map(literalPathspec)])
    if (restore.status !== 0) return { failed: `engine revert: ${(restore.stderr ?? '').trim()}`, denied }
  }
  const kept = paths.filter((p) => !engineTracked.includes(p)).concat(enginePatch ? [enginePatch] : [])
  if (!kept.length) return { skipped: 'only-engine-paths', denied, engineReverted: engineTracked.length, enginePatch }
  // Sol-high round 14 H1: porcelain names go back to git as pathspecs — `:(literal)` disables glob/magic so a file named
  // `[ab].txt` or `:(top)*` can never widen the selection past the filtered list (even after `--`).
  const specs = kept.map(literalPathspec)
  // 2026-10-06~08 실사고(40시간 · 슬롯 191회 정지): 추적 중인 `_bmad-output/planning-artifacts/epics.md` 가 무시 폴더(info/exclude) 안에
  // 있어 `git add -A -- <그 경로>` 가 「paths are ignored」로 non-zero 종료 → 나머지는 staged 로 남고 커밋 없이 끝나 다음 슬롯마다 refresh 가
  // 거부했다. 추적 파일은 이미 저장소에 있으므로 `-f` 로 스테이징한다. 미추적 파일은 `-f` 없이 — status 는 무시된 미추적 파일을 애초에
  // 나열하지 않으므로 `-f` 가 새 무시 파일을 끌어들이지 않는다. 빈 목록으로 add 를 부르면 트리 전체가 스테이징되므로 건너뛴다.
  const ls = git(['ls-files', '-z', '--', ...specs])
  if (ls.status !== 0) return { failed: `ls-files: ${gitError(ls)}`, denied }
  const trackedSet = new Set((ls.stdout ?? '').split('\0').filter(Boolean))
  const trackedSpecs = kept.filter((p) => trackedSet.has(p.replaceAll('\\', '/'))).map(literalPathspec)
  const untrackedSpecs = specs.filter((s) => !trackedSpecs.includes(s))
  // 성공 판정은 exit code 만 본다 — LF/CRLF 같은 warning 은 stderr 에 나와도 실패가 아니다(보고 문구에서만 걸러 낸다).
  for (const [flags, list] of [[['-A', '-f'], trackedSpecs], [['-A'], untrackedSpecs]]) {
    if (!list.length) continue
    const add = git(['add', ...flags, '--', ...list])
    if (add.status !== 0) { git(['reset', '-q', '--', ...specs]); return { failed: `add: ${gitError(add)}`, denied } }
  }
  const staged = git(['diff', '--cached', '--unified=0', '--', ...specs])
  const secrets = secretHits(staged.stdout ?? '')
  if (secrets.length) {
    git(['reset', '-q', '--', ...specs])
    return { failed: `secret pattern in leftovers (${secrets.length}) — left uncommitted for a human`, secrets: secrets.length, denied }
  }
  const message = `chore(batch): STOP 잔여물 보존 — ${label || '(배치)'}${exitCode == null ? '' : ` (exit ${exitCode})`} · 워커가 본 트리에 남긴 미완 변경 ${kept.length}건${engineTracked.length ? ` · 엔진 사본 변경 ${engineTracked.length}건 되돌림(patch 보존)` : ''} · 다음 라운드/사람 검토 대상`
  const commit = git(['-c', 'core.editor=true', 'commit', '-q', '-m', message, '--', ...specs])
  if (commit.status !== 0) { git(['reset', '-q', '--', ...specs]); return { failed: `commit: ${gitError(commit)}`, denied } }
  const head = (git(['rev-parse', 'HEAD']).stdout ?? '').trim()
  return { committed: head, entries: kept.length, denied, message, engineReverted: engineTracked.length, enginePatch }
}

/** 실패 보고용 git 오류 문장 — `warning:`·`hint:` 줄(LF/CRLF 경고 등)은 빼고 실제 오류만 남긴다. 판정 근거는 아니다(exit code 가 판정).
 *  종료 코드·spawn 오류는 항상 붙인다 — 2026-10-08 12:29 실사고는 stderr 가 비어 「add: 」만 남아 원인을 추적할 수 없었다. */
function gitError(r) {
  const lines = String(r.stderr || r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const real = lines.filter((l) => !/^(warning|hint):/i.test(l))
  const why = `exit ${r.status ?? 'null'}${r.signal ? ` signal ${r.signal}` : ''}${r.error ? ` error ${r.error.code ?? r.error.message}` : ''}`
  return [(real.length ? real : lines).join(' / '), `(${why})`].filter(Boolean).join(' ')
}

/** `git status --porcelain=v1 -z` → 경로 목록. rename/copy 레코드(`R  new\0old\0` · 대상 → 원본 순 — git-status 문서)는
 *  두 필드를 소비하고 **둘 다** 돌려준다(원본의 삭제도 같이 스테이징돼야 rename 이 절반만 실리지 않는다 — Sol-high 14차 M2). */
export function parsePorcelainZ(stdout) {
  const fields = String(stdout ?? '').split('\0')
  const out = []
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]
    if (!rec) continue
    const xy = rec.slice(0, 2)
    const path = rec.slice(3)
    if (path) out.push(path)
    if (/[RC]/.test(xy)) { const src = fields[i + 1]; if (src) out.push(src); i++ }
  }
  return out
}

/** git 에 되돌려 주는 pathspec 은 항상 리터럴이다 — glob(`*`·`[]`)·매직(`:(top)` 등)이 든 파일 이름이 선택 범위를 넓히지 못한다. */
export const literalPathspec = (p) => `:(literal)${p}`
