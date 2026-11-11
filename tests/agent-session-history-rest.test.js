import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';
import {createWork,claimWork,updateWork,stampClaimHistory,MAX_CLAIM_HISTORY} from '../server/work-claims.mjs';
const start=Date.parse('2026-11-04T00:00:00Z'),now=start+3600000;
function seed(id, ownerAt=start+60000){return updateWork(claimWork(createWork({id,title:'Synthetic'},{now:start,agentId:'owner'}),'owner',{now:start,leaseHours:null}),'owner',{state:'in_progress',now:ownerAt});}
function notes(c,count){for(let i=0;i<count;i++)c=stampClaimHistory(c,'other',{action:'note',note:'Synthetic',now:start+3420000+i*500});return c;}
test('actual REST derives owner status before list trim and never from another member updatedAt',async t=>{
 const previous=process.env.ROOM_AGENT_SESSION_STATES;process.env.ROOM_AGENT_SESSION_STATES='1';
 const store=new RoomStore(':memory:',{now:()=>now});store.initialize(initialRoom());
 const token=store.issueAccessKey('commons','owner');
 const cases=[notes(seed('list-cap'),3),notes(seed('stored-cap'),MAX_CLAIM_HISTORY),notes(seed('recent-owner',start+3300000),3)];
 for(const c of cases)store.workClaims.set('commons',c);
 const raw=JSON.parse(store.db.prepare("SELECT item_json FROM work_claims WHERE claim_id='stored-cap'").get().item_json).data;
 assert.equal(raw.history.length,MAX_CLAIM_HISTORY);assert.ok(!raw.history.some(s=>s.agentId==='owner'));
 const before=store.db.prepare('SELECT claim_id,item_json FROM work_claims ORDER BY claim_id').all();
 const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();if(previous===undefined)delete process.env.ROOM_AGENT_SESSION_STATES;else process.env.ROOM_AGENT_SESSION_STATES=previous;});
 const get=async()=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/work-claims`,{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);return(await r.json()).claims;};
 const rows=await get();const byId=new Map(rows.map(c=>[c.id,c]));
 assert.equal(byId.get('list-cap').agentSession,'stale');assert.equal(byId.get('stored-cap').agentSession,'stale');assert.equal(byId.get('recent-owner').agentSession,'active');
 for(const c of rows)assert.ok(c.history.length<=3);
 delete process.env.ROOM_AGENT_SESSION_STATES;
 const off=await get();assert.ok(off.every(c=>!Object.hasOwn(c,'agentSession')));
 assert.deepEqual(store.db.prepare('SELECT claim_id,item_json FROM work_claims ORDER BY claim_id').all(),before);
});
