import { createHash } from 'node:crypto';
import { maskJavaScript } from './quality-rules.mjs';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const endpointKey = e => `${e.source}\0${e.method}\0${e.route}`;
export const sourceHash = text => createHash('sha256').update(text).digest('hex');
const valid = e => e && typeof e.source === 'string' && METHODS.includes(e.method) && typeof e.route === 'string' && e.route.startsWith('/');

// Static discovery is intentionally narrow. Unsupported frameworks require a reviewed,
// source-hash-bound inventory in project config; a report cannot declare its own scope.
export function discoverApiSurface({ sources = {}, inventory = [] } = {}) {
  const endpoints = [], unresolved = [];
  for (const [source, text] of Object.entries(sources)) {
    const code = maskJavaScript(text).code;
    const found = [];
    let uncertain = /\brouter\./.test(code);
    const calls = [...code.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete|head|options|all|use|route)\s*\(/g)];
    for (const call of calls) {
      const method = call[1].toUpperCase();
      const literal = /^\s*(['"])([^'"\r\n]+)\1\s*,/.exec(text.slice(call.index + call[0].length));
      if (!METHODS.includes(method) || !literal || !literal[2].startsWith('/')) { uncertain = true; continue; }
      found.push({ source, method, route: literal[2] });
    }
    // Next app-router paths map directly to routes, with dynamic segments preserved.
    const routeFile = /(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]s$/.exec(source);
    const exports = [...code.matchAll(/\bexport\s+(?:(?:async\s+)?function|const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
    if (exports.length) {
      if (!routeFile || /\([^/]*\)|@/.test(routeFile[1])) uncertain = true;
      else for (const item of exports) found.push({ source, method: item[1], route: '/' + routeFile[1].replace(/\/$/, '') });
    }
    // Other handler/mount syntaxes must be explicitly inventoried, not silently ignored.
    if (/\b(?:serve|handle|addEventListener)\s*\(|\.route\s*\(|\.method\b|\bexport\s+default\b/.test(code)) uncertain = true;
    const entry = inventory.find(item => item?.source === source);
    if (entry) {
      if (entry.sourceSha256 !== sourceHash(text) || !Array.isArray(entry.endpoints) || !entry.endpoints.length || !entry.endpoints.every(e => valid({ ...e, source }))) {
        unresolved.push({ source, why: 'invalid or stale reviewed endpoint inventory' }); continue;
      }
      const explicit = entry.endpoints.map(e => ({ source, method: e.method, route: e.route }));
      if (found.some(e => !explicit.some(candidate => endpointKey(candidate) === endpointKey(e)))) {
        unresolved.push({ source, why: 'reviewed inventory omits a statically discovered endpoint' }); continue;
      }
      endpoints.push(...explicit);
    } else if (!found.length || uncertain) unresolved.push({ source, why: 'API surface requires a reviewed source-hash-bound endpoint inventory' });
    else endpoints.push(...found);
  }
  return { result: unresolved.length ? 'not-verified' : 'pass', endpoints: [...new Map(endpoints.map(e => [endpointKey(e), e])).values()], unresolved };
}

export function missingEndpoints(expected, actual) {
  if (!Array.isArray(expected) || expected.some(e => !valid(e))) return { invalidScope: true, missing: expected ?? [] };
  return { invalidScope: false, missing: expected.filter(e => !actual.some(row => valid(row) && endpointKey(row) === endpointKey(e))) };
}
