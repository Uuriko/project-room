import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readTalkPolicy, writeTalkPolicy, mayWake } from '../server/agent-talk-policy.mjs';
const permissions=['steer','accept_work','complete_work','verify'];
function fixture(t, file = ':memory:') {
  const s=new RoomStore(file); t.after(()=>s.close()); s.initialize(initialRoom());
  const owner=s.issueAccessKey('commons','owner'); const sessions={owner:s.createSession(owner)};
  for(const id of ['friend','other']) {
    s.command(owner,'commons',{id:randomUUID(),type:'member.added',data:{memberId:id,displayName:id,kind:'human',permissions}});
    s.createAccount(`${id}-account`); s.bindHumanAccount('commons',id,`${id}-account`);
    sessions[id]=s.createSession(s.issueAccessKey('commons',id));
  }
  const state=()=>s.room('commons').state;
  const apply=(who,req)=>s.agentConnections.apply(sessions[who].token,'commons',req,sessions[who].session.sessionBinding);
  const key=()=>{const token=randomBytes(32).toString('base64url'); return {token,keyHash:createHash('sha256').update(token).digest('hex')};};
  const create=(who,memberId,extra={})=>{const credential=key();const req={action:'create',requestId:randomUUID(),memberId,displayName:memberId,access:'collaborate',keyHash:credential.keyHash,expiresAt:Date.now()+3600000,expectedOwnerRevision:state().members[who].revision,...extra};return {req,credential,result:apply(who,req)};};
  const change=(who,id,action)=>{const row=s.agentConnections.row('commons',id);return apply(who,{action,requestId:randomUUID(),memberId:id,expectedOwnerRevision:state().members[who].revision,expectedGeneration:row.generation,expectedMemberRevision:state().members[id].revision,...(action==='rotate'?{keyHash:key().keyHash,expiresAt:Date.now()+3600000}:{})});};
  return {s,owner,sessions,state,apply,create,change};
}
test('signed-in member sponsors own agent, cannot access others, rotates and disconnects with verified history',t=>{
  const f=fixture(t);const a=f.create('friend','friend-dot');const b=f.create('owner','john-agent');
  assert.equal(f.state().members['friend-dot'].accountableHumanId,'friend');
  assert.equal(a.result.receipt.version,2);assert.equal(b.result.receipt.version,1);
  assert.equal(f.s.authenticate(a.credential.token,'commons').member.id,'friend-dot');
  assert.equal(f.apply('friend',a.req).duplicate,true);
  assert.equal(f.s.agentConnections.list(f.sessions.friend.token,'commons',f.sessions.friend.session.sessionBinding).connections.length,1);
  assert.throws(()=>f.change('other','friend-dot','rotate'),{code:'sponsor_required'});
  assert.throws(()=>f.change('owner','friend-dot','rotate'),{code:'sponsor_required'});
  f.change('friend','friend-dot','rotate');assert.throws(()=>f.s.authenticate(a.credential.token,'commons'));
  assert.doesNotThrow(()=>f.s.agentConnections.verify());
  f.change('friend','friend-dot','disconnect');assert.equal(f.state().members['friend-dot'].active,false);
  assert.doesNotThrow(()=>f.s.agentConnections.verify());
});
test('friend sponsorship never grants unheld or administrative/external authority; raw keys cannot self-sponsor',t=>{
  const f=fixture(t);
  assert.throws(()=>f.create('friend','too-wide',{access:'member'}),{code:'sponsor_scope_exceeded'});
  f.s.command(f.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'friend',expectedMemberRevision:0,active:true,permissions:['accept_work']}});
  assert.throws(()=>f.create('friend','too-much'),{code:'sponsor_scope_exceeded'});
  assert.throws(()=>f.s.command(f.s.issueAccessKey('commons','other'),'commons',{id:randomUUID(),type:'member.added',data:{memberId:'forged',displayName:'Forged',kind:'agent',permissions:[],accountableHumanId:'other'}}));
});
test('sponsor downgrade revokes authority while retained history verifies; owner can disconnect',t=>{
  const f=fixture(t);const a=f.create('friend','friend-dot');
  f.s.command(f.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'friend',expectedMemberRevision:0,active:true,permissions:[]}});
  assert.throws(()=>f.s.authenticate(a.credential.token,'commons'));
  assert.equal(f.s.agentConnections.authority(f.s.agentConnections.row('commons','friend-dot')),false);
  assert.doesNotThrow(()=>f.s.agentConnections.verify());
  f.change('owner','friend-dot','disconnect');assert.doesNotThrow(()=>f.s.agentConnections.verify());
});
test('distinct sponsors require both-direction talk permission; a friend cannot widen Johns agent policy',t=>{
  const f=fixture(t);f.create('friend','friend-dot');f.create('owner','john-agent');
  assert.equal(readTalkPolicy(f.s.db,'commons','friend-dot').policy,'owner');
  assert.equal(mayWake(f.s.db,f.state(),'commons','john-agent','friend-dot'),false);
  assert.equal(mayWake(f.s.db,f.state(),'commons','friend-dot','john-agent'),false);
  const write=(actorId,memberId,allowed)=>writeTalkPolicy(f.s.db,f.state(),{roomId:'commons',actorId,memberId,policy:'members',allowed},Date.now(),(status,code)=>{throw Object.assign(new Error(code),{code});});
  assert.throws(()=>write('friend','john-agent',['friend-dot']),{code:'owner_required'});
  write('friend','friend-dot',['john-agent']);write('owner','john-agent',['friend-dot']);
  assert.equal(mayWake(f.s.db,f.state(),'commons','john-agent','friend-dot'),true);
  assert.equal(mayWake(f.s.db,f.state(),'commons','friend-dot','john-agent'),true);
});
test('identity proof binds the friends agent and sponsor revocation cannot be bypassed with its identity or MCP key',t=>{
  const f=fixture(t), identity=f.s.identities.create('Existing Dot');
  const identityLinkCode=f.s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons',sponsorAccountId:'friend-account'}).linkCode;
  const a=f.create('friend','friend-dot',{identityId:identity.identityId,identityLinkCode});
  assert.equal(a.result.receipt.identityId,identity.identityId);
  assert.equal(f.s.authenticate(identity.secret,'commons').member.accountableHumanId,'friend');
  const mcpKey=a.result.mcpToken.credential;
  assert.equal(f.s.authenticate(mcpKey,'commons').member.id,'friend-dot');
  f.s.command(f.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'friend',expectedMemberRevision:0,active:false,permissions}});
  for(const token of [identity.secret,mcpKey,a.credential.token]) assert.throws(()=>f.s.authenticate(token,'commons'));
  assert.doesNotThrow(()=>f.s.agentConnections.verify());
});
test('friend account deletion ends connection without making historical proof depend on the newer checkpoint',async t=>{
  const f=fixture(t), a=f.create('friend','friend-dot');
  const {planAccountDeletion,executeAccountDeletion}=await import('../server/account-deletion.mjs');
  const {plan}=planAccountDeletion(f.s,'friend-account');executeAccountDeletion(f.s,plan);
  assert.throws(()=>f.s.authenticate(a.credential.token,'commons'));
  assert.doesNotThrow(()=>f.s.agentConnections.verify());
});
test('HTTP friend session can create and list own connection with the actual binding and CSRF fences',async t=>{
  const f=fixture(t);const {createRoomServer}=await import('../server/http.mjs');
  const server=createRoomServer({store:f.s});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin=`http://127.0.0.1:${server.address().port}`,session=f.sessions.friend;
  const headers={Authorization:`Bearer ${session.token}`,Origin:origin,'Content-Type':'application/json','x-session-binding':session.session.sessionBinding,'x-csrf-token':session.session.csrf};
  const req={action:'create',requestId:randomUUID(),memberId:'http-dot',displayName:'HTTP Dot',access:'collaborate',keyHash:createHash('sha256').update(randomBytes(32)).digest('hex'),expiresAt:Date.now()+3600000,expectedOwnerRevision:0};
  const res=await fetch(`${origin}/api/rooms/commons/agent-connections`,{method:'POST',headers,body:JSON.stringify(req)}),body=await res.json();
  assert.equal(res.status,201,JSON.stringify(body));assert.equal(body.receipt.memberId,'http-dot');
  const listed=await fetch(`${origin}/api/rooms/commons/agent-connections`,{headers});assert.equal(listed.status,200);assert.equal((await listed.json()).connections.length,1);
});

test('persisted friend connection survives a fresh store and expiry ends identity authority',t=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-restart-')),file=join(dir,'room.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fixture(t,file),a=f.create('friend','friend-dot');
  const reopened=new RoomStore(file);t.after(()=>reopened.close());
  assert.equal(reopened.authenticate(a.credential.token,'commons').member.accountableHumanId,'friend');
  assert.doesNotThrow(()=>reopened.agentConnections.verify());
  reopened.now=()=>a.req.expiresAt+1;
  assert.equal(reopened.agentConnections.identityAuthority('commons','friend-dot'),false);
  assert.throws(()=>reopened.authenticate(a.credential.token,'commons'));
});
test('two independently sponsored agents receive addressed requests and deliver an exact reviewed result through human correction',async t=>{
  const f=fixture(t),{textVersion}=await import('../server/text-results.mjs');
  const agents={};
  for(const [who,id] of [['friend','friend-dot'],['owner','john-agent']]) {
    const identity=f.s.identities.create(id);
    const identityLinkCode=f.s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons'}).linkCode;
    f.create(who,id,{identityId:identity.identityId,identityLinkCode});agents[id]=identity;
    f.s.agentHeartbeats.heartbeat({agentId:identity.identityId,hostId:`host-${id}`,mode:'pull-only',workWakes:true});
  }
  const send=(actor,type,data)=>f.s.command(actor==='owner'?f.owner:agents[actor].secret,'commons',{id:randomUUID(),type,data});
  for(const [from,to] of [['john-agent','friend-dot'],['friend-dot','john-agent']]) {
    writeTalkPolicy(f.s.db,f.state(),{roomId:'commons',actorId:to==='friend-dot'?'friend':'owner',memberId:to,policy:'members',allowed:[from]},Date.now(),()=>assert.fail());
    const messageId=randomUUID();const q=send(from,'message.posted',{messageId,toMemberId:to,body:'Please check the launch checklist.',requestKind:'reply'});
    const signals=f.s.agentHeartbeats.pendingWakes(agents[to].identityId);
    assert.ok(signals.some(s=>s.messageId===messageId),'actual registered receiver gets addressed wake');
    send(to,'message.posted',{messageId:randomUUID(),body:'Checklist reviewed; test invitation recovery.',responseToRequestId:messageId,expectedRequestRevision:0,responseOutcome:'answered',contextEventId:q.event.id,contextSequence:q.sequence,replyToId:messageId,toMemberId:from,workItemId:null});
    assert.equal(f.state().replyRequests[messageId].status,'answered');
    f.s.agentHeartbeats.ackWakes({agentId:agents[to].identityId,signalIds:signals.map(s=>s.signalId)});
  }
  send('owner','work.proposed',{workItemId:'launch-check',title:'Friend launch checklist',definitionOfDone:'An actionable checklist with recovery checks',accountableMemberId:'friend-dot',verifierMemberId:'john-agent',independentVerificationRequired:true,ownerDecisionRequired:true,humanDecisionMakerId:'owner',mode:'read'});
  const item=()=>f.state().workItems['launch-check'];
  const mutate=(actor,type,data={})=>send(actor,type,{workItemId:'launch-check',expectedRevision:item().revision,...data});
  mutate('friend-dot','work.accepted');mutate('friend-dot','work.started');
  const complete=body=>{const post=send('friend-dot','message.posted',{messageId:randomUUID(),workItemId:'launch-check',body});return mutate('friend-dot','work.completed',{evidenceKind:'room_text',evidenceMessageId:post.event.data.messageId,evidenceMessageEventId:post.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:item().receipt?.eventId??null,producerId:'friend-dot',summary:'Checklist ready',nextAction:'Review exact checklist'});};
  const verify=()=>mutate('john-agent','verification.recorded',{result:'pass',completionEventId:item().receipt.eventId,evidenceVersion:item().receipt.evidenceVersion,summary:'Checked invite and recovery steps'});
  const decide=(decision,reason)=>{const post=send('owner','message.posted',{messageId:randomUUID(),body:reason});return mutate('owner','owner.decision_recorded',{decision,completionEventId:item().receipt.eventId,evidenceVersion:item().receipt.evidenceVersion,reason,sourceMessageId:post.event.data.messageId});};
  complete('1. Invite friend. 2. Verify an addressed answer.');verify();
  decide('changes_requested','Add a reconnect check.');
  mutate('friend-dot','work.started',{resolvedBlocker:'Adding reconnect check'});
  complete('1. Invite friend. 2. Verify addressed answer. 3. Disconnect and reconnect; verify no duplicate output.');
  assert.throws(()=>decide('approved','Looks good'),'old review cannot approve new evidence');
  verify();decide('approved','Recovery check included; accepted.');
  assert.equal(item().decision.decision,'approved');assert.equal(item().verification.independenceConfirmed,true);
  assert.notEqual(f.state().members['friend-dot'].accountableHumanId,f.state().members['john-agent'].accountableHumanId);
  assert.doesNotThrow(()=>f.s.agentConnections.verify());
});
