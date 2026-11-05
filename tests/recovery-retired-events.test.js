import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {EVENT_TYPES,event,RETIRED_REPLAY_EVENT_TYPES} from '../src/events.js';
import {exportNdjsonText} from '../server/room-export.mjs';
import {replayNdjsonInto} from '../server/restore-ndjson.mjs';
const retired=RETIRED_REPLAY_EVENT_TYPES.MESSAGE_REACTION_SET;
function fixture(t){
 const store=new RoomStore(':memory:');t.after(()=>store.close());
 store.initialize([...initialRoom('commons'),event({type:'message.posted',actorId:'owner',roomId:'commons',id:'posted',data:{messageId:'message',body:'Synthetic message'}}),
  event({type:retired,actorId:'owner',roomId:'commons',id:'retired-event',data:{messageId:'message',emoji:'watch',active:true}})]);
 return store;
}
function restore(t,source){const target=new RoomStore(':memory:');t.after(()=>target.close());return {target,result:replayNdjsonInto(exportNdjsonText(source.db),target)};}
test('strict restore retains supported retired reaction history without restoring live reactions',t=>{
 const source=fixture(t),before=source.db.prepare("SELECT body FROM events WHERE id='retired-event'").get().body;
 const {target,result}=restore(t,source);assert.equal(result.verified,true);assert.equal(result.audit.ok,true);assert.equal(result.contentVerification,'full');
 assert.equal(target.db.prepare("SELECT body FROM events WHERE id='retired-event'").get().body,before);
 assert.equal(Object.hasOwn(target.room('commons').state.messages[0],'reactions'),false);
 assert.equal(Object.values(EVENT_TYPES).includes(retired),false);
 const owner=target.issueAccessKey('commons','owner');
 assert.throws(()=>target.command(owner,'commons',{id:'new-reaction',type:retired,data:{messageId:'message',emoji:'watch',active:true}}));
});
for(const [name,edit,expected] of [
 ['unknown type',e=>{e.type='message.unknown_retired';}, /Unsupported event type/],
 ['missing actor',e=>{delete e.actorId;}, /Event missing actorId/],
 ['missing idempotency key',e=>{delete e.idempotencyKey;}, /Event missing idempotencyKey/],
 ['invalid timestamp',e=>{e.at='invalid';}, /Event at must be an ISO date/],
 ['array data',e=>{e.data=[];}, /Event data must be an object/]
])test(`strict restore rejects ${name} in historical event`,t=>{
 const source=fixture(t),row=source.db.prepare("SELECT body FROM events WHERE id='retired-event'").get(),historical=JSON.parse(row.body);edit(historical);
 source.db.prepare("UPDATE events SET body=? WHERE id='retired-event'").run(JSON.stringify(historical));
 assert.throws(()=>restore(t,source), expected);
});
