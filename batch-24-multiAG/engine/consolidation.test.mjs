import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { selectStories, checkManualDependencies } from './finish-stories.mjs';
import { asfCandidates } from './asf-resolve.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const sprint = 'development_status:\n  4-1-a: review\n  4-2-b: done\n  4-3-c: backlog\n  4-3-c: in-progress\n  4-4-d: backlog\n';
test('manual normal range resolves real keys, skips done and deduplicates sprint rows', () => {
  assert.deepEqual(selectStories(sprint, { from: '4-1', to: '4-4' }), ['4-1-a', '4-3-c', '4-4-d']);
  assert.deepEqual(selectStories(sprint, { stories: '4-3,4-3,4-1' }), ['4-3-c', '4-1-a']);
});
test('manual failure and boundary: unknown/reversed range and all-done', () => {
  assert.throws(() => selectStories(sprint, { from: '5-1' }), /unknown/);
  assert.throws(() => selectStories(sprint, { from: '4-4', to: '4-1' }), /range/);
  assert.deepEqual(selectStories(sprint, { from: '4-2' }), []);
  assert.throws(() => asfCandidates('../escape.mjs'), /invalid/);
});
test('installation normal: pinned runtime works after legacy globals disappear; config and queue survive force', { timeout: 180000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'batch-canonical-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(join(project, 'tools/auto'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"canonical-smoke","scripts":{}}');
  const config = { project: 'canonical-smoke', stateDir: join(root, 'state'), epicOrder: [4], schema: 'night-batch-ops/config/1' };
  const queue = '{"batches":[{"stories":["4-1-a"]}]}\n';
  writeFileSync(join(project, 'tools/auto/auto.config.json'), JSON.stringify(config));
  writeFileSync(join(project, 'tools/auto/night-queue.json'), queue);
  const env = { ...process.env, HOME: home, USERPROFILE: home, AUTO_BATCH_STATE_DIR: config.stateDir };
  delete env.NODE_TEST_CONTEXT; delete env.AUTO_STORY_RUNTIME;
  const run = args => spawnSync(process.execPath, args, { cwd: project, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const install = run([join(HERE, '../install.mjs'), '--force']);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(project, 'tools/auto/auto.config.json'))), config);
  assert.equal(readFileSync(join(project, 'tools/auto/night-queue.json'), 'utf8'), queue);
  for (const provider of ['.claude', '.codex']) {
    const global = join(home, provider, 'skills'); mkdirSync(global, { recursive: true });
    cpSync(join(HERE, '..'), join(global, 'batch-24-multiAG'), { recursive: true });
    for (const old of ['auto-story-finish', 'night-batch-ops']) { const p = join(global, old); mkdirSync(p); rmSync(p, { recursive: true }); assert.equal(existsSync(p), false); }
    assert.ok(readFileSync(join(global, 'batch-24-multiAG/SKILL.md'), 'utf8').includes('Story 4-1'));
  }
  const imported = run(['--input-type=module', '-e', "const r=await import('./tools/auto/asf-resolve.mjs'); const q=await import(r.resolveAsf('quality-gates.mjs')); console.log(q.QUALITY_SCHEMA)"]);
  assert.equal(imported.status, 0, imported.stderr); assert.match(imported.stdout, /batch-24-multiag\/quality\/1/);
  assert.ok(existsSync(join(project, 'tools/auto/adapters/vitest-quality.mjs')));
  assert.equal(readFileSync(join(project, 'tools/auto/adapters/vitest-quality.mjs'), 'utf8'), readFileSync(join(HERE, '../adapters/vitest-quality.mjs'), 'utf8'));
  assert.equal(existsSync(join(project, 'quality-adapter.config.json')), false, 'installer must not invent project test scope');
  assert.ok(existsSync(join(project, 'tools/auto/model-routing.test.mjs')));
  assert.ok(existsSync(join(project, 'tools/auto/runtime/quality-gates.test.mjs')));
  const routing = run(['--test', 'tools/auto/model-routing.test.mjs']); assert.equal(routing.status, 0, routing.stdout + routing.stderr);
});

test('manual dependency normal ordering, failure external dependency, boundary done predecessor', () => {
  assert.deepEqual(checkManualDependencies(sprint, ['4-1-a', '4-3-c'], { '4-3-c': 'Depends-On: 4-1' }), ['4-1-a', '4-3-c']);
  assert.throws(() => checkManualDependencies(sprint, ['4-3-c'], { '4-3-c': 'Depends-On: 4-1' }), /unresolved/);
  assert.deepEqual(checkManualDependencies(sprint, ['4-3-c'], { '4-3-c': 'Depends-On: 4-2' }), ['4-3-c']);
});
