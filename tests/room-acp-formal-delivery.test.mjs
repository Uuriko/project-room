import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditRecovery} from '../server/recovery.mjs';
import {buildReplyCommand,validateReplyRead} from '../client/reply-actions.mjs';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {TurnRecorder} from '../room-acp/src/render.mjs';
import {RoomClient, RoomError} from '../room-acp/src/room.mjs';
import {readCompleteRequest, prepareFormalDelivery} from '../room-acp/src/formal-delivery.mjs';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';

const syntheticAnswerEnding = '\n\nVerification: the answer is saved exactly; no tools or model calls are repeated.';
const syntheticAnswer4141 = Array.from({length:20}, (_, index) => `Step ${index + 1}: I recommend preserving the original request identity and checking current recipient authority before delivery. Save the exact response command before its first network send, then reuse that command after an uncertain acknowledgement. Verify the selected response and its context binding before marking local delivery complete.`).join('\n\n')
  .slice(0, 4141 - syntheticAnswerEnding.length) + syntheticAnswerEnding;

async function fixture(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'formal-bridge-'));
  const database = options.persist ? join(home,'room.sqlite') : ':memory:';
  const store = new RoomStore(database), seeded = seedScopedInbox(store);
  const server = createRoomServer({store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  };
  t.after(async () => {await close(); rmSync(home, {recursive:true, force:true});});
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const counts = {prompts:0, sent:[]}, logs = [];
  const connection = {apiBase, roomId:'commons', memberId:'worker', identityId:seeded.identityId,
    credential:seeded.token, hostId:'formal-fixture'};
  const make = (fetchImpl = fetch) => new Bridge({connection, env:{ROOM_ACP_HOME:home}, fetchImpl,
    log:line => logs.push(line), host:{
      session:async () => ({sessionId:'synthetic', created:true}),
      prompt:async (_key, prompt) => {
        counts.prompts++; counts.prompt = prompt;
        if (options.updates) { const recorder = new TurnRecorder(); for (const update of options.updates) recorder.update(update); return {recorder, stopReason:options.stopReason ?? 'end_turn'}; }
        return {recorder:{text:options.text ?? JSON.stringify({outcome:'answered', body:'Useful verified answer'}), tools:new Map()},
          stopReason:options.stopReason ?? 'end_turn'};
      }
    }});
  const ready = async bridge => {await bridge.refreshRoom(); await bridge.lease();};
  const read = async (bridge, id = 'dm') => bridge.room.request(`/api/rooms/commons/reply-context?requestMessageId=${id}`);
  const wake = {signalId:'synthetic-formal-wake', messageId:'dm', author:'owner', body:'Please answer'};
  return {store, seeded, home, database, close, connection, make, ready, read, wake, counts, logs};
}

test('ACP answer completes a real normalized reply request, rather than posting ordinary chat', async t => {
  const f = await fixture(t), bridge = f.make(); await f.ready(bridge);
  await bridge.turn('dm', [f.wake]);
  const current = await f.read(bridge);
  assert.equal(current.request.status, 'answered');
  assert.equal(current.page.items.find(item => item.kind === 'answered').message.body, 'Useful verified answer');
  assert.equal(f.counts.prompts, 1);
});

test('lost committed formal response retries the frozen recipe after restart without a second execution or event', async t => {
  const f = await fixture(t,{text:JSON.stringify({outcome:'answered',body:syntheticAnswer4141})}); let lose = true;
  const first = f.make(async (url, options) => {
    const response = await fetch(url, options);
    if (options?.body) {
      const command = JSON.parse(options.body);
      if (command.data?.responseToRequestId) {
        f.counts.sent.push(options.body);
        const receipts = readdirSync(join(f.home, 'chat-turns')).map(file => JSON.parse(readFileSync(join(f.home,'chat-turns',file),'utf8')));
        assert.ok(receipts.some(receipt => receipt.phase === 'result' && JSON.stringify(receipt.formalDelivery?.recipe.command) === options.body), 'filled command must be saved before any send');
        if (lose) {lose = false; throw Error('response lost after commit');}
      }
    }
    return response;
  });
  await f.ready(first); const before = f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons').sequence;
  await first.turn('dm', [f.wake]);
  assert.equal((await f.read(first)).request.status, 'answered');
  const after = f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons').sequence; assert.equal(after, before + 1);
  const second = f.make(async (url, options) => {
    if (options?.body && JSON.parse(options.body).data?.responseToRequestId) f.counts.sent.push(options.body);
    return fetch(url, options);
  });
  await f.ready(second); await second.turn('dm', [f.wake]);
  assert.equal(f.counts.prompts, 1);
  assert.equal(f.counts.sent.length, 2); assert.equal(new Set(f.counts.sent).size, 1);
  assert.equal(f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons').sequence, after);
  const saved = second.chatReceipts.read(second.chatReceipts.key(f.wake.signalId));
  assert.equal(saved.phase, 'posted');
});

for (const [text, stopReason, status] of [
  [JSON.stringify({outcome:'declined',body:'Outside my scope'}),'end_turn','declined'],
  [JSON.stringify({outcome:'pending',body:'I need approval before continuing'}),'end_turn','open'],
  ['I have finished it','end_turn','open'],
  [JSON.stringify({outcome:'answered',body:'partial answer'}),'max_tokens','open']
]) test(`formal response uses explicit outcome (${status}, ${stopReason}, ${text.slice(0,20)})`, async t => {
  const f = await fixture(t, {text, stopReason}), bridge = f.make(); await f.ready(bridge);
  await bridge.turn('dm', [f.wake]); assert.equal((await f.read(bridge)).request.status, status);
});

test('formal prompt reads every page without the ordinary thread family limit', async t => {
  const f = await fixture(t), bridge = f.make();
  let now = Date.now()+10000; f.store.now = () => now;
  for (let n=0;n<29;n++) {now += 2001; f.store.command(f.seeded.owner, 'commons', {id:'context-'+n, type:'message.posted',
    data:{messageId:'context-'+n,body:'context '+n,replyToId:'dm',toMemberId:'worker'}});}
  await f.ready(bridge);
  let pages=0; const read = bridge.room.requestContext.bind(bridge.room);
  bridge.room.requestContext = async (...args) => {pages++; return read(...args);};
  await bridge.turn('dm', [f.wake]);
  assert.equal((await f.read(bridge)).request.status, 'answered', f.logs.join(' | ')); assert.ok(pages > 1);
  const prompt = JSON.parse(f.counts.prompt[0].text.split('\n\n').at(-1));
  for(let n=0;n<29;n++) assert.ok(prompt.items.some(item => item.message?.body === 'context '+n));
});

test('a response prepared before new context cannot silently refresh its basis or repeat execution', async t => {
  const f = await fixture(t); let inject = true;
  const bridge = f.make(async (url, options) => {
    if (inject && options?.body && JSON.parse(options.body).data?.responseToRequestId) {
      inject=false; f.store.command(f.seeded.owner,'commons',{id:'new-context',type:'message.posted',data:{messageId:'new-context',body:'Please include this new constraint',replyToId:'dm',toMemberId:'worker'}});
    }
    return fetch(url,options);
  });
  await f.ready(bridge); await bridge.turn('dm', [f.wake]); await bridge.turn('dm', [f.wake]);
  assert.equal((await f.read(bridge)).request.status,'open'); assert.equal(f.counts.prompts,1);
  const receipt=bridge.chatReceipts.read(bridge.chatReceipts.key(f.wake.signalId));
  assert.equal(receipt.phase,'posted');assert.equal(receipt.formalReview,true);
  assert.ok((await f.read(bridge)).page.items.some(item=>item.message?.body.includes('draft for review, not a completed answer')));
});

test('lost stale-draft response retries only that draft and never resends the rejected formal answer', async t => {
  const f=await fixture(t);let inject=true, lose=true, formalPosts=0;const drafts=[];
  const transport=async(url,options)=>{
    const command=options?.body ? JSON.parse(options.body) : null;
    if(command?.data?.responseToRequestId) {
      formalPosts++;
      if(inject){inject=false;f.store.command(f.seeded.owner,'commons',{id:'changed',type:'message.posted',data:{messageId:'changed',body:'New constraint',replyToId:'dm',toMemberId:'worker'}});}
    }
    const response=await fetch(url,options);
    if(command?.type==='message.posted'&&!command.data.responseToRequestId){drafts.push(options.body);if(lose){lose=false;await response.clone().json();throw Error('draft receipt lost');}}
    return response;
  };
  const first=f.make(transport);await f.ready(first);await first.turn('dm',[f.wake]);
  const second=f.make(transport);await f.ready(second);await second.turn('dm',[f.wake]);
  assert.equal(formalPosts,1);assert.equal(f.counts.prompts,1);assert.equal(drafts.length,2);assert.equal(new Set(drafts).size,1);
  const current=await f.read(second);assert.equal(current.request.status,'open');
  assert.equal(current.page.items.filter(item=>item.message?.body.includes('draft for review, not a completed answer')).length,1);
  assert.equal(second.chatReceipts.read(second.chatReceipts.key(f.wake.signalId)).phase,'posted');
});

test('complete context is bound to the actual recipient and every page is inspected', async t => {
  const f=await fixture(t), bridge=f.make(); await f.ready(bridge);
  const context=await readCompleteRequest(bridge.room,'dm');
  assert.throws(()=>prepareFormalDelivery({...context,viewerId:'another-agent'},JSON.stringify({outcome:'answered',body:'wrong recipient'}),'end_turn'),{code:'formal_context_invalid'});
  assert.throws(()=>prepareFormalDelivery({...context,allPagesRead:false},JSON.stringify({outcome:'answered',body:'partial'}),'end_turn'),{code:'formal_context_invalid'});
  assert.throws(()=>prepareFormalDelivery({...context,responseHttpActions:context.responseHttpActions.map(action=>({...action,path:'/api/rooms/another-room/commands'}))},JSON.stringify({outcome:'answered',body:'wrong room'}),'end_turn'),{code:'formal_context_invalid'});
});

test('hard process exit after formal commit recovers the durable result without executing again', {timeout:30000}, async t => {
  const f = await fixture(t), path = join(f.home,'synthetic-connection.json'), executions=join(f.home,'executions');
  writeFileSync(path,JSON.stringify(f.connection),{mode:0o600});
  const source = `import fs from 'node:fs';
    import {Bridge} from ${JSON.stringify(new URL('../room-acp/src/bridge.mjs',import.meta.url).href)};
    const connection=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const bridge=new Bridge({connection,env:{ROOM_ACP_HOME:${JSON.stringify(f.home)}},host:{session:async()=>({sessionId:'s',created:true}),prompt:async()=>{
      fs.appendFileSync(${JSON.stringify(executions)},'one execution\\n');
      return {recorder:{text:JSON.stringify({outcome:'answered',body:'Hard-crash answer'}),tools:new Map()},stopReason:'end_turn'};
    }},fetchImpl:async(url,options)=>{
      const response=await fetch(url,options);
      if(options?.body&&JSON.parse(options.body).data?.responseToRequestId){await response.clone().json();process.exit(73);}
      return response;
    }});
    await bridge.refreshRoom();await bridge.lease();await bridge.turn('dm',[${JSON.stringify(f.wake)}]);process.exit(74);`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,path],{stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});t.after(()=>child.kill());
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  assert.equal(code,73,errors);
  const restarted=f.make();await f.ready(restarted);const before=f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons').sequence;
  await restarted.turn('dm',[f.wake]);
  assert.equal(f.counts.prompts,0);assert.equal(readFileSync(executions,'utf8'),'one execution\n');
  assert.equal(f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons').sequence,before);
  const current=await f.read(restarted);assert.equal(current.request.status,'answered');
  assert.equal(current.page.items.find(item=>item.kind==='answered').message.body,'Hard-crash answer');
  assert.equal(restarted.chatReceipts.read(restarted.chatReceipts.key(f.wake.signalId)).phase,'posted');
});

test('interrupted formal execution remains inspectable and is never automatically rerun', async t => {
  const f=await fixture(t), first=f.make();await f.ready(first);
  first.host.prompt=async()=>{f.counts.prompts++;first.stop();throw Error('interrupted after possible outside work');};
  await first.turn('dm',[f.wake]);const second=f.make();await f.ready(second);await second.turn('dm',[f.wake]);
  assert.equal(f.counts.prompts,1);assert.equal((await f.read(second)).request.status,'open');
  const receipt=second.chatReceipts.read(second.chatReceipts.key(f.wake.signalId));
  assert.equal(receipt.phase,'started');assert.equal(receipt.formalContext.allPagesRead,true);
});

test('a context network failure before execution retries preparation rather than parking an unstarted prompt', async t => {
  const f=await fixture(t), first=f.make();await f.ready(first);
  first.room.requestContext=async()=>{throw Object.assign(Error('Room temporarily unreachable'),{code:'network'});};
  await first.turn('dm',[f.wake]);assert.equal(f.counts.prompts,0);
  assert.equal(first.chatReceipts.read(first.chatReceipts.key(f.wake.signalId)).phase,'queued');
  const second=f.make();await f.ready(second);await second.turn('dm',[f.wake]);
  assert.equal(f.counts.prompts,1);assert.equal((await f.read(second)).request.status,'answered');
});

test('selected message view keeps private and edited-history boundaries', async t => {
  const f=await fixture(t), bridge=f.make();await f.ready(bridge);
  const selected=await bridge.room.thread('dm',{selected:true});
  assert.equal(selected.replyRequest.recipientId,'worker');assert.deepEqual(selected.thread.replies,[]);
  const outsider=f.store.issueAccessKey('commons','other');
  const r=await fetch(f.connection.apiBase+'/api/rooms/commons/messages/dm/thread?view=message',{headers:{authorization:'Bearer '+outsider}});
  assert.equal(r.status,404);
  f.store.command(f.seeded.owner,'commons',{id:'edit-selected',type:'message.edited',data:{messageId:'mention',body:'Edited current text',expectedMessageRevision:0}});
  const edited=await bridge.room.thread('mention',{selected:true});
  assert.equal(edited.thread.body,'Edited current text');assert.equal(Object.hasOwn(edited.thread,'editHistory'),false);
  assert.equal(JSON.stringify(edited).includes('@Worker please inspect the useful result'),false);
});

test('an older server cannot silently substitute full thread context for the selected view', async()=>{
  const room=new RoomClient({apiBase:'https://room.example.test',roomId:'room',memberId:'agent',fetchImpl:async()=>Response.json({roomId:'room',thread:{id:'message',replies:[]}})});
  await assert.rejects(room.thread('message',{selected:true}),error=>error instanceof RoomError&&error.code==='selected_message_context_unavailable');
});

test('a crash before grouping leaves complete queued input, not a false started execution', {timeout:30000}, async t=>{
  const f=await fixture(t),path=join(f.home,'crash-before-group.json');writeFileSync(path,JSON.stringify(f.connection),{mode:0o600});
  const source=`import fs from 'node:fs';import {Bridge} from ${JSON.stringify(new URL('../room-acp/src/bridge.mjs',import.meta.url).href)};
    const connection=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const bridge=new Bridge({connection,env:{ROOM_ACP_HOME:${JSON.stringify(f.home)}},host:{session:async()=>({sessionId:'s'}),prompt:async()=>{throw Error('must not execute before grouping');}}});
    bridge.chatReceipts.save=()=>process.kill(process.pid,'SIGKILL');
    await bridge.refreshRoom();await bridge.lease();await bridge.turn('dm',[${JSON.stringify(f.wake)}]);process.exit(74);`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,path],{stdio:'ignore'});t.after(()=>child.kill());
  const result=await new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
  assert.equal(result.signal,'SIGKILL');
  const second=f.make(),key=second.chatReceipts.key(f.wake.signalId),saved=second.chatReceipts.read(key);
  assert.equal(saved.phase,'queued');assert.deepEqual(saved.messageIds,['dm']);
  await f.ready(second);await second.turn('dm',[f.wake]);
  assert.equal(f.counts.prompts,1);assert.equal((await f.read(second)).request.status,'answered');
  assert.equal(second.chatReceipts.read(key).phase,'posted');
});

for (const point of ['second-begin','secondary-link']) test(`partial ${point} recovery handles reordered wakes without parked or duplicate execution`,async t=>{
  const f=await fixture(t),first=f.make(),a={...f.wake,signalId:'a'},b={...f.wake,signalId:'b'};await f.ready(first);
  if(point==='second-begin'){
    const begin=first.chatReceipts.begin.bind(first.chatReceipts);let calls=0;
    first.chatReceipts.begin=(...args)=>{if(++calls===2)throw Error('interrupted second begin');return begin(...args);};
  }else{
    const save=first.chatReceipts.save.bind(first.chatReceipts);
    first.chatReceipts.save=(key,value)=>{if(value.phase==='linked')throw Error('interrupted link');return save(key,value);};
  }
  await first.turn('dm',[a,b]);assert.equal(f.counts.prompts,0);
  const second=f.make(),acks=[];await f.ready(second);second.room.ack=async value=>{acks.push(...value.signalIds);};
  await second.turn('dm',[b,a]);await second.turn('dm',[a,b]);
  assert.equal(f.counts.prompts,1);assert.equal((await f.read(second)).request.status,'answered');
  assert.ok(acks.includes('a')&&acks.includes('b'));
  for(const wake of [a,b])assert.notEqual(second.chatReceipts.read(second.chatReceipts.key(wake.signalId)).phase,'started');
});

test('duplicate signal IDs inside a single batch execute once',async t=>{
  const f=await fixture(t),bridge=f.make();await f.ready(bridge);await bridge.turn('dm',[f.wake,f.wake]);
  assert.equal(f.counts.prompts,1);assert.equal((await f.read(bridge)).request.status,'answered');
});

test('a changed response body is retained for review instead of acknowledged or repeatedly sent',async t=>{
  const f=await fixture(t);let mutate=true,posts=0,mutated=false;
  const bridge=f.make(async(url,options)=>{
    const response=await fetch(url,options);
    if(options?.body&&JSON.parse(options.body).data?.responseToRequestId){
      posts++;
      if(mutate){mutate=false;await response.clone().json();const command=JSON.parse(options.body);
        f.store.command(f.seeded.owner,'commons',{id:'owner-revised-answer',type:'message.edited',data:{messageId:command.data.messageId,body:'Owner revised this answer',expectedMessageRevision:0}});mutated=true;}
    }
    return response;
  });
  await f.ready(bridge);let acks=0;bridge.room.ack=async()=>{acks++;};
  await bridge.turn('dm',[f.wake]);assert.equal(mutated,true);
  assert.equal(bridge.chatReceipts.read(bridge.chatReceipts.key(f.wake.signalId)).phase,'needs_review');
  await bridge.turn('dm',[f.wake]);assert.equal(posts,1);assert.equal(f.counts.prompts,1);assert.equal(acks,0);
});

for (const terminalLimit of [false,true]) test(`actual wake redelivery survives repeated preparation failure${terminalLimit?' and stops on a context limit':''}`,async t=>{
  const f=await fixture(t),bridge=f.make();await f.ready(bridge);
  f.store.command(f.seeded.owner,'commons',{id:'retry-formal',type:'message.posted',data:{messageId:'retry-formal',body:'@Worker please answer this fresh request',toMemberId:'worker',requestKind:'reply'}});
  const original=bridge.room.requestContext.bind(bridge.room);let preparations=0;
  bridge.room.requestContext=async(...args)=>{
    preparations++;
    if(preparations<=2){
      if(terminalLimit&&preparations===2)throw new RoomError(413,'formal_context_too_large','Context budget exceeded');
      throw Error('temporary preparation failure');
    }
    return original(...args);
  };
  const poll=()=>bridge.room.poll({hostId:f.connection.hostId,waitMs:0});
  const initial=(await poll()).pendingWakes.find(w=>w.messageId==='retry-formal');assert.ok(initial,'real Room queue contains the formal request');
  for(let attempt=0;attempt<(terminalLimit?2:3);attempt++){
    const pending=(await poll()).pendingWakes.find(w=>w.signalId===initial.signalId);assert.ok(pending,'unanswered wake must still be queued');
    await bridge.accept(pending);await bridge.queue.idle();
  }
  if(terminalLimit){
    assert.equal(bridge.stopReason,'context_unavailable');assert.equal(bridge.controller.signal.aborted,true);
    assert.equal(f.counts.prompts,0);
    // The stopped work client now aborts all requests; observe the unchanged
    // server queue with the same existing credential through a fresh reader.
    const observer=new RoomClient(f.connection);
    assert.ok((await observer.poll({hostId:f.connection.hostId,waitMs:0})).pendingWakes.some(w=>w.signalId===initial.signalId));
  }else{
    // Two failures, successful preparation, then the fresh post-session check.
    assert.equal(preparations,4);assert.equal(f.counts.prompts,1);assert.equal((await f.read(bridge,'retry-formal')).request.status,'answered');
    assert.equal((await poll()).pendingWakes.some(w=>w.signalId===initial.signalId),false);
  }
});

for (const [label, body] of [['reported4141',syntheticAnswer4141], ['boundary8192','b'.repeat(8192)], ['escaped8192','\u0001'.repeat(8192)], ['unicode8192','😀'.repeat(4096)]])
test(`formal answer ${label} delivers exact text through actual HTTP and selected context`, async t => {
  const f = await fixture(t, {text:JSON.stringify({outcome:'answered',body})}), bridge=f.make(); await f.ready(bridge);
  await bridge.turn('dm',[f.wake]);
  const current=await f.read(bridge);
  assert.equal(current.request.status,'answered',f.logs.join(' | '));
  assert.equal(current.page.items.find(item=>item.kind==='answered').message.body,body);
  assert.equal(f.counts.prompts,1);
  validateReplyRead(current,{name:'room_read_request',args:{requestMessageId:'dm'},roomId:'commons'});
  assert.ok(auditRecovery(f.store).dataSha256);
});

test('oversize formal answer retains an exact bounded draft before post and across lost ACK restart', async t => {
  const body='a'.repeat(8193), f=await fixture(t,{text:JSON.stringify({outcome:'answered',body})});
  const first=f.make(); await f.ready(first);
  first.room.ack=async()=>{throw Error('synthetic lost ACK');};
  await first.turn('dm',[f.wake]);
  const key=first.chatReceipts.key(f.wake.signalId), saved=first.chatReceipts.read(key);
  assert.equal(saved.phase,'posted');assert.equal(saved.formalDraft.body,body);
  assert.equal(saved.formalDraft.requestMessageId,'dm');assert.equal(saved.formalDraft.viewerId,'worker');
  assert.equal(saved.formalPending.code,'formal_body_too_long');assert.equal(saved.formalPending.actual,8193);
  assert.equal(saved.formalPending.maximum,8192);assert.equal(saved.formalPending.draftRetained,true);
  assert.equal(saved.body,undefined);assert.equal(saved.formalDelivery,undefined);
  const current=await f.read(first);assert.equal(current.request.status,'open');
  assert.ok(current.page.items.some(item=>item.message?.body.includes('(8193 / 8192)')));
  const second=f.make();await f.ready(second);await second.turn('dm',[f.wake]);
  assert.equal(f.counts.prompts,1);assert.deepEqual(second.chatReceipts.read(key).formalDraft,saved.formalDraft);
});
test('over-budget local draft is never partially retained or answered', async t=>{
  const f=await fixture(t,{text:JSON.stringify({outcome:'answered',body:'😀'.repeat(10000)})}),bridge=f.make();await f.ready(bridge);
  await bridge.turn('dm',[f.wake]);const saved=bridge.chatReceipts.read(bridge.chatReceipts.key(f.wake.signalId));
  assert.equal(saved.phase,'posted');assert.equal(saved.formalDraft,undefined);assert.equal(saved.formalPending.draftRetained,false);
  assert.equal((await f.read(bridge)).request.status,'open');
});
test('formal command byte overflow retains a non-executable draft and precise reason',async t=>{
  const f=await fixture(t),bridge=f.make();await f.ready(bridge);const context=await readCompleteRequest(bridge.room,'dm');
  context.responseHttpActions[0].command.id='a'.repeat(65536);
  const delivery=prepareFormalDelivery(context,JSON.stringify({outcome:'answered',body:'Do not lose this draft'}),'end_turn');
  assert.equal(delivery.kind,'pending');assert.equal(delivery.pendingReason.code,'formal_command_too_large');
  assert.equal(delivery.draft.body,'Do not lose this draft');assert.equal(delivery.recipe,undefined);
});
test('formal MCP response accepts 8192 while opening questions and cancel reasons retain 4096',async t=>{
  const f=await fixture(t),bridge=f.make();await f.ready(bridge);const context=await readCompleteRequest(bridge.room,'dm');
  const action=context.responseActions.find(action=>action.arguments.responseOutcome==='answered');
  const command=buildReplyCommand({roomId:'commons',memberId:'worker'},action.tool,{...action.arguments,requestId:'long-mcp-answer',body:'x'.repeat(8192)});
  const result=await bridge.room.request('/api/rooms/commons/commands',{body:command});
  assert.equal(result.event.data.body.length,8192);
  for(const [type,data] of [['message.posted',{messageId:'oversize-opening',toMemberId:'worker',requestKind:'reply',body:'x'.repeat(4097)}],['reply_request.cancelled',{requestMessageId:'dm',expectedRequestRevision:0,reason:'x'.repeat(4097)}]]){
    assert.throws(()=>f.store.command(f.seeded.owner,'commons',{id:'too-long-'+type,type,data}),{status:422});
  }
});

test('8192 escaped answer survives a real SQLite cold reopen and literal recovery audit',async t=>{
  const body='\u0001'.repeat(8192),f=await fixture(t,{persist:true,text:JSON.stringify({outcome:'answered',body})});
  const bridge=f.make();await f.ready(bridge);await bridge.turn('dm',[f.wake]);
  const before=auditRecovery(f.store);await f.close();
  const store=new RoomStore(f.database),server=createRoomServer({store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const room=new RoomClient({...f.connection,apiBase:`http://127.0.0.1:${server.address().port}`});
  const current=await room.request('/api/rooms/commons/reply-context?requestMessageId=dm');
  assert.equal(current.request.status,'answered');assert.equal(current.page.items.find(row=>row.kind==='answered').message.body,body);
  assert.equal(auditRecovery(store).dataSha256,before.dataSha256);
});

test('follow-up preparation accepts the larger exact answer in previous exchanges',async t=>{
  const body='A useful response. '.repeat(455).slice(0,8192);
  const f=await fixture(t,{text:JSON.stringify({outcome:'answered',body})}),bridge=f.make();
  await f.ready(bridge);await bridge.turn('dm',[f.wake]);
  const answered=await f.read(bridge);
  assert.equal(answered.request.status,'answered');
  f.store.command(f.seeded.owner,'commons',{id:'follow-long-answer',type:'message.posted',data:{
    messageId:'follow-long-answer',body:'Please clarify that answer.',requestKind:'reply',
    toMemberId:'worker',replyToId:answered.request.responseMessageId
  }});
  const follow=await bridge.room.requestContext('follow-long-answer');
  assert.equal(follow.preparation.previousExchanges.length,1);
  assert.equal(follow.preparation.previousExchanges[0].messages.find(m=>m.id===answered.request.responseMessageId).body,body);
  validateReplyRead(follow,{name:'room_read_request',args:{requestMessageId:'follow-long-answer'},roomId:'commons'});
  assert.equal(follow.request.status,'open');
});

const messageChunk = (messageId, text) => ({sessionUpdate:'agent_message_chunk', ...(messageId ? {messageId} : {}), content:{type:'text',text}});
test('formal delivery uses the final ACP message, excluding separate commentary', async t => {
  const json=JSON.stringify({outcome:'answered',body:'Final bounded answer'});
  const f=await fixture(t,{updates:[messageChunk('commentary','I will check the evidence.'),messageChunk('final',json.slice(0,15)),messageChunk('final',json.slice(15)),{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private reasoning must not become the reply'}}]}),bridge=f.make();
  await f.ready(bridge); await bridge.turn('dm',[f.wake]);
  const current=await f.read(bridge);
  assert.equal(current.request.status,'answered');
  assert.equal(current.page.items.find(item=>item.kind==='answered').message.body,'Final bounded answer');
});
for (const [label,updates] of [
  ['untagged mixed text',[messageChunk(null,'Checking.'),messageChunk(null,JSON.stringify({outcome:'answered',body:'Unbound candidate'}))]],
  ['invalid final message',[messageChunk('first',JSON.stringify({outcome:'answered',body:'Earlier candidate'})),messageChunk('last','Still checking')]],
  ['interleaved message IDs',[messageChunk('first','Checking'),messageChunk('last','Another message'),messageChunk('first',JSON.stringify({outcome:'answered',body:'Ambiguous candidate'}))]],
]) test(`formal extraction keeps ${label} pending`,async t=>{
  const f=await fixture(t,{updates}),bridge=f.make();await f.ready(bridge);await bridge.turn('dm',[f.wake]);assert.equal((await f.read(bridge)).request.status,'open');
});

test('final-message tracking stays bounded and falls back after 256 groups',()=>{
  const recorder=new TurnRecorder();
  for(let i=0;i<256;i++) recorder.update(messageChunk(`message-${i}`,'Commentary.'));
  recorder.update(messageChunk('last',JSON.stringify({outcome:'answered',body:'Over-budget candidate'})));
  assert.equal(recorder.messageIds.size,256);
  assert.equal(recorder.formalText,recorder.text);
  assert.throws(()=>JSON.parse(recorder.formalText));
});
