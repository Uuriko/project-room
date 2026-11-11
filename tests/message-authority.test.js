import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMessageAuthority } from '../server/message-authority.mjs';
import { exportNdjsonText } from '../server/room-export.mjs';
import { replayNdjsonInto } from '../server/restore-ndjson.mjs';
import { readConversation } from '../server/conversation-sync.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { selectedMessageRecord } from '../server/message-repository.mjs';
function fixture(t) {
  const s = new RoomStore(':memory:', { maintainMessageCertification: true });
  t.after(() => s.close()); s.initialize(initialRoom());
  const owner = s.issueAccessKey('commons', 'owner');
  const send = (type, data, id = crypto.randomUUID()) => s.command(owner, 'commons', { id, type, data });
  const post = (id, body = `Body ${id}`) => send('message.posted', { messageId: id, body });
  const certify = () => { while (!s.backfillMessages({ limit: 1000 }).done) {} assert.equal(s.checkMessagesParity({roomId:'commons'}).ok,true); };
  const raw = () => JSON.parse(s.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  return { s, send, post, certify, raw };
}
test('explicit conversion preserves records and event head, is idempotent and reversible', t => {
  const f = fixture(t); f.post('first'); f.post('second'); f.certify();
  const before = f.s.room('commons');
  assert.equal(f.s.migrateMessageAuthority('commons').changed,true);
  assert.equal(Object.hasOwn(f.raw(),'messages'),false);
  assert.equal(hasMessageAuthority(f.raw()),true);
  assert.deepEqual(f.raw().messageAuthority,{version:1,count:2});
  assert.deepEqual(f.s.room('commons').state.messages,before.state.messages);
  assert.equal(f.s.room('commons').sequence,before.sequence);
  assert.equal(f.s.migrateMessageAuthority('commons').changed,false);
  assert.equal(f.s.migrateMessageAuthority('commons',{reverse:true}).changed,true);
  assert.equal(Object.hasOwn(f.raw(),'messageAuthority'),false);
  assert.deepEqual(f.s.room('commons').state,before.state);
});
test('commands persist canonical entities and replay remains equivalent', t => {
  const f=fixture(t); f.post('first'); f.certify(); f.s.migrateMessageAuthority('commons');
  f.post('second');
  f.send('message.edited',{messageId:'first',body:'Revised',expectedMessageRevision:0});
  f.send('message.posted',{messageId:'reply',body:'Reply',replyToId:'first',alsoSendToChannel:true});
  assert.equal(f.raw().messageAuthority.count,4);
  assert.equal(Object.hasOwn(f.raw(),'messages'),false);
  assert.equal(f.s.room('commons').state.messages[0].body,'Revised');
  assert.equal(selectedMessageRecord(f.s,'commons','first').body,'Revised');
  f.certify(); assert.doesNotThrow(()=>auditRecovery(f.s));
  f.send('message.deleted',{messageId:'first',expectedMessageRevision:1,reason:'test'});
  assert.equal(f.s.room('commons').state.messages[0].body,null);
  f.certify(); assert.doesNotThrow(()=>auditRecovery(f.s));
});
test('missing rows, invalid markers and competing arrays fail closed even with warm cache', t=>{
  const f=fixture(t); f.post('first');f.certify();f.s.migrateMessageAuthority('commons');
  f.s.room('commons');
  assert.throws(()=>f.s.transaction(()=>{f.s.db.prepare("DELETE FROM messages WHERE message_id='first'").run();f.s.room('commons');}),/projection_corrupt/);
  assert.equal(f.s.room('commons').state.messages.length,1);
  for(const mutation of [r=>{r.messageAuthority.count=-1;},r=>{r.messageAuthority.version=2;},r=>{r.messages=[];}]) {
    assert.throws(()=>f.s.transaction(()=>{const r=f.raw();mutation(r);f.s.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(r));f.s.room('commons');}),/projection_corrupt/);
  }
});
test('failed entity write rolls back event, receipt and canonical count together',t=>{
  const f=fixture(t); f.post('first');f.certify();f.s.migrateMessageAuthority('commons');
  const before=f.s.room('commons');
  f.s.db.exec("CREATE TRIGGER fail_new_message BEFORE INSERT ON messages WHEN NEW.message_id='fail' BEGIN SELECT RAISE(ABORT,'injected entity failure'); END");
  assert.throws(()=>f.post('fail'),/injected entity failure/);
  assert.equal(f.s.room('commons').sequence,before.sequence);assert.equal(f.raw().messageAuthority.count,1);
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(body,'$.data.messageId')='fail'").get().n,0);
  f.s.db.exec('DROP TRIGGER fail_new_message');f.post('fail');assert.equal(f.raw().messageAuthority.count,2);
});
test('archive view survives authority migration, new posts, parity and reverse',t=>{
  const f=fixture(t);for(let i=0;i<8;i++)f.post(`m${i}`);f.certify();
  assert.equal(f.s.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
  const before=f.s.room('commons').state.messages;f.certify();f.s.migrateMessageAuthority('commons');
  assert.deepEqual(f.s.room('commons').state.messages,before);
  assert.equal(selectedMessageRecord(f.s,'commons','m0',true).body,'Body m0');
  f.post('last');f.certify();assert.doesNotThrow(()=>auditRecovery(f.s));
  f.s.migrateMessageAuthority('commons',{reverse:true});assert.equal(f.s.room('commons').state.messages.at(-1).id,'last');
});
test('stored metadata contains no message bodies or per-message references',t=>{
  const f=fixture(t);f.post('one','x'.repeat(10000));f.certify();f.s.migrateMessageAuthority('commons');
  const first=JSON.stringify(f.raw());for(let i=0;i<25;i++)f.post(`next${i}`,'y'.repeat(1000));
  const next=JSON.stringify(f.raw());assert.ok(next.length-first.length<100);
  assert.equal(next.includes('x'.repeat(100)),false);assert.equal(next.includes('next24'),false);
});

test('conversation reads use canonical rows even after unsupported events invalidate parity',t=>{
 const f=fixture(t);f.post('first');f.certify();f.s.migrateMessageAuthority('commons');
 f.send('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});
 f.s.db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id='commons'").run();
 const token=f.s.issueAccessKey('commons','owner');
 assert.equal(readConversation(f.s,token,'commons',{}).messages[0].body,'Body first');
});
test('canonical whole-store export restores and verifies inside an empty target',t=>{
 const f=fixture(t);f.post('first');f.certify();f.s.migrateMessageAuthority('commons');f.post('next');
 const target=new RoomStore(':memory:');t.after(()=>target.close());
 assert.equal(replayNdjsonInto(exportNdjsonText(f.s.db),target).verified,true);
 assert.deepEqual(target.room('commons').state,f.s.room('commons').state);
 assert.doesNotThrow(()=>auditRecovery(target));
});
test('event history replacement maintains authority and new posting provenance atomically',t=>{
 const f=fixture(t);f.post('first');f.certify();f.s.migrateMessageAuthority('commons');
 const lines=f.s.db.prepare("SELECT sequence,body FROM events WHERE room_id='commons' ORDER BY sequence").all().map(r=>({sequence:r.sequence,event:JSON.parse(r.body)}));
 f.post('removed-by-import');const token=f.s.issueAccessKey('commons','owner');
 assert.equal(f.s.importEvents(token,'commons',lines).imported,lines.length);
 assert.equal(hasMessageAuthority(f.raw()),true);assert.equal(f.raw().messageAuthority.count,1);
 assert.equal(selectedMessageRecord(f.s,'commons','removed-by-import'),undefined);
 assert.equal(f.s.room('commons').state.messages[0].id,'first');
 f.certify();assert.doesNotThrow(()=>auditRecovery(f.s));
});

test('archived deletion preserves retained count and erases prior wording',t=>{
 const f=fixture(t);for(let i=0;i<6;i++)f.post(`m${i}`);f.certify();
 f.s.archiveMessages('commons',{keepNewest:2,dryRun:false});f.certify();f.s.migrateMessageAuthority('commons');
 f.send('message.deleted',{messageId:'m0',expectedMessageRevision:0,reason:'removed'});
 assert.equal(f.s.room('commons').state.messages.find(m=>m.id==='m0').body,null);
 assert.equal(JSON.stringify(f.s.room('commons').state).includes('Body m0'),false);
 f.certify();assert.doesNotThrow(()=>auditRecovery(f.s));
});

test('archived authority rooms retain ordinary write refusal and the explicit owner privacy exception',t=>{
 const f=fixture(t);f.post('first');f.certify();f.s.migrateMessageAuthority('commons');f.send('room.archived',{});
 const head=f.s.headSequence('commons'),archived=structuredClone(f.s.room('commons').state.room);
 assert.throws(()=>f.post('forbidden'),error=>error.code==='room_archived');
 assert.throws(()=>f.send('message.edited',{messageId:'first',expectedMessageRevision:0,body:'Forbidden edit'}),error=>error.code==='room_archived');
 assert.equal(f.s.headSequence('commons'),head);assert.equal(f.s.room('commons').state.messages[0].body,'Body first');
 const data={messageId:'first',expectedMessageRevision:0,reason:'Explicit owner privacy cleanup'},saved=f.send('message.deleted',data,'erase-after-archive');
 assert.equal(saved.duplicate,false);assert.equal(f.send('message.deleted',data,'erase-after-archive').duplicate,true);
 assert.equal(f.s.room('commons').state.messages[0].body,null);assert.deepEqual(f.s.room('commons').state.room,archived);assert.equal(f.raw().messageAuthority.count,1);f.certify();assert.doesNotThrow(()=>auditRecovery(f.s));
 assert.throws(()=>f.post('still-forbidden'),error=>error.code==='room_archived');
 const cold=new RoomStore(':memory:',{maintainMessageCertification:true});t.after(()=>cold.close());replayNdjsonInto(exportNdjsonText(f.s.db),cold);assert.deepEqual(cold.room('commons').state.room,archived);assert.equal(cold.room('commons').state.messages[0].body,null);assert.doesNotThrow(()=>auditRecovery(cold));
});

test('retained top-level edit loads no unrelated room messages and preserves global count',t=>{
 const f=fixture(t);f.s.roomFlood={consume(){}};for(let i=0;i<100;i++)f.post(`m${i}`);f.certify();f.s.migrateMessageAuthority('commons');
 const original=f.s.room;let reads=0;f.s.room=()=>{reads++;throw Error('unbounded room read');};
 try{f.send('message.edited',{messageId:'m99',body:'Bounded edit',expectedMessageRevision:0});}
 finally{f.s.room=original;}
 assert.equal(reads,0);assert.equal(f.raw().messageAuthority.count,100);
 assert.equal(f.s.room('commons').state.messages.length,100);
 assert.equal(f.s.room('commons').state.messages.at(-1).body,'Bounded edit');
 f.certify();assert.doesNotThrow(()=>auditRecovery(f.s));
});
test('bounded edit agrees with the full command pipeline for records, history, indexes and refusals',t=>{
 const f=fixture(t);for(let i=0;i<12;i++)f.post(`m${i}`);f.certify();f.s.migrateMessageAuthority('commons');
 const full=new RoomStore(':memory:',{maintainMessageCertification:true});t.after(()=>full.close());
 replayNdjsonInto(exportNdjsonText(f.s.db),full);full.canonicalMessageEditContext=()=>null;
 const key1=f.s.issueAccessKey('commons','owner'),key2=full.issueAccessKey('commons','owner');
 f.s.now=full.now=()=>Date.UTC(2026,10,1);
 const commands=[{id:'edit1',type:'message.edited',data:{messageId:'m9',body:'改訂 🪷',expectedMessageRevision:0}},
 {id:'edit2',type:'message.edited',data:{messageId:'m9',body:'Second revision',expectedMessageRevision:1}}];
 for(const command of commands){f.s.command(key1,'commons',command);full.command(key2,'commons',command);}
 assert.deepEqual(f.s.room('commons').state,full.room('commons').state);
 const rows=s=>s.db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY seq,message_id").all();assert.deepEqual(rows(f.s),rows(full));
 for(const revision of [0,3]){
  const cmd={id:crypto.randomUUID(),type:'message.edited',data:{messageId:'m9',body:'Refused',expectedMessageRevision:revision}};
  const outcome=(s,key)=>{try{s.command(key,'commons',cmd);return null;}catch(e){return[e.status,e.code,e.message];}};
  assert.deepEqual(outcome(f.s,key1),outcome(full,key2));
 }
});
