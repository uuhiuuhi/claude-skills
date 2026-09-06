import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inside, readConfig, capabilities, assertRunEvidence, selectAffected, runAdapter } from './vitest-quality.mjs';

const dependencies = { vitest: '4.1.10', '@vitest/coverage-v8': '4.1.10' };
const adapter = fileURLToPath(new URL('./vitest-quality.mjs', import.meta.url));
function fixture(t, config = { unit: { include: ['tests/**/*.test.js'] } }) {
  const root = mkdtempSync(join(tmpdir(), 'vitest-quality-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'quality-adapter.config.json'), JSON.stringify(config));
  return root;
}
function modules(...states) {
  return [{ children: { *allTests() { for (const state of states) yield { result: () => ({ state }) }; } } }];
}

test('capability checks dependencies without claiming execution and never leaks environment values', t => {
  const root = fixture(t);
  const config = { unit: { include: ['tests/*.js'] }, integration: { include: ['tests/db/*.js'], requiredEnv: ['QA_PASSWORD', 'QA_EMAIL'] } };
  const result = capabilities(root, config, { QA_PASSWORD: 'do-not-print-this' }, dependencies);
  assert.equal(result.verified, false);
  assert.equal(result.capabilities.affected.available, true);
  assert.equal(result.capabilities.integration.available, false);
  assert.deepEqual(result.capabilities.integration.missingEnv, ['QA_EMAIL']);
  assert.equal(JSON.stringify(result).includes('do-not-print-this'), false);
  for (const mode of ['api', 'authorization', 'security', 'performance']) assert.equal(result.capabilities[mode].available, false);
  assert.equal(capabilities(root, config, {}, { ...dependencies, '@vitest/coverage-v8': '4.1.9' }).capabilities.affected.available, false);
});

test('path containment rejects traversal and a junction escaping the project', t => {
  const root = fixture(t);
  assert.throws(() => inside(root, '../lcov.info'), /inside project/);
  assert.throws(() => inside(root, root), /inside project/);
  const outside = mkdtempSync(join(tmpdir(), 'quality-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inside(root, 'escape/lcov.info'), /symlink escapes/);
});

test('configuration requires explicit test scope and environment variable names', t => {
  const root = fixture(t, { unit: { include: [] } });
  assert.throws(() => readConfig(root), /unit.include/);
  writeFileSync(join(root, 'quality-adapter.config.json'), JSON.stringify({ integration: { include: ['tests/db/**'], requiredEnv: ['QA_PASSWORD=secret'] } }));
  assert.throws(() => readConfig(root), /environment variable names/);
});

test('execution evidence rejects no tests, errors, interrupted run and strict integration skips', () => {
  assert.throws(() => assertRunEvidence([]), /zero tests/);
  assert.throws(() => assertRunEvidence(modules('skipped')), /zero passing/);
  assert.throws(() => assertRunEvidence(modules('passed'), [{}]), /unhandled/);
  assert.throws(() => assertRunEvidence(modules('passed'), [], 'interrupted'), /failed/);
  assert.throws(() => assertRunEvidence(modules('passed', 'skipped'), [], 'passed', true), /skipped/);
  assert.deepEqual(assertRunEvidence(modules('passed', 'skipped')), { passed: 1, total: 2 });
});

test('affected selection maps each source through Vitest and deduplicates shared tests', async t => {
  const root = fixture(t);
  const spec = { project: { name: 'unit' }, moduleId: join(root, 'tests/foo.test.js') };
  const seen = [];
  const ctx = { config: { related: undefined }, async getRelevantTestSpecifications() { seen.push(this.config.related[0]); return [spec]; } };
  const result = await selectAffected(ctx, root, ['src/foo.js', 'tests/foo.test.js'], {});
  assert.deepEqual(result, [spec]);
  assert.equal(seen.length, 2);
  assert.equal(ctx.config.related, undefined);
  ctx.getRelevantTestSpecifications = async () => [];
  await assert.rejects(selectAffected(ctx, root, ['src/orphan.js'], {}), /unmapped/);
  await assert.rejects(selectAffected(ctx, root, ['supabase/migrations/change.sql'], {}), /unsupported executable coverage/);
  await assert.rejects(selectAffected(ctx, root, ['functions/index.ts'], { unsupportedSourcePrefixes: ['functions/'] }), /unsupported/);
});

test('missing coverage and missing integration environment stop before loading Vitest', async t => {
  const root = fixture(t, { unit: { include: ['tests/**'] }, integration: { include: ['tests/db/**'], requiredEnv: ['QA_PASSWORD'] } });
  const noLoad = async () => { assert.fail('must not load Vitest'); };
  await assert.rejects(runAdapter({ root, createVitest: noLoad, dependencies: { vitest: '4.1.10', '@vitest/coverage-v8': null } }), /matching coverage/);
  await assert.rejects(runAdapter({ root, mode: 'integration', env: {}, createVitest: noLoad, dependencies }), /requires declared environment/);
  await assert.rejects(runAdapter({ root, mode: 'authorization', dependencies }), /unsupported/);
  await assert.rejects(runAdapter({ root, mode: 'capability', required: ['api'], dependencies }), /capability unavailable/);
});

test('a stale LCOV cannot be accepted after a run that writes no coverage', async t => {
  const root = fixture(t);
  spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root, windowsHide: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/foo.js'), 'export const foo = 1');
  mkdirSync(join(root, 'coverage'));
  writeFileSync(join(root, 'coverage/lcov.info'), 'SF:src/foo.js\nDA:1,1\nend_of_record\n');
  let runs = 0;
  let closed = false;
  const createVitest = async (_mode, options) => ({
    config: {},
    async getRelevantTestSpecifications() { return [{ project: {}, moduleId: join(root, 'tests/foo.test.js') }]; },
    async standalone() {},
    async runTestSpecifications() { runs++; options.reporters[1].onTestRunEnd(modules('passed'), [], 'passed'); },
    async close() { closed = true; },
  });
  await assert.rejects(runAdapter({ root, dependencies, createVitest, env: { BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: '["src/foo.js"]' } }), /fresh LCOV missing/);
  assert.equal(runs, 1);
  assert.equal(closed, true);
  assert.equal(existsSync(join(root, 'coverage/lcov.info')), false);
});

const nodeModules = process.env.VITEST_QUALITY_TEST_NODE_MODULES;
function realFixture(t, config) {
  const root = fixture(t, config);
  symlinkSync(resolve(nodeModules), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(root, 'tests/db'), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'vite.config.js'), 'export default { test: { include: ["tests/**/*.test.js"] } }');
  writeFileSync(join(root, 'src/math.js'), 'export const double = n => n * 2;\n');
  writeFileSync(join(root, 'tests/math.test.js'), 'import { test, expect } from "vitest"; import { double } from "../src/math.js"; test("real mapping and assertion",()=>expect(double(2)).toBe(4));\n');
  return root;
}
function cli(root, mode, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [adapter, mode], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
}

test('real Vitest all excludes DB while strict integration rejects its skipped test', { skip: !nodeModules }, t => {
  const root = realFixture(t, { unit: { include: ['tests/**/*.test.js'] }, integration: { include: ['tests/db/**/*.test.js'], requiredEnv: ['QA_LOCAL_FIXTURE'] } });
  writeFileSync(join(root, 'tests/db/live.test.js'), 'import { test, expect } from "vitest"; test.skip("unavailable DB",()=>expect(true).toBe(true));');
  const unit = cli(root, 'all');
  assert.equal(unit.status, 0, unit.stdout + unit.stderr);
  assert.match(unit.stdout, /real mapping and assertion/);
  assert.doesNotMatch(unit.stdout, /unavailable DB/);
  const integration = cli(root, 'integration', { QA_LOCAL_FIXTURE: 'local-only' });
  assert.notEqual(integration.status, 0);
  assert.match(integration.stderr + integration.stdout, /skipped|zero passing|not-verified/);
});

test('real Vitest related runs the affected test once and creates actual LCOV', { skip: !nodeModules || !existsSync(join(nodeModules ?? '', '@vitest/coverage-v8/package.json')) }, t => {
  const root = realFixture(t, { unit: { include: ['tests/**/*.test.js'] } });
  const commands = [
    ['init', '-q'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'],
  ];
  for (const args of commands) assert.equal(spawnSync('git', args, { cwd: root, windowsHide: true }).status, 0);
  writeFileSync(join(root, 'tests/unrelated.test.js'), 'throw new Error("unrelated test must not execute")');
  const result = cli(root, 'affected', { BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: '["src/math.js","tests/math.test.js"]', BATCH_LCOV_REPORT: join(root, 'coverage/lcov.info') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lcov = readFileSync(join(root, 'coverage/lcov.info'), 'utf8');
  assert.match(lcov.replace(/\\/g, '/'), /SF:src\/math.js/);
  assert.match(lcov, /DA:1,1/);
  assert.match(result.stdout, /"passed":1/);
  t.diagnostic('real affected fixture: one test executed once; LCOV source math.js LF=1 LH=1 (100%)');
});

