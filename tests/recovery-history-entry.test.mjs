import test from 'node:test';
import assert from 'node:assert/strict';
import {event,RETIRED_REPLAY_EVENT_TYPES} from '../src/events.js';
import {validateRecoveryHistoryEntry} from '../server/recovery-history-entry.mjs';
const incoming=()=>event({id:'history-proof-event',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'history-proof-message',body:'Exact retained history'}});
const row=value=>({sequence:7,id:value.id,body:JSON.stringify(value)});
test('the original history contract admits known current and retained legacy envelopes without certifying reducer effects',()=>{
 const current=incoming();assert.deepEqual(validateRecoveryHistoryEntry(row(current),7,'commons'),current);const legacy={...current,type:Object.values(RETIRED_REPLAY_EVENT_TYPES)[0]};assert.deepEqual(validateRecoveryHistoryEntry(row(legacy),7,'commons'),legacy);
});
test('the original history contract rejects misattributed, gapped and malformed retained entries',()=>{
 const current=incoming();for(const changed of [{...row(current),sequence:8},{...row(current),id:'different-row-id'},row({...current,roomId:'different-room'}),row({...current,type:'unregistered.event'}),row({...current,at:'not-a-date'}),row({...current,data:[]})])assert.throws(()=>validateRecoveryHistoryEntry(changed,7,'commons'),/requires operator reconciliation/);
});
