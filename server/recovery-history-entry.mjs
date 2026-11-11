// Exact event-history predicates shared by the existing full audit and its
// durable continuation. This validates history, not reducer equivalence.
import {EVENT_TYPES,RETIRED_REPLAY_EVENT_TYPES,validId} from '../src/events.js';
const requireState=condition=>{if(!condition)throw Error('Recovery data requires operator reconciliation');};
export function validateRecoveryHistoryEntry(entry,expectedSequence,roomId){
 const incoming=JSON.parse(entry.body);
 requireState(entry.sequence===expectedSequence&&incoming.id===entry.id&&incoming.roomId===roomId);
 requireState([incoming.id,incoming.idempotencyKey,incoming.actorId,incoming.roomId].every(validId)
  &&(Object.values(EVENT_TYPES).includes(incoming.type)||Object.values(RETIRED_REPLAY_EVENT_TYPES).includes(incoming.type))
  &&typeof incoming.at==='string'&&Number.isFinite(Date.parse(incoming.at))
  &&incoming.data&&typeof incoming.data==='object'&&!Array.isArray(incoming.data));
 return incoming;
}
