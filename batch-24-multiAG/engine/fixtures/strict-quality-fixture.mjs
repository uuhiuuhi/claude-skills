// Synthetic project adapter for regression tests. Never installed as project policy.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_HELPER = String.raw`
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
export function writeStoryTests(root, key, files) {
  const dir = join(root, 'tests'); mkdirSync(dir, { recursive: true });
  const names = files.filter(p => /\.ts$/.test(p) && !/(?:^|\/)tests?\/|\.(?:test|spec)\./.test(p));
  if (!names.length) return;
  const body = ["import { test } from 'node:test';", "import assert from 'node:assert/strict';"];
  names.forEach((p, i) => {
    body.push('import * as source' + i + ' from ' + JSON.stringify('../' + p.replace(/\\/g, '/')) + ';');
    body.push('test(' + JSON.stringify(key + ' normal ' + i) + ', () => assert.notEqual(Object.values(source' + i + ')[0], undefined));');
    body.push('test(' + JSON.stringify(key + ' failure invalid ' + i) + ', () => assert.equal(source' + i + '.missingExport, undefined));');
    body.push('test(' + JSON.stringify(key + ' boundary empty ' + i) + ', () => assert.equal(source' + i + '[""], undefined));');
  });
  writeFileSync(join(dir, key + '.test.mjs'), body.join('\n') + '\n');
}
`;

const COVERAGE = String.raw`
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
mkdirSync('coverage', { recursive: true });
const files = readdirSync('tests').filter(p => p.endsWith('.test.mjs')).map(p => 'tests/' + p);
const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-reporter=lcov', '--test-reporter-destination=coverage/lcov.info', ...files], { stdio: 'inherit', windowsHide: true });
process.exitCode = r.status ?? 1;
`;
export function setupStrictQualityFixture(root) {
  const p = join(root, 'package.json'), pkg = JSON.parse(readFileSync(p, 'utf8'));
  pkg.scripts = { ...pkg.scripts, typecheck: pkg.scripts.qa, 'test:affected': 'node tools/fixture-coverage.mjs', coverage: 'node tools/fixture-coverage.mjs', 'test:all': 'node tools/fixture-coverage.mjs', 'test:integration': pkg.scripts.qa };
  if (pkg.scripts['test:security']) {
    pkg.scripts['test:authorization'] = 'node tools/fixture-authorization.mjs';
    writeFileSync(join(root, 'tools/fixture-authorization.mjs'), AUTHORIZATION);
  }
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools/quality-fixture.mjs'), FIXTURE_HELPER);
  writeFileSync(join(root, 'tools/fixture-coverage.mjs'), COVERAGE);
  const ignore = join(root, '.gitignore');
  writeFileSync(ignore, readFileSync(ignore, 'utf8') + '\ncoverage/\n_bmad-output/implementation-artifacts/auto-pipeline-logs/quality-cache/\n');
}

const AUTHORIZATION = String.raw`
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const server = createServer((req, res) => {
  res.statusCode = !req.headers.authorization ? 401 : req.headers['x-role'] !== 'admin' ? 403 : req.headers['x-tenant'] !== 'self' ? 404 : 204;
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const cases = {};
  for (const [name, headers, expected] of [
    ['anonymous', {}, 401], ['forbidden', { authorization: 'fixture', 'x-role': 'reader' }, 403],
    ['allowed', { authorization: 'fixture', 'x-role': 'admin', 'x-tenant': 'self' }, 204],
    ['crossTenant', { authorization: 'fixture', 'x-role': 'admin', 'x-tenant': 'other' }, 404],
  ]) {
    const response = await fetch('http://127.0.0.1:' + server.address().port, { headers });
    assert.equal(response.status, expected); cases[name] = response.status;
  }
  mkdirSync('coverage', { recursive: true });
  writeFileSync(process.env.BATCH_AUTHORIZATION_REPORT, JSON.stringify({ nonce: process.env.BATCH_VERIFICATION_NONCE, codeFingerprint: process.env.BATCH_CODE_FINGERPRINT, endpoints: [{ source: 'src/auth/session.ts', method: 'GET', route: '/fixture', authorizationApplied: true, cases }] }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
`;
