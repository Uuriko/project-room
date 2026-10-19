import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, replayEvents, emptyRoomState, event } from '../src/events.js';
import { initialRoom } from '../server/bootstrap.mjs';
const post = (id,extra={}) => event({id,roomId:'commons',actorId:'owner',idempotencyKey:id,
 type:'message.posted',at:'2026-01-01T00:00:00.000Z',data:{messageId:id,body:'Recorded.',...extra}});
function freeze(value){if(value && typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

test('owned replay journal matches immutable event folds including duplicate events and resumed state',()=>{
 const first=initialRoom();const initial=first.reduce(applyEvent,emptyRoomState());
 const events=[...Array.from({length:120},(_,i)=>post(`m-${i}`))];events.push(events[12]);
 events.push(event({id:'edit',idempotencyKey:'edit',roomId:'commons',actorId:'owner',type:'message.edited',at:'2026-01-02T00:00:00.000Z',data:{messageId:'m-0',body:'Changed.',expectedMessageRevision:0}}));
 const before=structuredClone(initial);freeze(initial);
 const expected=events.reduce(applyEvent,initial);
 assert.deepEqual(replayEvents(initial,events),expected);assert.deepEqual(initial,before);
 const half=replayEvents(initial,events.slice(0,60));
 assert.deepEqual(replayEvents(half,events.slice(60)),expected);
 assert.deepEqual(replayEvents(emptyRoomState(),[...first,...events]),expected);
 assert.equal(replayEvents(initial,[]),initial);
});

test('replay refuses conflicting event or idempotency reuse and late failures never mutate its input',()=>{
 const original=post('original');const initial=replayEvents(emptyRoomState(),[...initialRoom(),original]);
 const before=structuredClone(initial);freeze(initial);
 for(const conflicting of [{...original,data:{...original.data,body:'Different.'}}, {...post('different'),idempotencyKey:original.idempotencyKey}]) {
  assert.throws(()=>replayEvents(initial,[post('temporary'),conflicting]),/Conflicting reuse/);
  assert.deepEqual(initial,before);
 }
 assert.throws(()=>replayEvents(initial,[post('temporary'),post('bad',{replyToId:'missing'})]),/Reply must reference/);
 assert.deepEqual(initial,before);
});
