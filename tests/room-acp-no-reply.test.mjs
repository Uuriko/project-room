import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {buildPrompt} from '../room-acp/src/prompt.mjs';

async function fixture(t,{text='Useful answer',tools=new Map(),plan=[],stopReason='end_turn',formal=false}={}){
 const store=new RoomStore(':memory:'),seeded=seedScopedInbox(store),server=createRoomServer({store}),home=mkdtempSync(join(tmpdir(),'acp-no-reply-'));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(home,{recursive:true,force:true});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connection={apiBase:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'worker',identityId:seeded.identityId,credential:seeded.token,hostId:'no-reply-fixture'};
 const counts={prompts:0,posts:[],acks:0},logs=[],output={text,tools,plan,stopReason};let clock=100000;
 const make=async()=>{
  const bridge=new Bridge({connection,env:{ROOM_ACP_HOME:home},log:line=>logs.push(line),host:{session:async()=>({sessionId:'synthetic',created:true}),prompt:async()=>{counts.prompts++;return{recorder:{text:output.text,tools:output.tools,plan:output.plan},stopReason:output.stopReason};}}});
  const post=bridge.room.post.bind(bridge.room),ack=bridge.room.ack.bind(bridge.room);
  bridge.room.post=async args=>{counts.posts.push({...args});return post(args);};bridge.room.ack=async args=>{counts.acks++;return ack(args);};
  if(bridge.reserveOrdinaryReply){const reserve=bridge.reserveOrdinaryReply.bind(bridge);bridge.reserveOrdinaryReply=receipt=>reserve(receipt,clock);}
  await bridge.refreshRoom();await bridge.lease();return bridge;
 };
 const thread=formal?'dm':'mention',wake=id=>({signalId:id,messageId:thread,author:'owner',body:'FYI: the update is complete. No acknowledgement needed.'});
 return{store,seeded,make,counts,logs,output,thread,wake,advance:ms=>{clock+=ms;}};
}
const saved=(bridge,id)=>bridge.chatReceipts.read(bridge.chatReceipts.key(id));
test('ordinary explicit no_reply is persisted before ACK; restart then direct question posts only useful answered body',async t=>{
 const f=await fixture(t,{text:JSON.stringify({outcome:'no_reply',body:''})}),first=await f.make();
 const ack=first.room.ack.bind(first.room);first.room.ack=async args=>{assert.equal(saved(first,'fyi').disposition,'silent');await ack(args);throw Error('synthetic lost ACK');};
 await first.turn(f.thread,[f.wake('fyi')]);assert.equal(f.counts.posts.length,0);assert.equal(saved(first,'fyi').phase,'discarded');
 const second=await f.make();await second.turn(f.thread,[f.wake('fyi')]);assert.equal(f.counts.prompts,1);
 f.output.text=JSON.stringify({outcome:'answered',body:'Use the selected request API and retain the same request ID.'});
 const question={...f.wake('question'),body:'Which API should I use, and how do I retry it?'};
 await second.turn(f.thread,[question]);assert.equal(f.counts.prompts,2);assert.equal(f.counts.posts.length,1);
 assert.equal(f.counts.posts[0].body,'Use the selected request API and retain the same request ID.');
});
test('ordinary window survives restart, keeps rate-limited result local, and permits another reply at exactly60seconds',async t=>{
 const f=await fixture(t),first=await f.make();await first.turn(f.thread,[f.wake('first')]);
 const second=await f.make();await second.turn(f.thread,[f.wake('limited')]);assert.equal(f.counts.posts.length,1);
 assert.equal(saved(second,'limited').phase,'discarded');assert.equal(saved(second,'limited').disposition,'reply_window_limited');assert.equal(saved(second,'limited').body,'Useful answer');
 f.advance(60000);await second.turn(f.thread,[f.wake('later')]);assert.equal(f.counts.posts.length,2);
});
test('ambiguous ordinary POST retries exact operation after restart even after a newer window',async t=>{
 const f=await fixture(t),first=await f.make(),post=first.room.post.bind(first.room);let lose=true;
 first.room.post=async args=>{const result=await post(args);if(lose){lose=false;throw Error('synthetic response lost after commit');}return result;};
 await first.turn(f.thread,[f.wake('unknown')]);const original=saved(first,'unknown');assert.equal(original.phase,'result');
 f.advance(60000);const second=await f.make();await second.turn(f.thread,[f.wake('new-window')]);
 await second.turn(f.thread,[f.wake('unknown')]);assert.equal(f.counts.prompts,2);assert.equal(f.counts.posts.length,3);
 assert.deepEqual(f.counts.posts[2],f.counts.posts[0]);assert.equal(saved(second,'unknown').phase,'posted');
});
test('reply-window reservation save fault posts nothing and exact recovery does not rerun the model',async t=>{
 const f=await fixture(t),first=await f.make(),save=first.chatReceipts.save.bind(first.chatReceipts);let fail=true;
 first.chatReceipts.save=(key,receipt)=>{if(receipt.ordinaryReplyWindow&&fail){fail=false;throw Error('synthetic local save fault');}return save(key,receipt);};
 await first.turn(f.thread,[f.wake('save-fault')]);assert.equal(f.counts.posts.length,0);assert.equal(saved(first,'save-fault').phase,'result');
 const second=await f.make();await second.turn(f.thread,[f.wake('save-fault')]);assert.equal(f.counts.prompts,1);assert.equal(f.counts.posts.length,1);
});
for(const options of [{tools:new Map([['t',{title:'Inspected file',status:'completed'}]])},{plan:[{content:'Inspect local output',status:'completed'}]},{stopReason:'max_tokens'}])
test('no_reply cannot hide tools, plan or unfinished execution '+Object.keys(options).join(','),async t=>{
 const f=await fixture(t,{text:JSON.stringify({outcome:'no_reply',body:''}),...options}),bridge=await f.make();await bridge.turn(f.thread,[f.wake('activity')]);
 assert.equal(f.counts.posts.length,1);assert.notEqual(saved(bridge,'activity').disposition,'silent');
});
test('formal no_reply is not an answer or silent disposition, and formal pending is exempt from ordinary window',async t=>{
 const f=await fixture(t,{formal:true,text:JSON.stringify({outcome:'no_reply',body:''})}),bridge=await f.make();
 await bridge.turn(f.thread,[f.wake('formal-no-reply')]);f.output.text=JSON.stringify({outcome:'pending',body:'The required approval is not available.'});
 await bridge.turn(f.thread,[f.wake('formal-pending')]);assert.equal(f.counts.posts.length,2);
 assert.equal((await bridge.room.request('/api/rooms/commons/reply-context?requestMessageId=dm')).request.status,'open');
 assert.notEqual(saved(bridge,'formal-no-reply').disposition,'silent');
});
test('wake prompt discourages FYI noise and states host limits on resumed sessions too',()=>{
 const text=buildPrompt({roomTitle:'Room',thread:{},wakes:[{author:'owner',body:'FYI'}],firstTurn:false})[0].text;
 assert.match(text,/no_reply/);assert.match(text,/direct question|explicit task/i);assert.match(text,/FYI/);assert.match(text,/enabled.*host|host.*enabled/i);
});
test('ordinary posted receipt survives lost ACK without another prompt or POST',async t=>{
 const f=await fixture(t),first=await f.make(),ack=first.room.ack.bind(first.room);
 first.room.ack=async args=>{assert.equal(saved(first,'lost-ack').phase,'posted');await ack(args);throw Error('synthetic lost ACK');};
 await first.turn(f.thread,[f.wake('lost-ack')]);const second=await f.make();await second.turn(f.thread,[f.wake('lost-ack')]);
 assert.equal(f.counts.prompts,1);assert.equal(f.counts.posts.length,1);assert.equal(f.counts.acks,2);
});
test('corrupt addressed reply window fails closed without post or acknowledgement',async t=>{
 const f=await fixture(t),bridge=await f.make();await bridge.turn(f.thread,[f.wake('first')]);
 const key=bridge.replyWindows.key(f.thread),window=bridge.replyWindows.read(key);
 bridge.replyWindows.save(key,{...window,reservedAt:'not-a-clock'});
 await bridge.turn(f.thread,[f.wake('corrupt-window')]);assert.equal(f.counts.posts.length,1);assert.equal(f.counts.acks,1);
 assert.equal(saved(bridge,'corrupt-window').phase,'result');assert.match(f.logs.join('\n'),/Invalid ordinary reply window/);
});
for(const body of [' ', 'This is an acknowledgement'])test('no_reply with nonempty body is not silently accepted '+JSON.stringify(body),async t=>{
 const f=await fixture(t,{text:JSON.stringify({outcome:'no_reply',body})}),bridge=await f.make();await bridge.turn(f.thread,[f.wake('invalid-no-reply')]);assert.equal(f.counts.posts.length,1);assert.notEqual(saved(bridge,'invalid-no-reply').disposition,'silent');
});
test('different threads retain independent reply windows for the same existing seat',async t=>{
 const f=await fixture(t),bridge=await f.make();await bridge.turn(f.thread,[f.wake('first-thread')]);
 f.store.command(f.seeded.owner,'commons',{id:'second-thread',type:'message.posted',data:{messageId:'second-thread',body:'What is your recommendation?',toMemberId:'worker'}});
 await bridge.turn('second-thread',[{signalId:'second-thread-wake',messageId:'second-thread',author:'owner',body:'What is your recommendation?'}]);
 assert.equal(f.counts.posts.length,2);
});
