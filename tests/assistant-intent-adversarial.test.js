import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
async function setup(t){
 const f=createAcceptanceFixture({dmConsent:true});const server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();});
 const api=async(actor,input)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/assistant`,{method:input?'POST':'GET',headers:{authorization:`Bearer ${f.keys[actor]}`,'content-type':'application/json'},...(input?{body:JSON.stringify({requestId:randomUUID(),...input})}:{})});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;};
 await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
 const member=f.store.room('commons').state.members.owner;
 f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'owner',expectedMemberRevision:member.revision??0,permissions:[...new Set([...member.permissions,'steer'])],active:true}});
 const command=id=>({id:'post-'+id,type:'message.posted',data:{messageId:id,body:'@Room, do this work.'}});
 const post=c=>f.store.command(f.keys.owner,'commons',c);
 return{f,api,command,post};
}
test('distinct valid source IDs must not overwrite an active assistant run',async t=>{
 const {api,command,post}=await setup(t);const long='a'.repeat(128),short=createHash('sha256').update(long).digest('hex').slice(0,60);
 // Command ID is independently bounded; source message IDs are the collision.
 const first=command(long);first.id='first';post(first);
 const before=(await api('owner')).runs.find(r=>r.sourceMessageId===long);assert.ok(before);
 const claimed=(await api('producer',{action:'claim',runId:before.id,attemptId:'active-attempt',expectedRevision:0})).result;
 post(command(short));const after=(await api('owner')).runs.find(r=>r.id===before.id);
 console.log(JSON.stringify({case:'collision',before:{source:claimed.sourceMessageId,status:claimed.status,attempt:claimed.attemptId},after:{source:after.sourceMessageId,status:after.status,attempt:after.attemptId}}));
 assert.equal(after.sourceMessageId,long);assert.equal(after.attemptId,'active-attempt');
});
test('retry after one derived insert failure must recover a run for the durable message',async t=>{
 const {f,api,command,post}=await setup(t);
 f.store.db.exec("CREATE TRIGGER injected_run_failure BEFORE INSERT ON room_assistant_runs BEGIN SELECT RAISE(ABORT,'injected run insert failure'); END");
 const c=command('retry-source');const receipt=post(c);assert.ok(receipt.sequence);
 f.store.db.exec('DROP TRIGGER injected_run_failure');const retry=post(c);assert.equal(retry.duplicate,true);
 const runs=(await api('owner')).runs.filter(r=>r.sourceMessageId==='retry-source');
 console.log(JSON.stringify({case:'retry',messagePersisted:f.store.room('commons').state.messages.some(m=>m.id==='retry-source'),duplicate:retry.duplicate,runs:runs.length}));
 assert.equal(runs.length,1);
});
