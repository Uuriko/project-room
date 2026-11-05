import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createInboundHook, revokeInboundHook, postInboundHook } from '../server/inbound-task-hooks.mjs';
import { eventSigningKey } from '../server/mcp-events-wire.mjs';
import { postInboundHookAdmin } from '../server/routes/inbound-hooks.mjs';
import { postAutomationsAdmin } from '../server/routes/automations.mjs';
const reject = (status, code) => { throw Object.assign(new Error(code), {status,code}); };
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'revocation-'));
 const store=new RoomStore(join(dir,'room.sqlite')); store.initialize(initialRoom());
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});}); return store;
}
test('revoking a hook while its signed body is pending refuses mutation and replay receipt', async t=>{
 const store=fixture(t), env={ROOM_INBOUND_HOOKS:'1',ROOM_INBOUND_HOOK_KEY:'synthetic-only-key-'.repeat(3)};
 const hook=createInboundHook(store.db,{roomId:'commons',targetMember:'owner',createdBy:'owner',env});
 const body=JSON.stringify({eventId:'event1',name:'test',data:{title:'Synthetic'}}), now=Date.now(), ts=String(Math.floor(now/1000)), id='delivery1';
 const signature='v1,'+createHmac('sha256',eventSigningKey(hook.secret)).update(`${id}.${ts}.${body}`).digest('base64');
 const ctx={store,params:{hookId:hook.hookId},req:{headers:{'webhook-id':id,'webhook-timestamp':ts,'webhook-signature':signature}},reject,json:(_r,status,data)=>({status,data}),readText:async()=>{revokeInboundHook(store.db,{roomId:'commons',hookId:hook.hookId});return body;}};
 await assert.rejects(postInboundHook(ctx,{env,now}), e=>e.status===404);
 assert.equal(store.db.prepare('SELECT count(*) n FROM room_inbound_deliveries').get().n,0);
 assert.equal(store.workClaims.list('commons').length,0);
});
for (const [name,handler,flag,data,table] of [
 ['hooks',postInboundHookAdmin,'ROOM_INBOUND_HOOKS',{target:'owner'},'room_inbound_hooks'],
 ['automations',postAutomationsAdmin,'ROOM_AUTOMATIONS',{template:'post-deploy-check'},'room_automations'],
]) for(const change of ['owner','credential','identity']) test(`${name} rechecks ${change} after body read`,async t=>{
 const store=fixture(t); const prior=process.env[flag], key=process.env.ROOM_INBOUND_HOOK_KEY;
 process.env[flag]='1';process.env.ROOM_INBOUND_HOOK_KEY='synthetic-only-key-'.repeat(3);
 t.after(()=>{if(prior===undefined)delete process.env[flag];else process.env[flag]=prior;if(key===undefined)delete process.env.ROOM_INBOUND_HOOK_KEY;else process.env.ROOM_INBOUND_HOOK_KEY=key;});
 const original=store.roomAuthority.bind(store);let changed=false;
 store.roomAuthority=(room)=>{const a=original(room);return changed&&(change==='owner'||change==='identity')?{...a,ownerId:'replacement'}:a;};
 const ctx={store,params:{roomId:'commons'},req:{},url:new URL('http://synthetic.invalid'),roomCredentials:()=>({mode:'room',bearer:true}),expectedBinding:()=>null,
 roomAuth:()=>{if(changed&&change==='credential')reject(401,'unauthenticated');return {member:{id:changed&&change==='identity'?'replacement':'owner'},credentialScope:'room',credentialHash:'synthetic'};},protectWrite:()=>{},rate:()=>{},reject,
 body:async()=>{changed=true;return data;},json:(_r,status,value)=>({status,value})};
 await assert.rejects(handler(ctx),e=>e.status===(change==='credential'?401:403));
 const exists=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
 assert.equal(exists?store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n:0,0);
});
