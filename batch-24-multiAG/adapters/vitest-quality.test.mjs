import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inside, readConfig, capabilities, assertRunEvidence, selectAffected, runAdapter, validateSkipPolicy, evaluateSkip, withProjectEnvFile, loadTypeScript, analyzeSource, resolvesImport } from './vitest-quality.mjs';

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

test('declared integration environment resolves from the project env file after the process environment, without leaking values', t => {
  const root = fixture(t);
  const config = { unit: { include: ['tests/*.js'] }, integration: { include: ['tests/db/*.js'], requiredEnv: ['QA_URL', 'QA_KEY', 'QA_FLAG'] } };
  assert.equal(capabilities(root, config, {}, dependencies).capabilities.integration.available, false);
  writeFileSync(join(root, '.env.local'), ['# comment', 'export QA_URL="https://example.invalid" ', "QA_KEY='do-not-print-this'", 'QA_FLAG=1 # inline comment', 'QA_EMPTY=', ''].join('\n'));
  const merged = withProjectEnvFile(root, config, { QA_FLAG: 'process-wins', QA_URL: '', QA_KEY: '   ' });
  // Exactly `process.env.X || fromFile.X`: a set value wins, an empty value falls back, a whitespace-only value is kept
  // (truthy for `||`) and therefore reads as absent/unarmed downstream — never silently replaced by the file value.
  assert.deepEqual([merged.QA_URL, merged.QA_KEY, merged.QA_FLAG, merged.QA_EMPTY], ['https://example.invalid', '   ', 'process-wins', '']);
  assert.equal(capabilities(root, config, { QA_KEY: '   ' }, dependencies).capabilities.integration.available, false);
  const result = capabilities(root, config, {}, dependencies);
  assert.equal(result.capabilities.integration.available, true);
  assert.equal(JSON.stringify(result).includes('do-not-print-this'), false);
  assert.deepEqual(capabilities(root, { ...config, integration: { ...config.integration, requiredEnv: ['QA_URL', 'QA_EMPTY'] } }, {}, dependencies).capabilities.integration.missingEnv, ['QA_EMPTY']);
  assert.throws(() => withProjectEnvFile(root, { integration: { envFile: '../outside.env' } }, {}), /file name in the project root/);
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

// ---- reviewed integration skip policy (2026-09-06) ----
const POLICY = (entries) => ({ schema: 'batch-24-multiag/skip-policy/1', reviewedOn: '2026-09-06', reviewedBy: 'fixture', entries });
const optionalEntry = (over = {}) => ({ file: 'tests/db/live.test.js', test: 'unarmed probe', category: 'optional-not-applicable', kind: 'armed-write-probe', rationale: 'writes rows; runs only when armed', evidence: { envNotArmed: 'QA_PROBE_ARMED' }, ...over });
function fakeModules(root, specs) {
  return specs.map(({ file, tests }) => ({
    moduleId: join(root, file),
    state: () => 'passed',
    children: { *allTests() { for (const t of tests) yield { module: { moduleId: join(root, file) }, fullName: t.name, name: t.name, options: { mode: t.mode ?? 'run' }, result: () => ({ state: t.state, note: t.note }) }; } },
  }));
}

test('skip policy validation: schema, category, evidence, duplicates and environment names are enforced', { skip: !nodeModules }, t => {
  const root = realFixture(t); // typescript (for AST binding checks) comes from the real dependency tree
  // Environment evidence must be bound to the test's own gating code: an actual lookup (process.env.NAME …) in the test
  // file or in a module the test imports — parsed as an AST, so comments, strings, regex literals, JSON or unrelated
  // files never count.
  writeFileSync(join(root, 'tests/db/live.test.js'), [
    "import { armed } from './client.js'",
    "// import './stranger.js'  (commented import must not count)",
    '// process.env.QA_COMMENT_LOOKUP  (commented lookup must not count)',
    'const text = "process.env.QA_STRING_LOOKUP"  // lookup inside a string must not count',
    'const re = /process.env.QA_REGEX_LOOKUP/g  // lookup inside a regex literal must not count',
    'if (text) /process.env.QA_IF_REGEX/.test(text)  // regex after a control condition must not count',
    "const other = settings['QA_BRACKET_OTHER']  // bracket access on another object must not count",
    "const bracket = process.env['QA_BRACKET_ENV']  // bracket access on process.env counts",
    'const ratio = 4 / process.env.QA_DIVISION / 2  // division stays code',
    'const gate = process.env.QA_PROBE_ARMED',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'tests/db/client.js'), 'export const armed = () => process.env.QA_SHARED_FLAG;\n');
  writeFileSync(join(root, 'tests/db/stranger.js'), 'export const other = () => process.env.QA_STRANGER_FLAG;\n');
  for (const name of ['QA_BRACKET_ENV', 'QA_DIVISION']) assert.equal(validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: name } })])).entries.length, 1, name);
  for (const name of ['QA_COMMENT_LOOKUP', 'QA_STRING_LOOKUP', 'QA_REGEX_LOOKUP', 'QA_IF_REGEX', 'QA_BRACKET_OTHER']) assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: name } })])), new RegExp(`never looks up ${name}`), name);
  writeFileSync(join(root, 'tests/db/broken.test.js'), 'const x = ;\n');
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ file: 'tests/db/broken.test.js' })])), /does not parse/);
  const ok = POLICY([optionalEntry(), { file: 'tests/db/live.test.js', test: 'required one', category: 'required-missing', kind: 'stale-static-skip', rationale: 'QA account exists; test still it.skip' }]);
  assert.equal(validateSkipPolicy(root, ok), ok);
  assert.equal(validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: 'QA_SHARED_FLAG', envSource: 'tests/db/client.js' } })])).entries.length, 1);
  assert.throws(() => validateSkipPolicy(root, { ...ok, schema: 'other' }), /schema/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ category: 'waived' })])), /category/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: {} })])), /evidence/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: 'BAD=1' } })])), /environment variables/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: 'QA_COMMENT_ONLY' } })])), /never looks up QA_COMMENT_ONLY/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: 'QA_UNRELATED' } })])), /never looks up QA_UNRELATED/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: 'QA_STRANGER_FLAG', envSource: 'tests/db/stranger.js' } })])), /does not import tests\/db\/stranger\.js/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envNotArmed: 'QA_PROBE_ARMED', envSource: 'quality-adapter.config.json' } })])), /must be a JavaScript\/TypeScript module/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { envMissing: ['QA_SHARED_FLAG'], envSource: 'tests/db/missing.js' } })])), /envSource does not exist/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { documented: { reference: 'a real document' } } })])), /documentation alone/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { documented: {} } })])), /documentation alone/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ evidence: { coveredBy: { file: 'src/not-a-test.js', test: 'x' } } })])), /coveredBy.file must be a test file/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry(), optionalEntry()])), /duplicate/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ rationale: '' })])), /rationale/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ file: '../outside.test.js' })])), /inside project/);
  assert.throws(() => validateSkipPolicy(root, POLICY([optionalEntry({ file: 'src/not-a-test.js' })])), /not a test file/);
  writeFileSync(join(root, 'quality-adapter.config.json'), JSON.stringify({ unit: { include: ['tests/**'] }, integration: { include: ['tests/db/**'], requiredEnv: ['QA_X'], skipPolicy: { schema: 'nope' } } }));
  assert.throws(() => readConfig(root), /schema/);
});

test('skip decisions: unlisted, required, unknown change scope, affected module, stale evidence all block; only proven optional skips are approved', () => {
  const policy = POLICY([
    optionalEntry(),
    optionalEntry({ test: 'covered duplicate', kind: 'duplicate', evidence: { coveredBy: { file: 'tests/db/anon.test.js', test: 'anon baseline' } } }),
    optionalEntry({ test: 'fixture env', kind: 'fixture-env', evidence: { envMissing: ['QA_SECRET_ID'] }, note: 'no vault item' }),
    { file: 'tests/db/live.test.js', test: 'required one', category: 'required-missing', kind: 'stale-static-skip', rationale: 'QA account exists; test still it.skip' },
  ]);
  // Vitest reports `suite > … > name`; a covering test may be named by its own name or its full name.
  const scope = (files = [], reasons = []) => ({ modules: new Set(files), all: reasons.length > 0, reasons });
  const ctx = (over = {}) => ({ env: {}, passed: new Set(['tests/db/anon.test.js\0anon suite > anon baseline']), affected: scope(), ...over });
  const at = (name, over = {}) => ({ file: 'tests/db/live.test.js', name, state: 'skipped', ...over });
  assert.equal(evaluateSkip(at('unarmed probe'), policy, ctx()).verdict, 'approved');
  assert.match(evaluateSkip(at('nobody listed'), policy, ctx()).reason, /unclassified/);
  assert.match(evaluateSkip(at('required one'), policy, ctx()).reason, /required-missing/);
  assert.match(evaluateSkip(at('unarmed probe'), policy, ctx({ affected: null })).reason, /change scope unknown/);
  assert.match(evaluateSkip(at('unarmed probe'), policy, ctx({ affected: scope(['tests/db/live.test.js']) })).reason, /affected by the change/);
  assert.match(evaluateSkip(at('unarmed probe'), policy, ctx({ affected: scope([], ['non-JavaScript change cannot be mapped: supabase/migrations/x.sql']) })).reason, /cannot be mapped to integration modules \(non-JavaScript change cannot be mapped: supabase\/migrations\/x\.sql\)/);
  // Arming follows the project's probes: any non-empty value except '0'/'false' arms — 'off', 'no', '00' are armed.
  for (const value of ['1', 'true', 'yes', 'on', 'off', 'no', '00', ' x ']) assert.match(evaluateSkip(at('unarmed probe'), policy, ctx({ env: { QA_PROBE_ARMED: value } })).reason, /is armed/, value);
  for (const value of ['0', 'false', 'FALSE', '', '  ']) assert.equal(evaluateSkip(at('unarmed probe'), policy, ctx({ env: { QA_PROBE_ARMED: value } })).verdict, 'approved', value);
  assert.equal(evaluateSkip(at('covered duplicate'), policy, ctx()).verdict, 'approved');
  assert.match(evaluateSkip(at('covered duplicate'), policy, ctx({ passed: new Set() })).reason, /covering test did not pass/);
  assert.match(evaluateSkip(at('fixture env', { note: 'no vault item provisioned' }), policy, ctx({ env: { QA_SECRET_ID: 'x' } })).reason, /environment provides QA_SECRET_ID/);
  assert.match(evaluateSkip(at('fixture env', { note: 'different' }), policy, ctx()).reason, /note does not match/);
  assert.equal(evaluateSkip(at('fixture env', { note: 'no vault item provisioned' }), policy, ctx()).verdict, 'approved');
  assert.match(evaluateSkip(at('unarmed probe', { state: 'failed' }), policy, ctx()).reason, /failed/);
});

test('execution evidence with a policy tolerates only approved optional skips and reports both lists exactly', t => {
  const root = fixture(t);
  const policy = { ...POLICY([optionalEntry(), { file: 'tests/db/live.test.js', test: 'required one', category: 'required-missing', kind: 'fixture-missing', rationale: 'needs a second QA account' }]), root, env: {}, affected: { modules: new Set(), all: false, reasons: [] } };
  const good = fakeModules(root, [{ file: 'tests/db/live.test.js', tests: [{ name: 'runs', state: 'passed' }, { name: 'unarmed probe', state: 'skipped', mode: 'skip' }] }]);
  const result = assertRunEvidence(good, [], 'passed', true, policy);
  assert.deepEqual({ passed: result.passed, total: result.total, approved: result.skipped.approvedOptional.length, blocking: result.skipped.blocking.length }, { passed: 1, total: 2, approved: 1, blocking: 0 });
  assert.equal(result.skipped.approvedOptional[0].kind, 'armed-write-probe');
  const bad = fakeModules(root, [{ file: 'tests/db/live.test.js', tests: [{ name: 'runs', state: 'passed' }, { name: 'unarmed probe', state: 'skipped' }, { name: 'required one', state: 'skipped' }, { name: 'stranger', state: 'skipped' }] }]);
  assert.throws(() => assertRunEvidence(bad, [], 'passed', true, policy), error => {
    assert.match(error.message, /2 skipped integration test\(s\) block landing \(approved optional skips: 1\)/);
    assert.deepEqual(error.skipped.blocking.map(b => b.test), ['required one', 'stranger']);
    assert.match(error.skipped.blocking[0].reason, /required-missing: needs a second QA account/);
    assert.match(error.skipped.blocking[1].reason, /unclassified/);
    return true;
  });
  // Without a policy the strict behaviour is unchanged.
  assert.throws(() => assertRunEvidence(good, [], 'passed', true), /skipped/);
  assert.deepEqual(assertRunEvidence(good, [], 'passed', false), { passed: 1, total: 2 });
});

test('real Vitest integration with a reviewed policy: approved optional skip lands only with change scope and outside affected modules', { skip: !nodeModules }, t => {
  const policy = POLICY([
    { file: 'tests/db/live.test.js', test: 'unarmed write probe', category: 'optional-not-applicable', kind: 'armed-write-probe', rationale: 'creates rows; runs only when QA_LOCAL_PROBE_ARMED=1', evidence: { envNotArmed: 'QA_LOCAL_PROBE_ARMED' } },
  ]);
  const root = realFixture(t, { unit: { include: ['tests/**/*.test.js'] }, integration: { include: ['tests/db/**/*.test.js'], requiredEnv: ['QA_LOCAL_FIXTURE'], skipPolicy: policy } });
  // node_modules is a junction into a real dependency tree — never `git add .` it (output floods maxBuffer and kills the child).
  writeFileSync(join(root, '.gitignore'), 'node_modules\ncoverage\n');
  for (const args of [['init', '-q'], ['add', '.gitignore', 'package.json', 'quality-adapter.config.json', 'vite.config.js', 'src', 'tests'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
  // The probe's own file references its arming variable (policy validation binds env evidence to the gating code).
  writeFileSync(join(root, 'tests/db/live.test.js'), 'import { test, expect } from "vitest"; const armed = process.env.QA_LOCAL_PROBE_ARMED; test("live read",()=>expect(1).toBe(1)); test.skip("unarmed write probe",()=>expect(armed).toBe(undefined)); ');
  writeFileSync(join(root, 'tests/db/other.test.js'), 'import { test, expect } from "vitest"; test("other read",()=>expect(2).toBe(2)); test.skip("unlisted skip",()=>expect(true).toBe(true));');
  const base = { QA_LOCAL_FIXTURE: 'local-only' };
  // 1. no change scope → optional tolerance denied (fail closed) and the unlisted skip is named
  const noScope = cli(root, 'integration', base);
  assert.notEqual(noScope.status, 0);
  assert.match(noScope.stderr, /change scope unknown/);
  assert.match(noScope.stderr, /other\.test\.js > unlisted skip — unclassified/);
  // 2. change scope given but an unlisted skip still blocks; remove it and the approved skip is tolerated
  writeFileSync(join(root, 'tests/db/other.test.js'), 'import { test, expect } from "vitest"; test("other read",()=>expect(2).toBe(2));');
  const scoped = cli(root, 'integration', { ...base, BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: '["src/math.js"]' });
  assert.equal(scoped.status, 0, scoped.stdout + scoped.stderr);
  assert.match(scoped.stdout, /\[skip-policy\] approved optional skips[^\n]*: 1/);
  assert.match(scoped.stdout, /"approvedOptional":\[\{"file":"tests\/db\/live\.test\.js","test":"unarmed write probe"/);
  // 3. the probe becomes armed → it must run, so its skip blocks
  const armed = cli(root, 'integration', { ...base, BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: '["src/math.js"]', QA_LOCAL_PROBE_ARMED: '1' });
  assert.notEqual(armed.status, 0);
  assert.match(armed.stderr, /QA_LOCAL_PROBE_ARMED is armed/);
  // 4. the change touches the skipped test's own module → optional tolerance denied
  const affected = cli(root, 'integration', { ...base, BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: '["tests/db/live.test.js"]' });
  assert.notEqual(affected.status, 0);
  assert.match(affected.stderr, /affected by the change/);
  // 5. a non-JavaScript change (SQL migration, the policy file itself) cannot be mapped → all optional tolerance denied
  for (const file of ['supabase/migrations/20260906_security.sql', 'quality-adapter.config.json', 'package.json', 'tools/migrate/samples/billing/contracts.jsonl', 'tests/db/fixtures/rows.csv', 'docs/samples/contracts.jsonl', '_bmad-output/seed.json']) {
    const r = cli(root, 'integration', { ...base, BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: JSON.stringify(['src/math.js', file]) });
    assert.notEqual(r.status, 0, file);
    assert.match(r.stderr, /cannot be mapped to integration modules \(non-JavaScript change cannot be mapped: /, file);
  }
  // 6. a JavaScript change Vitest cannot map to any integration test → denied as well (impact cannot be established)
  const unmapped = cli(root, 'integration', { ...base, BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: '["src/orphan.js"]' });
  assert.notEqual(unmapped.status, 0);
  assert.match(unmapped.stderr, /unmapped changed file: src\/orphan\.js/);
  // 7. documents never widen or narrow the scope
  const docs = cli(root, 'integration', { ...base, BATCH_BASE: 'HEAD', BATCH_CHANGED_FILES: '["src/math.js","README.md","docs/notes.txt"]' });
  assert.equal(docs.status, 0, docs.stdout + docs.stderr);
});

test('AST binding: comments, strings and regular-expression literals never establish imports or environment lookups', { skip: !nodeModules }, t => {
  const root = realFixture(t);
  const ts = loadTypeScript(root);
  const src = [
    '// process.env.QA_C',
    '/* env.QA_B */',
    'const s = "process.env.QA_S"',
    "const t = 'x' // env.QA_T",
    'const ok = process.env.QA_OK',
    "const br = fromFile['QA_BR']",
    "const no = settings['QA_NO']",
    'const tpl = `env.QA_TPL ${1}`',
    'const re = /process.env.QA_RX/g',
    'const re2 = x.match(/env.QA_RX2["]/)',
    'if (ok) /process.env.QA_IF/.test(s)',
    'let n = 2; n++ / process.env.QA_POST / 2',
    'const o = {} / process.env.QA_OBJ / 2',
    'const d = total / process.env.QA_DIV / 2',
    'function f() { return /env.QA_RET/.test(s) }',
    '',
  ].join('\n');
  const { envNames, imports } = analyzeSource(ts, src, 'tests/db/x.test.ts');
  assert.deepEqual(['QA_OK', 'QA_BR', 'QA_POST', 'QA_OBJ', 'QA_DIV', 'QA_NO', 'QA_C', 'QA_B', 'QA_S', 'QA_T', 'QA_TPL', 'QA_RX', 'QA_RX2', 'QA_IF', 'QA_RET'].map(k => envNames.has(k)), [true, true, true, true, true, false, false, false, false, false, false, false, false, false, false]);
  assert.deepEqual(imports, []);
  const specs = text => analyzeSource(ts, text, 'tests/db/live.test.ts').imports;
  assert.deepEqual(specs([
    "import { a } from './client'",
    "export { b } from './other'",
    "const c = require('./c')",
    "const d = await import('./sub')",
    "import 'vitest'",
    "// import './commented'",
    'const re = /from "\\.\\/regex"/',
    'const str = "from \'./string\'"',
  ].join('\n')), ['./client', './other', './c', './sub', 'vitest']);
  assert.throws(() => analyzeSource(ts, 'const x = ;', 'tests/db/broken.test.ts'), /does not parse/);
  writeFileSync(join(root, 'tests/db/client.ts'), 'export const a = 1\n');
  const test = 'tests/db/live.test.ts';
  assert.equal(resolvesImport(['./client'], test, 'tests/db/client.ts', root), true);
  assert.equal(resolvesImport(['./client.js'], test, 'tests/db/client.ts', root), true, 'TypeScript ESM .js specifier resolves to the .ts file when no .js file exists');
  writeFileSync(join(root, 'tests/db/client.js'), 'export const a = 2\n');
  assert.equal(resolvesImport(['./client.js'], test, 'tests/db/client.ts', root), false, 'a real .js file at that path is a different module');
  assert.equal(resolvesImport(['./client.js'], test, 'tests/db/client.js', root), true);
  assert.equal(resolvesImport(['./sub'], test, 'tests/db/sub/index.ts', root), true);
  assert.equal(resolvesImport(['vitest', '../client'], test, 'tests/db/client.ts', root), false);
  // A non-source suffix (json/css/…) is a real module path, never an omitted extension.
  assert.equal(resolvesImport(['./client.json'], test, 'tests/db/client.json.ts', root), false);
  assert.equal(resolvesImport(['./client.json'], test, 'tests/db/client.json', root), true);
  assert.equal(resolvesImport(['./styles.css'], test, 'tests/db/styles.css.js', root), false);
});

test('a fully skipped module is classified test by test under a policy; a failed module still ends the run', t => {
  const root = fixture(t);
  const policy = { ...POLICY([optionalEntry()]), root, env: {}, affected: { modules: new Set(), all: false, reasons: [] } };
  const skippedModule = [{ moduleId: join(root, 'tests/db/live.test.js'), state: () => 'skipped', children: { *allTests() { yield { module: { moduleId: join(root, 'tests/db/live.test.js') }, fullName: 'unarmed probe', name: 'unarmed probe', options: { mode: 'skip' }, result: () => ({ state: 'skipped' }) }; } } }];
  const passing = fakeModules(root, [{ file: 'tests/db/other.test.js', tests: [{ name: 'runs', state: 'passed' }] }]);
  const result = assertRunEvidence([...passing, ...skippedModule], [], 'passed', true, policy);
  assert.deepEqual([result.passed, result.skipped.approvedOptional.length, result.skipped.blocking.length], [1, 1, 0]);
  assert.throws(() => assertRunEvidence([...passing, ...skippedModule], [], 'passed', true), /skipped or failed integration module/);
  const failedModule = [{ moduleId: join(root, 'tests/db/bad.test.js'), state: () => 'failed', children: { *allTests() {} } }];
  assert.throws(() => assertRunEvidence([...passing, ...failedModule], [], 'passed', true, policy), /failed integration module/);
});
