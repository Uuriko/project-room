import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';

async function fixture(t,normalized=true){
 const dir=mkdtempSync(join(tmpdir(),'invitation-view-')),file=join(dir,'room.sqlite');let store=new RoomStore(file),server;
 store.initialize(initialRoom(),normalized?{representation:'normalized-current-v1'}:{});
 const key=store.issueAccessKey('commons','owner');
 async function open(){server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
 async function close(){server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await open();t.after(async()=>{await close();store.close();rmSync(dir,{recursive:true,force:true});});
 const read=async(query='?view=invitation',token=key)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/referrals${query}`,{headers:token?{Authorization:'Bearer '+token}:{}});return{status:r.status,body:await r.json()};};
 return{get store(){return store;},key,read,async reopen(){await close();store.close();store=new RoomStore(file);await open();}};
}

for(const normalized of [true,false])test(`invitation-only HTTP view reuses policy and original identity without reading the board (${normalized?'normalized':'legacy'})`,async t=>{
 const f=await fixture(t,normalized);
 f.store.referrals.board=()=>{throw Error('Invitation must not load leaderboard or settle activation history');};
 if(normalized)f.store.room=()=>{throw Error('Invitation must not load whole room');};
 let r=await f.read();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.contractVersion,1);assert.equal(r.body.roomId,'commons');assert.match(r.body.invite.token,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(Object.hasOwn(r.body,'referrals'),false);assert.equal(Object.hasOwn(r.body,'reward'),false);
 const token=r.body.invite.token;
 assert.equal((await f.read()).body.invite.token,token);assert.equal(f.store.db.prepare('SELECT count(*) n FROM share_links').get().n,1);
 const identity=f.store.identities.create('Existing peer');
 const admitted=f.store.shareLinks.joinAgent(identity.secret,token,'Existing peer');
 assert.equal(admitted.identityId,identity.identityId);assert.equal(f.store.shareLinks.joinAgent(identity.secret,token,'Existing peer').duplicate,true);
 const originalPrepare=f.store.db.prepare.bind(f.store.db),sql=[];f.store.db.prepare=(query)=>{sql.push(query);return originalPrepare(query);};
 assert.equal((await f.read()).body.invite.token,token);
 assert.equal(sql.some(query=>/\bFROM\s+messages\b/i.test(query)),false,'invitation must not scan message history to settle rewards');
 f.store.db.prepare=originalPrepare;
 await f.reopen();assert.equal((await f.read()).body.invite.token,token);
 f.store.revoke(f.key);assert.equal((await f.read()).status,401);
});

test('invitation-only view rejects missing credentials and ambiguous view selection',async t=>{
 const f=await fixture(t);
 assert.equal((await f.read('?view=invitation',null)).status,401);
 for(const query of ['?view=unknown','?view=invitation&view=invitation'])assert.equal((await f.read(query)).status,422);
});

test('members without invitation permission receive no invitation and no new link',async t=>{
 const f=await fixture(t);f.store.command(f.key,'commons',{id:'add-reader',type:'member.added',data:{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]}});
 const reader=f.store.issueAccessKey('commons','reader'),r=await f.read('?view=invitation',reader);
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.invite,null);assert.equal(f.store.db.prepare('SELECT count(*) n FROM share_links').get().n,0);
});
