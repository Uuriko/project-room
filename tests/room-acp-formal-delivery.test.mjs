import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {RoomClient, RoomError} from '../room-acp/src/room.mjs';
import {readCompleteRequest, prepareFormalDelivery} from '../room-acp/src/formal-delivery.mjs';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';

async function fixture(t, options = {}) {
  const store = new RoomStore(':memory:'), seeded = seedScopedInbox(store);
  const server = createRoomServer({store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'formal-bridge-'));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(home, {recursive:true, force:true});
  });
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const counts = {prompts:0, sent:[]}, logs = [];
  const connection = {apiBase, roomId:'commons', memberId:'worker', identityId:seeded.identityId,
    credential:seeded.token, hostId:'formal-fixture'};
  const make = (fetchImpl = fetch) => new Bridge({connection, env:{ROOM_ACP_HOME:home}, fetchImpl,
    log:line => logs.push(line), host:{
      session:async () => ({sessionId:'synthetic', created:true}),
      prompt:async (_key, prompt) => {
        counts.prompts++; counts.prompt = prompt;
        return {recorder:{text:options.text ?? JSON.stringify({outcome:'answered', body:'Useful verified answer'}), tools:new Map()},
          stopReason:options.stopReason ?? 'end_turn'};
      }
    }});
  const ready = async bridge => {await bridge.refreshRoom(); await bridge.lease();};
  const read = async (bridge, id = 'dm') => bridge.room.request(`/api/rooms/commons/reply-context?requestMessageId=${id}`);
  const wake = {signalId:'synthetic-formal-wake', messageId:'dm', author:'owner', body:'Please answer'};
  return {store, seeded, home, connection, make, ready, read, wake, counts, logs};
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
  const f = await fixture(t); let lose = true;
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
    assert.equal(f.counts.prompts,0);assert.ok((await poll()).pendingWakes.some(w=>w.signalId===initial.signalId));
  }else{
    // Two failures, successful preparation, then the fresh post-session check.
    assert.equal(preparations,4);assert.equal(f.counts.prompts,1);assert.equal((await f.read(bridge,'retry-formal')).request.status,'answered');
    assert.equal((await poll()).pendingWakes.some(w=>w.signalId===initial.signalId),false);
  }
});
