import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readCalls } from './fixtures/stub-claude.mjs';
import { readCodexCalls } from './fixtures/stub-codex.mjs';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'batch-fixture-contract-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={...process.env}; for(const k of Object.keys(env)) if(k.startsWith('STUB_')) delete env[k];
  delete env.NODE_TEST_CONTEXT;
  const run=(tool,prompt='',args=[],extra={})=>spawnSync(process.execPath,[fileURLToPath(new URL(`./fixtures/stub-${tool}.mjs`,import.meta.url)),...args],{cwd:root,env:{...env,...extra},input:prompt,encoding:'utf8',timeout:30000,windowsHide:true});
  return {root,run};
}
const plan='야간 배치 편성 계획 요청\n## 후보\n```json\n[{"key":"4-1-a","stages":["dev"]},{"key":"4-2-b"}]\n```';
test('fixture plan normal and boundary: ordering, stages, malformed candidates, invented stories',t=>{
  const {run}=fixture(t);
  const normal=JSON.parse(JSON.parse(run('claude',plan).stdout).result);
  assert.deepEqual(normal.batches.map(b=>b.stories[0]),['4-2-b','4-1-a']);
  assert.deepEqual(normal.batches[1].stages,['dev']);
  for(const prompt of ['야간 배치 편성 계획 요청','야간 배치 편성 계획 요청\n## 후보\n```json\ninvalid\n```','야간 배치 편성 계획 요청\n## 후보\n```json\n{}\n```']) assert.deepEqual(JSON.parse(JSON.parse(run('claude',prompt).stdout).result).batches,[]);
  const invented=JSON.parse(JSON.parse(run('claude',plan,[],{STUB_PLAN:'invented',STUB_PLAN_MODELS:'{"dev":"sonnet"}'}).stdout).result);
  assert.equal(invented.batches.at(-1).stories[0],'99-99-없는-스토리'); assert.equal(invented.batches[0].models.dev,'sonnet');
});
test('fixture plan failure: empty, invalid JSON, explicit error and secret stderr remain distinguishable',t=>{
  const {run}=fixture(t);
  assert.equal(run('claude',plan,[],{STUB_PLAN:'empty'}).stdout,'');
  assert.throws(()=>JSON.parse(run('claude',plan,[],{STUB_PLAN:'garbage'}).stdout));
  assert.equal(run('claude',plan,[],{STUB_PLAN:'error'}).status,1);
  const leak=run('claude',plan,[],{STUB_PLAN:'leak',STUB_LEAK_TOKEN:'SYNTHETIC_ONLY'});
  assert.equal(leak.status,1); assert.match(leak.stderr,/SYNTHETIC_ONLY/);
});
test('fixture CLI normal/failure: version, probe, unknown, repair and malformed call records',t=>{
  const {root,run}=fixture(t);
  assert.match(run('claude','',['--version'],{STUB_VERSION:'fixture-version'}).stdout,/fixture-version/);
  assert.equal(run('claude','ok').status,0);
  assert.equal(run('claude','unrecognized').status,1);
  assert.equal(run('claude','자동 수리').status,0); assert.ok(existsSync(join(root,'REPAIRED')));
  assert.match(run('codex','',['--version'],{STUB_CODEX_VERSION:'fixture-codex'}).stdout,/fixture-codex/);
  assert.match(run('codex','',['login','status']).stdout,/Logged in/);
  assert.deepEqual(readCalls(root),[]); assert.deepEqual(readCodexCalls(root),[]);
  for(const name of ['claude','codex']) writeFileSync(join(root,`${name}-calls.jsonl`),'invalid\n{"kind":"valid"}\n');
  assert.deepEqual(readCalls(root),[{raw:'invalid'},{kind:'valid'}]);
  assert.deepEqual(readCodexCalls(root),[{raw:'invalid'},{kind:'valid'}]);
  const file=join(root,'blocked-record-dir');writeFileSync(file,'file');
  assert.equal(run('claude','ok',[],{STUB_DIR:file}).status,0);
  assert.equal(run('codex','',['--version'],{STUB_DIR:file}).status,0);
});
test('fixture story normal/failure/boundary: missing story, declared files, human task and open review findings',t=>{
  const {root,run}=fixture(t),art=join(root,'_bmad-output/implementation-artifacts');mkdirSync(art,{recursive:true});
  assert.equal(run('claude','/bmad-dev-story missing').status,1);
  assert.equal(run('claude','/bmad-code-review missing').status,1);
  assert.equal(run('claude','/bmad-dev-story 4-1-a',[],{STUB_FAIL_STORY:'4-1-a'}).status,1);
  const story=join(art,'4-1-a.md');
  writeFileSync(story,'# Story\nStatus: in-progress\n- [ ] automated\n- [ ] 👤 human\n- [ ] [Review][Patch] old defect\n## Dev Notes\n### File List\n- `src/a.ts`\n');
  assert.equal(run('claude','/bmad-dev-story 4-1-a').status,0);
  assert.match(readFileSync(story,'utf8'),/- \[ \] 👤 human/);assert.match(readFileSync(story,'utf8'),/해소/);
  assert.ok(existsSync(join(root,'src/a.ts')));
  assert.equal(run('claude','/bmad-code-review 4-1-a',[],{STUB_REVIEW_FINDING:'4-1-a'}).status,0);
  assert.match(readFileSync(story,'utf8'),/Status: review/);assert.match(readFileSync(story,'utf8'),/\[Patch\]\[medium\]/);
  assert.equal(run('claude','/bmad-code-review 4-1-a').status,0);assert.match(readFileSync(story,'utf8'),/Status: done/);
  writeFileSync(story,'# Story\nStatus: backlog\n## Dev Notes\n');
  assert.equal(run('claude','/bmad-dev-story 4-1-a').status,0);
});
test('fixture Codex failure: limit and failed turns cannot resemble clean completion',t=>{
  const {run}=fixture(t);
  for(const env of [{STUB_CODEX_LIMIT:'1'},{STUB_CODEX_FAIL:'1'}]) {
    const r=run('codex','스토리 4-1-a',['exec'],env);
    assert.equal(r.status,1);const events=r.stdout.trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e=>e.type==='turn.failed'));assert.ok(!events.some(e=>e.type==='turn.completed'));
  }
});
test('fixture Codex normal/boundary: findings, stdout events, relative and absolute result paths',t=>{
  const {root,run}=fixture(t);
  const prompt='스토리 4-1-a\n`src/a.ts`\n- 변경 파일:\n  - src/b.ts\n  - (none)\nend';
  for(const out of ['relative.json',join(root,'absolute.json')]) {
    const r=run('codex',prompt,['exec','-o',out,'-s','read-only'],{STUB_CODEX_FINDING:'4-1-a',STUB_DIR:root});
    assert.equal(r.status,0,r.stderr);const events=r.stdout.trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e=>e.item?.command==='cat src/b.ts'));
    assert.equal(JSON.parse(readFileSync(out.startsWith(root)?out:join(root,out),'utf8')).verdict,'findings');
  }
  assert.equal(readCodexCalls(root).length,2);
  const clean=run('codex','',[]);assert.equal(clean.status,0);assert.equal(JSON.parse(clean.stdout.trim().split('\n').map(JSON.parse).find(e=>e.item?.type==='agent_message').item.text).verdict,'clean');
});
