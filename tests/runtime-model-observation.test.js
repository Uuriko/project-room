import test from 'node:test';import assert from 'node:assert/strict';import{join}from'node:path';import{rmSync}from'node:fs';
import{createAcceptanceFixture}from'../scripts/acceptance-fixture.mjs';
import{createRoomServer}from'../server/http.mjs';
import{openRequestJournal,runRequestOnce,requestFailureDiagnostic}from'../client/request-runner.mjs';
import{roomCodexHost,createCodexRuntimeHost}from'../client/codex-runtime.mjs';
test('authorization timeout before runtime start must not report a model start',async t=>{
const f=createAcceptanceFixture(),server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));const db=openRequestJournal(join(f.directory,'metrics.sqlite'));
t.after(async()=>{db.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
f.store.dmConsents.request('commons','owner','producer','fixture');f.store.dmConsents.decide('commons','producer','owner','approve');
f.store.command(f.keys.owner,'commons',{id:'ask-metrics',type:'message.posted',data:{messageId:'metrics-question',requestKind:'reply',toMemberId:'producer',body:'Return one word'}});
const connection={version:1,origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'producer',token:f.keys.producer};
let rpcCalls=0,metrics;
const rpc={request(){rpcCalls++;throw Error('No runtime call permitted');},notify(){throw Error('No notify permitted');},subscribe(){throw Error('No subscribe permitted');}};
const execute=roomCodexHost({connection:{...connection,fetchImpl:async()=>{throw new DOMException('Synthetic authorization timeout','TimeoutError');}},db,rpc,cwd:f.directory,policy:{approvalPolicy:'never',sandbox:'read-only'}});
await assert.rejects(runRequestOnce({connection,requestMessageId:'metrics-question',db,execute,onMetrics:m=>{metrics=m;}}),/Synthetic authorization timeout/);
assert.equal(rpcCalls,0);assert.equal(db.prepare('select count(*) n from codex_runtime_attempts').get().n,0);assert.equal(db.prepare('select count(*) n from request_runs where response is null').get().n,1);
console.log(JSON.stringify({runtimeCalls:rpcCalls,runtimeAttempts:0,reportedModelStarts:metrics.modelStarts}));
assert.equal(metrics.phasesMs.model,0);
assert.equal(metrics.modelStarts,0,'No model RPC was made: entering execute is not a model start');
});

import { DatabaseSync } from 'node:sqlite';
const binding={origin:'http://room',roomId:'room',memberId:'agent',requestMessageId:'q',requestId:'host-q',attemptId:'attempt',roomCreatedEventId:'created',openingEventId:'opened'};
for (const failure of ['first-authorization','second-authorization','thread','turn','none','observer']) {
 test(`model observation boundary: ${failure}`,async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let auth=0,starts=0,observed=0;
  const timeout=new DOMException('private provider detail','TimeoutError');
  const rpc={notify(){},subscribe(){return()=>{};},async request(method){
   if(method==='initialize')return{};
   if(method==='thread/start'){if(failure==='thread')throw timeout;return{thread:{id:'thread'}};}
   if(method==='turn/start'){starts++;if(failure==='turn')throw timeout;return{turn:{id:'turn',status:'completed',items:[{type:'agentMessage',id:'answer',text:'done'}]}};}
   throw Error(method);
  }};
  const host=createCodexRuntimeHost({db,rpc,scope:binding,cwd:'/tmp/test',policy:{approvalPolicy:'never',sandbox:'read-only'},authorize:async()=>{
   auth++;if(failure==='first-authorization'&&auth===1||failure==='second-authorization'&&auth===2)throw timeout;
  }});
  const run=host({requestId:'host-q',request:{id:'q'},messages:[],preparation:{}},{binding,onModelStart(){observed++;if(failure==='observer')throw Error('observer');}});
  if(['none','observer'].includes(failure))assert.deepEqual(await run,{body:'done'});
  else await assert.rejects(run,error=>error===timeout);
  assert.equal(observed,starts);
  assert.equal(starts,['turn','none','observer'].includes(failure)?1:0);
  if(failure.includes('authorization'))assert.deepEqual(requestFailureDiagnostic(timeout),{failurePhase:'authorization',failureCode:'timeout'});
  assert.equal(JSON.stringify(requestFailureDiagnostic(timeout)).includes('private'),false);
 });
}
test('diagnostic output excludes arbitrary codes, messages and phases',()=>{
 assert.deepEqual(requestFailureDiagnostic({message:'secret',code:'secret',runtimePhase:'secret'}),{failurePhase:'unknown',failureCode:'execution_failed'});
});

for (const immutable of ["frozen", "readonly-phase"]) test(`authorization preserves ${immutable} original error`, async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const original = new Error("private authorization detail");
  if (immutable === "frozen") Object.freeze(original);
  else Object.defineProperty(original, "runtimePhase", { value: "existing", writable: false });
  let calls = 0;
  const host = createCodexRuntimeHost({ db, rpc: { request() { calls++; }, notify() {}, subscribe() { return () => {}; } }, scope: binding,
    cwd: "/tmp/test", policy: { approvalPolicy: "never", sandbox: "read-only" },
    authorize: async () => { throw original; } });
  await assert.rejects(host({ requestId: "host-q", request: { id: "q" }, messages: [], preparation: {} }, { binding }), error => error === original);
  assert.equal(calls, 0);
});
