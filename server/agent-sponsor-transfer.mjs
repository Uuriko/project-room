// Existing-seat sponsorship requires recipient account consent and a separate
// current membership administrator decision. No identity or permission grant.
import { createHash } from 'node:crypto';
import { ownMember, isRoomArchived, event } from '../src/events.js';
const fail=(status,code,message)=>{throw Object.assign(Error(message),{status,code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopes=new WeakMap();
export const SPONSOR_TRANSFER='agent-sponsor-transfer';
export function sponsorTransferContents(row) {
 const value=JSON.parse(row.requested_permissions);
 if(value?.kind!==SPONSOR_TRANSFER)return null;
 if(value.version!==1||typeof value.accountId!=='string'||typeof value.memberId!=='string'||typeof value.humanMemberId!=='string'
  ||typeof value.identityId!=='string'||typeof value.identityEpoch!=='string'||!Number.isSafeInteger(value.accountEpoch)
  ||![value.memberRevision,value.humanRevision,value.ownershipRevision].every(n=>Number.isSafeInteger(n)&&n>=0)
  ||!Array.isArray(value.permissions)||value.permissions.some(p=>typeof p!=='string')||row.identity_id!==`member:${value.humanMemberId}`)
  fail(409,'invalid_request','Invalid saved sponsorship consent');
 return value;
}
function facts(store,roomId,value) {
 const authority=store.agentSponsorAuthority(roomId,[value.memberId,value.humanMemberId]);
 const member=ownMember(authority.members,value.memberId),human=ownMember(authority.members,value.humanMemberId);
 const account=store.db.prepare('SELECT active,auth_epoch FROM accounts WHERE id=?').get(value.accountId);
 const link=store.db.prepare('SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?').get(roomId,value.humanMemberId);
 const identity=store.db.prepare('SELECT secret_hash,revoked_at FROM agent_identities WHERE identity_id=?').get(value.identityId);
 const linked=store.db.prepare('SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId,value.identityId);
 const epoch=identity&&identity.revoked_at===null?createHash('sha256').update(`mcp-oauth-identity:${identity.secret_hash}`).digest('hex'):null;
 if(isRoomArchived({room:authority})||account?.active!==1||account.auth_epoch!==value.accountEpoch||link?.account_id!==value.accountId
  ||human?.kind!=='human'||human.active!==true||human.revision!==value.humanRevision
  ||member?.kind!=='agent'||member.active!==true||member.id===authority.ownerId||member.identityId!==value.identityId
  ||member.revision!==value.memberRevision||member.accountableHumanId!==value.previousSponsorId
  ||linked?.member_id!==member.id||epoch!==value.identityEpoch||authority.ownerId!==value.ownerId
  ||(authority.ownershipRevision??0)!==value.ownershipRevision||JSON.stringify(member.permissions)!==JSON.stringify(value.permissions))
  fail(409,'stale_membership','Account or membership changed; request sponsorship approval again');
 return {authority,member,human};
}
export class AgentSponsorTransfers {
 constructor(access){this.access=access;this.store=access.store;this.db=access.db;}
 request(token,roomId,{memberId,requestId}={},binding=null){
  if(typeof memberId!=='string'||typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(requestId))fail(422,'invalid_request','Choose an existing agent and request identifier');
  return this.store.transaction(()=>{
   const auth=this.store.authenticateAccountSession(token,roomId,binding);
   const old=this.db.prepare('SELECT * FROM access_requests WHERE request_id=?').get(requestId);
   if(old){const v=sponsorTransferContents(old);if(!v||old.room_id!==roomId||v.accountId!==auth.account.id||v.memberId!==memberId||v.humanMemberId!==auth.member.id)fail(409,'request_conflict','Request identifier is already in use');return this.access.toRequest(this.access.maybeExpire(old));}
   const authority=this.store.agentSponsorAuthority(roomId,[memberId,auth.member.id]),member=ownMember(authority.members,memberId);
   const identity=member?.identityId&&this.db.prepare('SELECT secret_hash,revoked_at FROM agent_identities WHERE identity_id=?').get(member.identityId);
   const value={version:1,kind:SPONSOR_TRANSFER,accountId:auth.account.id,accountEpoch:auth.account.authEpoch,
    memberId,humanMemberId:auth.member.id,humanRevision:auth.member.revision,memberRevision:member?.revision,
    previousSponsorId:member?.accountableHumanId,identityId:member?.identityId,
    identityEpoch:identity?createHash('sha256').update(`mcp-oauth-identity:${identity.secret_hash}`).digest('hex'):null,
    ownerId:authority.ownerId,ownershipRevision:authority.ownershipRevision??0,permissions:member?.permissions};
   facts(this.store,roomId,value);
   if(member.accountableHumanId===auth.member.id)fail(409,'nothing_to_request','This agent is already sponsored by you');
   const limit=this.access.rateLimiter.check(`agent-sponsor:${auth.account.id}`);if(!limit.allowed)fail(429,'rate_limited',limit.message);
   this.access.expireOld(roomId,`member:${auth.member.id}`);
   if(this.db.prepare("SELECT count(*) n FROM access_requests WHERE room_id=? AND identity_id=? AND status='pending_upgrade'").get(roomId,`member:${auth.member.id}`).n>=5)fail(409,'too_many_requests','Review existing requests first');
   this.db.prepare("INSERT INTO access_requests(request_id,room_id,identity_id,display_name,requested_permissions,note,status,created_at) VALUES(?,?,?,?,?,?,'pending_upgrade',?)")
    .run(requestId,roomId,`member:${auth.member.id}`,member.displayName,JSON.stringify(value),`${auth.member.displayName} requests sponsorship of this existing agent; identity and room permissions stay unchanged`,this.store.now());
   this.store.appendSideTableEvent(roomId,event({id:`sponsor-request-${requestId}`,idempotencyKey:`sponsor-request-${requestId}`,roomId,type:'access.requested',actorId:auth.member.id,at:new Date(this.store.now()).toISOString(),data:{requestId,identityId:auth.member.id,displayName:member.displayName,permissions:[],requestKind:SPONSOR_TRANSFER,requesterMemberId:auth.member.id,requestDigest:digest(value),note:`${auth.member.displayName} asks to connect this existing agent; room permissions and identity stay unchanged`}}));
   return this.access.toRequest(this.db.prepare('SELECT * FROM access_requests WHERE request_id=?').get(requestId));
  });
 }
 review(token,roomId,row,{decision,permissions,note},auth,binding){
  const value=sponsorTransferContents(row);
  if(permissions!==undefined)fail(422,'invalid_request','Sponsorship approval cannot change permissions');
  if(note!=null&&(typeof note!=='string'||note.length>500))fail(422,'invalid_request','Review note is too long');
  if(row.status!=='pending_upgrade'){
   if(row.status===(decision==='approve'?'approved':'denied')&&row.decided_by===auth.member.id&&(row.decision_note??null)===(note?.trim()||null))return this.access.toRequest(row);
   fail(409,'already_decided','This request has already been decided');
  }
  if(decision==='approve'){
   const basis=this.db.prepare('SELECT body FROM events WHERE room_id=? AND id=?').get(roomId,`sponsor-request-${row.request_id}`);
   const requested=basis&&JSON.parse(basis.body);
   if(requested?.type!=='access.requested' || requested.actorId!==value.humanMemberId || requested.data.requestDigest!==digest(value) || requested.data.requestKind!==SPONSOR_TRANSFER || requested.data.requestId!==row.request_id)fail(409,'stale_membership','Recipient consent evidence is missing or changed');
   const {authority,member}=facts(this.store,roomId,value);
   if(auth.member.id!==authority.ownerId&&(!auth.member.permissions.includes('manage_members')||!auth.member.permissions.includes('decide')||member.permissions.some(p=>!auth.member.permissions.includes(p))))fail(403,'access_denied','Owner or administrator holding the agent permissions required');
   const command={id:`adopt-${row.request_id}`,type:'member.sponsor_transferred',data:{requestId:row.request_id,requestDigest:digest(value),memberId:value.memberId,
    expectedMemberRevision:value.memberRevision,toMemberId:value.humanMemberId,expectedHumanRevision:value.humanRevision,previousSponsorId:value.previousSponsorId,identityId:value.identityId}};
   const prior=scopes.get(this.store);scopes.set(this.store,{roomId,command});
   try{this.store.command(token,roomId,command,binding);}finally{if(prior)scopes.set(this.store,prior);else scopes.delete(this.store);}
   // Fence the old managed credential and invitation grants for this seat only.
   const connection=this.store.agentConnections.row(roomId,value.memberId);
   if(connection?.status==='issued'){
    this.db.prepare('UPDATE credentials SET revoked=1 WHERE hash=?').run(connection.credential_hash);
   }
   // The persisted member adoption marker fences pre-transfer OAuth codes,
   // access/refresh tokens and descriptors through their normal validators.
   // Do not scan unrelated token history or rewrite immutable grant receipts.

  }
  this.db.prepare('UPDATE access_requests SET status=?,decided_at=?,decided_by=?,decision_note=? WHERE request_id=?').run(decision==='approve'?'approved':'denied',this.store.now(),auth.member.id,note?.trim()||null,row.request_id);
  return this.access.toRequest(this.db.prepare('SELECT * FROM access_requests WHERE request_id=?').get(row.request_id));
 }
}
export function assertSponsorTransferCommand(store,roomId,command){
 const scope=scopes.get(store);
 if(!scope||scope.roomId!==roomId||scope.command!==command)fail(403,'access_denied','An explicit recipient request and reviewed approval are required');
}
export function approvedAgentAdoption(store,roomId,member,accountId){
 if(!member?.sponsorAdoptionId)return null;
 const row=store.db.prepare('SELECT * FROM access_requests WHERE room_id=? AND request_id=?').get(roomId,member.sponsorAdoptionId);
 if(!row||row.status!=='approved')return null;
 let value;try{value=sponsorTransferContents(row);}catch{return null;}
 if(!value||member.kind!=='agent'||value.memberId!==member.id||value.accountId!==accountId||value.humanMemberId!==member.accountableHumanId||value.identityId!==member.identityId||digest(value)!==member.sponsorAdoptionDigest)return null;
 const basis=store.db.prepare('SELECT body FROM events WHERE room_id=? AND id=?').get(roomId,`sponsor-request-${row.request_id}`);
 if(!basis)return null;
 const requested=JSON.parse(basis.body);
 if(requested.type!=='access.requested' || requested.actorId!==value.humanMemberId || requested.data.requestKind!==SPONSOR_TRANSFER || requested.data.requestId!==row.request_id || requested.data.requestDigest!==member.sponsorAdoptionDigest)return null;
 const raw=store.db.prepare('SELECT e.body FROM commands c JOIN events e ON e.room_id=c.room_id AND e.sequence=c.sequence WHERE c.room_id=? AND c.id=? AND c.actor_id=?').get(roomId,`adopt-${row.request_id}`,row.decided_by);
 if(!raw)return null;
 const e=JSON.parse(raw.body);
 if(e.type!=='member.sponsor_transferred'||e.actorId!==row.decided_by||e.data.requestId!==row.request_id||e.data.requestDigest!==member.sponsorAdoptionDigest||e.data.memberId!==member.id||e.data.toMemberId!==member.accountableHumanId)return null;
 return value;
}

export function agentSponsorTransferCandidate(store,accountId,{preferredRoomId:roomId,preferredMemberId:memberId}={}){
 if(!roomId||!memberId)return null;
 const linked=store.db.prepare('SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?').get(roomId,accountId);
 if(!linked)return null;
 const authority=store.agentSponsorAuthority(roomId,[memberId,linked.member_id]),human=ownMember(authority.members,linked.member_id),member=ownMember(authority.members,memberId);
 if(isRoomArchived({room:authority})||human?.kind!=='human'||human.active!==true||member?.kind!=='agent'||member.active!==true||!member.identityId||member.id===authority.ownerId||member.accountableHumanId===human.id)return null;
 const rows=store.db.prepare("SELECT * FROM access_requests WHERE room_id=? AND identity_id=? AND status='pending_upgrade' ORDER BY created_at DESC LIMIT 5").all(roomId,`member:${human.id}`);
 const pending=rows.find(row=>{const value=sponsorTransferContents(row);return value?.memberId===memberId&&value.accountId===accountId&&store.now()-row.created_at<=7*86400000;});
 return {roomId,memberId,displayName:member.displayName,roomTitle:authority.title??roomId,pendingRequestId:pending?.request_id??null};
}
