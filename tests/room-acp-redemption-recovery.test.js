import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,rmSync,readFileSync,readdirSync,writeFileSync,mkdtempSync,symlinkSync} from 'node:fs';import {join as pathJoin} from 'node:path';import {spawn} from 'node:child_process';
import {join} from '../room-acp/src/join.mjs';import {loadConnection,saveConnection} from '../room-acp/src/credentials.mjs';import {RoomClient} from '../room-acp/src/room.mjs';
import {tmpdir} from 'node:os';
import {startRoom} from './room-acp-fixture.mjs';
const receipt=home=>JSON.parse(readFileSync(pathJoin(home,readdirSync(home).find(n=>/^\.join-[a-f0-9]{64}$/.test(n)),'receipt.json'),'utf8'));

test('lost redemption and rotation responses recover one member without installing identity-wide credentials',async t=>{
 const f=await startRoom(t),link=f.invite().link;let redeem=0,rotate=0,lastReplay;
 const fetchImpl=async(url,init)=>{const r=await fetch(url,init);if(url.endsWith('/redeem')){const value=await r.clone().json();if(value.duplicate)lastReplay=value;if(++redeem===1)throw Error('lost redeem');}if(url.endsWith('/token/rotate') && ++rotate===1)throw Error('lost rotate');return r;};
 await assert.rejects(join({link,displayName:'Recovery',env:f.env,fetchImpl}));
 await assert.rejects(join({link,displayName:'Recovery',env:f.env,fetchImpl}));
 const identitySecret=lastReplay.identitySecret;
 const recovered=await join({link,displayName:'Recovery',env:f.env,fetchImpl});
 assert.equal(redeem,2);assert.equal(rotate,2);assert.equal(recovered.identitySecret,identitySecret);assert.match(recovered.credential,/^rak_/);
 assert.notEqual(recovered.credential,recovered.identitySecret);assert.equal(Object.values(f.f.store.room('commons').state.members).filter(m=>m.displayName==='Recovery').length,1);
 const privateReceipt=JSON.stringify(receipt(f.home));assert.ok(!privateReceipt.includes(recovered.credential));assert.ok(!privateReceipt.includes(identitySecret));
 const again=await join({link,displayName:'Recovery',env:f.env,fetchImpl});assert.equal(again.memberId,recovered.memberId);assert.equal(again.hostId,recovered.hostId);assert.equal(redeem,2);assert.equal(rotate,2);
 await new RoomClient({...recovered,fetchImpl:fetch}).room();
});

test('failed final credential save retries the saved response without another redemption',async t=>{
 const f=await startRoom(t),link=f.invite().link;let redeemed=0,committed;
 const blocker=pathJoin(f.home,'commons.json');const fetchImpl=async(url,init)=>{const response=await fetch(url,init);if(url.endsWith('/redeem')){redeemed++;committed=await response.clone().json();mkdirSync(blocker);}return response;};
 await assert.rejects(join({link,displayName:'Disk retry',env:f.env,fetchImpl}));assert.equal(redeemed,1);
 assert.equal(Object.values(f.f.store.room('commons').state.members).filter(m=>m.displayName==='Disk retry').length,1);
 rmSync(blocker,{recursive:true});const recovered=await join({link,displayName:'Disk retry',env:f.env,fetchImpl});
 assert.equal(redeemed,1);assert.equal(recovered.identityId,committed.identityId);assert.equal(recovered.memberId,committed.memberId);assert.equal(loadConnection({},f.env).credential,recovered.credential);
});

test('connection replacement refuses a linked target and preserves its existing bytes',t=>{
 const home=mkdtempSync(pathJoin(tmpdir(),'private-save-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const original=pathJoin(home,'original.json');writeFileSync(original,'preserved bytes',{mode:0o600});symlinkSync(original,pathJoin(home,'r.json'));
 assert.throws(()=>saveConnection({roomId:'r',credential:'replacement'},{ROOM_ACP_HOME:home}),/private|links/);
 assert.equal(readFileSync(original,'utf8'),'preserved bytes');
});

test('process exit after a lost successful response leaves a retryable private operation',async t=>{
 const f=await startRoom(t),link=f.invite().link;
 const source=`import {join} from ${JSON.stringify(new URL('../room-acp/src/join.mjs',import.meta.url).href)};try{await join({link:${JSON.stringify(link)},displayName:'Restart recovery',env:{ROOM_ACP_HOME:${JSON.stringify(f.home)}},fetchImpl:async(url,init)=>{const r=await fetch(url,init);if(url.endsWith('/redeem'))throw Error('lost response');return r;}});process.exitCode=9;}catch{process.exitCode=17;}`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>{errors+=b;});
 assert.equal(await new Promise(resolve=>child.on('exit',resolve)),17,errors);
 const recovered=await join({link,displayName:'Restart recovery',env:f.env});
 assert.match(recovered.credential,/^rak_/);assert.equal(Object.values(f.f.store.room('commons').state.members).filter(m=>m.displayName==='Restart recovery').length,1);
});

// Dot's independently reproduced direct-client replay failure: mcpToken:null
// must use authenticated room-token recovery, never install identitySecret.
test('same operation replay recovers a room-scoped credential through the documented endpoint',async t=>{
 const f=await startRoom(t),{code}=f.invite(),client=new RoomClient({apiBase:f.origin});
 const first=await client.redeem({code,displayName:'Replay',requestId:'stable-client-replay'});
 const second=await client.redeem({code,displayName:'Replay',requestId:'stable-client-replay'});
 assert.equal(second.memberId,first.memberId);assert.equal(second.identityId,first.identityId);assert.equal(second.identitySecret===first.identitySecret,true,'a client with its saved identity must not rotate the global secret on replay');assert.match(second.credential,/^rak_/);assert.notEqual(second.credential,second.identitySecret);
});

test('a second concurrent join cannot redeem or rotate while the first owns the operation',async t=>{
 const f=await startRoom(t),link=f.invite().link;let release,entered,redeems=0;
 const ready=new Promise(r=>{entered=r;}),held=new Promise(r=>{release=r;});
 const fetchImpl=async(url,init)=>{const response=await fetch(url,init);if(url.endsWith('/redeem')){redeems++;entered();await held;}return response;};
 const first=join({link,displayName:'Concurrent',env:f.env,fetchImpl});
 try{await ready;await assert.rejects(join({link,displayName:'Concurrent',env:f.env,fetchImpl}),/Another join/);assert.equal(redeems,1);}finally{release();}
 const saved=await first;const second=await join({link,displayName:'Concurrent',env:f.env,fetchImpl});assert.equal(second.memberId,saved.memberId);assert.equal(second.hostId,saved.hostId);assert.equal(redeems,1);
});

test('failure to save the operation consumes no invitation',async t=>{
 const f=await startRoom(t),link=f.invite().link,blocked=pathJoin(f.home,'not-a-directory');writeFileSync(blocked,'preserve');let calls=0;
 await assert.rejects(join({link,displayName:'No save',env:{ROOM_ACP_HOME:blocked},fetchImpl:async()=>{calls++;throw Error('unexpected network');}}));
 assert.equal(calls,0);assert.equal(readFileSync(blocked,'utf8'),'preserve');
 const saved=await join({link,displayName:'No save',env:f.env});assert.match(saved.credential,/^rak_/);
});

test('revoking membership after a lost response refuses recovery without a new member',async t=>{
 const f=await startRoom(t),link=f.invite().link;
 await assert.rejects(join({link,displayName:'Revoked recovery',env:f.env,fetchImpl:async(url,init)=>{const response=await fetch(url,init);if(url.endsWith('/redeem'))throw Error('lost');return response;}}));
 const member=Object.values(f.f.store.room('commons').state.members).find(m=>m.displayName==='Revoked recovery');
 f.f.store.command(f.ownerKey,'commons',{id:'revoke-recovery',type:'member.access_changed',data:{memberId:member.id,expectedMemberRevision:member.revision,permissions:member.permissions,active:false}});
 await assert.rejects(join({link,displayName:'Revoked recovery',env:f.env}),error=>error.status===403 && error.code==='access_ended');
 assert.equal(loadConnection({},f.env),null);assert.equal(Object.values(f.f.store.room('commons').state.members).filter(m=>m.displayName==='Revoked recovery').length,1);
});
