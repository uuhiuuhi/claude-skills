import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assertReviewedRuntime, assertIncomingToolingStable } from './runtime-pin.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'runtime-pin-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Runtime Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(cwd, 'tools/auto'), { recursive: true });
  writeFileSync(join(cwd, 'tools/auto/engine.mjs'), 'export const version = 1;\n');
  writeFileSync(join(cwd, 'app.txt'), 'baseline\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  return { cwd, toolingDir: 'tools/auto', git, base: git('rev-parse', 'HEAD') };
}
function commitFile(f, path, content, message) {
  writeFileSync(join(f.cwd, path), content);
  f.git('add', path); f.git('commit', '-qm', message);
  return f.git('rev-parse', 'HEAD');
}

test('required missing and malformed pins fail; optional absence remains backwards compatible', () => {
  assert.deepEqual(assertReviewedRuntime({}), { checked: false, reason: 'runtime pin not configured' });
  assert.throws(() => assertReviewedRuntime({ required: true }), /missing/);
  assert.throws(() => assertReviewedRuntime({ commit: 'HEAD' }), /malformed/);
  assert.throws(() => assertReviewedRuntime({ commit: 'a'.repeat(39) }), /malformed/);
});

test('reviewed pin must remain an ancestor and tooling descendants or dirty edits fail', t => {
  const f = fixture(t);
  const pin = commitFile(f, 'tools/auto/engine.mjs', 'export const version = 2;\n', 'reviewed tooling');
  const input = { cwd: f.cwd, toolingDir: f.toolingDir, commit: pin, required: true };
  assert.equal(assertReviewedRuntime(input).checked, true);
  f.git('checkout', '--detach', f.base);
  assert.throws(() => assertReviewedRuntime(input), /not an ancestor/);
  f.git('checkout', '--detach', pin);
  commitFile(f, 'tools/auto/engine.mjs', 'export const version = 3;\n', 'unreviewed tooling');
  assert.throws(() => assertReviewedRuntime(input), /differs/);
  f.git('checkout', '--detach', pin);
  writeFileSync(join(f.cwd, 'tools/auto/engine.mjs'), 'export const version = 4;\n');
  assert.throws(() => assertReviewedRuntime(input), /differs/);
  f.git('add', 'tools/auto/engine.mjs');
  assert.throws(() => assertReviewedRuntime(input), /differs/);
});

test('application-only descendants and dirty app changes preserve the reviewed runtime', t => {
  const f = fixture(t);
  commitFile(f, 'app.txt', 'new app\n', 'app update');
  writeFileSync(join(f.cwd, 'app.txt'), 'dirty app\n');
  assert.equal(assertReviewedRuntime({ cwd: f.cwd, toolingDir: f.toolingDir, commit: f.base, required: true }).checked, true);
});

test('incoming app change is allowed with older remote tooling; incoming tooling change is blocked', t => {
  const f = fixture(t);
  const local = commitFile(f, 'tools/auto/engine.mjs', 'export const version = 2;\n', 'local reviewed tooling');
  f.git('checkout', '-qb', 'incoming', f.base);
  const remoteApp = commitFile(f, 'app.txt', 'remote app\n', 'remote application update');
  f.git('update-ref', 'refs/remotes/origin/main', remoteApp);
  f.git('checkout', '--detach', local);
  const allowed = assertIncomingToolingStable({ cwd: f.cwd, toolingDir: f.toolingDir });
  assert.equal(allowed.mergeBase, f.base);
  f.git('checkout', 'incoming');
  const remoteTool = commitFile(f, 'tools/auto/engine.mjs', 'export const version = 9;\n', 'remote tooling update');
  f.git('update-ref', 'refs/remotes/origin/main', remoteTool);
  f.git('checkout', '--detach', local);
  assert.throws(() => assertIncomingToolingStable({ cwd: f.cwd, toolingDir: f.toolingDir }), /incoming branch changes tooling/);
});

test('git launch failures, invalid status and containment errors fail closed', () => {
  const cwd = tmpdir();
  const input = { cwd, toolingDir: 'tools/auto', commit: 'a'.repeat(40), required: true };
  for (const failure of [{ error: new Error('spawn failed'), status: null }, { status: 128 }, { status: null }, { status: 0, stdout: 'not a commit' }]) {
    assert.throws(() => assertReviewedRuntime({ ...input, runGit: () => failure }), /verification failed|did not resolve/);
  }
  let calls = 0;
  assert.throws(() => assertReviewedRuntime({ ...input, runGit: () => ++calls === 1 ? { status: 0, stdout: 'a'.repeat(40) } : { status: 2 } }), /verification failed/);
  assert.throws(() => assertReviewedRuntime({ ...input, toolingDir: '../outside' }), /inside cwd/);
  assert.throws(() => assertIncomingToolingStable({ cwd, toolingDir: 'tools/auto', ref: '--evil' }), /invalid/);
});


test('run-night pre-merge wiring refuses incoming tooling before merge can execute', t => {
  const f = fixture(t);
  const local = commitFile(f, 'tools/auto/engine.mjs', 'export const version = 2;\n', 'reviewed runtime');
  f.git('checkout', '-qb', 'remote-incoming', f.base);
  const incoming = commitFile(f, 'tools/auto/engine.mjs', 'export const version = 8;\n', 'unreviewed incoming runtime');
  f.git('update-ref', 'refs/remotes/origin/main', incoming);
  f.git('checkout', '--detach', local);
  const context = operationalContext(f, local);
  let merges = 0;
  context.BRANCH = 'auto/test';
  context.loadState = () => ({ day: {}, save() {} });
  context.spawnSync = (_file, args) => {
    if (args.includes('merge')) { merges++; return { status: 0 }; }
    if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'auto/test' };
    if (args.includes('rev-list')) return { status: 0, stdout: '1' };
    return { status: 0, stdout: '' };
  };
  const source = runnerFunction('assertOperationalRuntime') + '\n' + runnerFunction('doDownSync') + '\ndoDownSync()';
  assert.throws(() => runInNewContext(source, context), /incoming branch changes tooling/);
  assert.equal(merges, 0);
});

test('run-night post-sync and sequential/parallel child boundaries stop changed tooling', async t => {
  const f = fixture(t);
  const context = operationalContext(f, f.base);
  context.doDownSync = () => {
    writeFileSync(join(f.cwd, 'tools/auto/engine.mjs'), 'export const version = 99;\n');
    return { ok: true, note: null };
  };
  let planned = 0;
  context.selectQueue = async () => { planned++; return null; };
  const runner = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const from = runner.indexOf('  const ds = doDownSync()');
  const to = runner.indexOf('  if (!sel) break', from);
  assert.ok(from > 0 && to > from, 'actual post-sync runner boundary must exist');
  await assert.rejects(runInNewContext(runnerFunction('assertOperationalRuntime') + '\n(async()=>{for(;;){' + runner.slice(from,to) + '\nbreak}})()', context), /differs/);
  assert.equal(planned, 0);
  let spawned = 0;
  context.spawn = context.spawnSync = () => { spawned++; return {}; };
  context.process.execPath = process.execPath;
  context.args = [];
  context.wt = { dir: f.cwd };
  context.engineArgsFor = () => [];
  context.WORKTREE_ENV = {};
  for (const anchor of ['    const child = spawn(process.execPath', '    const run = spawnSync(process.execPath, args,']) {
    const pos = runner.indexOf(anchor);
    const start = runner.lastIndexOf('    assertOperationalRuntime()', pos);
    const end = runner.indexOf('\n', pos);
    assert.ok(pos > start && pos - start < 60, 'guard must immediately precede actual child spawn');
    assert.throws(() => runInNewContext(runnerFunction('assertOperationalRuntime') + '\n' + runner.slice(start,end), context), /differs/);
  }
  assert.equal(spawned, 0);
});

function runnerFunction(name) {
  const runner = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = runner.indexOf('function ' + name + '(');
  const end = runner.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'actual runner function must exist: ' + name);
  return runner.slice(start, end + 2).replaceAll('import.meta.dirname', 'TOOLING_DIR');
}
function operationalContext(f, pin) {
  const state = join(f.cwd, '.state');
  mkdirSync(state);
  writeFileSync(join(state, 'runtime-pin.json'), JSON.stringify({ schema: 'batch-24-multiag/runtime-pin/1', commit: pin }));
  writeFileSync(join(f.cwd, '.auto-batch-worktree'), '');
  return {
    STATE_DIR: state, TOOLING_DIR: join(f.cwd, 'tools/auto'), CFG: { runtimePin: { required: true } }, dryRun: false,
    join, resolve: (...args) => resolve(f.cwd, ...args), existsSync, readFileSync,
    readRecord: JSON.parse, process: { cwd: () => f.cwd }, console: { log() {} },
    assertReviewedRuntime, assertIncomingToolingStable,
  };
}


test('actual parallel pool rejects a guard failure and cleans only never-started worktrees', { timeout: 3000 }, async t => {
  const context = parallelPoolContext({ failAt: 1, t });
  await assert.rejects(runInNewContext(context.code, context.vm), /reviewed runtime changed/);
  assert.equal(context.counts.spawned, 0);
  assert.deepEqual(context.counts.cleaned, ['1-1', '1-2', '1-3']);
  assert.equal(context.dirs.some(existsSync), false, 'actual cleanup removes never-started directories');
});

test('actual parallel pool drains running workers, stops rescheduling and preserves their output on rejection', { timeout: 3000 }, async t => {
  const context = parallelPoolContext({ failAt: 2, t });
  await assert.rejects(runInNewContext(context.code, context.vm), /reviewed runtime changed/);
  assert.equal(context.counts.spawned, 1);
  assert.equal(context.counts.completed, 1, 'cleanup waits for the already running worker');
  assert.deepEqual(context.counts.cleaned, ['1-2', '1-3'], 'started worker output remains available for recovery');
  assert.equal(readFileSync(join(context.dirs[0], 'output.txt'), 'utf8'), 'retained worker evidence');
  assert.equal(context.dirs.slice(1).some(existsSync), false);
});

function parallelPoolContext({ failAt, t }) {
  const source = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  const runOne = (wt) => new Promise');
  const end = source.indexOf('  // landing —', start);
  const cleanupStart = source.indexOf('  const cleanup = ');
  const cleanupEnd = source.indexOf('  for (let i = 0; i < storyList.length;', cleanupStart);
  assert.ok(start >= 0 && end > start && cleanupStart >= 0 && cleanupEnd > cleanupStart, 'extract actual cleanup, runOne and outer pool');
  const root = mkdtempSync(join(tmpdir(), 'parallel-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = ['1-1', '1-2', '1-3'].map(story => join(root, story));
  for (const dir of dirs) { mkdirSync(dir); writeFileSync(join(dir, 'output.txt'), 'retained worker evidence'); }
  const counts = { checked: 0, spawned: 0, completed: 0, cleaned: [] };
  const vm = {
    wts: ['1-1', '1-2', '1-3'].map((story, i) => ({ story, dir: dirs[i], devProvider: 'claude' })),
    caps: { total: 2 }, laneLabel: 'DEV', WORKTREE_ENV: {}, process: { execPath: process.execPath },
    console: { log() {} },
    assertOperationalRuntime() { if (++counts.checked >= failAt) throw new Error('reviewed runtime changed'); },
    engineArgsFor: () => [],
    spawn() {
      counts.spawned++;
      const child = new EventEmitter();
      setTimeout(() => { counts.completed++; child.emit('close', 0); }, 20);
      return child;
    },
    pickRunnable(pending, running, caps) { return pending.slice(0, Math.max(0, caps.total - running.length)); },
    readWorktreeTimeline: () => [], readExitInfo: () => null, blockedProviderFromExit: () => null,
    blocked: [], reassign() {}, record() {},
    existsSync, rmSync,
    spawnSync(_file, args) {
      if (args[0] === 'worktree' && args[1] === 'remove') counts.cleaned.push(args[3].split(/[\\/]/).at(-1));
      return { status: 0 }; // Leave the fixture directory for actual cleanup's filesystem fallback.
    },
  };
  return { counts, dirs, vm, code: '(async()=>{\n' + source.slice(cleanupStart, cleanupEnd) + source.slice(start, end) + '\n})()' };
}

test('pin input boundary: missing revision stdout stops before ancestry or diff checks', () => {
  const commit = 'a'.repeat(40);
  const calls = [];
  const runGit = (file, args) => {
    calls.push({ file, args });
    return { status: 0 };
  };
  assert.throws(() => assertReviewedRuntime({ cwd: tmpdir(), toolingDir: 'tools/auto', commit, required: true, runGit }), /runtime pin revision did not resolve to a commit/);
  assert.deepEqual(calls, [{ file: 'git', args: ['--literal-pathspecs', 'rev-parse', '--verify', `${commit}^{commit}`] }], 'no ancestry or diff command follows a missing revision');
});

test('pin input boundary: missing or malformed merge base stops before any tooling diff', () => {
  const incoming = 'b'.repeat(40);
  for (const mergeBaseResult of [{ status: 0 }, { status: 0, stdout: 'not-a-commit\n' }]) {
    const calls = [];
    const runGit = (file, args) => {
      calls.push({ file, args });
      if (args[1] === 'rev-parse') return { status: 0, stdout: incoming + '\n' };
      if (args[1] === 'merge-base') return mergeBaseResult;
      assert.fail('tooling diff must not run with an unavailable merge base');
    };
    assert.throws(() => assertIncomingToolingStable({ cwd: tmpdir(), toolingDir: 'tools/auto', runGit }), /runtime pin merge base unavailable/);
    assert.deepEqual(calls, [
      { file: 'git', args: ['--literal-pathspecs', 'rev-parse', '--verify', 'origin/main^{commit}'] },
      { file: 'git', args: ['--literal-pathspecs', 'merge-base', 'HEAD', incoming] },
    ]);
  }
});

test('pin input boundary: missing or empty paths fail before Git is called', () => {
  for (const paths of [
    { toolingDir: 'tools/auto' },
    { cwd: '', toolingDir: 'tools/auto' },
    { cwd: tmpdir() },
    { cwd: tmpdir(), toolingDir: '' },
  ]) {
    let calls = 0;
    const runGit = () => { calls++; return { status: 0, stdout: 'c'.repeat(40) }; };
    assert.throws(() => assertReviewedRuntime({ ...paths, commit: 'c'.repeat(40), required: true, runGit }), /runtime pin requires cwd and toolingDir/);
    assert.throws(() => assertIncomingToolingStable({ ...paths, runGit }), /runtime pin requires cwd and toolingDir/);
    assert.equal(calls, 0, 'path validation must precede every Git subprocess');
  }
});
