// LOCAL TEST ONLY; never exported by the production Worker.
import entry, { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readConversation } from '../server/conversation-sync.mjs';
import { messageRepository } from '../server/message-repository.mjs';
export class MessageContinuityTestRoom extends HttpTestRoom {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/__test-message-continuity') return super.fetch(request);
    const s=this.store;
    s.maintainMessageCertification=true;s.messageProjectionWindow=4;
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
    return Response.json({seek,window:snapshot.messagesWindow,snapshotMessages:snapshot.state.messages.map(m=>m.id),recent,recordCount,head:s.headSequence('commons'),certified:certificate.parity_at_seq,
      tail:s.room('commons').state.messages.length,body:selected.messages[0].body,archivedBody:messageRepository(s,'commons').get('fixture-1').body,parity:s.checkMessagesParity().ok});
  }
}
export default entry;
