import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readConversation} from '../server/conversation-sync.mjs';
// These labels are both legal under validateEnvelope and represent the same
// instant. Sequence, not the spelling of the offset, must break the join tie.
test('an earlier equivalent-offset timestamp cannot cross a normalized since-join floor',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const at='2026-11-01T00:00:00.000Z',offset='2026-11-01T01:00:00+01:00';assert.equal(Date.parse(at),Date.parse(offset));
 const es=initialRoom();for(const e of es)e.at=at;
 es.push(event({roomId:'commons',actorId:'owner',at,type:'room.history_visibility_set',data:{historyVisibility:'since_join'}}));
 es.push(event({roomId:'commons',actorId:'owner',at:offset,type:'message.posted',data:{messageId:'before-offset',body:'Must stay before join'}}));
 es.push(event({roomId:'commons',actorId:'owner',at,type:'member.added',data:{memberId:'joined',displayName:'Joining agent',kind:'agent',permissions:[]}}));
 es.push(event({roomId:'commons',actorId:'owner',at,type:'message.posted',data:{messageId:'after-canonical',body:'Visible after join'}}));
 s.initialize(es,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','joined');
 assert.throws(()=>readConversation(s,key,'commons',{messageId:'before-offset'}),e=>e.status===404);
 assert.equal(readConversation(s,key,'commons',{messageId:'after-canonical'}).messages[0].body,'Visible after join');
});
