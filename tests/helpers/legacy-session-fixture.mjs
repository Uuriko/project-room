import assert from 'node:assert/strict';
import { initialRoom } from '../../server/bootstrap.mjs';
import { applyEvent, emptyRoomState, event } from '../../src/events.js';
import { syncMessageRows } from '../../server/messages-store.mjs';

// Entirely synthetic reproduction of the pre749 contract: session events
// changed the session/revision, while explicit lifecycle events changed state.
export function historicalSequence(roomId='legacy-room') {
  const base=initialRoom(roomId,'owner').map((e,i)=>({...e,at:new Date(Date.UTC(2026,8,1,0,0,i)).toISOString()}));
  const definitions=[
    ['work.proposed',{workItemId:'task',title:'Synthetic historical task',definitionOfDone:'A synthetic result',accountableMemberId:'owner',mode:'read'}],
    ['session.started',{workItemId:'task',expectedRevision:0}],
    ['session.status_changed',{workItemId:'task',status:'active',expectedRevision:1}],
    ['session.stopped',{workItemId:'task',status:'done',expectedRevision:2}],
    ['work.accepted',{workItemId:'task',expectedRevision:3}],
    ['work.started',{workItemId:'task',expectedRevision:4}],
    ['message.posted',{messageId:'message',body:'Synthetic historical message'}]
  ];
  return [...base,...definitions.map(([type,data],i)=>event({id:'synthetic-'+i,idempotencyKey:'synthetic-key-'+i,roomId,actorId:'owner',at:new Date(Date.UTC(2026,8,1,0,1,i)).toISOString(),type,data}))];
}
export function fixtureLegacyApply(state,incoming) {
  const previous=state.workItems?.[incoming.data?.workItemId]?.state;
  const next=applyEvent(state,incoming);
  if(['session.started','session.status_changed','session.stopped'].includes(incoming.type)&&previous)
    next.workItems[incoming.data.workItemId].state=previous;
  return next;
}
export function seedLegacyFixture(s, events=historicalSequence()) {
  const initial=events.slice(0,initialRoom().length);s.initialize(initial);
  let state=emptyRoomState();
  // Trusted historical-writer fixture. These proofs pre-exist every repair
  // invocation; production repair may neither establish nor replace them.
  s.transaction(()=>{
    for(const [index,incoming]of events.entries()){
      state=fixtureLegacyApply(state,incoming);
      if(index>=initial.length){s.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('legacy-room',index+1,incoming.id,JSON.stringify(incoming));syncMessageRows(s.db,{roomId:'legacy-room',sequence:index+1,event:incoming,state});}
    }
    const compact={...state,eventLog:[],seenEvents:{},seenIdempotencyKeys:{}};
    s.db.prepare('UPDATE rooms SET sequence=?,projection=? WHERE id=?').run(events.length,s.storedProjection('legacy-room',compact),'legacy-room');
    s.rememberReconstructedRoomProof('legacy-room');
  });
  const backfill=s.backfillMessages({limit:64});
  assert.equal(backfill.quarantined.length,1);
  const request={repairKind:'pre749-session-backfill',rooms:[{roomId:'legacy-room',expectedHead:events.length}],reason:'Synthetic historical backfill reconciliation'};
  return{s,events,request};
}
