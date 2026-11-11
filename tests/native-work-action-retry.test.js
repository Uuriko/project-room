import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { setTier } from '../server/autonomy-tiers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildWorkCommand, submitWorkAction } from '../client/work-actions.mjs';
import { PassThrough } from 'node:stream';
import { serveRoomMcp } from '../client/mcp-stdio.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for(const operation of ['room_accept_work','room_start_work','room_submit_text_result','room_record_verification'])for(const explicit of [false,true])test(`${operation}: lost ack ${explicit?'explicit':'implicit'} revision replay`,async t=>{
 const f=createAcceptanceFixture({dmConsent:true});
 const server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const transcript=[], agents={};
 for(const actor of ['producer','reviewer']) {
   const input=new PassThrough(),output=new PassThrough(),pending=new Map();let buffer='',sequence=0;
   output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const r=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(r.id)?.(r);pending.delete(r.id);}});
   const client=new RoomAgentClient({origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:actor,token:f.keys[actor]});
   const originalCommand=client.command.bind(client);client.command=(command,options)=>{transcript.push({actor,httpCommand:command});return originalCommand(command,options);};
   serveRoomMcp({client,roomId:'commons',memberId:actor,input,output});
   const rpc=(method,params)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
   await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'journey-test',version:'1'}});
   input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
   agents[actor]=(name,args)=>rpc('tools/call',{name,arguments:args});t.after(()=>input.end());
 }
 const raw=async(actor,name,args={})=>{const body=await agents[actor](name,args);transcript.push({actor,name,body});return body;};
 const call=async(actor,name,args={})=>{const body=await raw(actor,name,args);assert.equal(body.error,undefined,JSON.stringify(body));assert.notEqual(body.result?.isError,true,JSON.stringify(body));return body.result.structuredContent;};
 const workItemId='test-handoff', work=()=>call('producer','room_read_work',{workItemId});
 await call('producer','room_check_access');await call('producer','get_room_context');await call('producer','room_read_inbox');
 assert.ok((await call('producer','room_list_work',{focus:'needs_me'})).work.some(w=>w.id===workItemId));
 assert.equal((await work()).next.action,'accept');

 const actor=operation==='room_record_verification'?'reviewer':'producer';
 if(operation!=='room_accept_work')await call('producer','room_accept_work',{workItemId,expectedRevision:(await work()).work.revision});
 if(['room_submit_text_result','room_record_verification'].includes(operation))await call('producer','room_start_work',{workItemId,expectedRevision:(await work()).work.revision});
 let args={workItemId,requestId:'lost-ack-'+operation};
 if(['room_submit_text_result','room_record_verification'].includes(operation)){
  const posted=await call('producer','room_post_draft',{requestId:'draft',packetId:'draft',workItemId,basisRevision:(await work()).work.revision,body:'Owner: human owner. Duration: 15 minutes.'});
  const preview=await call('producer','room_read_result',{workItemId,draftMessageId:posted.messageId});const e=preview.result.text;
  const completion={workItemId,requestId:'completion',summary:'Complete agenda',nextAction:'Review exact text',producerId:'producer',evidenceMessageId:e.messageId,evidenceMessageEventId:e.messageEventId,evidenceVersion:e.evidenceVersion,previousCompletionEventId:preview.current.completionEventId};
  if(operation==='room_submit_text_result')args={...completion,requestId:args.requestId};
  else {await call('producer','room_submit_text_result',{...completion,expectedRevision:(await work()).work.revision});const exact=await call('reviewer','room_read_result',{workItemId});args={...args,result:'pass',completionEventId:exact.result.receipt.eventId,evidenceVersion:exact.result.text.evidenceVersion,summary:'Exact evidence checked'};}
 }
 if(explicit)args.expectedRevision=(await work()).work.revision;
 const first=await call(actor,operation,args); // The simulated caller loses this acknowledgement, retaining only original args.
 const before=f.store.room('commons').sequence;const retry=await raw(actor,operation,args);const after=f.store.room('commons').sequence;
 assert.equal(after,before,'retry must not duplicate side effects');
 assert.notEqual(retry.result?.isError,true,'exact original retry must recover saved receipt');
 assert.equal(retry.result.structuredContent.duplicate,true);assert.equal(retry.result.structuredContent.eventId,first.eventId);

});

function replayFixture({ action = 'room_accept_work', input = { workItemId: 'task', requestId: 'stable' }, revision = 0 } = {}) {
 const identity = { roomId: 'commons', memberId: 'producer' };
 const original = buildWorkCommand(action, input, identity, { expectedRevision: revision });
 const event = { id: 'saved-event', roomId: identity.roomId, actorId: identity.memberId, type: original.type,
   at: '2026-11-01T00:00:00Z', causationId: null,
   idempotencyKey: createHash('sha256').update(`${identity.memberId}:${original.id}`).digest('hex'), data: structuredClone(original.data) };
 const conflict = () => Object.assign(new Error('Different command'), { code: 'idempotency_conflict', status: 409 });
 const receipt = { sequence: 1, event, duplicate: true };
 const reads = [], commands = [];
 const client = {
  workContext: async () => ({ evaluatedThrough: 1, work: { revision: revision + 1 } }),
  changes: async (...args) => { reads.push(args); return { events: [{ sequence: 1, event }], next: 1, hasMore: false }; },
  command: async command => { commands.push(command);if (JSON.stringify(command) !== JSON.stringify(original)) throw conflict();return receipt; }
 };
 return { identity, original, event, receipt, client, reads, commands, conflict, input, action };
}

test('reconciliation reconstructs only revision and passes signal through both boundaries', async () => {
 const f=replayFixture(), signal=new AbortController().signal;
 const result=await submitWorkAction(f.client,f.identity,f.action,f.input,{signal});
 assert.equal(result.duplicate,true);assert.equal(result.currentStateVerified,false);
 assert.equal(f.commands.length,2);assert.deepEqual(f.commands[1],f.original);
 assert.equal(f.reads[0][2].signal,signal);
});

for (const change of ['intent','type','work','explicit-revision']) test(`changed ${change} stays refused without repaired write`, async () => {
 const f=replayFixture(change==='intent'?{action:'room_start_work',input:{workItemId:'task',requestId:'stable',resolvedBlocker:'Original reason'}}:{});let action=f.action;const input={...f.input};
 if(change==='intent')input.resolvedBlocker='Different intent';
 if(change==='type')action='room_start_work';
 if(change==='work')input.workItemId='other-task';
 if(change==='explicit-revision')input.expectedRevision=1;
 await assert.rejects(submitWorkAction(f.client,f.identity,action,input),{code:'idempotency_conflict'});
 assert.equal(f.commands.length,1);
 if(change==='explicit-revision')assert.equal(f.reads.length,0);
});

for (const mode of ['missing','redacted','different-member','different-room','wrong-key','malformed-page','nonadvancing-page','truncated-bound','read-error']) test(`receipt ${mode} fails closed`, async () => {
 const f=replayFixture();let calls=0;
 f.client.changes=async(after)=>{
  calls++;
  if(mode==='read-error')throw Object.assign(new Error('History unavailable'),{code:'unavailable'});
  if(mode==='missing')return {events:[],next:1,hasMore:false};
  if(mode==='truncated-bound')return {events:[],next:after+100,hasMore:true};
  if(mode==='malformed-page')return {events:[],next:1,hasMore:'false'};
  if(mode==='nonadvancing-page')return {events:[],next:after,hasMore:true};
  const receiptEvent=structuredClone(f.event);
  if(mode==='redacted')delete receiptEvent.data.expectedRevision;
  if(mode==='different-member')receiptEvent.actorId='other';
  if(mode==='different-room')receiptEvent.roomId='elsewhere';
  if(mode==='wrong-key')receiptEvent.idempotencyKey='0'.repeat(64);
  return {events:[{sequence:1,event:receiptEvent}],next:1,hasMore:false};
 };
 await assert.rejects(submitWorkAction(f.client,f.identity,f.action,f.input),{code:mode==='read-error'?'unavailable':'idempotency_conflict'});
 assert.equal(f.commands.length,1);if(mode==='truncated-bound')assert.equal(calls,5);
});

test('later authenticated receipt page succeeds without treating omitted earlier events as absence', async () => {
 const f=replayFixture(),pages=[];f.receipt.sequence=201;
 f.client.changes=async(after)=>{pages.push(after);return after===0?{events:[],next:200,hasMore:true}:{events:[{sequence:201,event:f.event}],next:201,hasMore:false};};
 const result=await submitWorkAction(f.client,f.identity,f.action,f.input);
 assert.equal(result.duplicate,true);assert.deepEqual(pages,[0,200]);assert.equal(f.commands.length,2);
});

test('reconciliation never bypasses reauthentication after history read', async () => {
 const f=replayFixture();let writes=0;
 f.client.command=async()=>{writes++;throw writes===1?f.conflict():Object.assign(new Error('Revoked'),{code:'access_ended',status:401});};
 await assert.rejects(submitWorkAction(f.client,f.identity,f.action,f.input),{code:'access_ended'});assert.equal(writes,2);
});

test('non-idempotency errors do not trigger history reads or retry', async () => {
 const f=replayFixture();f.client.command=async()=>{throw Object.assign(new Error('Stale'),{code:'command_rejected',status:409});};
 await assert.rejects(submitWorkAction(f.client,f.identity,f.action,f.input),{code:'command_rejected'});assert.equal(f.reads.length,0);
});

async function httpFixture(t) {
 const f=createAcceptanceFixture(),server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const identity={roomId:'commons',memberId:'producer'};
 const fresh=()=>new RoomAgentClient({origin:`http://127.0.0.1:${server.address().port}`,...identity,token:f.keys.producer});
 return {...f,identity,fresh};
}

test('fresh native client recovers a discarded acknowledgement from the latest durable HTTP window', async t => {
 const f=await httpFixture(t);
 for(let i=0;i<110;i++){const guest=f.store.room('commons').state.members.guest;f.store.command(f.keys.owner,'commons',{id:'pad-'+i,type:'member.access_changed',data:{memberId:'guest',expectedMemberRevision:guest.revision,active:true,permissions:guest.permissions}});}
 const input={workItemId:'test-handoff'}; // derived ID must survive fresh client too
 await submitWorkAction(f.fresh(),f.identity,'room_accept_work',input); // discarded ack
 const sequence=f.store.room('commons').sequence,client=f.fresh(),pages=[],changes=client.changes.bind(client);
 client.changes=(after,limit,options)=>{pages.push(after);return changes(after,limit,options);};
 const recovered=await submitWorkAction(client,f.identity,'room_accept_work',input);
 assert.equal(recovered.duplicate,true);assert.equal(f.store.room('commons').sequence,sequence);assert.equal(pages.length,1);assert.ok(pages[0]>0);
});

test('HTTP revocation after conflict prevents receipt recovery with fresh client', async t => {
 const f=await httpFixture(t),input={workItemId:'test-handoff',requestId:'revoked-retry'};
 await submitWorkAction(f.fresh(),f.identity,'room_accept_work',input);
 const client=f.fresh(),command=client.command.bind(client);let attempts=0;
 client.command=async(...args)=>{attempts++;try{return await command(...args);}catch(error){
  const member=f.store.room('commons').state.members.producer;
  f.store.command(f.keys.owner,'commons',{id:'revoke',type:'member.access_changed',data:{memberId:'producer',expectedMemberRevision:member.revision,active:false,permissions:member.permissions}});
  throw error;
 }};
 await assert.rejects(submitWorkAction(client,f.identity,'room_accept_work',input));assert.equal(attempts,1);
 assert.equal(f.store.room('commons').state.workItems['test-handoff'].state,'accepted');
});


test('recent lost acknowledgement in a 24000-event room uses a bounded latest window', async t => {
 const store=new RoomStore(':memory:'),seed=initialRoom();
 seed.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'producer',displayName:'Synthetic producer',kind:'agent',accountableHumanId:'owner',permissions:['accept_work','complete_work']}}));
 for(let i=0;i<24000;i++)seed.push(event({roomId:'commons',actorId:'owner',type:'member.access_changed',data:{memberId:'producer',expectedMemberRevision:i,active:true,permissions:['accept_work','complete_work']}}));
 seed.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'large-room-task',title:'Synthetic latest task',definitionOfDone:'One result',accountableMemberId:'producer',mode:'read',independentVerificationRequired:false,ownerDecisionRequired:false}}));
 store.initialize(seed);setTier(store.db,'commons','producer','t2_standard',{updatedBy:'owner',nowMs:store.now()});
 const token=store.issueAccessKey('commons','producer'),server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
 const identity={roomId:'commons',memberId:'producer'},fresh=()=>new RoomAgentClient({origin:`http://127.0.0.1:${server.address().port}`,...identity,token});
 const input={workItemId:'large-room-task',requestId:'recent-lost-ack'};
 await submitWorkAction(fresh(),identity,'room_accept_work',input);
 const before=store.room('commons').sequence,client=fresh(),changes=client.changes.bind(client),pages=[];
 client.changes=(after,limit,options)=>{pages.push(after);return changes(after,limit,options);};
 let recovered;try {recovered=await submitWorkAction(client,identity,'room_accept_work',input);}finally{console.log('LARGE_ROOM_RETRY '+JSON.stringify({before,pages,historyCalls:pages.length,after:store.room('commons').sequence}));}
 assert.equal(recovered.duplicate,true);assert.equal(store.room('commons').sequence,before);assert.ok(pages[0]>23000);assert.ok(pages.length<=2);
});


for(const mode of ['older-window','visibility-gap','concurrent-tail'])test(`bounded recent lookup handles ${mode}`,async()=>{
 const f=replayFixture(),pages=[];f.client.workContext=async()=>({evaluatedThrough:1000,work:{revision:1}});
 const sequence=mode==='older-window'?850:mode==='visibility-gap'?720:1101;f.receipt.sequence=sequence;
 f.client.changes=async(after)=>{pages.push(after);
  if(mode==='concurrent-tail'&&after<1100)return {events:[],next:after+100,hasMore:true};
  return {events:sequence>after?[{sequence,event:f.event}]:[],next:Math.max(1000,sequence),hasMore:false};
 };
 const result=await submitWorkAction(f.client,f.identity,f.action,f.input);assert.equal(result.duplicate,true);
 assert.deepEqual(pages,mode==='older-window'?[900,800]:mode==='visibility-gap'?[900,800,700]:[900,1000,1100]);assert.ok(pages.length<=5);
});

test('receipt older than the bounded recent window remains original conflict after five reads',async()=>{
 const f=replayFixture(),pages=[];f.client.workContext=async()=>({evaluatedThrough:24000,work:{revision:1}});
 f.client.changes=async after=>{pages.push(after);return {events:[],next:24000,hasMore:false};};
 await assert.rejects(submitWorkAction(f.client,f.identity,f.action,f.input),{code:'idempotency_conflict'});
 assert.deepEqual(pages,[23900,23800,23700,23600,23500]);assert.equal(f.commands.length,1);
});

for(const horizon of [undefined,-1,1.5,Number.MAX_SAFE_INTEGER+1,'24000'])test(`unavailable authenticated horizon ${horizon} never falls back to event-body horizon`,async()=>{
 const f=replayFixture();f.event.evaluatedThrough=24000;f.client.workContext=async()=>({evaluatedThrough:horizon,work:{revision:1}});
 await assert.rejects(submitWorkAction(f.client,f.identity,f.action,f.input),{code:'idempotency_conflict'});assert.equal(f.reads.length,0);assert.equal(f.commands.length,1);
});

test('zero horizon follows the first concurrently saved event without a negative cursor',async()=>{
 const f=replayFixture();f.client.workContext=async()=>({evaluatedThrough:0,work:{revision:1}});
 assert.equal((await submitWorkAction(f.client,f.identity,f.action,f.input)).duplicate,true);assert.equal(f.reads[0][0],0);
});
