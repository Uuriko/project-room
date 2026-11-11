import { run } from '../room-acp/src/run.mjs';
import { saveConnection } from '../room-acp/src/credentials.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { seedScopedInbox } from './helpers/scoped-inbox-source.mjs';
import { Bridge } from '../room-acp/src/bridge.mjs';
import { parseArgs } from '../room-acp/src/args.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StageObserver } from '../room-acp/src/stage-observer.mjs';
import { AgentHost } from '../room-acp/src/agent-host.mjs';

test('metadata observations preserve each batched signal start and deduplicate stages',()=>{
 let tick=10;const events=[];
 const tracker=new StageObserver({observe:e=>events.push(e),monotonic:()=>tick,wall:()=>1700000000000});
 tracker.received(['private-signal-A']);tick=20;tracker.received(['private-signal-B']);tick=40;
 tracker.mark(['private-signal-A','private-signal-B'],'first_observable_output','secret-operation','text');
 tracker.mark(['private-signal-A'],'first_observable_output','secret-operation','text');
 assert.deepEqual(events.filter(e=>e.stage==='first_observable_output').map(e=>e.elapsedMs),[30,20]);
 assert.equal(events.length,4);
 const serialized=JSON.stringify(events);
 for(const forbidden of ['private-signal','secret-operation'])assert.ok(!serialized.includes(forbidden));
 assert.equal(events[0].observedAt,'2023-11-14T22:13:20.000Z');
 assert.equal(events[2].operationHash,events[3].operationHash);
 assert.match(events[0].signalHash,/^[a-f0-9]{64}$/);
});
test('observer failures are nonfatal and disabled observers retain no identifiers',async()=>{
 const disabled=new StageObserver();disabled.received(['secret']);assert.equal(disabled.signals.size,0);
 for(const observe of [()=>{throw Error('failure');},async()=>{throw Error('failure');}]){
  const tracker=new StageObserver({observe});tracker.received(['one']);tracker.mark(['one'],'durable_queued');
 }
 await new Promise(resolve=>setImmediate(resolve));
});
test('bounded observation capacity does not evict or restart in-flight timing',()=>{
 const events=[],tracker=new StageObserver({observe:e=>events.push(e),maxSignals:1});
 tracker.received(['one','two']);tracker.received(['one']);tracker.mark(['one','two'],'reply_posted');
 assert.deepEqual(events.map(e=>e.stage),['signal_received','reply_posted']);
});
function hostWithUpdates(updates,{fail=false}={}){
 const host=new AgentHost({candidate:{}});
 host.process={peer:{request:async()=>{
  for(const update of updates)host.recorders.get('session')?.update(update);
  if(fail)throw Error('host failure');
  return{stopReason:'end_turn'};
 }}};
 return host;
}
test('only nonempty model text or a tool call counts, once per prompt',async()=>{
 for(const kind of ['text','tool']){
  const events=[];
  const excluded=[{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private thought'}},
   {sessionUpdate:'notice',description:'private-path'}, {sessionUpdate:'plan',entries:[{content:'plan'}]},
   {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'  '}}, {sessionUpdate:'tool_call_update',toolCallId:'old'}];
  const actual=kind==='text'?{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'private result'}}:{sessionUpdate:'tool_call',toolCallId:'private-tool',title:'private title'};
  const host=hostWithUpdates([...excluded,actual,actual]);
  await host.prompt('thread',[],{sessionId:'session',onFirstOutput:k=>events.push(k)});
  assert.deepEqual(events,[kind]);
  assert.equal(host.recorders.has('session'),false);
  assert.ok(!JSON.stringify(events).includes('private'));
 }
});
test('empty or failed prompt never invents first output and callbacks cannot break a turn',async()=>{
 const events=[],host=hostWithUpdates([{sessionUpdate:'notice'}],{fail:true});
 await assert.rejects(host.prompt('thread',[],{sessionId:'session',onFirstOutput:k=>events.push(k)}),/host failure/);
 assert.deepEqual(events,[]);
 const healthy=hostWithUpdates([{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer'}}]);
 assert.equal((await healthy.prompt('thread',[],{sessionId:'session',onDispatched:()=>{throw Error('observer');},onFirstOutput:()=>{throw Error('observer');}})).recorder.text,'answer');
});
test('session loading does not count replayed history as prompt output',async()=>{
 const host=new AgentHost({candidate:{},savedSessions:{get:()=> 'saved'}});
 host.capabilities={loadSession:true};
 host.process={peer:{request:async()=>{host.recorders.get('saved')?.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old history'}});}}};
 const session=await host.session('thread');assert.equal(session.loaded,true);
 assert.equal(host.recorders.size,0);
});

test('stage CLI is explicit and only offered on the implemented receiver path',()=>{
 assert.equal(parseArgs(['run']).observeStages,undefined);
 assert.equal(parseArgs(['run','--observe-stages']).observeStages,true);
 assert.throws(()=>parseArgs(['run','--observe-stages','--receiver-policy','disabled']),/applies only/);
 assert.throws(()=>parseArgs(['doctor','--observe-stages']),/applies only/);
});
async function bridgeFixture(t,{postFails=false,queueSaveFails=false}={}){
 const store=new RoomStore(':memory:'),seeded=seedScopedInbox(store),server=createRoomServer({store}),home=mkdtempSync(join(tmpdir(),'stage-observe-'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(home,{recursive:true,force:true});});
 const events=[];let prompts=0;
 const signalId='private-test-signal';
 const bridge=new Bridge({connection:{apiBase:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'worker',credential:seeded.token,hostId:'test'},env:{ROOM_ACP_HOME:home},observeStage:e=>{
  if(e.stage==='durable_queued')assert.equal(bridge.chatReceipts.read(bridge.chatReceipts.key(signalId)).phase,'queued');
  if(e.stage==='durable_result_saved')assert.equal(bridge.chatReceipts.read(bridge.chatReceipts.key(signalId)).phase,'result');
  if(e.stage==='reply_posted')assert.equal(bridge.chatReceipts.read(bridge.chatReceipts.key(signalId)).phase,'posted');
  events.push(e);
 },host:{session:async()=>({sessionId:'synthetic',created:true}),prompt:async(_thread,_prompt,options)=>{prompts++;options.onDispatched();options.onFirstOutput('text');return{recorder:{text:'Private result',tools:new Map(),plan:[]},stopReason:'end_turn'};}}});
 await bridge.refreshRoom();await bridge.lease();
 if(postFails)bridge.room.post=async()=>{throw Error('unknown delivery');};
 if(queueSaveFails)bridge.chatReceipts.begin=()=>{throw Error('disk failed');};
 const wake={signalId,messageId:'mention',author:'owner',body:'private source'};
 bridge.stageObserver.received([signalId]);
 return {bridge,events,wake,prompts:()=>prompts};
}
test('durable stages follow saves and retry does not report another turn',async t=>{
 const f=await bridgeFixture(t);await f.bridge.turn('mention',[f.wake]);
 assert.deepEqual(f.events.map(e=>e.stage),['signal_received','durable_queued','session_preparing','session_ready','prompt_dispatch_attempt','first_observable_output','durable_result_saved','reply_posted']);
 await f.bridge.turn('mention',[f.wake]);assert.equal(f.prompts(),1);assert.equal(f.events.length,8);
 for(const text of ['private-test-signal','Private result','private source'])assert.ok(!JSON.stringify(f.events).includes(text));
});
test('unknown delivery never reports posted and failed queue save never reports durable queue',async t=>{
 const f=await bridgeFixture(t,{postFails:true});await f.bridge.turn('mention',[f.wake]);
 assert.ok(f.events.some(e=>e.stage==='durable_result_saved'));
 assert.ok(!f.events.some(e=>e.stage==='reply_posted'));
 const g=await bridgeFixture(t,{queueSaveFails:true});await g.bridge.turn('mention',[g.wake]);
 assert.deepEqual(g.events.map(e=>e.stage),['signal_received']);assert.equal(g.prompts(),0);
});

test('concurrent sessions attribute first output to the current prompt only',async()=>{
 const host=new AgentHost({candidate:{}}),events=[];
 host.process={peer:{request:async(_method,{sessionId})=>{
  await new Promise(resolve=>setImmediate(resolve));
  host.recorders.get(sessionId)?.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'private'}});
  return {stopReason:'end_turn'};
 }}};
 await Promise.all(['a','b'].map(sessionId=>host.prompt(sessionId,[],{sessionId,onFirstOutput:kind=>events.push([sessionId,kind])})));
 assert.deepEqual(events.sort(),[['a','text'],['b','text']]);assert.equal(host.recorders.size,0);
});

test('opt-in run sends stage JSON to its stderr sink, default run sends none',async t=>{
 const home=mkdtempSync(join(tmpdir(),'stage-cli-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const env={ROOM_ACP_HOME:home};saveConnection({apiBase:'https://example.test',roomId:'r',memberId:'existing',credential:'private-fixture',hostId:'existing-host'},env);
 for(const enabled of [false,true]){
  const lines=[];
  assert.equal(await run({observeStages:enabled},{env,print(){},candidate:{label:'test-only'},writeStage:line=>lines.push(JSON.parse(line)),onBridge:bridge=>{
   bridge.run=async()=>{bridge.stageObserver.received(['private-signal']);return 'stopped';};
  }}),0);
  assert.equal(lines.length,enabled?1:0);
  if(enabled){assert.equal(lines[0].event,'agent_stage');assert.equal(lines[0].stage,'signal_received');assert.ok(!JSON.stringify(lines).includes('private'));}
 }
});
