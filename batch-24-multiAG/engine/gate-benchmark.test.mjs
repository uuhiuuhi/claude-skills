import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareGateCosts } from './gate-benchmark.mjs';
const sample = values => values.map(wallClockMs => ({ wallClockMs, exit: 0 }));
test('cost normal: medians resist one slow outlier', () => { const r=compareGateCosts(sample([90,100,900]),sample([100,110,120])); assert.equal(r.beforeMs,100); assert.equal(r.afterMs,110); assert.equal(r.result,'pass'); });
test('cost failure: 31 percent requires investigation, failed runs are unverified', () => { assert.equal(compareGateCosts(sample([100]),sample([131])).result,'investigate'); assert.equal(compareGateCosts([{wallClockMs:100,exit:1}],sample([100])).result,'not-verified'); });
test('cost boundary: exactly 30 percent requires investigation and invalid baseline is rejected', () => { assert.equal(compareGateCosts(sample([100,100]),sample([130,130])).result,'investigate'); assert.throws(()=>compareGateCosts([],sample([1]))); assert.throws(()=>compareGateCosts(sample([0]),sample([1]))); });
