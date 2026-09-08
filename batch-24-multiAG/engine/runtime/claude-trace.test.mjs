import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseClaudeTrace,buildClaudeCommand,runClaudeWorker} from './providers/claude.mjs';
const use=(id,name,input)=>({type:'assistant',message:{content:[{type:'tool_use',id,name,input}]}});
const done=(id,is_error=false)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error,content:'actual result'}]}});
const stream=events=>events.map(e=>JSON.stringify(e)).join('\n');
test('Claude trace normal: only matched successful Read and Bash calls are recorded',()=>{
  const raw=stream([use('r','Read',{file_path:'src/a.ts'}),done('r'),done('r'),use('b','Bash',{command:'cat src/b.ts'}),done('b')]);
  assert.deepEqual(parseClaudeTrace(raw),{filePaths:['src/a.ts'],commandList:['cat src/b.ts']});
  const result=runClaudeWorker({file:'claude',argv:[],prompt:'review',timeoutMs:1000,spawn:()=>({status:0,stdout:raw})});
  assert.deepEqual(result.events.filePaths,['src/a.ts']);
});
test('Claude trace failure: error results, unmatched tools and assistant claims prove no reads',()=>{
  const raw=stream([use('r','Read',{file_path:'src/a.ts'}),done('r',true),done('unknown'),{type:'assistant',message:{content:[{type:'text',text:'I read src/a.ts'}]}},use('w','Write',{file_path:'src/a.ts'}),done('w')]);
  assert.deepEqual(parseClaudeTrace(raw),{filePaths:[],commandList:[]});
});
test('Claude trace boundary: malformed/plain output and empty input have no evidence; stream is review opt-in',()=>{
  assert.deepEqual(parseClaudeTrace('not JSON\n{}\nnull'),{filePaths:[],commandList:[]});
  assert.deepEqual(parseClaudeTrace(),{filePaths:[],commandList:[]});
  const normal=buildClaudeCommand(),review=buildClaudeCommand({stream:true});
  assert.ok(!normal.argv.includes('--output-format'));assert.ok(review.argv.includes('stream-json'));assert.ok(review.argv.includes('--verbose'));assert.match(review.display,/stream-json/);
});
