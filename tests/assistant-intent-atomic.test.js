import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
async function setup(t, configured = true){
 const f=createAcceptanceFixture({dmConsent:true});const server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();});
 const api=async(actor,input,expected=200)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/assistant`,{method:input?'POST':'GET',headers:{authorization:`Bearer ${f.keys[actor]}`,'content-type':'application/json'},...(input?{body:JSON.stringify({requestId:randomUUID(),...input})}:{})});const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));return b;};
 if(configured) await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
 const member=f.store.room('commons').state.members.owner;
 f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'owner',expectedMemberRevision:member.revision??0,permissions:[...new Set([...member.permissions,'steer'])],active:true}});
 const command=id=>({id:'post-'+id,type:'message.posted',data:{messageId:id,body:'@Room, do this work.'}});
 const post=c=>f.store.command(f.keys.owner,'commons',c);
 return{f,api,command,post};
}
const inject = store => store.db.exec("CREATE TRIGGER injected_run_failure BEFORE INSERT ON room_assistant_runs BEGIN SELECT RAISE(ABORT,'injected run insert failure'); END");
const clear = store => store.db.exec('DROP TRIGGER injected_run_failure');
function absent(store, id, head) {
 assert.equal(store.headSequence('commons'), head);
 assert.equal(store.room('commons').state.messages.some(m=>m.id===id),false);
 assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE room_id='commons' AND id=?").get('post-'+id).n,0);
 assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM room_assistant_runs WHERE room_id='commons' AND json_extract(value,'$.sourceMessageId')=?").get(id).n,0);
}
test('plain addressed post and derived run roll back together, then exact retry commits once',async t=>{
 const {f,api,command,post}=await setup(t);const c=command('atomic-plain'),head=f.store.headSequence('commons');
 let notifications=0;f.store.humanPush.notifyPosted=()=>{notifications++;};
 inject(f.store);assert.throws(()=>post(c),/injected run insert failure/);assert.equal(notifications,0);absent(f.store,'atomic-plain',head);clear(f.store);
 assert.equal(post(c).duplicate,false);assert.equal(post(c).duplicate,true);assert.equal(notifications,1);
 const runs=(await api('owner')).runs.filter(r=>r.sourceMessageId==='atomic-plain');assert.equal(runs.length,1);
 assert.equal(f.store.room('commons').state.messages.filter(m=>m.id==='atomic-plain').length,1);
});
test('atomic submit reports insert failure without a receipt or message and retries once',async t=>{
 const {f,api,command}=await setup(t);const c=command('atomic-submit'),head=f.store.headSequence('commons');
 const input={requestId:'submit-retry',action:'submit',command:c,intent:{action:'invoke'},fileIds:[]};
 inject(f.store);await api('owner',input,500);absent(f.store,'atomic-submit',head);clear(f.store);
 const first=await api('owner',input),again=await api('owner',input);assert.equal(first.result.id,again.result.id);
 assert.equal((await api('owner')).runs.filter(r=>r.sourceMessageId==='atomic-submit').length,1);
});
for(const mutation of ['unchanged','edited','deleted'])test(`old ${mutation} message retry after configuration does not acquire new execution`,async t=>{
 const {f,api,command,post}=await setup(t,false);const id='old-'+mutation,c=command(id);post(c);
 if(mutation!=='unchanged')f.store.command(f.keys.owner,'commons',{id:'change-'+mutation,type:mutation==='edited'?'message.edited':'message.deleted',data:{messageId:id,expectedMessageRevision:0,...(mutation==='edited'?{body:'No longer asking'}:{})}});
 await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
 assert.equal(post(c).duplicate,true);assert.equal((await api('owner')).runs.length,0);
});
for(const revoked of ['sender','coordinator'])test(`retry after failed insert rechecks ${revoked} permission before creating work`,async t=>{
 const {f,api,command}=await setup(t);const guest=f.store.room('commons').state.members.guest;
 f.store.command(f.keys.owner,'commons',{id:'grant',type:'member.access_changed',data:{memberId:'guest',expectedMemberRevision:guest.revision??0,permissions:[...new Set([...guest.permissions,'steer'])],active:true}});
 const c=command('revoke-'+revoked),post=()=>f.store.command(f.keys.guest,'commons',c);
 inject(f.store);assert.throws(post,/injected run insert failure/);clear(f.store);
 const id=revoked==='sender'?'guest':'producer',member=f.store.room('commons').state.members[id];
 f.store.command(f.keys.owner,'commons',{id:'revoke',type:'member.access_changed',data:{memberId:id,expectedMemberRevision:member.revision??0,permissions:member.permissions.filter(p=>p!==(revoked==='sender'?'steer':'accept_work')),active:true}});
 assert.equal(post().duplicate,false);assert.equal((await api('owner')).runs.filter(r=>r.sourceMessageId===c.data.messageId).length,0);
});
