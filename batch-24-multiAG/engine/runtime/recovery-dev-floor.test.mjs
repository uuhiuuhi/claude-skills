import test from 'node:test';
import assert from 'node:assert/strict';
import { policyRelief, selectModel } from './model-policy.mjs';

// 👤 2026-10-11 「추천안 2」 — 회수 dev 만 설정으로 품질 하한을 sonnet 까지 내린다. 신규 dev·review 는 종전 하한 그대로.
test('policyRelief: recovery dev only, and only when modelPolicy.recoveryDevFloor is 1', () => {
  const policy = { recoveryDevFloor: 1 };
  assert.equal(policyRelief({ stage: 'dev', batchKind: 'recovery', policy }), true);
  assert.equal(policyRelief({ stage: 'dev', batchKind: 'new', policy }), false);
  assert.equal(policyRelief({ stage: 'review', batchKind: 'recovery', policy }), false);
  assert.equal(policyRelief({ stage: 'dev', batchKind: 'recovery', policy: { recoveryDevFloor: 2 } }), false);
  assert.equal(policyRelief({ stage: 'dev', batchKind: 'recovery', policy: null }), false);
  assert.equal(policyRelief({ stage: 'dev', batchKind: 'recovery' }), false);
});

test('a high-risk recovery dev takes sonnet under the policy relief, and keeps opus without it', () => {
  const providers = { claude: { enabled: true }, codex: { enabled: true } };
  const relaxed = selectModel({ role: 'dev', risk: 10, difficulty: 8, preferred: 'sonnet', providers, limitRelief: true });
  assert.equal(relaxed.model, 'sonnet');
  const strict = selectModel({ role: 'dev', risk: 10, difficulty: 8, preferred: 'sonnet', providers, limitRelief: false });
  assert.notEqual(strict.model, 'sonnet');
  // review floor never drops: a high-risk review still refuses sonnet even with relief.
  const review = selectModel({ role: 'review', risk: 10, difficulty: 8, preferred: 'sonnet', providers, limitRelief: true, avoid: 'opus' });
  assert.notEqual(review.model, 'sonnet');
});
