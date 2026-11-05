import {event,PERMISSIONS,HISTORY_DEFAULTS_VERSION} from '../../src/events.js';
// Historical compatibility fixture, deliberately NOT the new-room product API.
// These two journal entries and identity-link rows reproduce the pre-normalized
// agent-owned room. New canonical tests must use AgentRooms.create unchanged.
export function seedHistoricalNeedsMeRoom(store,owner,{roomId,title,purpose,kind='personal'}){
 const at=new Date(store.now()).toISOString(),memberId=owner.identityId;
 store.transaction(()=>{
  store.initialize([
   event({roomId,actorId:memberId,at,type:'room.created',data:{roomId,ownerId:memberId,title,purpose,kind,historyDefaultsVersion:HISTORY_DEFAULTS_VERSION}}),
   event({roomId,actorId:memberId,at,type:'member.added',data:{memberId,displayName:owner.displayName??'Historical owner',kind:'agent',identityId:memberId,permissions:[...PERMISSIONS]}})
  ]);
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run(roomId,memberId,memberId,store.now());
  store.db.prepare('INSERT INTO agent_room_ownership(identity_id,room_id,created_at,request_id) VALUES(?,?,?,NULL)').run(memberId,roomId,store.now());
 });
}
