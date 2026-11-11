import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';

test('proof adoption intent is explicit, plan bound and immutable on receipt retry',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom());
 const plain={roomId:'commons',discardLegacyAssignments:true};
 const ordinary=operatorNormalization(s,plain),opted=operatorNormalization(s,{...plain,adoptAbsentInlineProofs:true});
 assert.equal(ordinary.adoptAbsentInlineProofs,false);assert.equal(opted.adoptAbsentInlineProofs,true);
 assert.notEqual(ordinary.planHash,opted.planHash);
 assert.equal(typeof opted.messages.missingProofs,'number');
 for(const bad of [null,1,'true',{}])assert.throws(()=>operatorNormalization(s,{...plain,adoptAbsentInlineProofs:bad}),e=>e.code==='invalid_normalization_request');
 const request={...plain,adoptAbsentInlineProofs:true,planHash:opted.planHash,requestId:'proof-intent',reason:'Explicit synthetic qualification'};
 assert.throws(()=>operatorNormalization(s,{...request,planHash:ordinary.planHash},true),e=>e.code==='plan_changed');
 const result=operatorNormalization(s,request,true);assert.equal(result.adoptAbsentInlineProofs,true);
 assert.deepEqual(operatorNormalization(s,request,true),{...result,duplicate:true});
 assert.throws(()=>operatorNormalization(s,{...request,adoptAbsentInlineProofs:false},true),e=>e.code==='idempotency_conflict');
});
