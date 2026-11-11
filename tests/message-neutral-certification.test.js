import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event, applyEvent } from '../src/events.js';
import { captureMessageCertification, advanceMessageCertification } from '../server/messages-store.mjs';

function fixture(t, size = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'neutral-cert-'));
  const path = join(directory, 'room.sqlite');
  const options = {messageProjectionWindow:8};
  let store = new RoomStore(path, options);
  const events = initialRoom();
  for (let i=0;i<size;i++) events.push(event({id:`seed-${i}`,idempotencyKey:`seed-${i}`,roomId:'commons',actorId:'owner',type:'message.posted',at:new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),data:{messageId:`m-${i}`,body:`Settled ${i}.`}}));
  store.initialize(events);
  const owner = store.issueAccessKey('commons','owner');
  store.roomFlood = {consume(){}};
  while(!store.backfillMessages({limit:1000}).done) {};
  assert.equal(store.checkMessagesParity().ok,true);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {get store(){return store;},
    command:(type,data,id)=>store.command(owner,'commons',{id,type,data}),
    join:(id='reader')=>store.command(owner,'commons',{id:`join-${id}`,type:'member.added',data:{memberId:id,displayName:id,kind:'human',permissions:[]}}),
    certificate:()=>store.db.prepare("SELECT * FROM messages_backfill_cursor WHERE room_id='commons'").get(),
    reopen:()=>{store.close();store=new RoomStore(path,options);store.roomFlood={consume(){}};}};
}
for (const size of [1000,10000]) test(`membership addition preserves bounded tail and canonical parity at ${size} records`,t=>{
  const f=fixture(t,size);
  assert.equal(f.store.archiveMessages('commons',{keepNewest:8,dryRun:false}).ok,true);
  const checkpoint=f.certificate().state_seq;
  f.join();
  assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));
  for(let i=0;i<40;i++) f.command('message.posted',{messageId:`new-${i}`,body:`Settled new ${i}.`},`new-${i}`);
  assert.ok(f.store.room('commons').state.messages.length<=16);
  assert.equal(f.certificate().state_seq,checkpoint,'no replay checkpoint rewrite');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='commons'").get().n,size+40);
  f.reopen();
  assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));
  assert.ok(f.store.room('commons').state.messages.length<=16);
  assert.equal(f.store.checkMessagesParity().ok,true,'independent canonical verifier after restart');
});

test('member certificate requires unchanged immutable records, pins, archive and exact current anchor',t=>{
  const f=fixture(t);
  const previous=f.store.room('commons');
  const incoming=event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]}});
  const next=applyEvent(previous.state,incoming);
  assert.equal(next.messages[0],previous.state.messages[0]);
  f.store.transaction(()=>{
    const capture=(state=previous.state,nextState=next)=>captureMessageCertification(f.store.db,{roomId:'commons',sequence:previous.sequence,event:incoming,state,nextState});
    assert.ok(capture());
    assert.equal(capture(structuredClone(previous.state)),null,'mutable input is not a witness');
    for(const changed of [
      {...next,messages:[{...next.messages[0],body:'hook changed content'}]},
      {...next,messages:[{...next.messages[0],receiptId:'hook metadata'}]},
      {...next,pins:[{messageId:'m-0'}]},
      {...next,messagesArchive:{throughSeq:99}},
      {...next,messages:[]}
    ]) assert.equal(capture(previous.state,changed),null);
    const certificate=capture();
    assert.equal(advanceMessageCertification(f.store.db,certificate,{sequence:previous.sequence+1,event:incoming,state:{...next,messages:[]}}),false,'recheck witness at persist');
    f.store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='wrong' WHERE room_id='commons'").run();
    assert.equal(capture(),null,'head sequence alone is not authority');
  });
});

test('quarantine and unsupported transitions cannot promote a member certificate',t=>{
  const f=fixture(t);
  f.store.db.prepare("INSERT INTO messages_backfill_blocks(room_id,sequence,error) VALUES('commons',1,'quarantined')").run();
  f.join();
  assert.notEqual(f.certificate().parity_at_seq,f.store.headSequence('commons'));
  f.store.db.prepare("DELETE FROM messages_backfill_blocks WHERE room_id='commons'").run();
  f.join('second');
  assert.notEqual(f.certificate().parity_at_seq,f.store.headSequence('commons'),'cannot heal a missing prior certificate');
});

test('failed member certificate update rolls back membership, head and certification across restart',t=>{
  const f=fixture(t);
  const before={...f.certificate()},head=f.store.headSequence('commons');
  f.store.db.exec("CREATE TRIGGER reject_member_certificate BEFORE UPDATE OF applied_seq ON messages_backfill_cursor BEGIN SELECT RAISE(ABORT,'injected neutral failure'); END");
  assert.throws(()=>f.join(),/injected neutral failure/);
  assert.equal(f.store.headSequence('commons'),head);
  assert.equal(f.store.room('commons').state.members.reader,undefined);
  assert.deepEqual({...f.certificate()},before);
  f.reopen();
  assert.equal(f.store.room('commons').state.members.reader,undefined);
  assert.deepEqual({...f.certificate()},before);
  f.store.db.exec('DROP TRIGGER reject_member_certificate');
  f.join();
  assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));
  assert.equal(f.store.checkMessagesParity().ok,true);
});
