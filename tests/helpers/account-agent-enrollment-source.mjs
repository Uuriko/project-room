import {createHash,randomUUID} from 'node:crypto';
import {initialRoom} from '../../server/bootstrap.mjs';
import {createAccountAgentEnrollment} from '../../server/account-agent-enrollment.mjs';
export const enrollmentResource='https://room.example/mcp';
export function seedAccountAgentEnrollment(s){
 s.initialize(initialRoom('source'),{representation:'normalized-current-v1'});
 s.initialize(initialRoom('target'),{representation:'normalized-current-v1'});
 s.createAccount('john');s.bindHumanAccount('source','owner','john');s.bindHumanAccount('target','owner','john');
 const key=s.issueAccountAccessKey('john'),slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,key,0),binding=session.sessionBinding;
 const identity=s.identities.create('Existing Claude'),code=s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'source'});
 const source=s.agentConnections.apply(slot.token,'source',{action:'create',requestId:'source-managed',memberId:'claude',displayName:'Existing Claude',access:'collaborate',expectedOwnerRevision:0,keyHash:createHash('sha256').update(randomUUID()).digest('hex'),expiresAt:s.now()+3600000,identityId:identity.identityId,identityLinkCode:code.linkCode},binding);
 const service=createAccountAgentEnrollment({store:s,resource:enrollmentResource,enabled:true});
 const choice=service.list(slot.token,'target',binding).choices[0];
 const request={action:'enroll-existing',requestId:'enroll-claude',choiceId:choice.choiceId,sourceRoomId:'source',sourceMemberId:'claude',identityId:identity.identityId,memberId:'claude',access:'collaborate',expectedOwnerRevision:0};
 return {slot,binding,identity,source,request};
}
