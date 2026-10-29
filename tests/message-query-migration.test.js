import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { OutsideAgents } from '../server/outside-agents.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readMessagePage } from '../server/snapshot-window.mjs';
import { messageRepository } from '../server/message-repository.mjs';

function setup(t) {
 const s=new RoomStore(':memory:');s.initialize(initialRoom());s.roomFlood={consume(){}};t.after(()=>s.close());
 const token=s.issueAccessKey('commons','owner');
 const command=(type,data)=>s.command(token,'commons',{id:randomUUID(),type,data});
 const post=(id,body,extra={})=>command('message.posted',{messageId:id,body,...extra});
 const certify=()=>{while(!s.backfillMessages({limit:1000}).done){}assert.equal(s.checkMessagesParity().ok,true);};
 return {s,token,command,post,certify,repo:()=>messageRepository(s,'commons')};
}

test('ordered repository scans merge archive and retained exceptions across multiple pages',t=>{
 const f=setup(t);
 for(let i=0;i<270;i++)f.post(`record-${i}`,i%10===0?`typed.v1\n${i}`:`Text ${i}`);
 f.command('message.pinned',{messageId:'record-3'});
 const before=[...f.repo().records()];const ids=before.map(m=>m.id);
 const first=f.repo().firstPostedAtByAuthor();f.certify();
 assert.equal(f.s.archiveMessages('commons',{keepNewest:3,dryRun:false}).ok,true);
 const repo=f.repo();
 // Page response bounds must also bound historical body decoding. The old
 // route returned five records after reading all 267 archived bodies.
 let bodyRows=0;
 const prepare=f.s.db.prepare.bind(f.s.db);
 t.mock.method(f.s.db,'prepare',sql=>{
  const statement=prepare(sql);
  if(!/SELECT message_id,seq,record_json,body FROM messages/.test(sql))return statement;
  return new Proxy(statement,{get(target,key){
   if(key==='all')return(...args)=>{const rows=target.all(...args);bodyRows+=rows.length;return rows;};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
 });
 const newest=readMessagePage(f.s,f.token,'commons',{limit:5});
 assert.deepEqual(newest.messages.map(m=>m.id),ids.slice(-5));
 assert.ok(bodyRows<=128,`five-record page loaded ${bodyRows} archived bodies`);
 const seen=[...newest.messages.map(m=>m.id)];let page=newest;
 while(page.messagesPage.hasMore){
  page=readMessagePage(f.s,f.token,'commons',{limit:17,before:page.messagesPage.before});
  seen.unshift(...page.messages.map(m=>m.id));
 }
 assert.deepEqual(seen,ids,'paging traverses archive and retained exceptions exactly once');
 t.mock.restoreAll();

 assert.deepEqual([...repo.records()].map(m=>m.id),ids);
 assert.deepEqual([...repo.records({descending:true})].map(m=>m.id),[...ids].reverse());
 assert.deepEqual([...repo.records({bodyPrefix:'typed.v1\n'})].map(m=>m.id),before.filter(m=>m.body?.startsWith('typed.v1\n')).map(m=>m.id));
 assert.deepEqual(repo.recent(40,m=>Number(m.id.split('-')[1])%2===0).map(m=>m.id),before.filter(m=>Number(m.id.split('-')[1])%2===0).slice(-40).map(m=>m.id));
 assert.deepEqual(repo.firstPostedAtByAuthor(),first);
 assert.deepEqual(repo.recent(0),[]);assert.throws(()=>repo.recent(1001),RangeError);
});

test('outside-agent identity facts and idempotency survive message compaction',t=>{
 const f=setup(t);
 f.s.outsideAgents=new OutsideAgents(f.s);
 const input={externalRef:'remote-agent',displayName:'Remote agent',origin:'host'};
 f.s.outsideAgents.record(f.token,'commons',input);
 for(let i=0;i<12;i++)f.post(`tail-${i}`,'Settled public record.');
 f.certify();const before=f.s.outsideAgents.list(f.token,'commons');
 assert.equal(f.s.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
 assert.deepEqual(f.s.outsideAgents.list(f.token,'commons'),before);
 const head=f.s.headSequence('commons');
 assert.equal(f.s.outsideAgents.record(f.token,'commons',input).recorded,'replay');
 assert.equal(f.s.headSequence('commons'),head);
});

test('assistant requests remain visible and controllable when their source leaves the working set',async t=>{
 const { RoomAssistant }=await import('../server/room-assistant.mjs');
 const f=setup(t);const assistant=new RoomAssistant(f.s);
 f.command('member.added',{memberId:'worker',displayName:'Worker',kind:'agent',permissions:['accept_work']});
 const authorize=()=>f.s.authenticate(f.token,'commons');
 const apply=input=>assistant.apply('commons',{requestId:randomUUID(),...input},authorize,f.token);
 apply({action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'worker'});
 f.post('assistant-source','A settled request.');
 apply({action:'invoke',runId:'archived-run',sourceMessageId:'assistant-source'});
 for(let i=0;i<12;i++)f.post(`assistant-tail-${i}`,'Unrelated settled record.');
 f.certify();const before=assistant.list('commons',authorize);
 assert.equal(f.s.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
 assert.equal(f.s.room('commons').state.messages.some(m=>m.id==='assistant-source'),false);
 assert.deepEqual(assistant.list('commons',authorize),before);
 assert.equal(apply({action:'pause',runId:'archived-run',expectedRevision:0}).result.status,'paused');
});


test('indexed seek preserves page boundaries across retained and archived records',t=>{
 const f=setup(t);
 for(let i=0;i<140;i++)f.post(`seek-${i}`,`Record ${i}.`);
 f.command('message.pinned',{messageId:'seek-4'});
 const before=[...f.repo().records()].map(m=>m.id);
 for(const archived of [false,true]) {
  if(archived){f.certify();f.s.archiveMessages('commons',{keepNewest:3,dryRun:false});}
  for(const index of [0,4,5,127,137,139]) {
   assert.deepEqual([...f.repo().records({afterId:before[index]})].map(m=>m.id),before.slice(index+1));
   assert.deepEqual([...f.repo().records({afterId:before[index],descending:true})].map(m=>m.id),before.slice(0,index).reverse());
  }
  assert.throws(()=>[...f.repo().records({afterId:'missing'})],/Unknown message cursor/);
 }
 // Seeking beyond an older malformed record must not load/decode that record.
 f.s.db.prepare("UPDATE messages SET record_json='invalid' WHERE message_id='seek-1'").run();
 assert.deepEqual([...f.repo().records({afterId:'seek-137'})].map(m=>m.id),['seek-138','seek-139']);
});

test('partial message backfill after prefix archive preserves snapshots and seek',t=>{
 const f=setup(t);
 for(let i=0;i<12;i++)f.post(`partial-${i}`,`Record ${i}`);
 f.certify();
 assert.equal(f.s.archiveMessages('commons',{keepNewest:4,dryRun:false}).ok,true);
 const expected=[...f.repo().records()].map(m=>m.id);
 // Legacy posts used their event ID when no explicit message ID was supplied.
 const legacy=f.s.db.prepare("SELECT id,body FROM events WHERE json_extract(body,'$.data.messageId')=?").get('partial-10');
 const event=JSON.parse(legacy.body);delete event.data.messageId;event.id='partial-10';
 f.s.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event),legacy.id);
 // A certified prefix can coexist with a working set not yet backfilled.
 f.s.db.prepare("DELETE FROM messages WHERE room_id=? AND message_id IN (?,?)").run('commons','partial-8','partial-10');
 assert.deepEqual([...f.repo().records()].map(m=>m.id),expected);
 assert.deepEqual(f.repo().recent(3).map(m=>m.id),expected.slice(-3));
 assert.deepEqual([...f.repo().records({afterId:'partial-8'})].map(m=>m.id),expected.slice(9));
 assert.deepEqual([...f.repo().records({afterId:'partial-10',descending:true})].map(m=>m.id),expected.slice(0,10).reverse());
 // #4265 ruling: a bare snapshot on an archived room returns the live window
 // only; this assertion wants full history, so it asks for it explicitly.
 assert.deepEqual(f.s.snapshot(f.token,'commons',null,'full',false,false,'full',null,true).state.messages.map(m=>m.id),expected);
 assert.deepEqual(f.s.snapshot(f.token,'commons',null,'full',false,false,'full',3).state.messages.map(m=>m.id),expected.slice(-3));
 assert.equal(f.s.db.prepare('SELECT count(*) n FROM messages WHERE message_id=?').get('partial-8').n,0,'read does not mutate or certify the partial table');
});


test('paging recovers posting sequences for unindexed replies and channel copies',t=>{
 const f=setup(t);
 f.post('root','Root');
 f.post('reply','Reply',{replyToId:'root',alsoSendToChannel:true});
 f.post('tail','Tail');
 const seq=f.s.db.prepare("SELECT sequence FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')='tail'").get().sequence;
 f.s.db.prepare("DELETE FROM messages WHERE room_id='commons'").run();
 const page=readMessagePage(f.s,f.token,'commons',{before:seq,limit:2});
 assert.deepEqual(page.messages.map(m=>m.id),['reply','reply:channel']);
 assert.equal(page.messagesPage.hasMore,true);
 assert.ok(Number.isSafeInteger(page.messagesPage.before));
 const older=readMessagePage(f.s,f.token,'commons',{before:page.messagesPage.before,limit:2});
 assert.deepEqual(older.messages.map(m=>m.id),['root']);
 assert.equal(older.messagesPage.hasMore,false);
});
