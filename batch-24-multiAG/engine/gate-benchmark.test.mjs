import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareGateCosts } from './gate-benchmark.mjs';
const sample = values => values.map(wallClockMs => ({ wallClockMs, exit: 0 }));
test('cost normal: medians resist one slow outlier', () => { const r=compareGateCosts(sample([90,100,900]),sample([100,110,120])); assert.equal(r.beforeMs,100); assert.equal(r.afterMs,110); assert.equal(r.result,'pass'); });
test('cost failure: 31 percent requires investigation, failed runs are unverified', () => { assert.equal(compareGateCosts(sample([100]),sample([131])).result,'investigate'); assert.equal(compareGateCosts([{wallClockMs:100,exit:1}],sample([100])).result,'not-verified'); });
test('cost boundary: exactly 30 percent requires investigation and invalid baseline is rejected', () => { assert.equal(compareGateCosts(sample([100,100]),sample([130,130])).result,'investigate'); assert.throws(()=>compareGateCosts([],sample([1]))); assert.throws(()=>compareGateCosts(sample([0]),sample([1]))); });

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const [name, args] of [
  ['missing baseline', []],
  ['too few samples', ['--baseline-engine', '.', '--samples', '2']],
  ['noninteger samples', ['--baseline-engine', '.', '--samples', 'abc']],
]) {
  test(`cost CLI rejects ${name} before fixture creation or model execution`, { timeout: 15000 }, t => {
    const root = mkdtempSync(join(tmpdir(), 'gate-benchmark-args-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const preload = join(root, 'deny-benchmark-work.mjs');
    const attempted = join(root, 'unexpected-work.log');
    const output = join(root, 'result.json');
    writeFileSync(preload, `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const append = fs.appendFileSync;
const deny = kind => (...args) => {
  append(process.env.BENCHMARK_TEST_ATTEMPT_LOG, kind + '\\n');
  throw new Error('Unexpected benchmark work: ' + kind);
};
fs.mkdtempSync = deny('fixture creation');
childProcess.spawnSync = deny('subprocess execution');
syncBuiltinESMExports();
`);
    const env = {
      ...process.env,
      BENCHMARK_TEST_ATTEMPT_LOG: attempted,
      NODE_OPTIONS: [process.env.NODE_OPTIONS || '', `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' '),
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./gate-benchmark.mjs', import.meta.url)), ...args, '--out', output], {
      cwd: root, env, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, 'argument rejection must not rely on a timeout or signal');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /--baseline-engine and --samples >= 3 required/);
    assert.doesNotMatch(result.stdout + result.stderr, /\[COST\]|Unexpected benchmark work/);
    assert.equal(existsSync(output), false, 'rejected arguments must not produce benchmark evidence');
    assert.equal(existsSync(attempted), false, existsSync(attempted) ? readFileSync(attempted, 'utf8') : 'no fixture or subprocess was attempted');
  });
}
