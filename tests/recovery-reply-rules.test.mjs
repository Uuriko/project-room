import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceReplyRequestAudit,compareReplyRequestAudit} from '../server/recovery-reply-rules.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
test('independent reply rules retain exact request presence and immutable message fields',()=>{
 const state={room:null,members:{},workItems:{},messages:[]},posts=new Map(),ids=new Set();
 initialRoom('reply-rules','owner').forEach((event,i)=>advanceReplyRequestAudit(state,{sequence:i+1,event},{posts,ids}));
 assert.equal(state.room.ownerId,'owner');assert.equal(state.members.owner.active,true);
 assert.throws(()=>compareReplyRequestAudit({...state,replyRequests:{}},state),/reconciliation/);
 const message={id:'m',authorId:'owner',body:'source',workItemId:null,replyToId:null,toMemberId:null,createdAt:'2026-11-01T00:00:00.000Z'},expected={replyRequests:{},messages:[message]};
 assert.doesNotThrow(()=>compareReplyRequestAudit(structuredClone(expected),expected));
 assert.throws(()=>compareReplyRequestAudit({...expected,messages:[{...message,body:'substitution'}]},expected),/reconciliation/);
});
