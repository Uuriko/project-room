import {permissionDecisionMessages} from '../server/member-permission-requests.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AccessRequests } from '../server/access-requests.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { listMcpOAuthAgents, validateMcpOAuthBinding } from '../server/mcp-oauth.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { event } from '../src/events.js';
import { createOAuthProvider } from '../server/oauth-provider.mjs';
const resource='https://room.example/mcp';
function fixture(t){
 const s=new RoomStore(':memory:');s.initialize(initialRoom('commons'));t.after(()=>s.close());
 s.accessRequests=new AccessRequests(s);
 const owner=s.issueAccessKey('commons','owner');
 s.command(owner,'commons',{id:'john',type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:[]}});
 const account=s.bindHumanAccount('commons','john');
 const key=s.issueAccountAccessKey(account.id),slot=s.createAccountSessionSlot();
 const auth=s.loginAccountSession(slot.token,key,0);
 const identity=s.identities.create('Existing Claude');linkWithProof(s,owner,'commons',identity,{permissions:['accept_work']});
 return {s,owner,identity,account,slot,auth,ask:()=>s.accessRequests.sponsorTransfers.request(slot.token,'commons',{memberId:identity.identityId,requestId:'adopt_claude'},auth.sessionBinding),decide:()=>s.accessRequests.decide(owner,'commons','adopt_claude',{decision:'approve'})};
}
test('recipient asks, owner approves the existing seat, OAuth refresh preserves identity and permissions',t=>{
 const f=fixture(t),{s,identity}=f;
 assert.equal(listMcpOAuthAgents(s,f.account.id,resource,{preferredRoomId:'commons',preferredMemberId:identity.identityId}).length,0);
 const before=s.room('commons').state.members[identity.identityId];
 const count=s.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
 assert.equal(f.ask().kind,'agent-sponsor-transfer');assert.equal(f.ask().status,'pending');
 assert.equal(s.accessRequests.list(f.owner,'commons')[0].kind,'agent-sponsor-transfer');
 assert.equal(f.decide().status,'approved');assert.deepEqual(f.decide(),f.decide());
 const member=s.room('commons').state.members[identity.identityId];
 assert.equal(member.accountableHumanId,'john');assert.equal(member.identityId,identity.identityId);assert.deepEqual(member.permissions,before.permissions);
 assert.equal(s.db.prepare('SELECT count(*) n FROM agent_identities').get().n,count);
 const [choice]=listMcpOAuthAgents(s,f.account.id,resource,{preferredRoomId:'commons',preferredMemberId:identity.identityId});
 assert.ok(choice,'approved nonowner recipient can connect the same existing seat');
 assert.equal(choice.binding.principalType,'account-adopted-agent');
 const provider=createOAuthProvider({db:s.db,clock:()=>s.now(),isBindingActive:(id,binding)=>!!validateMcpOAuthBinding(s,id,binding)});
 provider.registerClient({clientId:'claude',name:'Claude fixture',redirectUris:['https://client.example/callback']});
 const verifier='v'.repeat(43);
 const code=provider.issueCode({clientId:'claude',userId:f.account.id,redirectUri:'https://client.example/callback',scopes:['chat:read'],codeChallenge:createHash('sha256').update(verifier).digest('base64url'),binding:choice.binding}).code;
 const tokens=provider.exchangeCode({code,clientId:'claude',redirectUri:'https://client.example/callback',codeVerifier:verifier,resource});
 const refreshed=provider.refresh({refreshToken:tokens.refreshToken,clientId:'claude',resource});
 assert.equal(provider.verifyAccessToken(refreshed.accessToken,{resource}).binding.memberId,identity.identityId);
});
test('direct owner commands cannot fabricate recipient consent',t=>{
 const f=fixture(t);assert.throws(()=>f.s.command(f.owner,'commons',{id:'forged',type:'member.sponsor_transferred',data:{requestId:'forged',requestDigest:'a'.repeat(64),memberId:f.identity.identityId,toMemberId:'john',expectedMemberRevision:0,expectedHumanRevision:0,previousSponsorId:'owner',identityId:f.identity.identityId}}),e=>e.code==='access_denied');
});
for(const [label,mutate] of [
 ['account epoch',f=>f.s.db.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?').run(f.account.id)],
 ['identity epoch',f=>f.s.db.prepare('UPDATE agent_identities SET secret_hash=? WHERE identity_id=?').run('changed',f.identity.identityId)],
 ['recipient revision',f=>f.s.command(f.owner,'commons',{id:'change-john',type:'member.access_changed',data:{memberId:'john',expectedMemberRevision:0,active:true,permissions:['steer']}})],
 ['agent revision',f=>f.s.command(f.owner,'commons',{id:'change-claude',type:'member.access_changed',data:{memberId:f.identity.identityId,expectedMemberRevision:0,active:true,permissions:['verify']}})],
 ['owner',f=>f.s.command(f.owner,'commons',{id:'transfer',type:'ownership.transferred',data:{toMemberId:'john'}})],
 ['account link',f=>f.s.db.prepare("DELETE FROM member_accounts WHERE room_id='commons' AND member_id='john'").run()],
])test(`approval refuses changed ${label} without adopting`,t=>{
 const f=fixture(t);f.ask();mutate(f);const before=f.s.headSequence('commons');
 assert.throws(()=>f.decide());assert.equal(f.s.headSequence('commons'),before);assert.equal(f.s.room('commons').state.members[f.identity.identityId].accountableHumanId,'owner');
});
test('unrelated account, nonadministrator and expired request cannot adopt',t=>{
 const f=fixture(t);const other=f.s.createAccountSessionSlot();assert.throws(()=>f.s.accessRequests.sponsorTransfers.request(other.token,'commons',{memberId:f.identity.identityId,requestId:'wrong-account'}));
 f.ask();assert.throws(()=>f.s.accessRequests.decide(f.slot.token,'commons','adopt_claude',{decision:'approve'},f.auth.sessionBinding));
 f.s.db.prepare('UPDATE access_requests SET created_at=? WHERE request_id=?').run(Date.now()-8*86400000,'adopt_claude');assert.throws(()=>f.decide(),e=>e.code==='already_decided');assert.equal(f.s.room('commons').state.members[f.identity.identityId].accountableHumanId,'owner');
});
test('interrupted approval rolls back membership and decision; original request retries exactly',t=>{
 const f=fixture(t);f.ask();const before=f.s.headSequence('commons');
 f.s.db.exec("CREATE TRIGGER fail_adoption_save BEFORE UPDATE OF status ON access_requests WHEN NEW.status='approved' BEGIN SELECT RAISE(ABORT,'injected save failure');END");
 assert.throws(()=>f.decide(),/injected save/);assert.equal(f.s.headSequence('commons'),before);assert.equal(f.s.room('commons').state.members[f.identity.identityId].accountableHumanId,'owner');assert.equal(f.ask().status,'pending');
 f.s.db.exec('DROP TRIGGER fail_adoption_save');f.decide();const sequence=f.s.headSequence('commons');f.decide();assert.equal(f.s.headSequence('commons'),sequence);
});
test('approved adoption requires retained recipient and decision evidence, not a name or edited request row',t=>{
 const f=fixture(t);f.ask();f.decide();const [choice]=listMcpOAuthAgents(f.s,f.account.id,resource);
 assert.ok(validateMcpOAuthBinding(f.s,f.account.id,choice.binding));
 const row=f.s.db.prepare('SELECT requested_permissions FROM access_requests WHERE request_id=?').get('adopt_claude');
 const intent=JSON.parse(row.requested_permissions);intent.accountEpoch=17;
 f.s.db.prepare('UPDATE access_requests SET requested_permissions=? WHERE request_id=?').run(JSON.stringify(intent),'adopt_claude');
 assert.equal(validateMcpOAuthBinding(f.s,f.account.id,choice.binding),null);
});
test('selected old account grant is durably fenced without denying another seat',t=>{
 const f=fixture(t),sponsor=f.s.bindHumanAccount('commons','owner');
 const other=f.s.identities.create('Unrelated agent');linkWithProof(f.s,f.owner,'commons',other,{permissions:['accept_work']});
 const provider=createOAuthProvider({db:f.s.db,isBindingActive:(id,binding)=>!!validateMcpOAuthBinding(f.s,id,binding)});
 provider.registerClient({clientId:'old',name:'Old connection',redirectUris:['https://client.example/callback']});
 const verifier='v'.repeat(43),mint=memberId=>{
  const binding=listMcpOAuthAgents(f.s,sponsor.id,resource,{preferredRoomId:'commons',preferredMemberId:memberId}).find(value=>value.binding.memberId===memberId).binding;
  const code=provider.issueCode({clientId:'old',userId:sponsor.id,redirectUri:'https://client.example/callback',scopes:['chat:read'],codeChallenge:createHash('sha256').update(verifier).digest('base64url'),binding}).code;
  return provider.exchangeCode({code,clientId:'old',redirectUri:'https://client.example/callback',codeVerifier:verifier,resource});
 };
 const old=mint(f.identity.identityId),unrelated=mint(other.identityId);assert.ok(provider.verifyAccessToken(old.accessToken,{resource}));
 f.ask();f.decide();
 assert.equal(provider.verifyAccessToken(old.accessToken,{resource}),null);assert.throws(()=>provider.refresh({refreshToken:old.refreshToken,clientId:'old',resource}));assert.ok(provider.verifyAccessToken(unrelated.accessToken,{resource}));
});

test('normalized current room with agent owner adopts the same existing seat and passes independent recovery',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const identity=s.identities.create('Existing Claude');
 const events=initialRoom('commons');events[1].data.kind='agent';
 events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:[]}}));
 events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:identity.identityId,identityId:identity.identityId,displayName:'Existing Claude',kind:'agent',permissions:['accept_work']}}));
 s.initialize(events,{representation:'normalized-current-v1'});const owner=s.issueAccessKey('commons','owner');
 linkWithProof(s,owner,'commons',identity,{permissions:['accept_work']});
 const account=s.bindHumanAccount('commons','john'),key=s.issueAccountAccessKey(account.id),slot=s.createAccountSessionSlot(),auth=s.loginAccountSession(slot.token,key,0);
 const access=new AccessRequests(s);access.sponsorTransfers.request(slot.token,'commons',{memberId:identity.identityId,requestId:'normalized-adoption'},auth.sessionBinding);
 access.decide(owner,'commons','normalized-adoption',{decision:'approve'});
 const [choice]=listMcpOAuthAgents(s,account.id,resource,{preferredRoomId:'commons',preferredMemberId:identity.identityId});assert.equal(choice.binding.memberId,identity.identityId);assert.equal(s.roomAuthority('commons').ownerId,'owner');assert.doesNotThrow(()=>auditRecovery(s));
});
test('old managed connection history stays intact while its scoped key and binding are fenced',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom('commons'));const owner=s.issueAccessKey('commons','owner'),session=s.createSession(owner);
 s.command(owner,'commons',{id:'add-human',type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:[]}});
 const identity=s.identities.create('Managed Claude'),proof=s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons'});
 s.agentConnections.apply(session.token,'commons',{action:'create',requestId:'create-claude',memberId:'claude',displayName:'Managed Claude',access:'collaborate',expectedOwnerRevision:0,expiresAt:s.now()+3600000,keyHash:createHash('sha256').update('fixture-scoped-key').digest('hex'),identityId:identity.identityId,identityLinkCode:proof.linkCode},session.session.sessionBinding);
 const old=s.agentConnections.row('commons','claude'),history=s.db.prepare('SELECT receipt_json,state_json FROM agent_connection_operations').all();
 assert.equal(s.agentConnections.authority(old),true);
 const account=s.bindHumanAccount('commons','john'),slot=s.createAccountSessionSlot(),auth=s.loginAccountSession(slot.token,s.issueAccountAccessKey(account.id),0),access=new AccessRequests(s);
 access.sponsorTransfers.request(slot.token,'commons',{memberId:'claude',requestId:'adopt-managed'},auth.sessionBinding);access.decide(owner,'commons','adopt-managed',{decision:'approve'});
 assert.deepEqual(s.agentConnections.row('commons','claude'),old);assert.deepEqual(s.db.prepare('SELECT receipt_json,state_json FROM agent_connection_operations').all(),history);
 assert.equal(s.db.prepare('SELECT revoked FROM credentials WHERE hash=?').get(old.credential_hash).revoked,1);assert.equal(s.agentConnections.authority(old),false);assert.equal(s.agentConnections.view(old).status,'access_changed');
 assert.equal(listMcpOAuthAgents(s,account.id,resource)[0].binding.memberId,'claude');assert.doesNotThrow(()=>auditRecovery(s));
});
test('administrator needs both decision authority and all existing agent permissions',t=>{
 const f=fixture(t);f.ask();
 f.s.command(f.owner,'commons',{id:'add-admin',type:'member.added',data:{memberId:'admin',displayName:'Qualified Reviewer',kind:'human',permissions:['manage_members','decide']}});const admin=f.s.issueAccessKey('commons','admin');
 assert.throws(()=>f.s.accessRequests.decide(admin,'commons','adopt_claude',{decision:'approve'}),e=>e.code==='access_denied');
 f.s.command(f.owner,'commons',{id:'grant-admin',type:'member.access_changed',data:{memberId:'admin',expectedMemberRevision:0,permissions:['manage_members','decide','accept_work'],active:true}});
 assert.equal(f.s.accessRequests.decide(admin,'commons','adopt_claude',{decision:'approve'}).status,'approved');
 assert.equal(f.s.room('commons').state.members[f.identity.identityId].accountableHumanId,'john');assert.equal(f.s.roomAuthority('commons').ownerId,'owner');
});

test('ordinary replies to adoption requests are not mistaken for permission-decision receipts',t=>{
 const f=fixture(t);f.ask();f.decide();
 const incoming={type:'message.posted',causationId:'sponsor-request-adopt_claude',roomId:'commons',data:{messageId:'ordinary-reply'}};
 assert.equal(permissionDecisionMessages(f.s,[{event:incoming}]).size,0);
});
