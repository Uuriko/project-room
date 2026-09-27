// Production wiring regression: an actual process restart used to lose every
// claim because HTTP and next-actions read a module-global Map. Pure registry
// tests cannot detect an unwired durable implementation or cross-room DB leaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { handleWorkClaims } from '../server/work-claim-routes.mjs';

const fixture = `
import {RoomStore} from ${JSON.stringify(new URL('../server/store.mjs',import.meta.url).href)};
import {initialRoom} from ${JSON.stringify(new URL('../server/bootstrap.mjs',import.meta.url).href)};
import {createRoomServer} from ${JSON.stringify(new URL('../server/http.mjs',import.meta.url).href)};
const [phase,file,savedKey]=process.argv.slice(1);
const store=new RoomStore(file);
if(phase==='create') store.initialize(initialRoom('commons'));
const key=savedKey||store.issueAccessKey('commons','owner');
if(phase==='create') store.command(key,'commons',{id:'add-other',type:'member.added',data:{memberId:'other',displayName:'Other',kind:'human',permissions:[]}});
const server=createRoomServer({store});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const call=async(path,data,token=key)=>{const r=await fetch(origin+'/api/rooms/commons/'+path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Origin:origin,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,body:await r.json()};};
let result;
if(phase==='create'){
 const made=await call('work-claims',{id:'persistent',files:['server/shared.mjs']});
 const claimed=await call('work-claims/persistent/claim',{leaseHours:1});
 result={key,made:made.status,claimed:claimed.status,lease:claimed.body.leaseExpiresAt};
}else{
 const read=await call('work-claims/persistent');
 const list=await call('work-claims');
 const conflict=await call('work-claims/persistent/claim',{},store.issueAccessKey('commons','other'));
 const next=await call('next-actions?kinds=heartbeat-due');
 result={read,list,conflict:conflict.status,next};
}
server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();
console.log(JSON.stringify(result));
`;

test('HTTP claims and next-actions retain the same claim across a real process restart', t=>{
 const dir=mkdtempSync(join(tmpdir(),'room-durable-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'room.sqlite');
 const run=(phase,key='')=>{const r=spawnSync(process.execPath,['--input-type=module','-e',fixture,phase,file,key],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());};
 const first=run('create');assert.equal(first.made,201);assert.equal(first.claimed,200);
 const second=run('read',first.key);assert.equal(second.read.status,200);
 assert.equal(second.read.body.owner,'owner');assert.equal(second.read.body.leaseExpiresAt,first.lease);
 assert.deepEqual(second.read.body.files,['server/shared.mjs']);assert.deepEqual(second.list.body.swept,[]);
 assert.equal(second.conflict,409);assert.equal(second.next.status,200);
 assert.ok(second.next.body.items.some(x=>x.ref?.workClaimId==='persistent'));
});

test('a failed claim transaction sends no success and rolls back the claim write', async t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(initialRoom('commons'));
 const registry=store.workClaims;let sent=false;
 const failing={...registry,transaction:fn=>store.transaction(()=>{fn();throw new Error('synthetic commit refusal');})};
 await assert.rejects(handleWorkClaims({req:{method:'POST'},res:{},url:new URL('http://localhost'),store,roomId:'commons',auth:{member:{id:'owner',kind:'human'}},workClaimRoute:'create',registry:failing,helpers:{body:async()=>({id:'rollback'}),json:()=>{sent=true;},reject:(_status,_code,message)=>{throw new Error(message);}}}),/synthetic commit refusal/);
 assert.equal(sent,false);assert.equal(registry.get('commons','rollback'),null);
 const other=new RoomStore(':memory:');t.after(()=>other.close());other.initialize(initialRoom('commons'));
 registry.set('commons',{id:'only-first'});assert.deepEqual(other.workClaims.list('commons'),[]);
});
