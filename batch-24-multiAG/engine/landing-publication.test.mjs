import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifiedLandingFingerprint } from './landing-publication.mjs'
import { integrationGateDecision } from './runner-rules.mjs'

const verified = 'a'.repeat(64)
const changed = 'b'.repeat(64)
const report = () => ({ schema: 'batch-24-multiag/quality/1', verdict: 'ready', phase: 'landing',
  base: 'base-sha', commit: 'landed-sha', codeFingerprint: verified, afterFingerprint: verified,
  risk: { category: 'standard' }, gates: [{ result: 'pass' }] })
const context = { landingBase: 'base-sha', head: 'landed-sha', currentFingerprint: verified }

test('publication uses gate-verified fingerprint and rejects post-gate source mutation', () => {
  assert.equal(verifiedLandingFingerprint(report(), context), verified)
  assert.throws(() => verifiedLandingFingerprint(report(), { ...context, currentFingerprint: changed }), /changed after verification/)
  assert.throws(() => verifiedLandingFingerprint({ ...report(), afterFingerprint: changed }, { ...context, currentFingerprint: changed }), /changed after verification/)
})

test('missing, stale, wrong-phase and non-ready reports cannot authorize publication', () => {
  for (const invalid of [null, {}, { ...report(), verdict: 'not-ready' }, { ...report(), base: 'old-base' },
    { ...report(), commit: 'old-head' }, { ...report(), phase: 'worker' }, { ...report(), schema: 'unknown' }]) {
    assert.throws(() => verifiedLandingFingerprint(invalid, context), /missing, stale, or not ready/)
  }
  assert.throws(() => verifiedLandingFingerprint({ ...report(), afterFingerprint: undefined }, context), /fingerprint changed/)
})

test('legacy docs-only ready report still binds publication to verified code', () => {
  const docs = { ...report(), risk: { category: 'docs' }, gates: [], coverage: { result: 'not-required' } }
  delete docs.afterFingerprint
  assert.equal(verifiedLandingFingerprint(docs, context), verified)
  assert.throws(() => verifiedLandingFingerprint(docs, { ...context, currentFingerprint: changed }), /changed after verification/)
})

test('actual runner integration gate rejects source mutation immediately after successful child and rolls back', () => {
  const source = readFileSync(new URL('./run-night.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function runIntegrationGate(')
  const end = source.indexOf('\n/** (N6/정책 16)', start)
  const fn = source.slice(start, end).replaceAll('import.meta.url', JSON.stringify(import.meta.url))
  const commands = [], records = []
  let currentFingerprint = verified
  let currentHead = 'landed-sha'
  const sandbox = {
    landingPublicationReady: true, landingPublicationFingerprint: 'old-proof', dryRun: false,
    landedStories: [{ story: '1-1', head: 'landed-sha' }], LOG_DIR: 'logs', STATE_DIR: 'state', QA_CMD: 'npm run qa', BRANCH: 'auto/test', NTFY_BRIEF: '',
    process, dirname, join, fileURLToPath, verifiedLandingFingerprint, integrationGateDecision,
    integrationGateInvocation: () => ({}), qualityFingerprint: () => currentFingerprint,
    readRecord: JSON.parse, existsSync: () => true, mkdirSync: () => {}, unlinkSync: () => {}, writeFileSync: () => {}, cpSync: () => {},
    readFileSync: path => JSON.stringify(path.endsWith('landing-quality.json') ? report() : { completion: { verdict: 'ready' }, quality: { verdict: 'ready' } }),
    REDACT: value => value, notify: () => {}, headSha: () => currentHead,
    writeRollbackManifests: () => ({}),
    spawnSync: (file, args) => {
      commands.push({ file, args })
      if (file === process.execPath) { currentFingerprint = changed; return { status: 0, stdout: 'ready', stderr: '' } }
      if (args[0] === 'reset') currentHead = 'base-sha'
      return { status: 0 }
    },
    record: text => records.push(text),
  }
  vm.createContext(sandbox)
  const result = vm.runInContext(`${fn}\nrunIntegrationGate({ landedStories, landingBase: 'base-sha', batchId: 'race', timeoutMin: 1, record })`, sandbox)
  assert.equal(result.skipPush, true)
  assert.equal(result.integration.result, 'rollback')
  assert.equal(sandbox.landingPublicationReady, false)
  assert.equal(sandbox.landingPublicationFingerprint, null)
  assert.equal(commands.some(command => command.file === 'git' && command.args[0] === 'reset'), true)
  assert.equal(records.some(line => line.includes('fingerprint changed after verification')), true)
  assert.equal(records.some(line => line.includes('[INTEGRATION][PASS]')), false)
})
