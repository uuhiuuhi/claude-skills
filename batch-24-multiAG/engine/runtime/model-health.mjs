import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalModel, providerOf } from './model-policy.mjs';
import { redactSecrets } from './providers/redact.mjs';

// Immutable events avoid read/modify/write races between independent worker processes.
export function recordModelEvent(stateDir, { model, kind, now = Date.now(), startedAt = now, retryAt = null, role = '', story = '', detail = '' }) {
  if (!stateDir) return null;
  const dir = join(stateDir, 'model-health');
  mkdirSync(dir, { recursive: true });
  const spec = canonicalModel(model);
  const scope = ['auth', 'spend', 'transient'].includes(kind) ? providerOf(spec) : spec;
  const delays = { limit: 15 * 60_000, auth: 5 * 60_000, spend: 30 * 60_000, unavailable: 60 * 60_000, transient: 60_000, other: 5 * 60_000 };
  const deadline = Number(retryAt);
  const event = { schema: 'batch-24-multiag/model-health/1', id: randomUUID(), model: spec, scope, kind, at: now, startedAt,
    retryAt: kind === 'success' ? null : Number.isFinite(deadline) && deadline > now ? deadline : now + (delays[kind] ?? delays.other),
    role, story, detail: redactSecrets(String(detail)).slice(0, 500) };
  const file = join(dir, `${now}-${event.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(event) + '\n', { flag: 'wx' });
  renameSync(`${file}.tmp`, file);
  return event;
}

export function readModelHealth(stateDir, now = Date.now()) {
  const latest = new Map();
  if (stateDir) {
    let names = [];
    try { names = readdirSync(join(stateDir, 'model-health')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const e = JSON.parse(readFileSync(join(stateDir, 'model-health', name), 'utf8'));
      if (![1, 'batch-24-multiag/model-health/1'].includes(e.schema) || !Number.isFinite(e.at) || !e.scope) throw new Error('invalid model-health event');
      const prev = latest.get(e.scope);
      // A request already in flight when quota failed cannot clear that newer failure.
      const staleSuccess = e.kind === 'success' && prev?.kind !== 'success' && (e.startedAt ?? e.at) <= prev?.at;
      const losesTie = e.kind === 'success' && prev?.kind !== 'success' && e.at === prev?.at;
      if ((!prev || e.at >= prev.at) && !staleSuccess && !losesTie) latest.set(e.scope, e);
      // A later-started successful call proves provider-wide auth/spend/transport
      // failures are no longer active, but it says nothing about another model's quota.
      if (e.kind === 'success') {
        const provider = providerOf(e.model), failed = latest.get(provider);
        if (failed && (e.startedAt ?? e.at) > failed.at && ['auth', 'spend', 'transient'].includes(failed.kind)) latest.delete(provider);
      }
    }
  }
  return {
    events: [...latest.values()],
    blocked(model) {
      const spec = canonicalModel(model);
      return [latest.get(spec), latest.get(providerOf(spec))].some((e) => e && e.kind !== 'success' && e.retryAt > now);
    },
  };
}
