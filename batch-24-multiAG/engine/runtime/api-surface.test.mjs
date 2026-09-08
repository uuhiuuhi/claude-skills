import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverApiSurface, sourceHash, missingEndpoints } from './api-surface.mjs';
import { apiAuthorizationVerdict, authorizationVerdict, classifyRisk } from './quality-gates.mjs';
const source = 'src/routes/items.ts';
const text = "app.post('/items', authorize, create);\napp.delete('/items/:id', authorize, remove);";
const context = { nonce: 'fresh', codeFingerprint: 'fp' };
const row = e => ({ ...e, authorizationApplied: true, cases: { anonymous: 401, forbidden: 403, allowed: 204, crossTenant: 404 } });

test('surface normal discovers every static method and route, deduplicates registrations', () => {
  const found = discoverApiSurface({ sources: { [source]: text + '\n' + text } });
  assert.equal(found.result, 'pass');
  assert.deepEqual(found.endpoints, [{ source, method: 'POST', route: '/items' }, { source, method: 'DELETE', route: '/items/:id' }]);
  const report = { ...context, endpoints: found.endpoints.map(row) };
  for (const verdict of [apiAuthorizationVerdict, authorizationVerdict]) assert.equal(verdict(report, { ...context, endpoints: found.endpoints }).result, 'pass');
});
test('surface failure rejects partial method coverage in API and authorization reports', () => {
  const found = discoverApiSurface({ sources: { [source]: text } });
  const report = { ...context, endpoints: [row(found.endpoints[0])] };
  for (const verdict of [apiAuthorizationVerdict, authorizationVerdict]) {
    const result = verdict(report, { ...context, endpoints: found.endpoints });
    assert.equal(result.result, 'fail');
    assert.equal(result.missing[0].method, 'DELETE');
    assert.equal(verdict(report, { ...context, endpoints: [source] }).result, 'not-verified');
  }
});
test('surface boundary distinguishes routes of the same method and rejects malformed scope', () => {
  const expected = [{ source, method: 'GET', route: '/one' }, { source, method: 'GET', route: '/two' }];
  assert.deepEqual(missingEndpoints(expected, [expected[0]]).missing, [expected[1]]);
  assert.equal(missingEndpoints(null, []).invalidScope, true);
  assert.equal(missingEndpoints([{source,method:'TRACE',route:'/'}], []).invalidScope, true);
});
test('surface ignores comments and quoted fake handlers', () => {
  const code = `// app.delete('/ignored', x)\nconst s = "app.post('/fake', x)";\napp.get('/real', handler);`;
  const found = discoverApiSurface({ sources: { [source]: code } });
  assert.deepEqual(found.endpoints, [{ source, method: 'GET', route: '/real' }]);
});
test('surface Next normal maps root and dynamic route exports', () => {
  const found = discoverApiSurface({ sources: { 'src/app/route.ts': 'export async function GET() {}', 'app/items/[id]/route.js': 'export const DELETE = handler' } });
  assert.equal(found.result, 'pass');
  assert.deepEqual(found.endpoints.map(e=>e.route), ['/', '/items/[id]']);
});
test('surface unknown or dynamic framework remains not-verified without inventory', () => {
  for (const code of ['', "app.get(path, handler)", "app.use('/v1', router)", "app.all('/x', handler)", 'Deno.serve(handler)', 'export default handler', 'export const POST = handler']) {
    assert.equal(discoverApiSurface({ sources: { [source]: code } }).result, 'not-verified', code);
  }
  assert.equal(discoverApiSurface({ sources: { 'app/(group)/route.ts': 'export const GET = handler' } }).result, 'not-verified');
});
test('surface explicit reviewed inventory covers unsupported dispatch without stale acceptance', () => {
  const code = 'Deno.serve(handler)', entry = { source, sourceSha256: sourceHash(code), endpoints: [{ method: 'POST', route: '/items' }] };
  assert.equal(discoverApiSurface({ sources: { [source]: code }, inventory: [entry] }).result, 'pass');
  assert.equal(discoverApiSurface({ sources: { [source]: code+' ' }, inventory: [entry] }).result, 'not-verified');
  for (const endpoints of [[], null, [{method:'GET',route:'bad'}]]) assert.equal(discoverApiSurface({ sources: { [source]: code }, inventory: [{...entry,endpoints}] }).result, 'not-verified');
});
test('surface inventory cannot omit a visible method even with a current source hash', () => {
  const result = discoverApiSurface({ sources: { [source]: text }, inventory: [{ source, sourceSha256: sourceHash(text), endpoints: [{method:'POST',route:'/items'}] }] });
  assert.equal(result.result, 'not-verified');
  assert.match(result.unresolved[0].why, /omits/);
});

test('surface HEAD OPTIONS and dynamic registration outside API directories still trigger the gate', () => {
  for (const method of ['head', 'options', 'all', 'use', 'route']) {
    const line = `app.${method}('/x', handler);`;
    const diff = `diff --git a/src/server.ts b/src/server.ts\n--- a/src/server.ts\n+++ b/src/server.ts\n@@ -0,0 +1 @@\n+${line}\n`;
    assert.equal(classifyRisk({files:['src/server.ts'],diff}).api, true, method);
  }
});
test('surface mounted router requires explicit external route inventory', () => {
  const code="router.get('/users', handler)", path='src/routes/users.ts';
  assert.equal(discoverApiSurface({sources:{[path]:code}}).result, 'not-verified');
  // A relative route cannot be silently relabeled; inventory must retain discovered
  // registrations until an adapter can prove the mount mapping explicitly.
  const entry={source:path,sourceSha256:sourceHash(code),endpoints:[{method:'GET',route:'/v1/users'}]};
  assert.equal(discoverApiSurface({sources:{[path]:code},inventory:[entry]}).result, 'not-verified');
});
