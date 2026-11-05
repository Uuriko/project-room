import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {seedAccountAgentEnrollment} from './helpers/account-agent-enrollment-source.mjs';
import {createAccountAgentEnrollment} from '../server/account-agent-enrollment.mjs';
import {listMcpOAuthAgents,validateMcpOAuthBinding} from '../server/mcp-oauth.mjs';
import {auditRecovery} from '../server/recovery.mjs';
const resource='https://room.example/mcp';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
 const s=new RoomStore(':memory:');t.after(()=>s.close());
 const {slot,binding,identity,source,request}=seedAccountAgentEnrollment(s);
 const service=createAccountAgentEnrollment({store:s,resource,enabled:true});
 return {s,slot,binding,identity,source,service,request,apply:input=>service.apply(slot.token,'target',input??request,binding)};
}

test('explicit account-controlled enrollment preserves identity and original source; target works after source archive',t=>{
 const f=fixture(t),before=f.s.db.prepare('SELECT * FROM agent_identities').all(),old=f.s.db.prepare("SELECT * FROM agent_connections WHERE room_id='source'").all();
 const result=f.apply();assert.equal(result.enrolledExisting,true);assert.equal(result.mcpToken,undefined);assert.equal(result.duplicate,false);
 assert.equal(f.s.db.prepare("SELECT member_id FROM identity_links WHERE room_id='target' AND identity_id=?").get(f.identity.identityId).member_id,'claude');
 assert.deepEqual(f.s.db.prepare('SELECT * FROM agent_identities').all(),before);assert.deepEqual(f.s.db.prepare("SELECT * FROM agent_connections WHERE room_id='source'").all(),old);
 assert.deepEqual(f.s.roomAuthority('target',{memberId:'claude'}).members.claude.permissions,['steer','accept_work','complete_work','verify']);
 assert.equal(f.apply().duplicate,true);assert.throws(()=>f.apply({...f.request,access:'review'}),{code:'idempotency_conflict'});
 f.s.command(f.slot.token,'source',{id:'archive-old',type:'room.archived',data:{reason:'Synthetic cutover'}},f.binding);
 const choice=listMcpOAuthAgents(f.s,'john',resource).find(value=>value.binding.roomId==='target');assert.ok(choice);
 assert.ok(validateMcpOAuthBinding(f.s,'john',choice.binding));assert.doesNotThrow(()=>auditRecovery(f.s));
});

test('writer and choices are disabled by default while strict proof reader remains installed',t=>{
 const f=fixture(t),disabled=createAccountAgentEnrollment({store:f.s,resource});
 assert.deepEqual(disabled.list(f.slot.token,'target',f.binding),{available:false,choices:[]});
 assert.throws(()=>disabled.apply(f.slot.token,'target',f.request,f.binding),{status:403,code:'access_denied'});
});

test('no holder-proof exemption is granted to callers who copy an enrollment reference',t=>{
 const f=fixture(t);f.apply();const raw=JSON.parse(f.s.db.prepare("SELECT request_json FROM agent_connection_operations WHERE room_id='target'").get().request_json);
 assert.throws(()=>f.s.agentConnections.apply(f.slot.token,'source',{...raw,requestId:'forged',memberId:'forged'},f.binding),{code:'identity_link_proof_required'});
});

for(const [name,change] of [
 ['source revocation',f=>f.s.command(f.slot.token,'source',{id:'revoke-source',type:'member.access_changed',data:{memberId:'claude',expectedMemberRevision:0,active:false,permissions:['steer','accept_work','complete_work','verify']}},f.binding)],
 ['source identity rotation',f=>f.s.identities.rotate(f.identity.identityId,f.identity.secret)],
 ['target owner revision',f=>f.s.command(f.slot.token,'target',{id:'owner-change',type:'member.access_changed',data:{memberId:'owner',expectedMemberRevision:0,active:true,permissions:f.s.roomAuthority('target',{memberId:'owner'}).members.owner.permissions}},f.binding)]
])test(`stale ${name} refuses before enrollment`,t=>{
 const f=fixture(t);change(f);assert.throws(()=>f.apply());assert.equal(f.s.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,0);
});

test('sponsorship alone never becomes control, even with caller-supplied preference IDs',t=>{
 const f=fixture(t),invite=f.s.invites.create(f.slot.token,'source',{profile:'contribute'},f.binding),other=f.s.identities.create('Sovereign agent');
 f.s.invites.redeem(invite.code,{identitySecret:other.secret,requestId:'join-uncontrolled'});
 assert.equal(f.s.roomAuthority('source',{memberId:other.identityId}).members[other.identityId].accountableHumanId,'owner');
 assert.ok(!f.service.list(f.slot.token,'target',f.binding).choices.some(choice=>choice.identityId===other.identityId));
 assert.throws(()=>f.apply({...f.request,preferredRoomId:'source',preferredMemberId:other.identityId}),{code:'invalid_connection'});
 const controlled=createAccountAgentEnrollment({store:f.s,resource,enabled:true,preferences:[{preferredRoomId:'source',preferredMemberId:other.identityId}]});
 assert.ok(controlled.list(f.slot.token,'target',f.binding).choices.some(choice=>choice.identityId===other.identityId),'only actual server configuration may establish the configured seat basis');
});

test('foreign account owner cannot enroll another account controlled identity',t=>{
 const f=fixture(t);f.s.initialize(initialRoom('foreign'),{representation:'normalized-current-v1'});
 f.s.createAccount('foreign');f.s.bindHumanAccount('foreign','owner','foreign');
 const slot=f.s.createAccountSessionSlot(),auth=f.s.loginAccountSession(slot.token,f.s.issueAccountAccessKey('foreign'),0);
 assert.deepEqual(f.service.list(slot.token,'foreign',auth.sessionBinding).choices,[]);
 assert.throws(()=>f.service.apply(slot.token,'foreign',f.request,auth.sessionBinding),{code:'connection_changed'});
 assert.equal(f.s.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='foreign'").get().n,0);
});

test('enrollment proof and managed membership roll back atomically on an interrupted save',t=>{
 const f=fixture(t),snapshot=()=>JSON.stringify(['operator_actions','agent_connection_operations','agent_connections','identity_links','credentials','current_room_head','current_room_records','current_room_record_proofs','events','commands'].map(table=>[table,f.s.db.prepare('SELECT * FROM '+table).all()])),before=snapshot();
 const prepare=f.s.db.prepare.bind(f.s.db);let fired=false;
 f.s.db.prepare=sql=>{const st=prepare(sql);if(!sql.startsWith('INSERT INTO agent_connection_operations'))return st;return new Proxy(st,{get(target,key){const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;return(...args)=>{const result=value.apply(target,args);if(args[0]==='target'){fired=true;throw Error('synthetic enrollment save fault');}return result;};}});};
 try{assert.throws(()=>f.apply(),/synthetic enrollment save fault/);}finally{f.s.db.prepare=prepare;}
 assert.equal(fired,true);assert.equal(snapshot(),before);assert.equal(f.apply().duplicate,false);assert.doesNotThrow(()=>auditRecovery(f.s));
});

test('original release refuses new proof during audit, while preopened ordinary writer cannot overwrite creation authority',async t=>{
 const f=fixture(t),{AgentConnections:OriginalConnections}=await import('./fixtures/pre-account-enrollment-agent-connections.mjs'),old=new OriginalConnections(f.s);
 assert.doesNotThrow(()=>old.verify());
 f.apply();assert.throws(()=>old.verify(),{code:'connection_integrity_error'});
 const originalProof=f.s.db.prepare("SELECT request_json,receipt_json FROM agent_connection_operations WHERE room_id='target' AND generation=1").get();
 const rotate={action:'rotate',requestId:'old-preopened-rotate',memberId:'claude',expectedOwnerRevision:0,expectedGeneration:1,expectedMemberRevision:0,keyHash:hash(randomUUID()),expiresAt:f.s.now()+3600000};
 const result=old.apply(f.slot.token,'target',rotate,f.binding);assert.equal(result.receipt.generation,2);
 assert.deepEqual(f.s.db.prepare("SELECT request_json,receipt_json FROM agent_connection_operations WHERE room_id='target' AND generation=1").get(),originalProof);
 assert.doesNotThrow(()=>auditRecovery(f.s));assert.throws(()=>old.verify(),{code:'connection_integrity_error'});
});

test('a room bearer, nonowner account, or stale account epoch cannot authorize enrollment',t=>{
 const f=fixture(t),ownerKey=f.s.issueAccessKey('target','owner');
 assert.throws(()=>f.service.apply(ownerKey,'target',f.request),{code:'owner_required'});
 f.s.command(f.slot.token,'target',{id:'add-human',type:'member.added',data:{memberId:'other',displayName:'Other human',kind:'human',permissions:[]}},f.binding);
 f.s.createAccount('other');f.s.bindHumanAccount('target','other','other');const slot=f.s.createAccountSessionSlot(),auth=f.s.loginAccountSession(slot.token,f.s.issueAccountAccessKey('other'),0);
 assert.throws(()=>f.service.apply(slot.token,'target',f.request,auth.sessionBinding),{code:'owner_required'});
 f.s.transaction(()=>f.s.db.prepare("UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id='john'").run());
 assert.throws(()=>f.apply());assert.equal(f.s.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,0);
});

test('corrupt protected source membership cannot become enrollment authority',async t=>{
 const f=fixture(t),{withCurrentRoomWriter}=await import('../server/current-room-repository.mjs');
 const row=f.s.db.prepare("SELECT payload FROM current_room_records WHERE room_id='source' AND domain='members' AND record_key='claude'").get();
 const changed=row.payload.replace('Existing Claude','Forgedxx Claude');assert.notEqual(row.payload,changed);
 f.s.transaction(()=>withCurrentRoomWriter(f.s.db,'source',()=>f.s.db.prepare("UPDATE current_room_records SET payload=? WHERE room_id='source' AND domain='members' AND record_key='claude'").run(changed)));
 assert.throws(()=>f.apply(),{code:'connection_changed'});assert.equal(f.s.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,0);
});

test('an approved adopted source is eligible without requiring its sovereign secret',async t=>{
 const f=fixture(t),{AccessRequests}=await import('../server/access-requests.mjs');f.s.accessRequests=new AccessRequests(f.s);
 f.s.initialize(initialRoom('adopt-source'),{representation:'normalized-current-v1'});
 const ownerKey=f.s.issueAccessKey('adopt-source','owner');f.s.command(ownerKey,'adopt-source',{id:'adopt-human',type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:[]}});
 f.s.bindHumanAccount('adopt-source','john','john');
 const identity=f.s.identities.create('Adopted existing agent'),code=f.s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'adopt-source'});
 f.s.identities.link(ownerKey,'adopt-source',{identityId:identity.identityId,displayName:'Adopted existing agent',permissions:['steer','accept_work','complete_work','verify'],identityLinkCode:code.linkCode});
 f.s.accessRequests.sponsorTransfers.request(f.slot.token,'adopt-source',{memberId:identity.identityId,requestId:'source-adoption'},f.binding);
 f.s.accessRequests.decide(ownerKey,'adopt-source','source-adoption',{decision:'approve'});
 const choice=f.service.list(f.slot.token,'target',f.binding).choices.find(value=>value.identityId===identity.identityId);assert.ok(choice);
 const request={...f.request,requestId:'enroll-adopted',choiceId:choice.choiceId,sourceRoomId:choice.sourceRoomId,sourceMemberId:choice.sourceMemberId,identityId:choice.identityId,memberId:choice.memberId};
 assert.equal(f.apply(request).identityId,identity.identityId);assert.doesNotThrow(()=>auditRecovery(f.s));
});
