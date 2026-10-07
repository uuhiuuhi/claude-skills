import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitDiffByFile, TEST_FILE_RE, testIntegrityFindings, securityTriggers, maskJavaScript } from './quality-rules.mjs';
import { newTestsFromDiff, testKindsVerdict } from './completion-rules.mjs';
import { integrationGateInvocation } from '../runner-rules.mjs';
import { deepRedact } from './providers/redact.mjs';

import { discoverApiSurface, missingEndpoints } from './api-surface.mjs';

export const QUALITY_SCHEMA = 'batch-24-multiag/quality/1';
export const MIN_COVERAGE = 90;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|sql|vue|svelte)$/i;
const generated = /^(?:_bmad-output\/|coverage\/|node_modules\/)|(?:^|\/)auto-pipeline-logs\//;
const norm = p => String(p).replace(/\\/g, '/');
export const implementationFile = p => SOURCE.test(p) && !TEST_FILE_RE.test(p) && !generated.test(p);
const changedText = diff => Object.values(splitDiffByFile(diff)).flatMap(f => [...f.added, ...f.removed].map(l => l.text)).join('\n');
// Tokenize comments while preserving literal values; changing a URL or quoted text is code.
const significant = (text, path = '') => {
  const lines = /\.(?:py|rb|php)$/i.test(path) ? '#[^\\n]*' : /\.sql$/i.test(path) ? '--[^\\n]*' : '//[^\\n]*';
  const literals = '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`';
  return String(text).replace(new RegExp('(' + literals + ')|(\\/\\*[\\s\\S]*?\\*\\/|<!--[^]*?-->|' + lines + ')', 'g'), (all, literal) => literal ?? '').trim();
};

export function classifyRisk({ files = [], diff = '', sensitivePaths = {} } = {}) {
  const byFile = splitDiffByFile(diff);
  const source = files.filter(implementationFile).filter(p => !byFile[p] || significant(byFile[p].added.map(l => l.text).join('\n'), p) !== significant(byFile[p].removed.map(l => l.text).join('\n'), p));
  const config = files.some(p => /(?:^|\/)(?:package(?:-lock)?\.json|.*config\.[^/]+|\.github\/)/.test(p));
  const testsChanged = files.some(p => TEST_FILE_RE.test(p));
  const text = changedText(diff);
  const apiFiles = source.filter(p => /(?:^|\/)(?:api|routes?|controllers?|endpoints?|functions)(?:\/|\.)|(?:route|controller)\.[^.]+$/i.test(p));
  const scoped = key => source.filter(p => (sensitivePaths[key] ?? []).some(prefix => p.startsWith(prefix)));
  apiFiles.push(...scoped('api').filter(p => !apiFiles.includes(p)));
  const handler = /\b(?:app|router)\.(?:get|post|put|patch|delete|head|options|all|use|route)\s*\(|export\s+(?:(?:async\s+)?function|const|let)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;
  apiFiles.push(...source.filter(p => !apiFiles.includes(p) && handler.test([...(byFile[p]?.added ?? []), ...(byFile[p]?.removed ?? [])].map(l => l.text).join('\n'))));
  const api = apiFiles.length > 0;
  const security = securityTriggers({ files: source, diff });
  const authDb = scoped('authDb').length > 0 || source.some(p => /\.sql$/i.test(p)) || source.some(p => /auth|login|session|permission|roles?|rls|tenant|polic|migrat|schema|database|(?:^|\/)db\//i.test(p)) || /\b(?:GRANT|REVOKE|CREATE POLICY|ALTER TABLE|requireAuth|authorize|tenantId|companyId)\b/i.test(text);
  const perfFiles = source.filter(p => /(?:^|\/)(?:performance|benchmarks?|cache|pagination)(?:\/|\.)/i.test(p));
  const perfText = /\b(?:memoize|useMemo|useCallback|EXPLAIN|CREATE INDEX)\b|Promise\.all\s*\(|\.limit\s*\(|\.range\s*\(/i.test(text);
  const performance = perfFiles.length > 0 || perfText || scoped('performance').length > 0;
  const docs = !source.length && !config && !testsChanged;
  return { category: docs ? 'docs' : authDb ? 'auth-db' : api ? 'api' : performance ? 'performance' : source.length <= 1 && !config ? 'fast' : 'standard',
    api, apiFiles, authDb, source, security: authDb, performance,
    reasons: { api: apiFiles.length ? apiFiles : api ? ['HTTP handler diff'] : [], security: [...security.reasons, ...(authDb ? ['auth/permissions/database change'] : []), ...(api ? ['API authorization surface'] : [])], performance: [...perfFiles, ...scoped('performance'), ...(perfText ? ['performance-sensitive expression changed'] : [])] } };
}

export function collectChanges(root, base = 'HEAD') {
  const git = args => { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr || 'git diff failed'); return r.stdout; };
  // A caller-supplied revision is resolved before it can become a diff argument.
  const revision = git(['rev-parse', '--verify', `${base}^{commit}`]).trim();
  // The diff body feeds only the judgement text (security triggers · test integrity · coverage lines). Engine artifacts
  // (`_bmad-output/`, `coverage/`, `node_modules/`, any `auto-pipeline-logs/`) never take part in that judgement, yet a
  // tracked 26MB state.json pushed `git diff` past the 64MB maxBuffer → spawnSync ENOBUFS → 'git diff failed' → the gate
  // could not write its report and the engine re-read a stale one (2026-09-24 실사고 · 13.10 자동 수리 1차 · 러너 워커가
  // 설치 사본을 고치고 tests/auto/quality-gates-collect.test.ts 로 물었으나 핀 보호로 사본 수정이 남지 못해 통합 게이트가
  // 매 착지마다 RED 였다 · 2026-09-25 정본 반영). The change list below stays complete — only the body drops them.
  // Pathspecs are prefix-at-directory matches, so `src/coverage/report.ts` and `coverage-report.ts` are not excluded.
  const bodyExcludes = [':(exclude)_bmad-output', ':(exclude)coverage', ':(exclude)node_modules', ':(exclude,glob)**/auto-pipeline-logs/**'];
  let diff = git(['diff', '--no-ext-diff', '--no-renames', '--unified=3', revision, '--', '.', ...bodyExcludes]);
  const changes = git(['diff', '--no-renames', '--name-status', revision, '--']).trim().split('\n').filter(Boolean).map(l => { const [status, path] = l.split('\t'); return { status, path }; });
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    if (generated.test(path)) continue;
    changes.push({ status: 'A', path });
    const bytes = readFileSync(resolve(root, path));
    if (bytes.includes(0)) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    diff += `\ndiff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => '+' + l).join('\n')}\n`;
  }
  return { base: revision, changes, diff, files: changes.map(c => c.path) };
}

export function fingerprint(root) {
  // maxBuffer: spawnSync defaults to 1 MiB. The runner clone's tracked list reached 1,054,484 bytes → ENOBUFS → status null →
  // 'cannot fingerprint code' on every story (2026-10-08 2-18 · 1-54 · 4-22 coverage::ready STOP). Same cap as collectChanges.
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`cannot fingerprint code${r.error?.code ? ` (${r.error.code})` : ''}`);
  const h = createHash('sha256');
  for (const p of [...new Set(r.stdout.split('\0').filter(Boolean))].filter(p => !generated.test(p)).sort()) {
    h.update(p).update('\0');
    try { h.update(readFileSync(resolve(root, p))); } catch (e) { if (e.code !== 'ENOENT') throw e; h.update('deleted'); }
    h.update('\0');
  }
  return h.digest('hex');
}

// LCOV is intersected with added/modified executable lines. Missing instrumentation
// remains unknown; an excluded file can never improve the percentage.
// JS line coverage can only ever exist for JavaScript/TypeScript the test runner instrumented. SQL migrations and other
// executable-but-not-JS sources are verified by their own gates (security/authorization + project guard tests) — counting
// their added lines here made every migration story "not-verified" forever (2026-09-10 5-3). `exclude` lists project-owned
// path prefixes (quality.config.json `coverageExclude`, e.g. Deno edge-function sources) that the JS runner cannot load.
const JS_COVERABLE = /\.[cm]?[jt]sx?$/i
export function changedCoverage({ diff, lcov, root = process.cwd(), exclude = [] }) {
  const records = new Map(); let current;
  for (const line of String(lcov).split(/\r?\n/)) {
    if (line.startsWith('SF:')) { const p = line.slice(3); const key = norm(isAbsolute(p) ? relative(root, p) : p).replace(/^\.\//, ''); current = records.get(key) ?? { lines: new Map(), branches: [] }; records.set(key, current); }
    else if (current && line.startsWith('DA:')) { const [n, hits] = line.slice(3).split(',').map(Number); if (!Number.isFinite(n) || !Number.isFinite(hits) || hits < 0) throw new Error('invalid LCOV line'); current.lines.set(n, Math.max(current.lines.get(n) ?? 0, hits)); }
    else if (current && line.startsWith('BRDA:')) { const [n, block, branch, hits] = line.slice(5).split(','); current.branches.push({ line: Number(n), id: `${n}:${block}:${branch}`, hits: hits === '-' ? 0 : Number(hits) }); }
    else if (line === 'end_of_record') current = null;
  }
  let total = 0, covered = 0, branches = 0, coveredBranches = 0; const unknown = [], files = [];
  for (const [path, f] of Object.entries(splitDiffByFile(diff))) {
    if (!implementationFile(path) || !f.added.length) continue;
    if (!JS_COVERABLE.test(path) || (Array.isArray(exclude) && exclude.some(p => typeof p === 'string' && p && norm(path).startsWith(norm(p))))) continue;
    const rec = records.get(path), lines = new Set(f.added.map(a => a.line));
    let fileTotal = 0, fileCovered = 0;
    for (const a of f.added) {
      const t = a.text.trim();
      // Structural/import/comment-only lines are not executable coverage targets.
      if (!t || /^(?:\/\/|\/\*|\*|import\b|export\s+(?:type|interface)\b|[{}()[\],;]+$)/.test(t)) continue;
      if (!rec) { unknown.push(`${path}:${a.line}`); continue; }
      // V8 LCOV lists DA rows only for statement-carrying lines. In an instrumented file, an added
      // line without a DA row is a non-statement line (method-chain continuation, type-only line,
      // multi-line literal) — not an executable coverage target. A file with no LCOV record at all
      // stays unknown above (never loaded/instrumented — fail closed). 2026-09-08 4-2 repair 2:
      // every multi-line TypeScript statement edit was reported unknown, so no real change could pass.
      if (!rec.lines.has(a.line)) continue;
      fileTotal++; if (rec.lines.get(a.line) > 0) fileCovered++;
    }
    const seenBranches = new Map();
    for (const b of rec?.branches ?? []) if (lines.has(b.line)) seenBranches.set(b.id, Math.max(seenBranches.get(b.id) ?? 0, b.hits));
    branches += seenBranches.size; coveredBranches += [...seenBranches.values()].filter(n => n > 0).length;
    total += fileTotal; covered += fileCovered; files.push({ path, total: fileTotal, covered: fileCovered });
  }
  const percent = total ? covered / total * 100 : null;
  const branchPercent = branches ? coveredBranches / branches * 100 : null;
  const result = unknown.length ? 'not-verified' : (percent !== null && percent < MIN_COVERAGE) || (branchPercent !== null && branchPercent < MIN_COVERAGE) ? 'fail' : 'pass';
  return { result, mode: 'changed-lines-and-branches', minimum: MIN_COVERAGE, percent, branchPercent, total, covered, branches, coveredBranches, unknown, files };
}

export function gatePlan(scripts, risk, phase = 'worker') {
  if (risk.category === 'docs') return [];
  const pick = names => names.find(n => typeof scripts[n] === 'string' && scripts[n].trim());
  if (phase === 'landing') return [['full', ['test:all', 'test']], ['integration', ['test:integration', 'integration']]].map(([name, candidates]) => ({ name, script: pick(candidates) ?? null, reason: 'once after landing / scheduled full regression' }));
  const gates = [
    ['typecheck', ['typecheck', 'type-check', 'check-types'], 'every change'],
    ['lint', ['lint', 'eslint'], 'every change'],
    ['unit', ['test:affected', 'test:unit:affected'], 'affected tests first'],
    ['coverage', ['test:coverage:changed', 'test:coverage', 'coverage'], 'changed code >= 90%'],
    ...(risk.security ? [['security', ['test:security', 'security', 'rls:check'], risk.reasons.security.join('; ')]] : []),
    ...(risk.api ? [['api', ['test:api', 'test:integration:api'], 'affected API integration tests']] : []),
    ...(risk.authDb ? [['authorization', ['test:authorization', 'test:authz'], 'authentication, permissions, DB/RLS and tenant isolation']] : []),
    ...(risk.performance ? [['performance', ['test:perf', 'test:performance', 'perf', 'bench'], risk.reasons.performance.join('; ')]] : []),
  ];
  return gates.map(([name, names, reason]) => ({ name, script: pick(names) ?? null, reason }));
}

function contained(root, path) {
  const p = resolve(root, path), rel = relative(root, p);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`report must be inside project: ${path}`);
  return p;
}

export async function executeGate(gate, { root, env = {}, timeoutMs = 20 * 60 * 1000 } = {}) {
  const started = Date.now();
  if (!gate.script) return { ...gate, command: null, result: 'required-missing', exit: null, durationMs: 0 };
  const inv = integrationGateInvocation(`npm run ${gate.script}`);
  return await new Promise(resolveResult => {
    let output = '', timedOut = false;
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT; // nested node:test is a fresh test run, not the parent harness
    const child = spawn(inv.file, inv.argv, { cwd: root, env: childEnv, shell: false, windowsVerbatimArguments: inv.verbatim, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); else child.kill('SIGKILL'); }, timeoutMs);
    const add = data => { output = (output + data).slice(-4 * 1024 * 1024); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', e => { clearTimeout(timer); resolveResult({ ...gate, command: inv.display, result: 'fail', exit: null, error: e.message, durationMs: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); resolveResult({ ...gate, command: inv.display, result: code === 0 && !timedOut ? 'pass' : 'fail', exit: code, timedOut, durationMs: Date.now() - started, output }); });
  });
}

// The authorization adapter must execute actual requests and assert status codes;
// results are accepted only from this run (unique nonce + code fingerprint).
export function authorizationVerdict(report, { nonce, codeFingerprint, endpoints = [] }) {
  if (!report || report.nonce !== nonce || report.codeFingerprint !== codeFingerprint || !Array.isArray(report.endpoints) || !report.endpoints.length) return { result: 'not-verified', why: 'missing/freshness-invalid authorization report' };
  const scope = missingEndpoints(endpoints, report.endpoints);
  if (scope.invalidScope) return { result: 'not-verified', why: 'endpoint scope requires source, method and route' };
  const missing = scope.missing;
  // Intentionally public/internal endpoints (cron-invoked worker with a shared-secret header, webhook receivers) cannot
  // produce anonymous/forbidden/allowed/cross-tenant cases — the same `public: true` + specific `publicReason` the api
  // report already accepts is accepted here, reviewed by the independent reviewer (2026-09-10 outbox-dispatch).
  const isPublic = e => e?.public === true && typeof e.publicReason === 'string' && e.publicReason.trim().length > 10;
  const invalid = report.endpoints.filter(e => !e.method || !e.route || (!isPublic(e) && (e.authorizationApplied !== true ||
    e.cases?.anonymous !== 401 || e.cases?.forbidden !== 403 || !(e.cases?.allowed >= 200 && e.cases?.allowed < 300) || ![403, 404].includes(e.cases?.crossTenant))));
  return { result: missing.length || invalid.length ? 'fail' : 'pass', missing, invalid: invalid.map(e => `${e.method} ${e.route}`), endpoints: report.endpoints };
}

export function executedTestVerdict(diff, output = '') {
  const tests = Object.values(splitDiffByFile(diff)).filter(f => TEST_FILE_RE.test(f.path)).flatMap(f => {
    const text = f.added.map(a => a.text).join('\n');
    const executable = maskJavaScript(text).code;
    return [...text.matchAll(/\b(?:it|test)\s*\(\s*(['"`])([^'"`]+)\1/g)].filter(m => /^(?:it|test)\s*\(/.test(executable.slice(m.index))).map(m => m[2]);
  });
  const passed = String(output).split(/\r?\n/).filter(l => /^\s*(?:ok\s+\d+\s*-?\s*|[✔✓√]\s*)/.test(l) && !/#\s*(?:SKIP|TODO)\b/i.test(l));
  const missing = tests.filter(name => !passed.some(line => line.includes(name)));
  return { result: tests.length && !missing.length ? 'pass' : 'not-verified', expected: tests, missing };
}

export function apiAuthorizationVerdict(report, { nonce, codeFingerprint, endpoints = [] }) {
  if (!report || report.nonce !== nonce || report.codeFingerprint !== codeFingerprint || !Array.isArray(report.endpoints)) return { result: 'not-verified' };
  const accepted = report.endpoints.filter(e => e.authorizationApplied === true || (e.public === true && typeof e.publicReason === 'string' && e.publicReason.trim().length > 10));
  const scope = missingEndpoints(endpoints, accepted);
  if (scope.invalidScope) return { result: 'not-verified', why: 'endpoint scope requires source, method and route' };
  return { result: scope.missing.length || !report.endpoints.length ? 'fail' : 'pass', missing: scope.missing, endpoints: report.endpoints };
}

// A fingerprint failure is retried once, then reported as not-verified instead of throwing — a thrown error left no fresh
// report behind and the engine re-read the previous one (2026-10-08). No gate runs without a code fingerprint.
function tryFingerprint(fingerprintCode, root) {
  let error;
  for (let attempt = 0; attempt < 2; attempt++) { try { return { value: fingerprintCode(root) }; } catch (e) { error = e; } }
  return { error: String(error?.message ?? error) };
}

export async function runQuality({ root = process.cwd(), base = 'HEAD', phase = 'worker', execute = executeGate, fingerprintCode = fingerprint } = {}) {
  const started = Date.now(), changes = collectChanges(root, base), fp = tryFingerprint(fingerprintCode, root);
  if (fp.error) return { schema: QUALITY_SCHEMA, generatedAt: new Date().toISOString(), phase, base: changes.base, codeFingerprint: null, gates: [], verdict: 'not-verified', why: fp.error, durationMs: Date.now() - started };
  const before = fp.value;
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const cfgPath = resolve(root, 'tools/auto/quality.config.json');
  const config = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  const risk = classifyRisk({ ...changes, sensitivePaths: config.sensitivePaths });
  const surface = risk.api ? discoverApiSurface({ sources: Object.fromEntries(risk.apiFiles.map(path => [path, existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : ''])), inventory: config.apiEndpoints ?? [] }) : { result: 'pass', endpoints: [], unresolved: [] };
  const auditDiff = changes.diff.split(/(?=^diff --git )/m).filter(part => { const path = /^diff --git a\/(.+?) b\/(.+)/.exec(part)?.[2]; return path && (SOURCE.test(path) || /config|package\.json/.test(path)); }).join('');
  const integrity = testIntegrityFindings({ ...changes, diff: auditDiff });
  const tests = newTestsFromDiff(changes.diff), hasCode = risk.source.length > 0;
  const [testResult, why] = hasCode && phase !== 'landing' ? testKindsVerdict(tests) : ['pass', 'no worker test-kind requirement in this scope'];
  const nonce = createHash('sha256').update(before + started + Math.random()).digest('hex');
  const result = { schema: QUALITY_SCHEMA, generatedAt: new Date().toISOString(), phase, base: changes.base, codeFingerprint: before, risk, apiSurface: surface, integrity, testEvidence: { ...tests, result: testResult, why }, gates: [], verdict: 'not-verified' };
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
  result.commit = commit;
  const version = ['./quality-gates.mjs', './quality-rules.mjs', './completion-rules.mjs', './api-surface.mjs', '../runner-rules.mjs'].map(p => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
  const cacheKey = createHash('sha256').update(JSON.stringify({ version, environment: { node: process.version, platform: process.platform, arch: process.arch }, commit, before, base: changes.base, diff: changes.diff, scripts: pkg.scripts, config, phase })).digest('hex');
  const cachePath = resolve(root, '_bmad-output/implementation-artifacts/auto-pipeline-logs/quality-cache', `${cacheKey}.json`);
  const finish = () => {
    result.durationMs = Date.now() - started;
    const clean = deepRedact(result);
    if (clean.verdict === 'ready') { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(clean) + '\n'); }
    return clean;
  };
  if (integrity.some(f => f.level === 'block') || testResult !== 'pass') { result.verdict = 'not-ready'; return finish(); }
  if (surface.result !== 'pass' && phase !== 'landing') return finish();
  const validCache = cached => {
    if (cached.schema !== QUALITY_SCHEMA || cached.verdict !== 'ready' || cached.codeFingerprint !== before || cached.base !== changes.base || cached.commit !== commit || cached.phase !== phase) return false;
    if (risk.category === 'docs') return cached.risk?.category === 'docs' && cached.gates?.length === 0 && cached.coverage?.result === 'not-required';
    const expected = gatePlan(pkg.scripts ?? {}, risk, phase).filter(g => hasCode || g.name !== 'coverage');
    if (cached.afterFingerprint !== before || !Array.isArray(cached.gates) || expected.length !== cached.gates.length) return false;
    if (!expected.every(g => g.script && cached.gates.some(c => c.name === g.name && c.result === 'pass' && c.exit === 0 && pkg.scripts[c.script] === pkg.scripts[g.script]))) return false;
    const c = cached.coverage;
    if (c?.result !== 'pass' || (c.unknown?.length ?? 0) > 0 || (c.percent != null && c.percent < MIN_COVERAGE) || (c.branchPercent != null && c.branchPercent < MIN_COVERAGE)) return false;
    if (hasCode && phase !== 'landing' && (cached.testEvidence?.result !== 'pass' || cached.executedTests?.result !== 'pass' || c.minimum !== MIN_COVERAGE)) return false;
    return phase === 'landing' || ((!risk.api || cached.api?.result === 'pass') && (!risk.authDb || cached.authorization?.result === 'pass'));
  };
  try { const cached = JSON.parse(readFileSync(cachePath, 'utf8')); if (validCache(cached)) return { ...cached, cacheHit: true, durationMs: Date.now() - started }; } catch { /* missing/invalid cache is a miss */ }
  if (risk.category === 'docs') { result.verdict = 'ready'; result.coverage = { result: 'not-required', reason: 'documents/comments/static resources only' }; return finish(); }
  const plan = gatePlan(pkg.scripts ?? {}, risk, phase);
  if (!hasCode || phase === 'landing') { const index = plan.findIndex(g => g.name === 'coverage'); if (index >= 0) plan.splice(index, 1); result.coverage = { result: 'pass', percent: null, reason: phase === 'landing' ? 'worker coverage verified before landing' : 'no changed implementation lines', mode: 'changed-lines-and-branches' }; }
  if (plan.some(g => !g.script)) { result.gates = plan.map(g => ({ ...g, command: g.script ? `npm run ${g.script}` : null, result: g.script ? 'not-run' : 'required-missing', exit: null })); return finish(); }
  const lcovPath = contained(root, config.lcov ?? 'coverage/lcov.info');
  const authPath = contained(root, config.authorizationReport ?? 'coverage/authorization.json');
  const apiPath = contained(root, config.apiReport ?? 'coverage/api-authorization.json');
  // Remove only these generated report files, never a report directory.
  if (hasCode && phase !== 'landing' && existsSync(lcovPath)) rmSync(lcovPath);
  if (risk.authDb && existsSync(authPath)) rmSync(authPath);
  if (risk.api && existsSync(apiPath)) rmSync(apiPath);
  const env = { BATCH_BASE: changes.base, BATCH_CHANGED_FILES: JSON.stringify(changes.files), BATCH_CODE_FINGERPRINT: before, BATCH_VERIFICATION_NONCE: nonce, BATCH_AUTHORIZATION_REPORT: authPath, BATCH_API_REPORT: apiPath, BATCH_LCOV_REPORT: lcovPath };
  const shared = new Map();
  const run = async gate => {
    const commandKey = pkg.scripts[gate.script].trim();
    const reused = shared.has(commandKey);
    if (!reused) shared.set(commandKey, execute(gate, { root, env, timeoutMs: config.timeoutMs }));
    const outcome = await shared.get(commandKey);
    return { ...outcome, name: gate.name, reason: gate.reason, sharedCommand: reused, ...(reused ? { durationMs: 0 } : {}) };
  };
  // Independent checks run together; tests sharing a database run in order.
  result.gates.push(...await Promise.all(plan.filter(g => ['typecheck', 'lint', 'unit'].includes(g.name)).map(run)));
  if (hasCode && phase !== 'landing' && result.gates.find(g => g.name === 'unit')?.result === 'pass') {
    result.executedTests = executedTestVerdict(changes.diff, result.gates.find(g => g.name === 'unit').output);
    if (result.executedTests.result !== 'pass') { result.verdict = 'not-verified'; return finish(); }
  }
  if (result.gates.every(g => g.result === 'pass')) {
    for (const gate of plan.filter(g => !['typecheck', 'lint', 'unit'].includes(g.name))) {
      const outcome = await run(gate); result.gates.push(outcome);
      if (outcome.result !== 'pass') break;
      if (gate.name === 'coverage') {
        result.coverage = existsSync(lcovPath) ? changedCoverage({ diff: changes.diff, lcov: readFileSync(lcovPath, 'utf8'), root , exclude: config.coverageExclude ?? [] }) : { result: 'not-verified', why: 'fresh LCOV report missing' };
        if (result.coverage.result !== 'pass') break;
      }
      if (gate.name === 'authorization') {
        let report; try { report = JSON.parse(readFileSync(authPath, 'utf8')); } catch { report = null; }
        result.authorization = authorizationVerdict(report, { nonce, codeFingerprint: before, endpoints: surface.endpoints });
        if (result.authorization.result !== 'pass') break;
      }
      if (gate.name === 'api') {
        let report; try { report = JSON.parse(readFileSync(apiPath, 'utf8')); } catch { report = null; }
        result.api = apiAuthorizationVerdict(report, { nonce, codeFingerprint: before, endpoints: surface.endpoints });
        if (result.api.result !== 'pass') break;
      }
    }
  }
  const fpAfter = tryFingerprint(fingerprintCode, root);
  if (fpAfter.error) { result.verdict = 'not-verified'; result.why = fpAfter.error; return finish(); }
  const after = fpAfter.value; result.afterFingerprint = after;
  const complete = result.gates.length === plan.length && result.gates.every(g => g.result === 'pass') && result.coverage?.result === 'pass' && (phase === 'landing' || ((!risk.authDb || result.authorization?.result === 'pass') && (!risk.api || result.api?.result === 'pass'))) && before === after;
  result.verdict = complete ? 'ready' : 'not-ready';
  return finish();
}

// ---- Engine side (auto-story-pipeline): how the parent reads the child's report ----
// The engine removes the report file before spawning the gate, so `report` here is either this run's report or null.
// The verdict is the judgement; the process exit code is only a transport. They can disagree (a crash after the write,
// a kill after the write); the verdict wins and the disagreement is surfaced as `mismatch`. A missing/unreadable
// report is never GREEN — that path used to fall back to the previous run's file (2026-10-08 coverage::ready).
export function qualityRunOutcome({ status, report, stderr = '' } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    const tail = String(stderr ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 300);
    return { code: 1, mismatch: null, policy: { verdict: 'not-verified', gates: [], why: `quality report missing (gate exit=${status})${tail ? `: ${tail}` : ''}` } };
  }
  const code = report.verdict === 'ready' ? 0 : 1;
  const mismatch = (status === 0) === (code === 0) ? null : `gate exit=${status} but report verdict=${report.verdict} — verdict 를 따른다`;
  return { code, mismatch, policy: { ...report, gates: Array.isArray(report.gates) ? report.gates : [] } };
}

// Failure family for repair signatures. `coverage.result === 'not-required'` (docs scope) is not a coverage failure.
export function qualityFailureKind(policy, failedGate) {
  if (policy?.integrity?.some?.(f => f.level === 'block')) return 'integrity';
  if (policy?.executedTests?.result === 'not-verified') return 'unit-evidence';
  const coverage = policy?.coverage?.result;
  if (coverage && coverage !== 'pass' && coverage !== 'not-required') return 'coverage';
  return failedGate?.name ?? 'quality';
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
  const output = arg('--out', '_bmad-output/implementation-artifacts/auto-pipeline-logs/quality-gates.json');
  try {
    const report = await runQuality({ base: arg('--base', 'HEAD'), phase: arg('--phase', 'worker') });
    const p = contained(process.cwd(), output); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(report, null, 2) + '\n');
    console.log(`quality ${report.verdict} (${report.durationMs}ms) ${p}`); process.exitCode = report.verdict === 'ready' ? 0 : 1;
  } catch (e) { console.error(`quality not-verified: ${e.message}`); process.exitCode = 1; }
}
