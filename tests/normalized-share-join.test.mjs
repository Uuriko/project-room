import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';import {AgentRooms} from '../server/agent-rooms.mjs';import {auditRecovery} from '../server/recovery.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';
import {createRoomServer} from '../server/http.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'native-share-')),path=join(dir,'room.sqlite');let s=new RoomStore(path);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});const owner=s.identities.create('Olive'),room='native-share';new AgentRooms(s).create(owner.secret,{roomId:room,title:'Native sharing',purpose:'Useful peers',starter:false});return{get s(){return s;},owner,room,reopen(){s.close();s=new RoomStore(path);}};}
function link(f,access='guest',maxJoins=2){const token=randomBytes(32).toString('base64url'),result=f.s.shareLinks.create(f.owner.secret,f.room,{requestId:randomUUID(),linkToken:token,expiresAt:Date.now()+3600000,maxJoins,expectedMemberRevision:0,access});return{token,...result};}
test('normalized share agent preview, first admission, cold lost-ACK retry and privacy keep one use',t=>{
 const f=fixture(t),l=link(f),peer=f.s.identities.create('Parker');f.s.command(f.owner.secret,f.room,{id:'before',type:'message.posted',data:{messageId:'before',body:'Earlier room history'}});
 f.s.room=()=>{throw Error('unexpected share blob hydration');};assert.equal(f.s.shareLinks.preview(l.token).room.title,'Native sharing');
 const joined=f.s.shareLinks.joinAgent(peer.secret,l.token,'Parker');assert.equal(joined.duplicate,false);assert.deepEqual(joined.permissions,[]);assert.equal(f.s.shareLinks.view(f.s.shareLinks.find(l.token)).joins,1);
 assert.throws(()=>readConversation(f.s,peer.secret,f.room,{messageId:'before'}),e=>e.status===404);
 f.s.command(f.owner.secret,f.room,{id:'after',type:'message.posted',data:{messageId:'after',body:'New work request'}});assert.equal(readConversation(f.s,peer.secret,f.room,{messageId:'after'}).messages[0].body,'New work request');
 f.reopen();assert.equal(f.s.shareLinks.joinAgent(peer.secret,l.token,'Parker').duplicate,true);assert.equal(f.s.shareLinks.view(f.s.shareLinks.find(l.token)).joins,1);assert.doesNotThrow(()=>auditRecovery(f.s));
 f.s.shareLinks.cancel(f.owner.secret,f.room,l.link.id);assert.equal(f.s.shareLinks.joinAgent(peer.secret,l.token,'Parker').duplicate,true);const outsider=f.s.identities.create('Vega');assert.throws(()=>f.s.shareLinks.joinAgent(outsider.secret,l.token,'Vega'),e=>e.code==='link_unavailable');
});
for(const access of ['guest','member','co_admin'])test(`normalized human ${access} share admission is atomic and cold-resumable`,t=>{
 const f=fixture(t),l=link(f,access);f.s.createAccount('human');const slot=f.s.createAccountSessionSlot(),login=f.s.loginAccountSession(slot.token,f.s.issueAccountAccessKey('human'),0),redemptionId=randomUUID();
 const request=()=>{const current=f.s.accountSessionSlot(slot.token);return{displayName:'Aster',redemptionId,expectedSessionRevision:current.sessionRevision,expectedSessionBinding:current.sessionBinding};};
 f.s.room=()=>{throw Error('unexpected human share blob hydration');};
 const prepare=f.s.db.prepare.bind(f.s.db);let fault=false;f.s.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('INSERT INTO share_link_joins VALUES'))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;return(...args)=>{value.apply(target,args);fault=true;throw Error('injected share receipt save fault');};}});};
 assert.throws(()=>f.s.shareLinks.join(slot.token,l.token,request()),/injected share receipt/);f.s.db.prepare=prepare;assert.equal(fault,true);assert.equal(f.s.shareLinks.view(f.s.shareLinks.find(l.token)).joins,0);assert.equal(f.s.db.prepare("SELECT count(*) n FROM member_accounts WHERE room_id=? AND account_id='human'").get(f.room).n,0);
 const first=f.s.shareLinks.join(slot.token,l.token,request());assert.equal(first.duplicate,false);assert.equal(first.session.member.role,access==='co_admin'?'moderator':access);if(access==='guest')assert.deepEqual(first.session.member.permissions,[]);
 assert.equal(f.s.shareLinks.join(slot.token,l.token,request()).duplicate,true);f.reopen();assert.equal(f.s.shareLinks.join(slot.token,l.token,request()).duplicate,true);assert.equal(f.s.shareLinks.view(f.s.shareLinks.find(l.token)).joins,1);assert.equal(f.s.verifyInvitationAudit().consistent,true);assert.doesNotThrow(()=>auditRecovery(f.s));assert.equal(login.sessionBinding,f.s.accountSessionSlot(slot.token).sessionBinding);
});

for(const removed of [false,true])test(`normalized share rejoin retains self-left versus owner-removed policy (removed=${removed})`,t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom());const owner=s.issueAccessKey('commons','owner'),token=randomBytes(32).toString('base64url');s.shareLinks.create(owner,'commons',{requestId:'rejoin-link',linkToken:token,expiresAt:Date.now()+3600000,maxJoins:3,expectedMemberRevision:0});
 const slot=s.createAccountSessionSlot(),first=s.shareLinks.join(slot.token,token,{displayName:'Aster',redemptionId:randomUUID(),expectedSessionRevision:0,expectedSessionBinding:slot.session.sessionBinding}),memberId=first.session.member.id;
 s.command(removed?owner:slot.token,'commons',{id:'end-membership',type:'member.access_changed',data:{memberId,expectedMemberRevision:0,permissions:[],active:false}},removed?null:first.session.sessionBinding);
 const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'adopt-left',reason:'Synthetic preserved rejoin policy'},true);s.room=()=>{throw Error('unexpected rejoin blob hydration');};
 const current=s.accountSessionSlot(slot.token),rejoin=()=>s.shareLinks.join(slot.token,token,{displayName:'Aster',redemptionId:randomUUID(),expectedSessionRevision:current.sessionRevision,expectedSessionBinding:current.sessionBinding});
 if(removed)assert.throws(rejoin,e=>e.code==='membership_removed');else{const result=rejoin();assert.equal(result.duplicate,true);assert.equal(result.session.member.id,memberId);assert.equal(result.session.member.active,true);}
 assert.equal(s.shareLinks.view(s.shareLinks.find(token)).joins,1);
});

test('actual normalized HTTP share preview and join return usable peer access without exposing the grant',async t=>{
 const f=fixture(t),l=link(f),peer=f.s.identities.create('Parker'),server=createRoomServer({store:f.s});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,post=async(path,data,token)=>{const response=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
 f.s.room=()=>{throw Error('unexpected HTTP share blob hydration');};
 const preview=await post('/api/share-links/preview',{linkToken:l.token});assert.equal(preview.status,200);assert.equal(preview.body.room.id,f.room);
 const args={linkToken:l.token,displayName:'Parker'},joined=await post('/api/share-links/join-agent',args,peer.secret);assert.equal(joined.status,201,JSON.stringify(joined.body));assert.equal((await post('/api/share-links/join-agent',args,peer.secret)).status,200);
 assert.ok(!JSON.stringify(joined.body).includes(l.token));assert.ok(!JSON.stringify(joined.body).includes(f.owner.secret));
 const hello=await post(`/api/rooms/${f.room}/commands`,{id:'peer-hello',type:'message.posted',data:{messageId:'peer-hello',body:'Ready to coordinate'}},peer.secret);assert.equal(hello.status,201,JSON.stringify(hello.body));
 assert.equal(readConversation(f.s,f.owner.secret,f.room,{messageId:'peer-hello'}).messages[0].body,'Ready to coordinate');
});
