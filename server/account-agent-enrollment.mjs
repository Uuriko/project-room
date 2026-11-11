// Explicit account consent enrolls an already controlled agent in another room.
// This is not identity-holder proof and never manufactures a holder link code.
import {createHash,randomBytes} from 'node:crypto';
import {listMcpOAuthAgents,validateMcpOAuthBinding} from './mcp-oauth.mjs';
import {ServiceError} from './service-error.mjs';
import {validId,ownMember} from '../src/events.js';
import {agentAccessProfiles} from './agent-connections.mjs';
const scopes=new WeakMap();
const action='account_agent_enrollment_v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(status,code,message)=>{throw new ServiceError(status,code,message);};
const fields=['action','requestId','choiceId','sourceRoomId','sourceMemberId','identityId','memberId','access','expectedOwnerRevision'];
function owner(store,token,roomId,binding){
 const auth=store.agentConnections.owner(token,roomId,binding);
 if(auth.delegate||auth.kind!=='session'||!auth.account||auth.member.kind!=='human'||auth.member.active!==true)
  fail(403,'owner_required','A signed-in human room owner must approve existing agent access');
 return auth;
}
function proofId(accountId,roomId,requestId){return `account-enroll-${hash(JSON.stringify([accountId,roomId,requestId]))}`;}
function savedProof(store,id){
 const row=store.db.prepare('SELECT action,target_kind,target_id,counts_json,result FROM operator_actions WHERE id=?').get(id);
 if(!row||row.action!==action||row.target_kind!=='room'||row.result!=='committed')return null;
 let proof;try{proof=JSON.parse(row.counts_json);}catch{return null;}
 if(proof?.version!==1||proof.targetRoomId!==row.target_id||hash(JSON.stringify(proof.request))!==proof.requestHash)return null;
 return proof;
}
export function assertAccountEnrollment(store,roomId,request,{history=false,accountId=null}={}){
 const proof=savedProof(store,request.accountEnrollment);
 if(!proof||request.accountEnrollment!==proofId(proof.accountId,roomId,request.requestId)||proof.targetRoomId!==roomId||proof.request.memberId!==request.memberId||proof.request.identityId!==request.identityId
  ||proof.request.access!==request.access||proof.request.requestId!==request.requestId||proof.request.expectedOwnerRevision!==request.expectedOwnerRevision
  ||proof.keyHash!==request.keyHash||proof.expiresAt!==request.expiresAt||proof.displayName!==request.displayName
  ||proof.sourceBinding.identityId!==request.identityId||proof.sourceBinding.memberId!==request.memberId
  ||accountId!==null&&proof.accountId!==accountId)
  fail(history?503:422,history?'connection_integrity_error':'identity_link_proof_required','Existing agent enrollment evidence requires reconciliation');
 if(!history&&scopes.get(store)!==request.accountEnrollment)
  fail(403,'access_denied','Explicit account enrollment consent required');
 return proof;
}
export function createAccountAgentEnrollment({store,resource,preferences=[],enabled=false}){
 // preferences is server configuration, never request-selected source authority.
 const configured=preferences.map(value=>({preferredRoomId:value.preferredRoomId,preferredMemberId:value.preferredMemberId}));
 function choices(auth,targetRoomId){
  const found=new Map();
  for(const preference of [{},...configured])for(const choice of listMcpOAuthAgents(store,auth.account.id,resource,preference)){
   const binding=choice.binding;
   if(binding.roomId===targetRoomId)continue;
   if(!validateMcpOAuthBinding(store,auth.account.id,binding))continue;
   const authority=store.agentSponsorAuthority(binding.roomId,[binding.memberId,binding.humanMemberId]);
   const member=ownMember(authority.members,binding.memberId);
   const source={binding,memberRevision:member.revision,humanRevision:ownMember(authority.members,binding.humanMemberId)?.revision,ownerId:authority.ownerId,ownershipRevision:authority.ownershipRevision??0};
   const choiceId=hash(JSON.stringify(source));
   found.set(`${binding.roomId}:${binding.memberId}`,{choiceId,sourceRoomId:binding.roomId,sourceMemberId:binding.memberId,
    identityId:binding.identityId,memberId:binding.memberId,displayName:member.displayName,label:choice.label,source});
  }
  return [...found.values()];
 }
 const publicChoice=({source,...choice})=>choice;
 return {
  list(token,roomId,binding){return store.readTransaction(()=>{
   const auth=owner(store,token,roomId,binding);
   return {available:enabled===true,choices:enabled===true?choices(auth,roomId).map(publicChoice):[],...(enabled===true?{profiles:Object.fromEntries(['chat','guest','contribute','review','collaborate'].map(name=>[name,[...agentAccessProfiles[name]]]))}:{})};
  });},
  apply(token,roomId,input,binding){
   if(enabled!==true)fail(403,'access_denied','Existing agent enrollment is not enabled on this release');
   if(!input||Object.keys(input).length!==fields.length||fields.some(key=>!Object.hasOwn(input,key))||input.action!=='enroll-existing'
    ||!validId(input.requestId)||!validId(input.memberId)||typeof input.choiceId!=='string'||!/^[a-f0-9]{64}$/.test(input.choiceId)
    ||!Number.isSafeInteger(input.expectedOwnerRevision)||input.expectedOwnerRevision<0
    ||!['chat','guest','contribute','review','collaborate'].includes(input.access))
    fail(422,'invalid_connection','Choose an existing controlled agent and an explicit supported access profile');
   const request=Object.fromEntries(fields.map(key=>[key,input[key]])),requestHash=hash(JSON.stringify(request));
   return store.transaction(()=>{
    const auth=owner(store,token,roomId,binding),id=proofId(auth.account.id,roomId,input.requestId);
    let proof=savedProof(store,id);
    if(proof){if(proof.requestHash!==requestHash||proof.accountId!==auth.account.id)fail(409,'idempotency_conflict','This request was used for different settings');}
    else{
     if(auth.member.revision!==input.expectedOwnerRevision)fail(409,'stale_member_revision','Your room access changed; refresh first');
     const choice=choices(auth,roomId).find(value=>value.choiceId===input.choiceId);
     if(!choice||choice.sourceRoomId!==input.sourceRoomId||choice.sourceMemberId!==input.sourceMemberId
      ||choice.identityId!==input.identityId||choice.memberId!==input.memberId)
      fail(409,'connection_changed','Existing agent control changed; refresh the choices');
     if(store.db.prepare('SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId,input.identityId))
      fail(409,'identity_already_linked','This identity already belongs to the target room');
     proof={version:1,request,requestHash,accountId:auth.account.id,accountEpoch:auth.account.authEpoch,targetRoomId:roomId,
      sourceBinding:choice.source.binding,source:choice.source,displayName:choice.displayName,
      keyHash:hash(randomBytes(32)),expiresAt:store.now()+30*86400000};
     store.db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,store.now(),action,'room',roomId,JSON.stringify(proof),'committed',input.requestId);
    }
    const managed={action:'create',requestId:input.requestId,memberId:input.memberId,displayName:proof.displayName,access:input.access,
     expectedOwnerRevision:input.expectedOwnerRevision,keyHash:proof.keyHash,expiresAt:proof.expiresAt,identityId:input.identityId,accountEnrollment:id};
    const prior=scopes.get(store);scopes.set(store,id);
    try{
     const result=store.agentConnections.apply(token,roomId,managed,binding);
     return {...result,enrolledExisting:true,identityId:input.identityId,next:{tool:'room_check_access',arguments:{roomId},requires:'Separate target-room OAuth consent'}};
    }finally{if(prior)scopes.set(store,prior);else scopes.delete(store);}
   });
  }
 };
}
