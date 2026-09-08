import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Project integration tests supply real credentials, a local test server, and an
// existing foreign-tenant resource. Never put tokens in the persisted report.
export async function verifyAuthorization({ url, method = 'GET', source, route, anonymous = {}, forbidden, allowed, crossTenant, request = fetch }) {
  const inputs = { anonymous, forbidden, allowed, crossTenant };
  const cases = {};
  for (const [name, options] of Object.entries(inputs)) {
    if (!options) throw new Error(`missing authorization case: ${name}`);
    const res = await request(options.url ?? url, { ...options, method, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    cases[name] = res.status;
    await res.body?.cancel();
  }
  const ok = cases.anonymous === 401 && cases.forbidden === 403 && cases.allowed >= 200 && cases.allowed < 300 && [403, 404].includes(cases.crossTenant);
  if (!ok) throw new Error(`authorization matrix failed: ${JSON.stringify({ route, method, cases })}`);
  return { source, route, method, authorizationApplied: true, cases };
}

export function writeAuthorizationReport(endpoints, env = process.env) {
  if (!env.BATCH_AUTHORIZATION_REPORT || !env.BATCH_VERIFICATION_NONCE || !env.BATCH_CODE_FINGERPRINT) throw new Error('run this integration adapter through batch-24-multiag');
  const report = { schema: 'batch-24-multiag/authorization/1', nonce: env.BATCH_VERIFICATION_NONCE, codeFingerprint: env.BATCH_CODE_FINGERPRINT, endpoints };
  mkdirSync(dirname(env.BATCH_AUTHORIZATION_REPORT), { recursive: true });
  writeFileSync(env.BATCH_AUTHORIZATION_REPORT, JSON.stringify(report, null, 2) + '\n');
  return report;
}
