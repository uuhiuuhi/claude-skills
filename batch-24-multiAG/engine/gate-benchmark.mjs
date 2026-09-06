#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeBenchFixture, runArm } from './bench.mjs';

export function compareGateCosts(baseline, candidate) {
  const median = values => { const v = [...values].sort((a,b) => a-b); if (!v.length || v.some(x => !Number.isFinite(x) || x < 0)) throw new Error('valid timings required'); const m = Math.floor(v.length/2); return v.length % 2 ? v[m] : (v[m-1]+v[m])/2; };
  const beforeMs = median(baseline.map(r => r.wallClockMs)), afterMs = median(candidate.map(r => r.wallClockMs));
  if (!beforeMs) throw new Error('baseline median must be positive');
  const increasePercent = (afterMs-beforeMs)*100/beforeMs;
  return { beforeMs, afterMs, increasePercent, thresholdPercent: 30, result: [...baseline,...candidate].some(r => r.exit !== 0) ? 'not-verified' : increasePercent >= 30 ? 'investigate' : 'pass', samples: { baseline: baseline.length, candidate: candidate.length }, limitation: 'Synthetic CLI fixture; real model latency is not measured.' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opt = (n, d) => { const i=process.argv.indexOf('--'+n); return i<0?d:process.argv[i+1]; };
  const oldEngine = resolve(opt('baseline-engine', '')), out = resolve(opt('out', 'gate-benchmark.json')), samples = Number(opt('samples', '3'));
  if (!process.argv.includes('--baseline-engine') || !Number.isInteger(samples) || samples < 3) throw new Error('--baseline-engine and --samples >= 3 required');
  const evidence = { schema: 'batch-24-multiag/gate-benchmark/1', baseline: [], candidate: [] };
  for (let i=0;i<samples;i++) for (const arm of ['baseline','candidate']) {
    const fx = makeBenchFixture('harness');
    try {
      if (arm === 'baseline') {
        cpSync(oldEngine, join(fx.proj, 'tools/auto'), { recursive: true, force: true });
        const r = spawnSync('git', ['-C', fx.proj, 'add', '-A'], { encoding: 'utf8' }); if(r.status!==0) throw new Error(r.stderr);
        const c = spawnSync('git', ['-C', fx.proj, 'commit', '-qm', 'baseline engine'], { encoding: 'utf8' }); if(c.status!==0) throw new Error(c.stderr);
      }
      console.log(`[COST] ${arm} ${i+1}/${samples}`);
      const result = runArm(fx);
      evidence[arm].push({ exit: result.exit, wallClockMs: result.wallClockMs, metrics: result.metrics, ...(result.exit !== 0 ? { failure: result.stdout.slice(-6000)+result.stderr } : {}) });
      mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(evidence,null,2)+'\n');
    } finally { rmSync(fx.T, { recursive: true, force: true }); }
  }
  evidence.comparison = compareGateCosts(evidence.baseline,evidence.candidate);
  writeFileSync(out, JSON.stringify(evidence,null,2)+'\n'); console.log(JSON.stringify(evidence.comparison));
  process.exitCode = evidence.comparison.result === 'pass' ? 0 : 1;
}
