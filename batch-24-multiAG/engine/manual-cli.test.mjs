import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli=fileURLToPath(new URL('./finish-stories.mjs',import.meta.url));
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'manual-cli-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(p,s)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),s);};
  put('package.json','{"name":"manual-fixture","scripts":{}}');
  put('tools/auto/auto.config.json',JSON.stringify({project:'manual-fixture',stateDir:join(root,'state'),modelPolicy:{enabled:true},providers:{claude:{enabled:true},codex:{enabled:true}},quality:{autoRepair:false}}));
  put('.claude/pipeline-settings.json','{"permissions":{"deny":["Bash(git commit:*)","Bash(git push:*)"]}}');
  put('_bmad-output/implementation-artifacts/sprint-status.yaml','development_status:\n  4-1-a: ready-for-dev\n  4-2-b: done\n');
  put('_bmad-output/implementation-artifacts/4-1-a.md','# Story 4.1\nStatus: ready-for-dev\n## Tasks\n- [ ] Implement\n## File List\n- `src/a.ts`\n');
  for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@test'],['add','.'],['commit','-qm','initial']]) {
    const r=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
  }
  const env={...process.env,CLAUDE_BIN:process.execPath,CODEX_BIN:process.execPath};delete env.NODE_TEST_CONTEXT;delete env.AUTO_STORY_RUNTIME;
  const run=args=>spawnSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8',timeout:30000,windowsHide:true});
  return {root,put,run};
}
test('manual CLI normal: dry range resolves real stories without marking work complete',t=>{
  const f=fixture(t),r=f.run(['--from','4-1','--to','4-2','--dry-run']);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/batch-24-multiag manual: 4-1-a/);assert.match(r.stdout,/commit\/push=off/);
  const p=join(f.root,'_bmad-output/implementation-artifacts/auto-pipeline-logs/state.json');
  assert.equal(existsSync(p),false,'dry run created completion state');
});
test('manual CLI failure: unresolved dependency prevents worker launch',t=>{
  const f=fixture(t);f.put('_bmad-output/implementation-artifacts/4-1-a.md','Depends-On: 3-9\n');const r=f.run(['--from','4-1']);
  assert.equal(r.status,1);assert.match(r.stderr,/unresolved dependencies/);assert.ok(!r.stdout.includes('BATCH START'));
});
test('manual CLI boundary: completed range exits without runtime and invalid selection fails',t=>{
  const f=fixture(t);const r=f.run(['--from','4-2']);assert.equal(r.status,0);assert.match(r.stdout,/already done/);
  const bad=f.run(['--from','99-1']);assert.equal(bad.status,1);assert.match(bad.stderr,/unknown/);
});
