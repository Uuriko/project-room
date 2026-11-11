import {createWork,claimWork} from '../../server/work-claims.mjs';
import {emitWorkClaimEvent} from '../../server/work-claim-events.mjs';
import {isFirstContribution,retentionAck} from '../../server/retention-response.mjs';
import {event,PERMISSIONS,HISTORY_DEFAULTS_VERSION} from '../../src/events.js';
// Synthetic existing agent-owned legacy room for historical Board contracts.
// Never relabel a normalized carrier or weaken production room creation/linking.
export function legacyAgentRoom(store,identity,{roomId,title,purpose,kind='personal',displayName='Owner',starter=true}) {
 return store.transaction(()=>{
  const at=new Date(store.now()).toISOString(),memberId=identity.identityId;
  store.initialize([
   event({type:'room.created',actorId:memberId,roomId,at,data:{roomId,ownerId:memberId,title,purpose,kind,historyDefaultsVersion:HISTORY_DEFAULTS_VERSION}}),
   event({type:'member.added',actorId:memberId,roomId,at,data:{memberId,displayName,kind:'agent',permissions:[...PERMISSIONS],identityId:identity.identityId}})
  ],{representation:null});
  // Register only this already-held synthetic founding identity, as the
  // historical room-create path did; no new credential or identity inference.
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run(roomId,identity.identityId,memberId,store.now());
  store.db.prepare('INSERT INTO agent_room_ownership(identity_id,room_id,created_at) VALUES(?,?,?)').run(identity.identityId,roomId,store.now());
  if(starter){
   // Preserve the existing historical AgentRooms legacy starter branch,
   // including both sequenced receipts and first-contribution retention ack.
   const now=store.now();let item=createWork({id:'starter',title:'Post your plan, then close this task',tags:['starter']},{now,agentId:memberId});
   store.workClaims.set(roomId,item);emitWorkClaimEvent(store,roomId,{actorId:memberId,item,action:'created',atMs:now});
   item=claimWork(item,memberId,{leaseHours:2,now});
   const first=isFirstContribution(store.workClaims.list(roomId).filter(row=>row.id!=='starter'),memberId);
   item=retentionAck(item,{now,first,agentId:memberId});store.workClaims.set(roomId,item);emitWorkClaimEvent(store,roomId,{actorId:memberId,item,action:'claimed',atMs:now});
  }
  return {roomId,ownerMemberId:memberId};
 });
}
