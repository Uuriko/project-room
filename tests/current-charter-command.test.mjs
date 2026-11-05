import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {seedHistoricalRedactionSource} from './helpers/historical-redaction-source.mjs';
import {auditRecovery} from '../server/recovery.mjs';
const command=(id='current-instructions',revision=0)=>({id,type:'room.charter_updated',data:{expectedRevision:revision,purpose:'Keep agents focused on useful work',outputs:'Save evidence',boundaries:null,escalation:'Ask the owner'}});
test('existing owner can edit room instructions after normalized activation and retry exactly',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const f=seedHistoricalRedactionSource(store),before=store.headSequence('legacy-room');
 const input=command(),result=store.command(f.key,'legacy-room',input);
 assert.equal(result.event.type,'room.charter_updated');assert.equal(store.headSequence('legacy-room'),before+1);const retry=store.command(f.key,'legacy-room',input);assert.deepEqual(retry.event,result.event);assert.equal(retry.sequence,result.sequence);assert.equal(retry.duplicate,true);assert.equal(store.headSequence('legacy-room'),before+1);assert.doesNotThrow(()=>auditRecovery(store));
});

function setup(t,options){const store=new RoomStore(':memory:');t.after(()=>store.close());return{store,...seedHistoricalRedactionSource(store,options)};}
test('normalized charter preserves ownership authorization and stale revision refusal',t=>{
 const f=setup(t),before=f.store.headSequence('legacy-room');
 assert.throws(()=>f.store.command(f.workerKey,'legacy-room',command('stranger')),/owner/);assert.equal(f.store.headSequence('legacy-room'),before);
 f.store.command(f.key,'legacy-room',command('first'));const head=f.store.headSequence('legacy-room');assert.throws(()=>f.store.command(f.key,'legacy-room',command('stale')),/Stale/);assert.equal(f.store.headSequence('legacy-room'),head);assert.doesNotThrow(()=>auditRecovery(f.store));
});
test('ownership transfer keeps charter authority with the exact new owner',t=>{
 const f=setup(t);f.store.command(f.key,'legacy-room',{id:'transfer-owner',type:'ownership.transferred',data:{toMemberId:'worker',reason:'Synthetic transfer'}});
 const head=f.store.headSequence('legacy-room');assert.throws(()=>f.store.command(f.key,'legacy-room',command('old-owner')),/owner/);assert.equal(f.store.headSequence('legacy-room'),head);
 f.store.command(f.workerKey,'legacy-room',command('new-owner'));assert.doesNotThrow(()=>auditRecovery(f.store));
});
test('archived normalized room refuses charter edit without appending an event',t=>{
 const f=setup(t,{beforeCapture:(store,{key})=>store.command(key,'legacy-room',{id:'archive-before-conversion',type:'room.archived',data:{}})}),head=f.store.headSequence('legacy-room');
 assert.throws(()=>f.store.command(f.key,'legacy-room',command()),/archived/);assert.equal(f.store.headSequence('legacy-room'),head);assert.doesNotThrow(()=>auditRecovery(f.store));
});
