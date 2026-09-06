import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyRisk, changedCoverage, gatePlan, authorizationVerdict, runQuality, fingerprint, collectChanges, executeGate, executedTestVerdict, apiAuthorizationVerdict } from './quality-gates.mjs';
import { testIntegrityFindings } from './quality-rules.mjs';
import { readRecord } from './schema-migration.mjs';

const diff = (file, added, removed = []) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map(x => '-' + x).concat(added.map(x => '+' + x)).join('\n')}\n`;
const names = risk => gatePlan({ typecheck: 'x', lint: 'x', 'test:affected': 'x', coverage: 'x', 'test:api': 'x', 'test:authorization': 'x', 'test:security': 'x', 'test:perf': 'x' }, risk).map(g => g.name);
for (const [file, lines, category] of [
  ['README.md', ['hello'], 'docs'], ['public/logo.svg', ['<svg/>'], 'docs'],
  ['src/math.ts', ['// better comment'], 'docs'], ['src/math.ts', ['export const x = 1'], 'fast'],
  ['src/api/item.ts', ['export const GET = handler'], 'api'], ['db/migrations/a.sql', ['ALTER TABLE users ADD name text'], 'auth-db'],
  ['src/cache/item.ts', ['export const cached = 1'], 'performance'], ['package.json', ['{}'], 'standard'],
]) test(`risk normal classification ${category}: ${file}`, () => {
  const risk = classifyRisk({ files: [file], diff: diff(file, lines) });
  assert.equal(risk.category, category);
  if (category === 'docs') assert.deepEqual(names(risk), []);
  if (category === 'fast') assert.deepEqual(names(risk), ['typecheck', 'lint', 'unit', 'coverage']);
});
test('API uses affected integration; authorization/security only auth-db', () => {
  const api = classifyRisk({ files: ['src/api/items.ts'], diff: diff('src/api/items.ts', ['export const GET = handler']) });
  assert.ok(names(api).includes('api')); assert.ok(!names(api).includes('authorization')); assert.ok(!names(api).includes('performance'));
  const auth = classifyRisk({ files: ['src/auth.ts'], diff: diff('src/auth.ts', ['export const requireAuth = fn']) });
  assert.ok(names(auth).includes('authorization')); assert.ok(names(auth).includes('security'));
});
test('ordinary batch/queue path does not trigger performance merely by name', () => {
  assert.equal(classifyRisk({ files: ['src/batch/queue.mjs'], diff: diff('src/batch/queue.mjs', ['export const label = 1']) }).performance, false);
});
test('removed auth/performance expressions still trigger required tests', () => {
  const r = classifyRisk({ files: ['src/x.ts'], diff: diff('src/x.ts', ['const x = []'], ['const x = Promise.all(items); requireAuth(x)']) });
  assert.equal(r.authDb, true); assert.equal(r.performance, true);
});
const coverageDiff = diff('src/x.ts', Array.from({ length: 10 }, (_, n) => `const x${n} = ${n}`));
const lcov = hits => `SF:src/x.ts\n${Array.from({ length: 10 }, (_, n) => `DA:${n + 1},${n < hits ? 1 : 0}`).join('\n')}\nend_of_record\n`;
test('coverage boundary exactly 90% passes; 80% fails', () => {
  assert.equal(changedCoverage({ diff: coverageDiff, lcov: lcov(9) }).result, 'pass');
  assert.equal(changedCoverage({ diff: coverageDiff, lcov: lcov(8) }).result, 'fail');
});
test('coverage missing/excluded changed line is not verified', () => {
  assert.equal(changedCoverage({ diff: coverageDiff, lcov: '' }).result, 'not-verified');
  const c = changedCoverage({ diff: coverageDiff, lcov: lcov(10).replace('DA:10,1', '') });
  assert.deepEqual(c.unknown, ['src/x.ts:10']);
});
test('branch diff coverage cannot be hidden by full line coverage', () => {
  const c = changedCoverage({ diff: coverageDiff, lcov: lcov(10).replace('end_of_record', 'BRDA:1,0,0,1\nBRDA:1,0,1,-\nend_of_record') });
  assert.equal(c.percent, 100); assert.equal(c.branchPercent, 50); assert.equal(c.result, 'fail');
});
test('coverage comments and structural lines have no denominator; malformed counts fail', () => {
  assert.equal(changedCoverage({ diff: diff('src/x.ts', ['// c', '}', 'import x from "x"']), lcov: '' }).result, 'pass');
  assert.throws(() => changedCoverage({ diff: coverageDiff, lcov: 'SF:src/x.ts\nDA:NaN,-2' }), /invalid LCOV/);
});
test('coverage uses diff lines instead of unrelated whole repository misses', () => {
  assert.equal(changedCoverage({ diff: coverageDiff, lcov: lcov(10) + 'SF:src/unrelated.ts\nDA:1,0\nend_of_record' }).percent, 100);
});
const authReport = () => ({ nonce: 'fresh', codeFingerprint: 'fp', endpoints: [{ source: 'src/api/items.ts', method: 'GET', route: '/items', authorizationApplied: true, cases: { anonymous: 401, forbidden: 403, allowed: 200, crossTenant: 404 } }] });
test('authorization normal 401/403/2xx/tenant isolation contract passes', () => {
  assert.equal(authorizationVerdict(authReport(), { nonce: 'fresh', codeFingerprint: 'fp', endpoints: [{ source: 'src/api/items.ts', method: 'GET', route: '/items' }] }).result, 'pass');
});
for (const kind of ['anonymous', 'forbidden', 'allowed', 'crossTenant']) test(`authorization failure blocks wrong ${kind}`, () => {
  const r = authReport(); r.endpoints[0].cases[kind] = 500;
  assert.equal(authorizationVerdict(r, { nonce: 'fresh', codeFingerprint: 'fp' }).result, 'fail');
});
test('authorization boundary rejects missing, stale, incomplete, no-middleware reports', () => {
  for (const report of [null, {}, { ...authReport(), nonce: 'old' }, { ...authReport(), endpoints: [] }]) assert.equal(authorizationVerdict(report, { nonce: 'fresh', codeFingerprint: 'fp' }).result, 'not-verified');
  assert.equal(authorizationVerdict(authReport(), { nonce: 'fresh', codeFingerprint: 'fp', endpoints: [{ source: 'src/api/missing.ts', method: 'GET', route: '/missing' }] }).result, 'fail');
  const r = authReport(); r.endpoints[0].authorizationApplied = false;
  assert.equal(authorizationVerdict(r, { nonce: 'fresh', codeFingerprint: 'fp' }).result, 'fail');
});
for (const [file, lines, removed, rule] of [
  ['tests/a.test.ts', ['test.only("x", () => {})'], [], 'test-only'],
  ['tests/a.test.ts', ['test.skip("x", () => {})'], [], 'test-skip'],
  ['tests/a.test.ts', ['test("x", () => {})'], [], 'empty-test'],
  ['tests/a.test.ts', ['assert.ok(true)'], [], 'trivial-assertion'],
  ['tests/a.test.ts', ['expect(x).toBeTruthy()'], ['expect(x).toEqual({id: 1})'], 'assertion-weakened'],
  ['src/x.ts', ['/* c8 ignore next */'], [], 'coverage-exclude'],
  ['tsconfig.json', ['"strict": false'], [], 'gate-config-weakened'],
  ['tests/a.test.ts', [], ['test("gone", () => assert.equal(x, 1))'], 'deleted-test-case'],
]) test(`bypass failure blocks ${rule}`, () => {
  assert.ok(testIntegrityFindings({ diff: diff(file, lines, removed) }).some(f => f.rule === rule && f.level === 'block'));
});
test('legacy migration preserves queue/ledger and unknown fields, changes only schema namespace', () => {
  const old = { schema: 'night-batch-ops/ledger/1', days: { today: [1, 2] }, nested: { schema: 'auto-story-finish/verification/1', completion: { verdict: 'not-verified' } } };
  const next = readRecord(JSON.stringify(old));
  assert.equal(next.schema, 'batch-24-multiag/ledger/1'); assert.equal(next.nested.schema, 'batch-24-multiag/verification/1'); assert.deepEqual(next.days, old.days); assert.equal(next.nested.completion.verdict, 'not-verified');
});

function fixture(t, { docs = false, scripts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quality-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (p, text) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
  const git = args => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  put('.gitignore', 'coverage/\n_bmad-output/\n');
  put('package.json', JSON.stringify({ scripts: docs ? {} : { typecheck: 'node tools/typecheck.mjs', lint: 'node tools/lint.mjs', 'test:affected': 'node tools/unit.mjs', coverage: 'node tools/coverage.mjs', ...scripts } }));
  git(['add', '.']); git(['commit', '-qm', 'baseline']);
  if (docs) put('README.md', 'documentation\n');
  else {
    put('src/math.ts', 'export const value = 1\n');
    put('tests/math.test.ts', 'test("normal value", () => assert.equal(value, 1))\ntest("rejects invalid", () => assert.throws(bad))\ntest("boundary empty", () => assert.equal(size([]), 0))\n');
  }
  return { root, put, git };
}
const fake = (fx, calls, options = {}) => async (gate) => {
  calls.push(gate.name);
  if (gate.name === 'coverage') fx.put('coverage/lcov.info', `SF:src/math.ts\nDA:1,${options.miss ? 0 : 1}\nend_of_record\n`);
  return { ...gate, command: `npm run ${gate.script}`, result: options.fail === gate.name ? 'fail' : 'pass', exit: options.fail === gate.name ? 1 : 0, durationMs: 1, output: 'ok 1 - normal value\nok 2 - rejects invalid\nok 3 - boundary empty' };
};
test('run normal: docs execute zero commands; cache reuses exact code and base', async t => {
  const fx = fixture(t, { docs: true }); const calls = [];
  const a = await runQuality({ root: fx.root, execute: fake(fx, calls) });
  assert.equal(a.verdict, 'ready'); assert.equal(a.risk.category, 'docs'); assert.deepEqual(calls, []);
  assert.equal((await runQuality({ root: fx.root, execute: fake(fx, calls) })).cacheHit, true);
});
test('run normal: mandatory gates, fresh changed coverage, fingerprint, cache then invalidation', async t => {
  const fx = fixture(t), calls = [];
  const first = await runQuality({ root: fx.root, execute: fake(fx, calls) });
  assert.equal(first.verdict, 'ready'); assert.equal(first.coverage.percent, 100); assert.equal(first.codeFingerprint, fingerprint(fx.root));
  assert.deepEqual(calls, ['typecheck', 'lint', 'unit', 'coverage']);
  assert.equal((await runQuality({ root: fx.root, execute: fake(fx, calls) })).cacheHit, true);
  fx.put('src/math.ts', 'export const value = 2\n');
  assert.equal((await runQuality({ root: fx.root, execute: fake(fx, calls) })).cacheHit, undefined);
});
test('run failure: uncovered code prevents ready and is not cached', async t => {
  const fx = fixture(t), calls = [];
  const a = await runQuality({ root: fx.root, execute: fake(fx, calls, { miss: true }) });
  assert.equal(a.verdict, 'not-ready'); assert.equal(a.coverage.percent, 0);
  const b = await runQuality({ root: fx.root, execute: fake(fx, calls) }); assert.equal(b.cacheHit, undefined); assert.equal(b.verdict, 'ready');
});
test('run failure: missing script, missing test kinds and RED fast gate stop', async t => {
  const fx = fixture(t, { scripts: { typecheck: '' } }), calls = [];
  const a = await runQuality({ root: fx.root, execute: fake(fx, calls) });
  assert.equal(a.verdict, 'not-verified'); assert.equal(a.gates[0].result, 'required-missing'); assert.deepEqual(calls, []);
  fx.put('tests/math.test.ts', 'test("normal", () => assert.equal(value, 1))\n');
  assert.equal((await runQuality({ root: fx.root, execute: fake(fx, calls) })).verdict, 'not-ready');
});
test('run boundary: stale LCOV cannot pass a command that emits no report', async t => {
  const fx = fixture(t); fx.put('coverage/lcov.info', 'SF:src/math.ts\nDA:1,1\nend_of_record');
  const a = await runQuality({ root: fx.root, execute: async gate => ({ ...gate, result: 'pass', exit: 0, output: 'ok 1 - normal value\nok 2 - rejects invalid\nok 3 - boundary empty' }) });
  assert.equal(a.coverage.result, 'not-verified'); assert.equal(a.verdict, 'not-ready');
});
test('run failure: command changes code after validation', async t => {
  const fx = fixture(t), calls = []; const run = fake(fx, calls);
  const a = await runQuality({ root: fx.root, execute: async (g, c) => { const r = await run(g, c); if (g.name === 'coverage') fx.put('src/math.ts', 'export const value = 9\n'); return r; } });
  assert.equal(a.verdict, 'not-ready'); assert.notEqual(a.codeFingerprint, a.afterFingerprint);
});
test('execute gate rejects missing commands and captures actual process failure', async t => {
  const fx = fixture(t, { scripts: { lint: 'node -e "process.exit(7)"' } });
  assert.equal((await executeGate({ name: 'missing', script: null }, { root: fx.root })).result, 'required-missing');
  const r = await executeGate({ name: 'lint', script: 'lint' }, { root: fx.root }); assert.equal(r.exit, 7); assert.equal(r.result, 'fail'); assert.ok(r.durationMs >= 0);
});
test('collect changes includes committed branch diff and untracked additions', t => {
  const fx = fixture(t); const base = fx.git(['rev-parse', 'HEAD']); fx.git(['add', '.']); fx.git(['commit', '-qm', 'implementation']);
  fx.put('extra.md', 'extra'); const c = collectChanges(fx.root, base); assert.ok(c.files.includes('src/math.ts')); assert.ok(c.files.includes('extra.md')); assert.throws(() => collectChanges(fx.root, 'missing-ref'));
});


test('comment normal: inline/block comments are docs while literal changes remain code', () => {
  for (const [added,removed] of [['const n = 1; // new','const n = 1; // old'],['/* revised */','/* before */']]) assert.equal(classifyRisk({files:['src/a.ts'],diff:diff('src/a.ts',[added],[removed])}).category,'docs');
  assert.equal(classifyRisk({files:['src/a.ts'],diff:diff('src/a.ts',['const url="https://new"'],['const url="https://old"'])}).category,'fast');
  assert.equal(classifyRisk({files:['src/a.ts'],diff:diff('src/a.ts',['const text="a  b"'],['const text="a b"'])}).category,'fast');
});
test('custom sensitivity can add required scopes; docs still require no code tests', () => {
  const r = classifyRisk({files:['src/list.ts'],diff:diff('src/list.ts',['export const x = 1']),sensitivePaths:{api:['src/list'],authDb:['src/list'],performance:['src/list']}});
  assert.equal(r.category,'auth-db');assert.equal(r.api,true);assert.equal(r.performance,true);
  assert.equal(classifyRisk({files:['README.md'],diff:diff('README.md',['text']),sensitivePaths:{performance:['README']}}).category,'docs');
});
test('executed tests failure: exit zero without passing cases and quoted fake cases are insufficient', () => {
  const d=diff('tests/x.test.ts',["test('normal', () => assert.equal(x, 1))"]);
  assert.equal(executedTestVerdict(d,'# tests 0').result,'not-verified');
  assert.equal(executedTestVerdict(d,'not ok 1 - normal').result,'not-verified');
  assert.equal(executedTestVerdict(d,'ok 1 - normal # SKIP condition').result,'not-verified');
  assert.equal(executedTestVerdict(d,'ok 1 - normal').result,'pass');
  assert.equal(executedTestVerdict(diff('tests/x.test.ts',[`const quoted = "test('fake', () => assert.ok(x))";`]),'ok 1 - fake').result,'not-verified');
});
test('API report boundary: explicit public reason, stale nonce, missing endpoint and missing authorization', () => {
  const context={nonce:'n',codeFingerprint:'f',endpoints:[{source:'src/api/x.ts',method:'GET',route:'/x'}]};
  const report={nonce:'n',codeFingerprint:'f',endpoints:[{source:'src/api/x.ts',method:'GET',route:'/x',public:true,publicReason:'Public health endpoint with no tenant data'}]};
  assert.equal(apiAuthorizationVerdict(report,context).result,'pass');
  assert.equal(apiAuthorizationVerdict({...report,nonce:'old'},context).result,'not-verified');
  assert.equal(apiAuthorizationVerdict({...report,endpoints:[]},context).result,'fail');
  assert.equal(apiAuthorizationVerdict({...report,endpoints:[{...report.endpoints[0],publicReason:''}]},context).result,'fail');
});
test('run normal: commands shared by unit and coverage execute once; independent checks overlap', async t => {
  const fx=fixture(t,{scripts:{'test:affected':'node both.mjs',coverage:'node both.mjs'}}),calls=[];
  let active=0,peak=0;
  const result=await runQuality({root:fx.root,execute:async (g)=>{
    calls.push(g.name);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,15));
    if(g.name==='unit') fx.put('coverage/lcov.info','SF:src/math.ts\nDA:1,1\nend_of_record\n');
    active--;return {...g,result:'pass',exit:0,durationMs:15,output:'ok 1 - normal value\nok 2 - rejects invalid\nok 3 - boundary empty'};
  }});
  assert.equal(result.verdict,'ready',JSON.stringify(result));assert.equal(peak,3);assert.deepEqual(calls,['typecheck','lint','unit']);assert.equal(result.gates.find(g=>g.name==='coverage').sharedCommand,true);
});
test('run failure: API/security/performance required-missing, irrelevant optional commands absent', async t => {
  for(const [path,gate] of [['src/api/x.ts','api'],['src/auth/session.ts','security'],['src/cache/x.ts','performance']]){
    const fx=fixture(t);fx.put(path,gate==='api'?"app.get('/x', handler)\n":'export const value = 1\n');const r=await runQuality({root:fx.root,execute:fake(fx,[])});
    assert.equal(r.verdict,'not-verified');assert.equal(r.gates.find(g=>g.name===gate).result,'required-missing');
  }
});
test('run landing normal/full failure: one full and integration; no worker coverage or performance rerun', async t => {
  const fx=fixture(t,{scripts:{'test:all':'node full.mjs','test:integration':'node integration.mjs'}}),calls=[];
  const result=await runQuality({root:fx.root,phase:'landing',execute:fake(fx,calls)});
  assert.equal(result.verdict,'ready');assert.deepEqual(calls,['full','integration']);
  fx.put('src/math.ts','export const value = 2\n');const next=[];
  assert.equal((await runQuality({root:fx.root,phase:'landing',execute:fake(fx,next,{fail:'full'})})).verdict,'not-ready');assert.deepEqual(next,['full']);
});
test('run auth/API normal and failure: fresh complete reports plus changed coverage are mandatory', async t => {
  const fx=fixture(t,{scripts:{'test:api':'node api.mjs','test:security':'node security.mjs','test:authorization':'node authorization.mjs'}});
  fx.put('src/api/auth.ts',"app.get('/auth', authorize)\n");
  const run=async (g,c)=>{
    if(g.name==='coverage') fx.put('coverage/lcov.info','SF:src/math.ts\nDA:1,1\nend_of_record\nSF:src/api/auth.ts\nDA:1,1\nend_of_record\n');
    const report={nonce:c.env.BATCH_VERIFICATION_NONCE,codeFingerprint:c.env.BATCH_CODE_FINGERPRINT,endpoints:[{source:'src/api/auth.ts',method:'GET',route:'/auth',authorizationApplied:true,cases:{anonymous:401,forbidden:403,allowed:204,crossTenant:404}}]};
    if(g.name==='api') fx.put('coverage/api-authorization.json',JSON.stringify(report));
    if(g.name==='authorization') fx.put('coverage/authorization.json',JSON.stringify(report));
    return {...g,result:'pass',exit:0,output:'ok 1 - normal value\nok 2 - rejects invalid\nok 3 - boundary empty'};
  };
  const r=await runQuality({root:fx.root,execute:run});assert.equal(r.verdict,'ready',JSON.stringify(r));assert.equal(r.api.result,'pass');assert.equal(r.authorization.result,'pass');
  fx.put('src/math.ts','export const value = 3\n');
  const bad=await runQuality({root:fx.root,execute:async(g,c)=>{const out=await run(g,c);if(g.name==='authorization')fx.put('coverage/authorization.json','{}');return out;}});
  assert.equal(bad.verdict,'not-ready');assert.equal(bad.authorization.result,'not-verified');
});

test('API handler outside conventional directory requires authorization evidence for that source', () => {
  const risk=classifyRisk({files:['src/server.ts'],diff:'diff --git a/src/server.ts b/src/server.ts\n--- a/src/server.ts\n+++ b/src/server.ts\n@@ -0,0 +1 @@\n+export const GET = () => response();\n'});
  assert.equal(risk.category,'api'); assert.deepEqual(risk.apiFiles,['src/server.ts']);
});

test('cache failure: a ready label with missing gate evidence forces verification again', async t => {
  const fx=fixture(t),calls=[]; const first=await runQuality({root:fx.root,execute:fake(fx,calls)});
  const dir=join(fx.root,'_bmad-output/implementation-artifacts/auto-pipeline-logs/quality-cache');
  const { readdirSync }=await import('node:fs'); const file=join(dir,readdirSync(dir)[0]);
  writeFileSync(file,JSON.stringify({...first,gates:[]})); const next=[];
  const result=await runQuality({root:fx.root,execute:fake(fx,next)}); assert.equal(result.verdict,'ready');assert.equal(result.cacheHit,undefined);assert.equal(next.length,4);
  const before=fingerprint(fx.root);fx.put('.claude/pipeline-settings.json','{"permissions":{"deny":[]}}');assert.notEqual(fingerprint(fx.root),before);
});


test('cache failure matrix: incomplete, stale, failed, low-coverage and unexecuted evidence never authorizes reuse', async t => {
  const fx=fixture(t),first=await runQuality({root:fx.root,execute:fake(fx,[])});
  assert.equal(first.verdict,'ready');
  const dir=join(fx.root,'_bmad-output/implementation-artifacts/auto-pipeline-logs/quality-cache');
  const {readdirSync}=await import('node:fs'),file=join(dir,readdirSync(dir)[0]);
  const mutations=[
    c=>{c.schema='legacy/quality/1'},c=>{c.commit='old'},c=>{c.phase='landing'},
    c=>{c.afterFingerprint='changed'},c=>{c.gates=null},
    c=>{c.gates[0].result='fail'},c=>{c.gates[0].exit=1},c=>{c.gates[0].script='unknown'},
    c=>{delete c.coverage},c=>{c.coverage.unknown=['src/math.ts:1']},
    c=>{c.coverage.percent=89.9},c=>{c.coverage.branchPercent=89.9},
    c=>{c.coverage.minimum=0},c=>{c.executedTests.result='not-verified'},
    c=>{c.testEvidence.result='not-verified'},
  ];
  for(const mutate of mutations){
    const cached=structuredClone(first);mutate(cached);writeFileSync(file,JSON.stringify(cached));
    const calls=[],r=await runQuality({root:fx.root,execute:fake(fx,calls)});
    assert.equal(r.cacheHit,undefined);assert.equal(r.verdict,'ready');assert.equal(calls.length,4);
  }
});


test('comment language boundary: SQL/Python/template comments are docs; quoted SQL and hash values remain code',()=>{
  for(const [path,added,removed] of [['db/schema.sql','-- updated explanation','-- previous explanation'],['src/task.py','# new explanation','# previous explanation'],['src/view.vue','<!-- new explanation -->','<!-- previous explanation -->']]) assert.equal(classifyRisk({files:[path],diff:diff(path,[added],[removed])}).category,'docs');
  assert.equal(classifyRisk({files:['db/schema.sql'],diff:diff('db/schema.sql',["SELECT '-- new'"],["SELECT '-- old'"])}).category,'auth-db');
  assert.equal(classifyRisk({files:['src/task.py'],diff:diff('src/task.py',['value = "# new"'],['value = "# old"'])}).category,'fast');
});
