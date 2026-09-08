import { existsSync, readFileSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';
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
  if (config.integration?.skipPolicy !== undefined) validateSkipPolicy(root, config.integration.skipPolicy);
  return config;
}

// ---- integration skip policy (reviewed classification of every skipped integration test) ----
// Every skipped test in the integration scope is either `required-missing` (a check that must run — it keeps
// blocking landing) or `optional-not-applicable` (an approved optional check whose evidence proves it does not
// apply in this environment). Unlisted skips block. Optional tolerance additionally requires that the change under
// landing does not affect the skipped test's module. Nothing here deletes or hides a test.
export const SKIP_POLICY_SCHEMA = 'batch-24-multiag/skip-policy/1';
export const SKIP_CATEGORIES = ['required-missing', 'optional-not-applicable'];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/i;
const nonEmpty = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`skipPolicy: ${label} must be a non-empty string`); return value; };

export function validateSkipPolicy(root, policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('skipPolicy must be an object');
  if (policy.schema !== SKIP_POLICY_SCHEMA) throw new Error(`skipPolicy.schema must be ${SKIP_POLICY_SCHEMA}`);
  nonEmpty(policy.reviewedOn, 'reviewedOn'); nonEmpty(policy.reviewedBy, 'reviewedBy');
  if (!Array.isArray(policy.entries)) throw new Error('skipPolicy.entries must be an array');
  const seen = new Set();
  let ts; // TypeScript compiler API, loaded only when an entry carries environment evidence
  for (const entry of policy.entries) {
    if (!entry || typeof entry !== 'object') throw new Error('skipPolicy entry must be an object');
    const file = normalize(relative(root, inside(root, nonEmpty(entry.file, 'file'))));
    if (!TEST.test(file)) throw new Error(`skipPolicy: ${file} is not a test file`);
    const key = `${file}\0${nonEmpty(entry.test, 'test')}`;
    if (seen.has(key)) throw new Error(`skipPolicy: duplicate entry ${file} > ${entry.test}`);
    seen.add(key);
    if (!SKIP_CATEGORIES.includes(entry.category)) throw new Error(`skipPolicy: category must be one of ${SKIP_CATEGORIES.join('|')}`);
    nonEmpty(entry.kind, 'kind'); nonEmpty(entry.rationale, 'rationale');
    if (entry.note !== undefined) nonEmpty(entry.note, 'note');
    if (entry.category !== 'optional-not-applicable') continue;
    const evidence = entry.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error(`skipPolicy: optional entry needs evidence (${entry.test})`);
    // Only mechanically checkable evidence authorizes tolerance. `documented` is an annotation, never sufficient alone.
    const kinds = ['coveredBy', 'envMissing', 'envNotArmed'].filter(k => evidence[k] !== undefined);
    if (!kinds.length) throw new Error(`skipPolicy: optional entry needs coveredBy|envMissing|envNotArmed evidence — documentation alone cannot authorize a skip (${entry.test})`);
    if (evidence.coveredBy !== undefined) {
      const covered = evidence.coveredBy;
      if (!covered || typeof covered !== 'object') throw new Error('skipPolicy: coveredBy must be {file,test}');
      const coveredFile = normalize(relative(root, inside(root, nonEmpty(covered.file, 'coveredBy.file')))); nonEmpty(covered.test, 'coveredBy.test');
      if (!TEST.test(coveredFile)) throw new Error(`skipPolicy: coveredBy.file must be a test file (${covered.file})`);
    }
    // Environment evidence must be bound to the gating code of the test: the variable must be *looked up* (process.env.NAME
    // or an equivalent member/bracket access) in the skipped test's own file or in a JavaScript/TypeScript module that the
    // test file imports (`envSource`, e.g. a shared tests/db/client.ts helper). Configuration/JSON files never qualify.
    const envNames = [...(evidence.envMissing !== undefined ? strings(evidence.envMissing, 'evidence.envMissing', true) : []), ...(evidence.envNotArmed !== undefined ? [nonEmpty(evidence.envNotArmed, 'envNotArmed')] : [])];
    for (const key of envNames) if (!ENV_NAME.test(key)) throw new Error('skipPolicy: environment evidence must name environment variables');
    if (envNames.length) {
      const testPath = inside(root, file);
      if (!existsSync(testPath)) throw new Error(`skipPolicy: test file does not exist (${file})`);
      const sourceRel = evidence.envSource !== undefined ? normalize(relative(root, inside(root, nonEmpty(evidence.envSource, 'envSource')))) : file;
      if (!JS.test(sourceRel)) throw new Error(`skipPolicy: envSource must be a JavaScript/TypeScript module (${sourceRel})`);
      const sourcePath = inside(root, sourceRel);
      if (!existsSync(sourcePath)) throw new Error(`skipPolicy: envSource does not exist (${sourceRel})`);
      ts ??= loadTypeScript(root);
      if (sourceRel !== file && !resolvesImport(analyzeSource(ts, readFileSync(testPath, 'utf8'), file).imports, file, sourceRel, root)) throw new Error(`skipPolicy: ${file} does not import ${sourceRel} — envSource must be a module the skipped test actually uses (${entry.test})`);
      const lookups = analyzeSource(ts, readFileSync(sourcePath, 'utf8'), sourceRel).envNames;
      for (const key of envNames) if (!lookups.has(key)) throw new Error(`skipPolicy: ${sourceRel} never looks up ${key} (process.env.${key} or equivalent) — environment evidence must be bound to the test's own gating code (${entry.test})`);
    }
    if (evidence.documented !== undefined) {
      if (!evidence.documented || typeof evidence.documented !== 'object') throw new Error('skipPolicy: documented must be {reference}');
      nonEmpty(evidence.documented.reference, 'documented.reference');
    }
  }
  return policy;
}

/** Load the TypeScript compiler API from the project (or, failing that, from the adapter's own installation). Binding
 * validation parses real ASTs instead of pattern-matching text, so comments, strings and regular-expression literals can
 * never look like an import or an environment lookup, and TypeScript syntax in the project's tests is understood.
 * Missing TypeScript is fail-closed: environment evidence cannot be validated. */
export function loadTypeScript(root) {
  for (const base of [resolve(root, 'package.json'), import.meta.url]) {
    try { return createRequire(base)('typescript'); } catch { /* try the next location */ }
  }
  throw new Error('skipPolicy: the typescript package is required to validate environment evidence bindings (install it in the project)');
}

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Parse one JavaScript/TypeScript source with the TypeScript parser and collect
 *  - `imports`: module specifiers of `import … from`, `export … from`, `import(…)` and `require(…)` (string literals only);
 *  - `envNames`: variable names looked up through `process.env.NAME`, `process.env['NAME']`, `env.NAME`, `env['NAME']`,
 *    `fromFile.NAME` or `fromFile['NAME']`.
 * A source that does not parse cleanly is rejected (fail closed). */
export function analyzeSource(ts, text, fileName) {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?ts$/i.test(fileName) ? ts.ScriptKind.TS : /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length) throw new Error(`skipPolicy: ${fileName} does not parse (${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' ')}) — evidence cannot be validated`);
  const imports = [], envNames = new Set();
  const isEnvObject = node => (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process' && node.name.text === 'env')
    || (ts.isIdentifier(node) && (node.text === 'env' || node.text === 'fromFile'));
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const callee = node.expression, first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first) && ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword)) imports.push(first.text);
    }
    if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression)) envNames.add(node.name.text);
    if (ts.isElementAccessExpression(node) && isEnvObject(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) envNames.add(node.argumentExpression.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, envNames };
}

/** Does one of the parsed import specifiers of the test file (project path `testFile`) resolve to the module at project path
 * `moduleRel`? Relative specifiers only. An omitted extension resolves against the source-extension list and `/index.<ext>`;
 * a TypeScript-ESM `.js`/`.jsx`/`.mjs`/`.cjs` specifier resolves to the `.ts`/`.tsx`/`.mts`/`.cts` module only when no real
 * `.js` file exists at that path (checked against `root`). */
export function resolvesImport(imports, testFile, moduleRel, root = null) {
  const dir = dirname(testFile);
  const target = normalize(moduleRel);
  const jsToTs = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' };
  for (const spec of imports) {
    if (typeof spec !== 'string' || !spec.startsWith('.')) continue;
    const candidate = normalize(join(dir, spec)).replace(/^\.\//, '');
    const last = candidate.slice(candidate.lastIndexOf('/') + 1);
    const anyExt = /\.[^.]+$/.exec(last)?.[0]?.toLowerCase() ?? ''; // any suffix (json, css, …) — never treated as omitted
    const ext = /\.[cm]?[jt]sx?$/i.exec(candidate)?.[0]?.toLowerCase() ?? '';
    if (ext) {
      if (candidate === target) return true;
      const mapped = jsToTs[ext];
      if (mapped && candidate.slice(0, -ext.length) + mapped === target && !(root && existsSync(resolve(root, candidate)))) return true;
      continue;
    }
    if (anyExt) { if (candidate === target) return true; continue; } // non-source module (json/css/…): exact path only
    for (const e of SOURCE_EXT) if (`${candidate}${e}` === target || `${candidate}/index${e}` === target) return true;
  }
  return false;
}

const testFile = (root, test) => normalize(relative(root, test.module?.moduleId ?? ''));
const testName = test => test.fullName ?? test.name ?? '';
// Same arming rule as the project's own probes (tests/db/client.ts): any non-empty value except '0'/'false' arms.
const armed = value => { const flag = typeof value === 'string' ? value.trim().toLowerCase() : ''; return flag !== '' && flag !== '0' && flag !== 'false'; };

/** A covering test is named by file + its own name or its full `suite > … > name`; either must have passed in this run. */
const coveringPassed = (passed, { file, test }) => {
  const prefix = `${normalize(file)}\0`;
  for (const key of passed) if (key.startsWith(prefix)) { const name = key.slice(prefix.length); if (name === test || name.endsWith(` > ${test}`)) return true; }
  return false;
};

/** Decide one skipped test against the policy. Returns { verdict: 'approved' | 'blocking', reason, entry }. */
export function evaluateSkip({ file, name, note, state }, policy, { env = {}, passed = new Set(), affected = null } = {}) {
  const entry = policy?.entries?.find(e => normalize(e.file) === file && e.test === name) ?? null;
  const block = reason => ({ verdict: 'blocking', reason, entry });
  if (state === 'failed') return block('failed');
  if (!entry) return block('unclassified: no reviewed classification for this skipped test');
  if (entry.category !== 'optional-not-applicable') return block(`${entry.category}: ${entry.rationale}`);
  if (affected === null) return block('optional-not-applicable but change scope unknown (BATCH_BASE/BATCH_CHANGED_FILES missing) — optional tolerance applies only to landing runs');
  if (affected.all) return block(`optional-not-applicable but the landing change cannot be mapped to integration modules (${affected.reasons.join('; ')}) — optional tolerance denied`);
  if (affected.modules.has(file)) return block('optional-not-applicable but its module is affected by the change under landing');
  if (entry.note !== undefined && !(typeof note === 'string' && note.includes(entry.note))) return block(`skip note does not match the reviewed note (${entry.note})`);
  const ev = entry.evidence ?? {};
  if (ev.coveredBy !== undefined && !coveringPassed(passed, ev.coveredBy)) return block(`covering test did not pass in this run: ${ev.coveredBy.file} > ${ev.coveredBy.test}`);
  if (ev.envMissing !== undefined) { const present = ev.envMissing.filter(key => env[key]?.trim()); if (present.length) return block(`environment provides ${present.join(', ')} — the test should run`); }
  if (ev.envNotArmed !== undefined && armed(env[ev.envNotArmed])) return block(`${ev.envNotArmed} is armed — the probe should run`);
  return { verdict: 'approved', reason: `${entry.kind}: ${entry.rationale}`, entry };
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

/** The project's own integration tests read `.env.local` themselves (Vitest `test` mode does not auto-load it), so the
 * declared environment names are resolved the same way: process environment first, then the project env file
 * (`integration.envFile`, default `.env.local`). Values are never printed; only presence is inspected. */
export function withProjectEnvFile(root, config, env = process.env) {
  const name = config?.integration?.envFile ?? '.env.local';
  if (typeof name !== 'string' || !name.trim() || name.includes('/') || name.includes('\\')) throw new Error('integration.envFile must be a file name in the project root');
  const file = inside(root, name);
  if (!existsSync(file)) return { ...env };
  const fromFile = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '').trim();
    fromFile[m[1]] = value;
  }
  // Exactly the project's precedence (`process.env.X || fromFile.X`): only an undefined/empty process value falls back to the
  // file; a whitespace-only process value is kept (JavaScript `||` treats it as truthy) and later reads as unarmed/absent.
  const merged = { ...env };
  for (const [key, value] of Object.entries(fromFile)) if (!merged[key]) merged[key] = value;
  return merged;
}

export function capabilities(root, config, env = process.env, dependencies = dependencyInfo(root)) {
  env = withProjectEnvFile(root, config, env);
  const vitest4 = /^4\./.test(dependencies.vitest ?? '');
  const coverage = vitest4 && dependencies['@vitest/coverage-v8'] === dependencies.vitest;
  const result = {
    schema: 'batch-24-multiag/vitest-capabilities/1',
    verified: false,
    dependencies,
    capabilities: {
      affected: { available: Boolean(config.unit && coverage), reason: !config.unit ? 'unit scope missing' : !coverage ? 'Vitest 4 and matching coverage-v8 required' : 'dependency mapping and real LCOV verified during execution' },
      all: { available: Boolean(config.unit && vitest4), reason: 'configured unit scope only; no DB integration claim' },
      integration: { available: Boolean(config.integration && vitest4 && config.integration.requiredEnv?.length && config.integration.requiredEnv.every(key => env[key]?.trim())), reason: 'requires declared environment names; execution rejects failed tests and every mandatory, unclassified or unproven skip (only reviewed optional skips with live evidence are tolerated and reported separately)', missingEnv: (config.integration?.requiredEnv ?? []).filter(key => !env[key]?.trim()) },
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

export function assertRunEvidence(modules, errors = [], reason = 'passed', strictSkip = false, policy = null) {
  if (errors.length || reason !== 'passed') throw new Error('Vitest failed or reported unhandled errors');
  // Without a policy any non-passed module (skipped or failed) ends the strict run. With a policy a failed module still
  // ends it, while a fully skipped module is classified test by test like any other skip (documented per-test tolerance).
  if (strictSkip && modules.some(module => typeof module.state === 'function' && (policy ? module.state() === 'failed' : module.state() !== 'passed'))) throw new Error(policy ? 'failed integration module' : 'skipped or failed integration module');
  const tests = modules.flatMap(module => [...module.children.allTests()]);
  if (!modules.length || !tests.length) throw new Error('zero tests executed');
  let passed = 0;
  const passedSet = new Set(), notPassed = [];
  for (const test of tests) {
    const state = test.result().state;
    if (state === 'passed') { passed++; if (policy) passedSet.add(`${testFile(policy.root, test)}\0${testName(test)}`); }
    else if (state === 'failed' || (strictSkip && !policy && state !== 'passed')) throw new Error('failed, skipped, pending, or todo tests are not integration evidence');
    else if (strictSkip) notPassed.push(test);
  }
  if (!passed) throw new Error('zero passing tests');
  if (!strictSkip || !policy) return { passed, total: tests.length };
  // Reviewed skip policy: each non-passing test is classified; only approved optional checks that provably do not
  // apply here (and are not touched by the change) are tolerated. Everything else blocks with its exact reason.
  const approvedOptional = [], blocking = [];
  for (const test of notPassed) {
    const file = testFile(policy.root, test), name = testName(test), result = test.result();
    const decision = evaluateSkip({ file, name, note: result.note, state: result.state }, policy, { env: policy.env, passed: passedSet, affected: policy.affected });
    const item = { file, test: name, state: result.state, mode: test.options?.mode, reason: decision.reason, kind: decision.entry?.kind ?? null };
    (decision.verdict === 'approved' ? approvedOptional : blocking).push(item);
  }
  const skipped = { approvedOptional, blocking, policy: { schema: policy.schema, reviewedOn: policy.reviewedOn, reviewedBy: policy.reviewedBy, entries: policy.entries.length } };
  if (blocking.length) {
    const error = new Error(`${blocking.length} skipped integration test(s) block landing (approved optional skips: ${approvedOptional.length}): ${blocking.map(b => `${b.file} > ${b.test} — ${b.reason}`).join(' | ')}`);
    error.skipped = skipped;
    throw error;
  }
  return { passed, total: tests.length, skipped };
}

/** Change scope for optional-skip tolerance — used only to deny tolerance, never to select tests. Fail closed:
 *  - documents/images are ignored by extension only (never by directory — a data file under docs/ is still data);
 *  - a changed test file affects itself;
 *  - a changed JavaScript/TypeScript file affects the integration modules Vitest maps to it; a file Vitest cannot map
 *    denies all tolerance (`all`), because its integration impact cannot be established;
 *  - any other executable or configuration change (SQL migrations, supabase/**, package/lock files, the policy file
 *    itself, tool configuration, …) denies all tolerance. */
// Documents and images only. Data files (csv/jsonl/json/sql/…) are test inputs or configuration and stay fail-closed.
const DOC_CHANGE = /\.(?:md|markdown|txt|rst|png|jpe?g|gif|svg|webp|ico|pdf)$/i;
export async function affectedModules(ctx, root, changed) {
  const modules = new Set(), reasons = [];
  const previous = ctx.config.related;
  try {
    for (const raw of changed) {
      const file = normalize(raw);
      if (DOC_CHANGE.test(file)) continue; // by extension only — a data file under docs/ is still data
      if (TEST.test(file)) { modules.add(file); continue; }
      if (!JS.test(file)) { reasons.push(`non-JavaScript change cannot be mapped: ${file}`); continue; }
      ctx.config.related = [normalize(resolve(root, file))];
      const specs = await ctx.getRelevantTestSpecifications();
      if (!specs.length) { reasons.push(`unmapped changed file: ${file}`); continue; }
      for (const spec of specs) modules.add(normalize(relative(root, spec.moduleId)));
    }
  } finally { ctx.config.related = previous; }
  return { modules, all: reasons.length > 0, reasons };
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
  let evidence, evidenceError;
  // Reviewed skip policy (integration only): change scope comes from the landing gate environment; without it the
  // policy still classifies every skip but tolerates none (fail closed — optional tolerance is a landing-only decision).
  const skipPolicy = mode === 'integration' && config.integration.skipPolicy ? { ...config.integration.skipPolicy, root, env: withProjectEnvFile(root, config, env), affected: null } : null;
  const reporter = {
    onTestRunEnd(modules, errors, reason) {
      try { evidence = assertRunEvidence(modules, errors, reason, mode === 'integration', skipPolicy); }
      catch (error) { evidenceError = error; }
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
    } else if (skipPolicy && env.BATCH_BASE && env.BATCH_CHANGED_FILES) {
      // Landing run with change scope: map the change through the project's whole test graph (unit ∪ integration —
      // a source file covered only by unit tests is mapped, not "unmapped"), then execute the integration scope
      // through the same specification API as the affected path (start() after a mapping query does not return in Vitest 4).
      const mapping = await createVitest('test', { root, watch: false, run: true, passWithNoTests: true, include: [...new Set([...(config.unit?.include ?? []), ...scope.include])], exclude: ['**/node_modules/**'], reporters: [], coverage: { enabled: false } });
      try { skipPolicy.affected = await affectedModules(mapping, root, parseChanged(root, env)); } finally { await mapping.close(); }
      const specs = await ctx.getRelevantTestSpecifications();
      if (!specs.length) throw new Error('zero integration test specifications');
      await ctx.standalone();
      await ctx.runTestSpecifications(specs, false);
    } else await ctx.start();
    if (evidenceError) throw evidenceError;
    if (!evidence) throw new Error('missing Vitest execution evidence');
    if (lcov && (!existsSync(lcov) || !/^(?:SF:|TN:)/m.test(readFileSync(lcov, 'utf8')))) throw new Error('fresh LCOV missing');
    return { mode, ...evidence, ...(lcov ? { lcov: normalize(relative(root, lcov)) } : {}) };
  } finally { await ctx?.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = process.argv[2] ?? 'affected';
  const requiredAt = process.argv.indexOf('--require');
  const required = requiredAt >= 0 ? (process.argv[requiredAt + 1] ?? '').split(',').filter(Boolean) : [];
  try {
    const result = await runAdapter({ mode: arg, required });
    if (result.skipped) console.log(`[skip-policy] approved optional skips (not applicable in this environment · reported separately, never counted as executed evidence): ${result.skipped.approvedOptional.length}${result.skipped.approvedOptional.map(s => `\n  ↓ ${s.file} > ${s.test} — ${s.reason}`).join('')}`);
    console.log(JSON.stringify(result));
  } catch (error) {
    if (error.skipped) {
      console.error(`[skip-policy] blocking skipped tests: ${error.skipped.blocking.length} · approved optional: ${error.skipped.approvedOptional.length}`);
      for (const b of error.skipped.blocking) console.error(`  ✖ ${b.file} > ${b.test} — ${b.reason}`);
      for (const s of error.skipped.approvedOptional) console.error(`  ↓ ${s.file} > ${s.test} — ${s.reason}`);
    }
    console.error(`quality adapter not-verified: ${error.message}`); process.exitCode = 1;
  }
}

