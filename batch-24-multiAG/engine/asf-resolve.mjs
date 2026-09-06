import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
// Compatibility name; the installed runtime never depends on a global skill.
export function asfCandidates(name, { here = HERE } = {}) {
  if (!name || name.includes('..') || /^[\\/]/.test(name)) throw new Error('invalid runtime module');
  const runtime = process.env.AUTO_STORY_RUNTIME ? resolve(process.env.AUTO_STORY_RUNTIME) : join(here, 'runtime');
  return [join(runtime, name)];
}
export function resolveAsf(name, opts) {
  const [path] = asfCandidates(name, opts);
  if (!existsSync(path)) throw new Error(`batch-24-multiag pinned runtime missing: ${path}; reinstall canonical skill`);
  return pathToFileURL(path).href;
}
