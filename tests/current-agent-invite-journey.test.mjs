import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {createLegacyInviteJourney,initializeCurrentInviteJourney} from './helpers/current-agent-invite-journey.mjs';
function fixture(t,options){
 const legacy=new RoomStore(':memory:');t.after(()=>legacy.close());
 const snapshot=createLegacyInviteJourney(legacy,options);
 const s=new RoomStore(':memory:');t.after(()=>s.close());
 const {inviter,peer,issued,ownerKey,friendKey,reviewerKey}=initializeCurrentInviteJourney(s,snapshot);
 const accountFor=(room,id)=>s.db.prepare('SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?').get(room,id).account_id;
 assert.notEqual(accountFor('commons','owner'),accountFor('friend-home','friend'));
 assert.equal(s.identities.resolveGlobalIdentitySecret(inviter.secret).identityId,inviter.identityId);
 assert.equal(s.identities.resolveGlobalIdentitySecret(peer.secret).identityId,peer.identityId);
 return{s,inviter,peer,issued,ownerKey,friendKey,reviewerKey};
}
test('normalized authorized existing agent creates its ordinary scoped invitation',t=>{
 const{s,inviter}=fixture(t);
 const issued=s.invites.create(inviter.secret,'commons',{profile:'contribute',displayName:'Friend existing agent'});
 assert.deepEqual(issued.permissions,['accept_work','complete_work']);
});
test('separately owned existing agent redeems into normalized room without another identity',t=>{
 const{s,peer,issued}=fixture(t),before=s.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
 const joined=s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'existing-peer-join'});
 assert.equal(joined.identityId,peer.identityId);assert.equal(joined.memberId,peer.identityId);
 assert.equal(s.db.prepare('SELECT count(*) n FROM agent_identities').get().n,before);
});
test('invitation replay cannot rotate a friend existing global identity without its credential',t=>{
 const{s,peer,issued}=fixture(t),requestId='existing-peer-replay';
 s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId});
 assert.throws(()=>s.invites.redeem(issued.code,{displayName:'Friend existing agent',requestId}),e=>e.status===401||e.status===403);
 assert.equal(Boolean(s.identities.resolveGlobalIdentitySecret(peer.secret)),true);
});
import {textVersion} from '../server/text-results.mjs';
import {auditRecovery} from '../server/recovery.mjs';
const inventory=s=>Object.fromEntries(['agent_identities','identity_links','events','commands','current_room_records','current_room_record_proofs','current_room_head','operator_actions','agent_invite_codes','agent_invite_redeem_receipts','referrals','agent_connections'].map(table=>[table,s.db.prepare('SELECT * FROM '+table).all()]));
test('existing agent lost-response retry preserves identity/grants and finishes first useful task under review',t=>{
 const{s,peer,inviter,issued,ownerKey,reviewerKey}=fixture(t),beforeIdentities=s.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
 const options={displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'journey-redeem'};
 const first=s.invites.redeem(issued.code,options),before=inventory(s),replay=s.invites.redeem(issued.code,options);
 assert.equal(replay.duplicate,true);assert.equal(replay.mcpToken,null);assert.equal(replay.identitySecret,undefined);assert.deepEqual(inventory(s),before);assert.equal(s.db.prepare('SELECT count(*) n FROM agent_identities').get().n,beforeIdentities);
 assert.equal(s.authenticate(peer.secret,'friend-home').member.id,peer.identityId);assert.deepEqual(s.authenticate(peer.secret,'commons').member.permissions,['accept_work','complete_work']);assert.deepEqual(s.authenticate(inviter.secret,'commons').member.permissions,['invite_member']);assert.equal(s.db.prepare('SELECT count(*) n FROM agent_connections').get().n,0);
 assert.equal(first.nextWork.coverage,'not-evaluated');assert.equal(first.starter,undefined);
 const cmd=(key,id,type,data)=>s.command(key,'commons',{id,type,data}),item=()=>JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE work_id='task'").get().body);
 cmd(ownerKey,'propose','work.proposed',{workItemId:'task',title:'Useful shared task',definitionOfDone:'Save and review useful result',accountableMemberId:first.memberId,verifierMemberId:'reviewer',independentVerificationRequired:true,ownerDecisionRequired:true,humanDecisionMakerId:'owner',mode:'read'});
 cmd(peer.secret,'accept','work.accepted',{workItemId:'task',expectedRevision:0});const body='First useful saved result',posted=cmd(peer.secret,'saved','message.posted',{messageId:'saved',body,workItemId:'task'}),version=textVersion(body);
 const done=cmd(peer.secret,'done','work.completed',{workItemId:'task',expectedRevision:1,evidenceKind:'room_text',evidenceMessageId:'saved',evidenceMessageEventId:posted.event.id,evidenceVersion:version,previousCompletionEventId:null,producerId:peer.identityId,summary:'Saved useful work',nextAction:'Independent review'});
 cmd(reviewerKey,'verify','verification.recorded',{workItemId:'task',expectedRevision:2,result:'pass',completionEventId:done.event.id,evidenceVersion:version,summary:'Reviewed exact saved result'});
 cmd(ownerKey,'rationale','message.posted',{messageId:'rationale',body:'Independent output accepted'});
 cmd(ownerKey,'approve','owner.decision_recorded',{workItemId:'task',expectedRevision:3,decision:'approved',completionEventId:done.event.id,evidenceVersion:version,reason:'Useful result verified',sourceMessageId:'rationale'});
 assert.equal(item().receipt.producerId,peer.identityId);assert.equal(item().decision.decision,'approved');assert.doesNotThrow(()=>auditRecovery(s));
});
test('interrupted normalized receipt save rolls back membership, link, invitation burn and proofs',t=>{
 const{s,peer,issued}=fixture(t),before=inventory(s),prepare=s.db.prepare.bind(s.db);let fired=false;
 s.db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const value=fn.apply(target,args);if(sql.includes('INSERT INTO agent_invite_redeem_receipts')){fired=true;throw Error('synthetic normalized join interrupted');}return value;};}});
 const options={displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'interrupted-join'};
 assert.throws(()=>s.invites.redeem(issued.code,options),/synthetic normalized join interrupted/);s.db.prepare=prepare;assert.equal(fired,true);assert.deepEqual(inventory(s),before);
 assert.equal(s.invites.redeem(issued.code,options).memberId,peer.identityId);assert.doesNotThrow(()=>auditRecovery(s));
});
test('reactivation uses the existing member and exact grant rather than duplicating identity',t=>{
 const{s,peer,issued}=fixture(t,{reactivate:true}),links=s.db.prepare('SELECT count(*) n FROM identity_links').get().n;
 const joined=s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'reactivate'});
 assert.equal(joined.memberId,peer.identityId);assert.equal(joined.relinked,true);assert.equal(s.db.prepare('SELECT count(*) n FROM identity_links').get().n,links);assert.deepEqual(s.authenticate(peer.secret,'commons').member.permissions,['accept_work','complete_work']);assert.doesNotThrow(()=>auditRecovery(s));
});
test('demoted issuer cannot complete its earlier invitation',t=>{
 const{s,peer,issued}=fixture(t,{demoteIssuer:true}),before=inventory(s);
 assert.throws(()=>s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'demoted'}),e=>e.code==='invite_authority_changed');assert.deepEqual(inventory(s),before);
});
import {readCurrentRecord} from '../server/current-room-repository.mjs';
test('invitation after ownership transfer preserves the original general-channel creator',t=>{
 const{s,peer,issued}=fixture(t,{transferOwner:true}),general=s.readTransaction(()=>readCurrentRecord(s.db,'commons','channels','general'));
 assert.equal(general.createdBy,'owner');s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'after-transfer'});
 assert.deepEqual(s.readTransaction(()=>readCurrentRecord(s.db,'commons','channels','general')),general);assert.doesNotThrow(()=>auditRecovery(s));
});
