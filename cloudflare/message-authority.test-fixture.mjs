// Local qualification only. No production route enables this migration.
import { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { RoomStore } from '../server/store.mjs';
import { durableStorage } from './storage.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readConversation } from '../server/conversation-sync.mjs';
export class MessageAuthorityTestRoom extends HttpTestRoom {
 async fetch() {
  const s=this.store; s.maintainMessageCertification=true;
  s.initialize(initialRoom()); const owner=s.issueAccessKey('commons','owner');
  const post=(id)=>s.command(owner,'commons',{id,type:'message.posted',data:{messageId:id,body:`Body ${id}`}});
  post('first');while(!s.backfillMessages({limit:1000}).done){};s.checkMessagesParity();
  s.migrateMessageAuthority('commons');post('second');
  s.command(owner,'commons',{id:'edit-second',type:'message.edited',data:{messageId:'second',body:'Bounded Worker edit',expectedMessageRevision:0}});
  const cold=new RoomStore(null,{database:s.db,storagePlatform:durableStorage});
  const read=readConversation(cold,owner,'commons',{});
  await cold.verifyRoomIntegrity();await cold.verifyRoomIntegrity();
  const beforeHash=cold.integrityChecksum().text;
  cold.db.prepare("UPDATE messages SET body='Changed Worker edit',record_json=json_set(record_json,'$.body','Changed Worker edit') WHERE message_id='second'").run();
  const payloadHashChanged=cold.integrityChecksum().text!==beforeHash;
  const payloadDrift=(await cold.verifyRoomIntegrity()).verified===0
    && cold.integrityFailures().some(f=>f.step==='projection_content'&&f.recordId==='commons');
  cold.db.prepare("UPDATE messages SET body='Bounded Worker edit',record_json=json_set(record_json,'$.body','Bounded Worker edit') WHERE message_id='second'").run();
  await cold.verifyRoomIntegrity();
  const raw=JSON.parse(s.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  let refused=false;
  try{s.transaction(()=>{s.db.prepare("DELETE FROM messages WHERE message_id='first'").run();s.room('commons');});}catch(e){refused=e.message.includes('projection_corrupt');}
  const preserved=s.room('commons').state.messages.length;
  cold.migrateMessageAuthority('commons',{reverse:true});
  return Response.json({hasArray:Object.hasOwn(raw,'messages'),count:raw.messageAuthority.count,
   bodies:read.messages.map(m=>m.body),refused,preserved,payloadHashChanged,payloadDrift,reverse:cold.room('commons').state.messages.length});
 }
}
export default {fetch(request,env){return env.ROOM.getByName('authority-fixture').fetch(request);}};
