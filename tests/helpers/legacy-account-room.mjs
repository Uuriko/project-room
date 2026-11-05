import {event,PERMISSIONS,HISTORY_DEFAULTS_VERSION} from '../../src/events.js';
// Explicit supported legacy representation for tests of legacy-only entity,
// backfill and inline archive contracts. This never relabels a current carrier
// or changes a schema watermark. New product rooms are tested separately.
export function legacyAccountRoom(store,accountId,{roomId,title,purpose,kind,displayName='Owner'}){
 return store.transaction(()=>{
  const at=new Date(store.now()).toISOString();
  store.initialize([
   event({type:'room.created',actorId:'owner',roomId,at,data:{roomId,ownerId:'owner',title,purpose,kind,historyDefaultsVersion:HISTORY_DEFAULTS_VERSION}}),
   event({type:'member.added',actorId:'owner',roomId,at,data:{memberId:'owner',displayName,kind:'human',permissions:[...PERMISSIONS]}})
  ],{representation:null});
  store.ensureHumanAccountBinding(roomId,'owner',accountId,'account-room-create');
  return roomId;
 });
}
