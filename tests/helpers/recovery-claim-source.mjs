import {initialRoom} from '../../server/bootstrap.mjs';
import {event,emptyRoomState,replayEvents} from '../../src/events.js';
import {auditRecovery} from '../../server/recovery.mjs';
export function seedRecoveryClaimSource(store) {
 const history=[...initialRoom()],push=(type,data)=>history.push(event({roomId:'commons',actorId:'owner',type,data,at:'2026-11-01T00:00:00.000Z'}));
 const ids=['z-first',...Array.from({length:150},(_,n)=>'no-overlap-'+n),'20','2','4294967294','01','4294967295','target'];
 for(const id of ids){push('work.proposed',{workItemId:id,title:id,definitionOfDone:'Preserve exact overlap evidence',accountableMemberId:'owner',mode:'write'});push('work.accepted',{workItemId:id,expectedRevision:0});}
 for(const id of ['z-first','20','2','4294967294','01','4294967295'])push('claim.acquired',{workItemId:id,expectedRevision:1,repository:' Synthetic/Repo ',ref:'branch-'+id,paths:['src/**','notes.txt'],expiresAt:'2099-01-01T00:00:00.000Z'});
 const prefix=history.length,checkpoint=replayEvents(emptyRoomState(),structuredClone(history));
 push('claim.acquired',{workItemId:'target',expectedRevision:1,repository:'synthetic/repo',ref:'target',paths:['src/file.js'],expiresAt:'2099-01-01T00:00:00.000Z'});
 store.initialize(history,{representation:'normalized-current-v1'});
 store.transaction(()=>store.db.prepare('INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)').run('commons',prefix,JSON.stringify(checkpoint)));
 auditRecovery(store);
 return {head:history.length,prefix,workItems:ids.length,expected:['2','20','4294967294','z-first','01','4294967295']};
}
