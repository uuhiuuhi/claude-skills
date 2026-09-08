#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSprint } from './story-ledger.mjs';
import { parseDependsOn, shortKey } from './plan-dag.mjs';
import { readRecord } from './runtime/schema-migration.mjs';

export function selectStories(sprint, { from, to, stories } = {}) {
  const rows = parseSprint(sprint);
  const lookup = prefix => { const hits = rows.filter(r => r.key === prefix || r.key.startsWith(prefix + '-')); if (hits.length !== 1) throw new Error(`unknown/ambiguous story: ${prefix}`); return hits[0]; };
  let selected;
  if (stories) selected = [...new Set(stories.split(',').map(s => s.trim()).filter(Boolean))].map(lookup);
  else {
    const first = lookup(from), last = lookup(to ?? from);
    const a = rows.indexOf(first), b = rows.indexOf(last);
    if (b < a) throw new Error('story range must follow sprint order');
    selected = rows.slice(a, b + 1);
  }
  return selected.filter(r => r.status !== 'done').map(r => r.key);
}
export function checkManualDependencies(sprint, selected, texts) {
  const rows = parseSprint(sprint), ready = new Set(rows.filter(r => r.status === 'done').map(r => shortKey(r.key)));
  for (const key of selected) {
    const missing = parseDependsOn(texts[key] ?? '').filter(dep => !ready.has(dep));
    if (missing.length) throw new Error(`${key}: unresolved dependencies ${missing.join(', ')}`);
    ready.add(shortKey(key));
  }
  return selected;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opt = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
  try {
    const stories = selectStories(readFileSync('_bmad-output/implementation-artifacts/sprint-status.yaml', 'utf8'), { from: opt('from'), to: opt('to'), stories: opt('stories') });
    if (!stories.length) { console.log('all selected stories already done'); process.exit(0); }
    const art = '_bmad-output/implementation-artifacts';
    const texts = Object.fromEntries(readdirSync(art).filter(f => f.endsWith('.md')).map(f => [f.slice(0, -3), readFileSync(join(art, f), 'utf8')]));
    checkManualDependencies(readFileSync(join(art, 'sprint-status.yaml'), 'utf8'), stories, texts);
    const cfgPath = resolve('tools/auto/auto.config.json'), cfg = readRecord(readFileSync(cfgPath, 'utf8'));
    const stateDir = process.env.AUTO_BATCH_STATE_DIR || cfg.stateDir || join(homedir(), '.claude-auto', cfg.project);
    const flags = ['--stories', stories.join(','), '--stages', opt('stages') ?? 'create,dev,review', '--routing-config', cfgPath, '--model-state-dir', stateDir, '--auto-repair', String(cfg.quality?.autoRepair === false ? 0 : typeof cfg.quality?.autoRepair === 'number' ? cfg.quality.autoRepair : 3), '--wait-auth-min', opt('wait-auth-min') ?? '0'];
    if (process.argv.includes('--dry-run')) flags.push('--dry-run');
    console.log(`batch-24-multiag manual: ${stories.join(', ')}; stages=${opt('stages') ?? 'create,dev,review'}; commit/push=off`);
    const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'runtime/auto-story-pipeline.mjs'), ...flags], { stdio: 'inherit', windowsHide: true });
    process.exitCode = r.status ?? 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
