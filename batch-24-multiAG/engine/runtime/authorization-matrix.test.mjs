import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAuthorization, writeAuthorizationReport } from './authorization-matrix.mjs';

test('normal real HTTP authorization: 401, 403, 204 and foreign tenant 404', async t => {
  const server = createServer((req, res) => {
    res.statusCode = !req.headers.authorization ? 401 : req.headers.authorization === 'reader' ? 403 : req.url === '/tenant-b/item' ? 404 : 204;
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = { url: base + '/tenant-a/item', method: 'GET', source: 'src/api/item.ts', route: '/:tenant/item', forbidden: { headers: { authorization: 'reader' } }, allowed: { headers: { authorization: 'admin' } }, crossTenant: { url: base + '/tenant-b/item', headers: { authorization: 'admin' } } };
  const report = await verifyAuthorization(input);
  assert.deepEqual(report.cases, { anonymous: 401, forbidden: 403, allowed: 204, crossTenant: 404 });
  await assert.rejects(verifyAuthorization({ ...input, crossTenant: { url: base + '/tenant-a/item', headers: { authorization: 'admin' } } }), /matrix failed/);
});
test('failure and boundary: missing case, denied allowed role, missing env', async () => {
  await assert.rejects(verifyAuthorization({ url: 'http://example.invalid', request: async () => ({ status: 401 }) }), /missing authorization case/);
  await assert.rejects(verifyAuthorization({ url: 'http://example.invalid', forbidden: {}, allowed: {}, crossTenant: {}, request: async () => ({ status: 401 }) }), /matrix failed/);
  assert.throws(() => writeAuthorizationReport([], {}), /adapter through/);
});
test('report is fresh and never stores supplied credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'auth-report-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = join(root, 'report.json');
  writeAuthorizationReport([{ source: 'src/auth.ts', method: 'GET', route: '/x', authorizationApplied: true, cases: { anonymous: 401, forbidden: 403, allowed: 200, crossTenant: 403 } }], { BATCH_AUTHORIZATION_REPORT: p, BATCH_VERIFICATION_NONCE: 'run-1', BATCH_CODE_FINGERPRINT: 'sha256' });
  const report = JSON.parse(readFileSync(p)); assert.equal(report.nonce, 'run-1'); assert.equal(report.codeFingerprint, 'sha256'); assert.equal(report.schema, 'batch-24-multiag/authorization/1');
});
