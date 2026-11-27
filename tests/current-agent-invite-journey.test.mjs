import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
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
test('existing agent lost-response retry preserves identity/grants and finishes first useful task under review',async t=>{
 const{s,peer,inviter,issued,ownerKey,reviewerKey}=fixture(t),beforeIdentities=s.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
 const options={displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'journey-redeem'};
 let server, origin;
 const connect = async () => {
  server = createRoomServer({ store: s });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
 };
 const disconnect = async () => {
  server.closeStreams();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 };
 await connect();
 t.after(disconnect);
 const {identitySecret,...input}=options;
 const res=await fetch(origin+'/api/agent-invites/redeem',{method:'POST',headers:{Authorization:'Bearer '+identitySecret,'Content-Type':'application/json'},
  body:JSON.stringify({code:issued.code,...input})});
 assert.equal(res.status,201);
 const first=await res.json(),before=inventory(s),replay=s.invites.redeem(issued.code,options);
 const endpoint=new URL(first.connect.mcpUrl,origin);
 assert.equal(endpoint.href,origin+'/mcp');
 assert.equal(new URL(first.nextActions.at(-1).path,origin).href,endpoint.href);
 assert.equal(replay.duplicate,true);assert.equal(replay.mcpToken,null);assert.equal(replay.identitySecret,undefined);assert.deepEqual(inventory(s),before);assert.equal(s.db.prepare('SELECT count(*) n FROM agent_identities').get().n,beforeIdentities);
 assert.equal(s.authenticate(peer.secret,'friend-home').member.id,peer.identityId);assert.deepEqual(s.authenticate(peer.secret,'commons').member.permissions,['accept_work','complete_work']);assert.deepEqual(s.authenticate(inviter.secret,'commons').member.permissions,['invite_member']);assert.equal(s.db.prepare('SELECT count(*) n FROM agent_connections').get().n,0);
 assert.deepEqual(first.nextWork,{tool:'room_next',arguments:{roomId:'commons',view:'pickup'},coverage:'not-evaluated',
  fallback:{tool:'room_list_work',arguments:{roomId:'commons',focus:'needs_me'}}});
 assert.deepEqual(first.next.map(step=>step.tool),['room_next']);
 assert.deepEqual(first.nextActions.map(step=>step.tool),['room_next']);
 assert.deepEqual(replay.next.map(step=>step.action),['reuse-identity','rotate','find-work']);
 assert.equal(replay.nextActions[0].action,'reuse-identity');
 assert.equal(replay.connect.mcpUrl,'/mcp');
 assert.equal(first.starter,undefined);
 const cmd=(key,id,type,data)=>s.command(key,'commons',{id,type,data}),item=()=>JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE work_id='task'").get().body);
 cmd(ownerKey,'propose','work.proposed',{workItemId:'task',title:'Useful shared task',definitionOfDone:'Save and review useful result',accountableMemberId:first.memberId,verifierMemberId:'reviewer',independentVerificationRequired:true,ownerDecisionRequired:true,humanDecisionMakerId:'owner',mode:'read'});
 async function mcp(pointer, token=first.mcpToken.credential){
  const res=await fetch(new URL(endpoint.pathname, origin),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:pointer.tool,arguments:pointer.arguments}})});
  return (await res.json()).result;
 }
 const pickup=await mcp(first.nextWork);
 assert.equal(pickup?.isError,undefined);
 assert.equal(pickup.structuredContent.viewerId,peer.identityId);
 assert.equal(pickup.structuredContent.nextRead.arguments.workItemId,'task');
 const brief=await mcp(pickup.structuredContent.nextRead);
 assert.equal(brief.structuredContent.continuation.action,'accept');
 const fallback=await mcp(first.nextWork.fallback);
 assert.ok(fallback.structuredContent.work.some(item=>item.id==='task'));
 const crossed=await mcp({...first.nextWork,arguments:{roomId:'friend-home'}});
 assert.equal(crossed.isError,true);
 const chatInvite=s.invites.create(inviter.secret,'commons',{profile:'chat'});
 const chat=s.invites.redeem(chatInvite.code,{displayName:'Chat-only guest'});
 assert.equal(typeof chat.identitySecret,'string');
 assert.equal(chat.next[0].action,'save-identity-secret');
 assert.equal(chat.nextActions[0].action,'save-identity-secret');
 cmd(ownerKey,'chat-task','work.proposed',{workItemId:'chat-task',title:'Permission witness',definitionOfDone:'Report the scope gap',
  accountableMemberId:chat.memberId,mode:'read'});
 const chatPickup=(await mcp(chat.nextWork,chat.mcpToken.credential)).structuredContent;
 assert.equal(chatPickup.work.items[0].reason,'permission_required');
 const chatBrief=(await mcp(chatPickup.nextRead,chat.mcpToken.credential)).structuredContent;
 assert.equal(chatBrief.continuation.action,'permission_required');
 assert.equal(chatBrief.continuation.tool,null);
 const peerCall = async (tool, args) => {
  const result = await mcp({ tool, arguments: { roomId: 'commons', ...args } }, peer.secret);
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.ok(result?.structuredContent, tool);
  return result.structuredContent;
 };
 const begin = await peerCall('room_begin_work', { workItemId: 'task', expectedRevision: 0 });
 assert.equal(begin.working, true);
 assert.deepEqual(begin.confirmed.map(row => row.action), ['room_accept_work', 'room_start_work']);
 assert.ok(begin.confirmed[1].eventId);
 const throughStart = s.headSequence('commons');
 await disconnect();
 await connect();
 const resumed = await peerCall('room_next', { view: 'pickup' });
 assert.equal(resumed.viewerId, peer.identityId);
 assert.equal(resumed.nextRead.arguments.workItemId, 'task');
 assert.equal(resumed.work.items.find(row => row.id === 'task').reason, 'in_progress');
 const resumedWork = await peerCall(resumed.nextRead.tool, resumed.nextRead.arguments);
 assert.equal(resumedWork.workItemId, 'task');
 assert.equal(resumedWork.revision, 2);
 assert.equal(s.headSequence('commons'), throughStart, 'reconnect and pickup reads do not write another start');

 const body = 'First useful saved result';
 const posted = await peerCall('room_post_message', { id: 'saved', body, workItemId: 'task' });
 const version = textVersion(body);
 const resultInput = {
  workItemId: 'task', expectedRevision: 2, evidenceMessageId: 'saved', evidenceMessageEventId: posted.event.id,
  evidenceVersion: version, previousCompletionEventId: null, producerId: peer.identityId,
  summary: 'Saved useful work', nextAction: 'Independent review', requestId: 'done'
 };
 cmd(ownerKey, 'propose-next', 'work.proposed', {
  workItemId: 'next-task', title: 'Check the next artifact', definitionOfDone: 'Return a cited QA finding',
  accountableMemberId: peer.identityId, mode: 'read'
 });
 const done = await peerCall('room_submit_text_result', resultInput);
 assert.equal(done.result.read.arguments.completionEventId, done.eventId);
 const replayedResult = await peerCall('room_submit_text_result', resultInput);
 assert.equal(replayedResult.duplicate, true);
 assert.equal(replayedResult.eventId, done.eventId);
 assert.deepEqual(replayedResult.nextPickup, done.nextPickup);
 assert.deepEqual(done.nextPickup, { tool: 'room_next', arguments: { roomId: 'commons', view: 'pickup' } });
 const next = await peerCall(done.nextPickup.tool, done.nextPickup.arguments);
 assert.equal(next.nextRead.arguments.workItemId, 'next-task');
 const nextWork = await peerCall(next.nextRead.tool, next.nextRead.arguments);
 const second = await peerCall('room_begin_work', { workItemId: 'next-task', expectedRevision: nextWork.revision });
 assert.equal(second.working, true);
 assert.deepEqual(second.confirmed.map(row => row.action), ['room_accept_work', 'room_start_work']);
 assert.notEqual(second.confirmed[1].eventId, begin.confirmed[1].eventId);
 const secondRead = await peerCall('room_read_work', { workItemId: 'next-task' });
 assert.equal(secondRead.work.state, 'working');
 assert.equal(item().state, 'completed');

 cmd(reviewerKey,'verify','verification.recorded',{workItemId:'task',expectedRevision:3,result:'pass',completionEventId:done.eventId,evidenceVersion:version,summary:'Reviewed exact saved result'});
 cmd(ownerKey,'rationale','message.posted',{messageId:'rationale',body:'Independent output accepted'});
 cmd(ownerKey,'approve','owner.decision_recorded',{workItemId:'task',expectedRevision:4,decision:'approved',completionEventId:done.eventId,evidenceVersion:version,reason:'Useful result verified',sourceMessageId:'rationale'});
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
