// LOCAL TEST ONLY; never exported by the production Worker.
import entry, { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readConversation } from '../server/conversation-sync.mjs';
export class MessageContinuityTestRoom extends HttpTestRoom {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/__test-message-continuity') return super.fetch(request);
    const s=this.store;
    s.maintainMessageCertification=true;s.messageProjectionWindow=4;
    s.initialize(initialRoom());const token=s.issueAccessKey('commons','owner');s.roomFlood={consume(){}};
    while(!s.backfillMessages({limit:1000}).done) {} s.checkMessagesParity();
    const command=(type,data)=>s.command(token,'commons',{id:crypto.randomUUID(),type,data});
    for(let i=0;i<18;i++)command('message.posted',{messageId:`fixture-${i}`,body:`Record ${i} completed.`});
    command('message.edited',{messageId:'fixture-0',body:'Corrected.',expectedMessageRevision:0});
    const selected=readConversation(s,token,'commons',{messageId:'fixture-0'});
    const certificate=s.db.prepare('SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get('commons');
    return Response.json({head:s.headSequence('commons'),certified:certificate.parity_at_seq,
      tail:s.room('commons').state.messages.length,body:selected.messages[0].body,parity:s.checkMessagesParity().ok});
  }
}
export default entry;
