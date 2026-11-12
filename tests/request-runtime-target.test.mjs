import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {validateReplyRead} from '../client/reply-actions.mjs';

function fixture(t, current) {
  const s=new RoomStore(':memory:');t.after(()=>s.close());
  s.initialize(initialRoom(),current?{representation:'normalized-current-v1'}:{});
  const owner=s.issueAccessKey('commons','owner'),identity=s.identities.create('Two hosts');
  linkWithProof(s,owner,'commons',identity,{memberId:'worker',permissions:[]});
  const scopes=['rooms:read','rooms:write','mcp:room:commons'];
  const issue=(patch={})=>s.agentPlugin.issueApiKey({identityId:identity.identityId,scopes,...patch});
  const intended=issue(),other=issue(),token=k=>'rak_'+k.secret;
  const open=(target=intended.keyId)=>s.command(owner,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:crypto.randomUUID(),body:'Bounded task',toMemberId:'worker',requestKind:'reply',...(target===null?{}:{targetRuntimeKeyId:target})}});
  const read=(credential,id)=>s.replyRequests.page(credential,'commons',{requestMessageId:id,direction:null});
  const response=q=>({id:crypto.randomUUID(),type:'message.posted',data:{messageId:crypto.randomUUID(),body:'Verified outcome',responseToRequestId:q.event.data.messageId,replyToId:q.event.data.messageId,toMemberId:'owner',workItemId:null,responseOutcome:'answered',expectedRequestRevision:0,contextEventId:q.event.id,contextSequence:q.sequence}});
  return {s,owner,identity,issue,intended,other,token,open,read,response};
}
for(const current of [false,true]) {
  test(`runtime binding refuses same-member foreign credentials and preserves intended response (${current?'current':'legacy'})`,t=>{
    const f=fixture(t,current),q=f.open(),id=q.event.data.messageId;
    for(const token of [f.identity.secret,f.token(f.other)]) {
      const read=f.read(token,id);
      assert.equal(read.current.runtimeAccess.authorized,false);assert.equal(read.current.answerBasis,null);
      validateReplyRead(read,{name:'room_read_request',args:{requestMessageId:id},roomId:'commons'});
      for (const outcome of ['answered','declined']) { const command=f.response(q); command.data.responseOutcome=outcome;
        assert.throws(()=>f.s.command(token,'commons',command),e=>e.code==='request_runtime_denied'&&e.status===403); }
      assert.throws(()=>f.s.requestRuns.apply(token,'commons',{requestMessageId:id,attemptId:'wrong-host',action:'claim',expectedRequestRevision:0,contextEventId:q.event.id}),e=>e.code==='request_runtime_denied');
      assert.throws(()=>f.s.command(token,'commons',{id:crypto.randomUUID(),type:'reply_request.progressed',data:{requestMessageId:id,expectedRequestRevision:0,progress:'working'}}),e=>e.code==='request_runtime_denied');
    }
    assert.equal(f.s.db.prepare('SELECT count(*) n FROM request_runs').get().n,0);
    const token=f.token(f.intended),read=f.read(token,id);
    assert.equal(read.current.runtimeAccess.authorized,true);
    validateReplyRead(read,{name:'room_read_request',args:{requestMessageId:id},roomId:'commons'});
    assert.equal(f.s.requestRuns.apply(token,'commons',{requestMessageId:id,attemptId:'right-host',action:'claim',expectedRequestRevision:0,contextEventId:q.event.id}).state,'working');
    f.s.command(token,'commons',f.response(q));assert.equal(f.read(token,id).request.status,'answered');
  });
  test(`runtime target rejects unknown, expired, revoked, broad and foreign-room keys (${current?'current':'legacy'})`,t=>{
    const f=fixture(t,current);
    const revoked=f.issue();f.s.agentPlugin.revokeApiKey({keyId:revoked.keyId,identityId:f.identity.identityId});
    for(const target of ['missing-key',revoked.keyId,
      f.issue({expiresAt:f.s.now()+1}).keyId,
      f.issue({scopes:['rooms:read','rooms:write']}).keyId,
      f.issue({scopes:['rooms:read','rooms:write','mcp:room:elsewhere']}).keyId]) {
      const clock=f.s.now();f.s.now=()=>clock+10;
      assert.throws(()=>f.open(target),e=>e.code==='request_runtime_denied');
    }
  });
  test(`untargeted requests remain compatible and post-opening revocation prevents completion (${current?'current':'legacy'})`,t=>{
    const f=fixture(t,current),ordinary=f.open(null);
    assert.equal(f.read(f.identity.secret,ordinary.event.data.messageId).current.runtimeAccess,undefined);
    f.s.command(f.identity.secret,'commons',f.response(ordinary));
    const q=f.open();f.s.agentPlugin.revokeApiKey({keyId:f.intended.keyId,identityId:f.identity.identityId});
    assert.equal(f.read(f.token(f.other),q.event.data.messageId).current.runtimeAccess.eligible,false);
    assert.throws(()=>f.s.command(f.token(f.intended),'commons',f.response(q)),e=>e.status===401);
    assert.equal(f.read(f.token(f.other),q.event.data.messageId).request.status,'open');
  });
}


test('actual HTTP admits scoped target opening, refuses other key response and permits intended key', async t=>{
  const f=fixture(t,true),server=createRoomServer({store:f.s});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const post=async(token,command)=>{
    const response=await fetch(origin+'/api/rooms/commons/commands',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(command)});
    return {status:response.status,body:await response.json()};
  };
  const opened=await post(f.owner,{id:'http-opening',type:'message.posted',data:{messageId:'http-question',body:'Please verify',toMemberId:'worker',requestKind:'reply',targetRuntimeKeyId:f.intended.keyId}});
  assert.equal(opened.status,201);
  const q=opened.body;
  const denied=await post(f.token(f.other),f.response(q));assert.equal(denied.status,403);assert.equal(denied.body.error.code,'request_runtime_denied');
  const accepted=await post(f.token(f.intended),f.response(q));assert.equal(accepted.status,201);
  assert.equal(f.read(f.token(f.intended),'http-question').request.status,'answered');
});


test('another recipient identity cannot be named as this member runtime and target expiry never transfers ownership',t=>{
  const f=fixture(t,true),peer=f.s.identities.create('Other member');
  linkWithProof(f.s,f.owner,'commons',peer,{memberId:'peer',permissions:[]});
  const peerKey=f.issue({identityId:peer.identityId});
  assert.throws(()=>f.open(peerKey.keyId),e=>e.code==='request_runtime_denied');
  const clock=f.s.now(),expiring=f.issue({expiresAt:clock+1000}),q=f.open(expiring.keyId);
  f.s.now=()=>clock+2000;
  assert.equal(f.read(f.token(f.other),q.event.data.messageId).current.runtimeAccess.eligible,false);
  assert.throws(()=>f.s.command(f.token(expiring),'commons',f.response(q)),e=>e.status===401||e.code==='request_runtime_denied');
  assert.throws(()=>f.s.requestRuns.apply(f.token(f.other),'commons',{requestMessageId:q.event.data.messageId,attemptId:'expired-target-takeover',action:'claim',expectedRequestRevision:0,contextEventId:q.event.id}),e=>e.code==='request_runtime_denied');
  assert.equal(f.read(f.token(f.other),q.event.data.messageId).request.status,'open');
});
