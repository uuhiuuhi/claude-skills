import { existsSync, readFileSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const MODES = ['affected', 'all', 'integration', 'api', 'authorization', 'security', 'performance'];
const EXTERNAL = ['api', 'authorization', 'security', 'performance'];
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const CODE = /\.(?:[cm]?[jt]sx?|sql|py|go|rs|java|kt|cs|rb|php|vue|svelte)$/i;
const JS = /\.[cm]?[jt]sx?$/i;
const DEFAULT_UNIT_EXCLUDE = ['tests/db/**', 'tests/integration/**', '**/*.sql', '**/node_modules/**'];
const normalize = value => value.replace(/\\/g, '/');

export function inside(root, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('invalid project path');
  const path = resolve(root, value);
  const rel = relative(resolve(root), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('path must stay inside project');
  // Follow existing parents, including symlinks/junctions, before permitting report writes.
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  const actualRoot = realpathSync(root);
  const actual = realpathSync(parent);
  const actualRel = relative(actualRoot, actual);
  if (actualRel.startsWith('..') || isAbsolute(actualRel)) throw new Error('symlink escapes project');
  return path;
}

const strings = (value, label, required = false) => {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && !value.length) || value.some(v => typeof v !== 'string' || !v.trim())) throw new Error(`invalid ${label}`);
  return value;
};

export function readConfig(root) {
  const file = inside(root, 'quality-adapter.config.json');
  if (!existsSync(file)) throw new Error('missing quality-adapter.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of ['unit', 'integration']) {
    if (!config[name]) continue;
    strings(config[name].include, `${name}.include`, true);
    strings(config[name].exclude, `${name}.exclude`);
    for (const pattern of [...config[name].include, ...(config[name].exclude ?? [])]) {
      if (isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || normalize(pattern).split('/').includes('..')) throw new Error('test patterns must stay inside project');
    }
  }
  strings(config.integration?.requiredEnv, 'integration.requiredEnv');
  for (const key of config.integration?.requiredEnv ?? []) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) throw new Error('requiredEnv must contain environment variable names');
  }
  strings(config.unsupportedSourcePrefixes, 'unsupportedSourcePrefixes');
  return config;
}

export function parseChanged(root, env) {
  if (!env.BATCH_BASE) throw new Error('missing BATCH_BASE');
  const git = spawnSync('git', ['rev-parse', '--verify', `${env.BATCH_BASE}^{commit}`], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (git.status !== 0) throw new Error('BATCH_BASE is not a local commit');
  let changed;
  try { changed = JSON.parse(env.BATCH_CHANGED_FILES); } catch { throw new Error('invalid BATCH_CHANGED_FILES JSON'); }
  strings(changed, 'BATCH_CHANGED_FILES', true);
  return [...new Set(changed.map(file => normalize(relative(root, inside(root, file)))))];
}

export function dependencyInfo(root) {
  const require = createRequire(resolve(root, 'package.json'));
  const result = {};
  for (const name of ['vitest', '@vitest/coverage-v8']) {
    try { result[name] = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version; }
    catch { result[name] = null; }
  }
  return result;
}

export function capabilities(root, config, env = process.env, dependencies = dependencyInfo(root)) {
  const vitest4 = /^4\./.test(dependencies.vitest ?? '');
  const coverage = vitest4 && dependencies['@vitest/coverage-v8'] === dependencies.vitest;
  const result = {
    schema: 'batch-24-multiag/vitest-capabilities/1',
    verified: false,
    dependencies,
    capabilities: {
      affected: { available: Boolean(config.unit && coverage), reason: !config.unit ? 'unit scope missing' : !coverage ? 'Vitest 4 and matching coverage-v8 required' : 'dependency mapping and real LCOV verified during execution' },
      all: { available: Boolean(config.unit && vitest4), reason: 'configured unit scope only; no DB integration claim' },
      integration: { available: Boolean(config.integration && vitest4 && config.integration.requiredEnv?.length && config.integration.requiredEnv.every(key => env[key]?.trim())), reason: 'requires declared environment names; execution rejects skipped tests', missingEnv: (config.integration?.requiredEnv ?? []).filter(key => !env[key]?.trim()) },
    },
    limitations: ['SQL and non-JavaScript executable coverage unsupported', 'HTTP authorization reports are not synthesized from RLS zero-row responses'],
  };
  for (const mode of EXTERNAL) {
    let available = false;
    try { available = typeof config.adapters?.[mode] === 'string' && statSync(inside(root, config.adapters[mode])).isFile(); } catch { /* invalid adapter paths remain unavailable */ }
    result.capabilities[mode] = { available, reason: available ? 'project adapter declared; runtime evidence still required' : 'unsupported: real project adapter missing' };
  }
  return result;
}

export function assertRunEvidence(modules, errors = [], reason = 'passed', strictSkip = false) {
  if (errors.length || reason !== 'passed') throw new Error('Vitest failed or reported unhandled errors');
  if (strictSkip && modules.some(module => typeof module.state === 'function' && module.state() !== 'passed')) throw new Error('skipped or failed integration module');
  const tests = modules.flatMap(module => [...module.children.allTests()]);
  if (!modules.length || !tests.length) throw new Error('zero tests executed');
  let passed = 0;
  for (const test of tests) {
    const state = test.result().state;
    if (state === 'passed') passed++;
    else if (state === 'failed' || (strictSkip && state !== 'passed')) throw new Error('failed, skipped, pending, or todo tests are not integration evidence');
  }
  if (!passed) throw new Error('zero passing tests');
  return { passed, total: tests.length };
}

export async function selectAffected(ctx, root, changed, config) {
  const unsupported = changed.filter(file => CODE.test(file) && (!JS.test(file) || (config.unsupportedSourcePrefixes ?? []).some(prefix => file.startsWith(prefix))));
  if (unsupported.length) throw new Error(`unsupported executable coverage: ${unsupported.join(', ')}`);
  const relevant = changed.filter(file => CODE.test(file));
  if (!relevant.length) throw new Error('no changed JavaScript source or tests to map');
  const selected = new Map();
  const previous = ctx.config.related;
  try {
    for (const file of relevant) {
      ctx.config.related = [normalize(resolve(root, file))];
      const specs = await ctx.getRelevantTestSpecifications();
      if (!specs.length) throw new Error(`unmapped changed file: ${file}`);
      for (const spec of specs) selected.set(`${spec.project.name ?? ''}:\0${spec.moduleId}`, spec);
    }
  } finally { ctx.config.related = previous; }
  if (!selected.size) throw new Error('zero affected tests');
  return [...selected.values()];
}

export async function runAdapter({ root = process.cwd(), mode = 'affected', env = process.env, required = [], createVitest: injectedCreateVitest, dependencies } = {}) {
  root = realpathSync(root);
  const config = readConfig(root);
  const capability = capabilities(root, config, env, dependencies);
  if (mode === 'capability') {
    for (const name of required) {
      if (!MODES.includes(name) || !capability.capabilities[name].available) throw new Error(`capability unavailable: ${name}`);
    }
    return capability;
  }
  if (!MODES.includes(mode)) throw new Error('unknown adapter mode');
  if (!capability.capabilities[mode].available) throw new Error(`${mode}: ${capability.capabilities[mode].reason}`);
  if (EXTERNAL.includes(mode)) {
    const childEnv = { ...env }; delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [inside(root, config.adapters[mode])], { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true, timeout: config.timeoutMs ?? 1_200_000 });
    if (result.status !== 0 || result.error) throw new Error(`${mode} project adapter failed`);
    return { mode, delegated: true }; // Gate engine validates API/auth freshness and actual report contents.
  }

  const affected = mode === 'affected';
  const scope = mode === 'integration' ? config.integration : config.unit;
  const changed = affected ? parseChanged(root, env) : [];
  const lcov = affected ? inside(root, env.BATCH_LCOV_REPORT ?? 'coverage/lcov.info') : null;
  if (lcov && basename(lcov) !== 'lcov.info') throw new Error('BATCH_LCOV_REPORT must end with lcov.info');
  // Never ask Vitest to recursively clean a user-selected report directory.
  if (lcov) { mkdirSync(dirname(lcov), { recursive: true }); if (existsSync(lcov)) rmSync(lcov); }
  let evidence;
  const reporter = {
    onTestRunEnd(modules, errors, reason) {
      evidence = assertRunEvidence(modules, errors, reason, mode === 'integration');
    },
  };
  const options = {
    root, watch: false, run: true, passWithNoTests: false, allowOnly: false, update: false,
    include: scope.include,
    exclude: [...new Set([...(scope.exclude ?? []), ...(mode === 'integration' ? ['**/node_modules/**'] : DEFAULT_UNIT_EXCLUDE)])],
    reporters: ['verbose', reporter],
    forceRerunTriggers: [],
    // Do not mutate source config thresholds or clean arbitrary directories.
    coverage: affected ? { enabled: true, provider: 'v8', reporter: ['lcov'], reportsDirectory: dirname(lcov), clean: false, cleanOnRerun: false, include: changed.filter(file => JS.test(file) && !TEST.test(file)), exclude: [], thresholds: { autoUpdate: false } } : { enabled: false },
  };
  const createVitest = injectedCreateVitest ?? (await import(pathToFileURL(createRequire(resolve(root, 'package.json')).resolve('vitest/node')).href)).createVitest;
  let ctx;
  try {
    ctx = await createVitest('test', options);
    if (affected) {
      const specs = await selectAffected(ctx, root, changed, config);
      // standalone initializes coverage and reporters before the public run API.
      await ctx.standalone();
      await ctx.runTestSpecifications(specs, false);
    } else await ctx.start();
    if (!evidence) throw new Error('missing Vitest execution evidence');
    if (lcov && (!existsSync(lcov) || !/^(?:SF:|TN:)/m.test(readFileSync(lcov, 'utf8')))) throw new Error('fresh LCOV missing');
    return { mode, ...evidence, ...(lcov ? { lcov: normalize(relative(root, lcov)) } : {}) };
  } finally { await ctx?.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = process.argv[2] ?? 'affected';
  const requiredAt = process.argv.indexOf('--require');
  const required = requiredAt >= 0 ? (process.argv[requiredAt + 1] ?? '').split(',').filter(Boolean) : [];
  try { console.log(JSON.stringify(await runAdapter({ mode: arg, required }))); }
  catch (error) { console.error(`quality adapter not-verified: ${error.message}`); process.exitCode = 1; }
}

