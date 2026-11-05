import test from 'node:test';
import assert from 'node:assert/strict';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {join} from '../room-acp/src/join.mjs';
import {startRoom,FAKE_AGENT} from './room-acp-fixture.mjs';

test('wake-poll 429 reports the remaining fixed-window wait to ACP',{timeout:30000},async t=>{
 const room=await startRoom(t),connection=await join({link:room.invite().link,displayName:'RateRetry',env:room.env});
 const bridge=new Bridge({connection,candidate:{command:process.execPath,args:[FAKE_AGENT]},env:room.env,waitMs:0,log:()=>{}});
 t.after(()=>bridge.stop());await bridge.lease();
 const realNow=Date.now,fixedNow=realNow();let offset=0;Date.now=()=>fixedNow+offset;t.after(()=>{Date.now=realNow;});
 for(let i=0;i<30;i++)await bridge.room.poll({hostId:connection.hostId,waitMs:0});
 offset=50000;
 await assert.rejects(bridge.room.poll({hostId:connection.hostId,waitMs:0}),e=>e.status===429&&e.retryAfterMs===10000);
 offset=61000;const after=await bridge.room.poll({hostId:connection.hostId,waitMs:0});assert.ok(Array.isArray(after.pendingWakes));
});
