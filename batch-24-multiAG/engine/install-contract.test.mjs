import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const skill = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(skill, 'install.mjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'batch-install-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const state = join(root, 'state');
  const tooling = join(project, 'tools', 'auto');
  mkdirSync(tooling, { recursive: true });
  mkdirSync(home);
  const pkg = JSON.stringify({ name: 'fixture-package', scripts: { test: 'original-test', qa: 'original-qa' } }, null, 2) + '\n';
  writeFileSync(join(project, 'package.json'), pkg);
  const audit = join(root, 'subprocesses.jsonl');
  const preload = join(root, 'install-subprocess-stub.mjs');
  // Run the real installer and filesystem operations. Only external capability probes
  // are replaced; every unrecognized subprocess fails before it can execute.
  writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
childProcess.spawnSync = (file, args) => {
  appendFileSync(process.env.INSTALL_TEST_AUDIT, JSON.stringify({ file, args }) + '\\n');
  if (file === 'install-test-codex.exe' && JSON.stringify(args) === '["--version"]')
    return { status: 0, stdout: 'codex fixture-version', stderr: '' };
  if (file === 'install-test-codex.exe' && JSON.stringify(args) === '["login","status"]')
    return { status: 0, stdout: 'Logged in using fixture', stderr: '' };
  if (file === 'powershell' && JSON.stringify(args) === '["-NoProfile","-NonInteractive","-Command","Get-ScheduledTask | Select-Object -ExpandProperty TaskName"]')
    return { status: 0, stdout: '', stderr: '' };
  throw new Error('Installer attempted an unauthorized subprocess');
};
syncBuiltinESMExports();
`);
  function install(args = []) {
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home, AUTO_BATCH_STATE_DIR: state,
      CODEX_BIN: 'install-test-codex.exe', INSTALL_TEST_AUDIT: audit,
      // Preserve the parent source-map/coverage preload in the installer child.
      NODE_OPTIONS: [process.env.NODE_OPTIONS || '', `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' '),
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.AUTO_STORY_RUNTIME;
    const result = spawnSync(process.execPath, [installer, ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const probes = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(probes, [
      { file: 'install-test-codex.exe', args: ['--version'] },
      { file: 'install-test-codex.exe', args: ['login', 'status'] },
      ...(process.platform === 'win32' ? [{ file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-ScheduledTask | Select-Object -ExpandProperty TaskName'] }] : []),
    ], 'installation must only request the explicitly stubbed capability probes');
    assert.equal(readFileSync(join(project, 'package.json'), 'utf8'), pkg, 'installer preserves project scripts byte for byte');
    assert.equal(existsSync(join(project, 'quality-adapter.config.json')), false, 'installer must not invent project test scope');
    assert.equal(existsSync(join(state, 'runtime-pin.json')), false, 'a reviewed commit cannot be invented during installation');
    return result;
  }
  return { root, project, tooling, state, install };
}

function assertPinnedPayload(tooling) {
  for (const [source, target] of [
    ['adapters/vitest-quality.mjs', 'adapters/vitest-quality.mjs'],
    ['engine/runtime-pin.mjs', 'runtime-pin.mjs'],
    ['engine/runtime/auto-story-pipeline.mjs', 'runtime/auto-story-pipeline.mjs'],
    ['engine/runtime/providers/index.mjs', 'runtime/providers/index.mjs'],
  ]) {
    assert.deepEqual(readFileSync(join(tooling, target)), readFileSync(join(skill, source)), `${target} must match the reviewed bundled source`);
  }
  assert.ok(readdirSync(join(tooling, 'adapters')).every(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs')), 'adapter tests and verification artifacts are not installed');
  assert.equal(existsSync(join(tooling, 'install-contract.test.mjs')), false);
}

test('fresh CLI installation requires a reviewed runtime pin and copies the real adapter without registering tasks', { timeout: 70000 }, t => {
  const f = fixture(t);
  f.install();
  const cfg = JSON.parse(readFileSync(join(f.tooling, 'auto.config.json'), 'utf8'));
  assert.deepEqual(cfg.runtimePin, { required: true });
  assert.equal(cfg.project, 'project');
  assert.equal(cfg.modelPolicy.enabled, true);
  const queue = JSON.parse(readFileSync(join(f.tooling, 'night-queue.json'), 'utf8'));
  assert.equal(queue.planned, 'auto');
  assert.deepEqual(queue.batches, []);
  assertPinnedPayload(f.tooling);
  assert.match(readFileSync(join(f.state, 'project-nonstop.xml'), 'utf8'), /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});

test('forced CLI upgrade preserves legacy config and queue bytes while replacing adapter and runtime pin tooling', { timeout: 70000 }, t => {
  const f = fixture(t);
  const cfg = '{\n  "project": "existing-fixture", "epicOrder": [8], "customSetting": {"retain": true}\n}\n';
  const queue = '{ "planned": "manual", "batches": [{"stories": ["8-1-example"]}] }\n';
  writeFileSync(join(f.tooling, 'auto.config.json'), cfg);
  writeFileSync(join(f.tooling, 'night-queue.json'), queue);
  mkdirSync(join(f.tooling, 'adapters'));
  mkdirSync(join(f.tooling, 'runtime'));
  writeFileSync(join(f.tooling, 'adapters', 'vitest-quality.mjs'), '// previous adapter\n');
  writeFileSync(join(f.tooling, 'runtime-pin.mjs'), '// previous runtime pin helper\n');
  writeFileSync(join(f.tooling, 'runtime', 'auto-story-pipeline.mjs'), '// previous runtime\n');
  f.install(['--force']);
  assert.equal(readFileSync(join(f.tooling, 'auto.config.json'), 'utf8'), cfg);
  assert.equal(Object.hasOwn(JSON.parse(cfg), 'runtimePin'), false, 'legacy fixture intentionally has no opt-in');
  assert.equal(readFileSync(join(f.tooling, 'night-queue.json'), 'utf8'), queue);
  assertPinnedPayload(f.tooling);
  assert.ok(existsSync(join(f.state, 'existing-fixture-nonstop.xml')), 'existing project name determines task artifact');
});
