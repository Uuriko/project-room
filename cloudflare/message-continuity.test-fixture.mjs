// LOCAL TEST ONLY; never exported by the production Worker.
import entry, { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { RoomStore } from '../server/store.mjs';
import { durableStorage } from './storage.mjs';
import { event } from '../src/events.js';
import { initialRoom } from '../server/bootstrap.mjs';
import { readConversation } from '../server/conversation-sync.mjs';
import { messageRepository } from '../server/message-repository.mjs';
export class MessageContinuityTestRoom extends HttpTestRoom {
  async fetch(request) {
    if (new URL(request.url).pathname === '/__test-member-continuity') {
      const s=this.store, roomId='member-continuity';
      s.maintainMessageCertification=true;s.messageProjectionWindow=8;
      const events=initialRoom(roomId);
      for(let i=0;i<1000;i++) events.push(event({id:`seed-${i}`,idempotencyKey:`seed-${i}`,roomId,actorId:'owner',type:'message.posted',at:new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),data:{messageId:`seed-${i}`,body:`Settled ${i}.`}}));
      s.initialize(events);const token=s.issueAccessKey(roomId,'owner');s.roomFlood={consume(){}};
      while(!s.backfillMessages({limit:1000}).done) {} s.checkMessagesParity();
      s.archiveMessages(roomId,{keepNewest:8,dryRun:false});
      const command=(type,data)=>s.command(token,roomId,{id:crypto.randomUUID(),type,data});
      command('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});
      const joinCertified=s.db.prepare('SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get(roomId).parity_at_seq===s.headSequence(roomId);
      for(let i=0;i<40;i++)command('message.posted',{messageId:`new-${i}`,body:`Settled new ${i}.`});
      const warmTail=s.room(roomId).state.messages.length;
      // New RoomStore, same durable SQL storage: no hydrated cache survives.
      const cold=new RoomStore(null,{database:s.db,storagePlatform:durableStorage,messageProjectionWindow:8});
      const certificate=cold.db.prepare('SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get(roomId);
      return Response.json({joinCertified,warmTail,coldTail:cold.room(roomId).state.messages.length,
        member:cold.room(roomId).state.members.reader.id,head:cold.headSequence(roomId),certified:certificate.parity_at_seq,
        records:cold.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id=?').get(roomId).n,
        oldBody:messageRepository(cold,roomId).get('seed-0').body,parity:cold.checkMessagesParity().ok});
    }
    if (new URL(request.url).pathname !== '/__test-message-continuity') return super.fetch(request);
    const s=this.store;
    s.maintainMessageCertification=true;s.messageProjectionWindow=4;s.messageEntityProjection=true;
    s.initialize(initialRoom());const token=s.issueAccessKey('commons','owner');s.roomFlood={consume(){}};
    while(!s.backfillMessages({limit:1000}).done) {} s.checkMessagesParity();
    const command=(type,data)=>s.command(token,'commons',{id:crypto.randomUUID(),type,data});
    for(let i=0;i<18;i++)command('message.posted',{messageId:`fixture-${i}`,body:`Record ${i} completed.`});
    const replay=s._replayRoom; s._replayRoom=()=>{throw new Error('Ordinary archived edit must not replay');};
    command('message.edited',{messageId:'fixture-0',body:'Corrected.',expectedMessageRevision:0});
    s._replayRoom=replay;
    const snapshot=s.snapshot(token,'commons',null,'full',false,false,'full',3);
    const seek=[...messageRepository(s,'commons').records({afterId:'fixture-15'})].map(m=>m.id);
    const selected=readConversation(s,token,'commons',{messageId:'fixture-0'});
    const certificate=s.db.prepare('SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get('commons');
    const records=messageRepository(s,'commons');
    const recent=records.recent(3).map(m=>m.id);
    const recordCount=[...records.records()].length;
    const entityRefs=JSON.parse(s.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection).messages.every(m=>m._entity===1);
    return Response.json({entityRefs,seek,window:snapshot.messagesWindow,snapshotMessages:snapshot.state.messages.map(m=>m.id),recent,recordCount,head:s.headSequence('commons'),certified:certificate.parity_at_seq,
      tail:s.room('commons').state.messages.length,body:selected.messages[0].body,archivedBody:messageRepository(s,'commons').get('fixture-1').body,parity:s.checkMessagesParity().ok});
  }
}
export default entry;
