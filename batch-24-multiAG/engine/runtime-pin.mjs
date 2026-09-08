import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';

function toolingPath(cwd, toolingDir) {
  if (typeof cwd !== 'string' || !cwd || typeof toolingDir !== 'string' || !toolingDir) throw new Error('runtime pin requires cwd and toolingDir');
  const path = relative(resolve(cwd), resolve(cwd, toolingDir)).replace(/\\/g, '/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('toolingDir must stay inside cwd');
  return path;
}

function git(cwd, args, runGit, allowed = [0]) {
  const result = runGit('git', ['--literal-pathspecs', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (!result || result.error || result.signal || !Number.isInteger(result.status) || !allowed.includes(result.status)) {
    throw new Error(`runtime pin git verification failed: ${args[0]}`);
  }
  return result;
}

function revision(cwd, ref, runGit) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('invalid runtime pin revision');
  const commit = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], runGit).stdout?.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit ?? '')) throw new Error('runtime pin revision did not resolve to a commit');
  return commit;
}

/** Verify the reviewed commit remains an ancestor and tracked tooling is identical,
 * including staged and unstaged edits. Untracked files are outside this contract. */
export function assertReviewedRuntime({ cwd, toolingDir, commit, required = false, runGit = spawnSync } = {}) {
  if (commit === undefined || commit === null || commit === '') {
    if (required) throw new Error('required reviewed runtime pin missing');
    return { checked: false, reason: 'runtime pin not configured' };
  }
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) throw new Error('malformed reviewed runtime pin');
  const path = toolingPath(cwd, toolingDir);
  const pin = revision(cwd, commit, runGit);
  const ancestor = git(cwd, ['merge-base', '--is-ancestor', pin, 'HEAD'], runGit, [0, 1]);
  if (ancestor.status !== 0) throw new Error('reviewed runtime pin is not an ancestor of HEAD');
  const diff = git(cwd, ['diff', '--no-ext-diff', '--quiet', pin, '--', path], runGit, [0, 1]);
  if (diff.status !== 0) throw new Error('tracked tooling differs from reviewed runtime pin');
  return { checked: true, commit: pin, toolingPath: path };
}

/** Check only changes introduced on the incoming branch since the merge base.
 * A remote branch whose tooling is older than local reviewed tooling is allowed. */
export function assertIncomingToolingStable({ cwd, ref = 'origin/main', toolingDir, runGit = spawnSync } = {}) {
  const path = toolingPath(cwd, toolingDir);
  const incoming = revision(cwd, ref, runGit);
  const base = git(cwd, ['merge-base', 'HEAD', incoming], runGit).stdout?.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base ?? '')) throw new Error('runtime pin merge base unavailable');
  const diff = git(cwd, ['diff', '--no-ext-diff', '--quiet', base, incoming, '--', path], runGit, [0, 1]);
  if (diff.status !== 0) throw new Error('incoming branch changes tooling; reviewed runtime restart required');
  return { checked: true, incoming, mergeBase: base, toolingPath: path };
}

