import {seedHistoricalRedactionSource} from './historical-redaction-source.mjs';
export function seedRecoveryInvitationRecords(s,roomId,{pending=1}={}){
 const issued=[];if(!s.accountForMember(roomId,'owner'))s.issueAccessKey(roomId,'owner');const ownerAccount=s.accountForMember(roomId,'owner').id;
  const session=id=>{const access=s.issueAccountAccessKey(id),slot=s.createAccountSessionSlot();return{token:slot.token,session:s.loginAccountSession(slot.token,access,0)};};
  const owner=session(ownerAccount);
  for(let i=0;i<pending+2;i++){
   const account='invite-account-'+i,member='invite-member-'+i;s.createAccount(account);const target=session(account),token=Buffer.alloc(32,i+1).toString('base64url');
   const value=s.issueInvitation(owner.token,roomId,{requestId:'independent-invite-'+i,token,intendedAccountId:account,intendedMemberId:member,displayName:'Intended human '+i,role:'member',expiresAt:Date.now()+3600000,expectedIssuerMemberRevision:s.room(roomId).state.members.owner.revision,expectedSessionBinding:owner.session.sessionBinding});
   issued.push({id:value.invitation.id,member,account,token,target});
   if(i===0)s.acceptInvitation(target.token,token,{redemptionId:'b6bdc104-080f-4373-9c75-704c8fe4f002',expectedRevision:0,expectedSessionBinding:target.session.sessionBinding});
   if(i===1)s.revokeInvitation(owner.token,value.invitation.id,{expectedRevision:0,reason:'Withdraw invitation',expectedSessionBinding:owner.session.sessionBinding});
  }
 return{issued,owner};
}
export function seedRecoveryInvitationSource(store,{pending=1,beforeCapture}={}){
 let issued;seedHistoricalRedactionSource(store,{beforeCapture(s,context){const value=seedRecoveryInvitationRecords(s,'legacy-room',{pending});issued=value.issued;beforeCapture?.(s,{...context,...value});}});return{issued,expected:store.verifyInvitationAudit()};
}

export function rebindRecoveryInvitee(s,{issued,owner}){
 const first=issued[0];
   const member=s.room('legacy-room').state.members[first.member],access=s.issueAccessKey('legacy-room',first.member);
   s.command(access,'legacy-room',{id:'self-leave-original-invite',type:'member.access_changed',data:{memberId:first.member,expectedMemberRevision:member.revision,active:false,permissions:member.permissions}});
   const token=Buffer.alloc(32,71).toString('base64url');s.issueInvitation(owner.token,'legacy-room',{requestId:'rebound-invitation',token,intendedAccountId:first.account,intendedMemberId:'returned-human',displayName:'Returned human',role:'member',expiresAt:Date.now()+3600000,expectedIssuerMemberRevision:s.room('legacy-room').state.members.owner.revision,expectedSessionBinding:owner.session.sessionBinding});
   s.acceptInvitation(first.target.token,token,{redemptionId:'ac492c4f-8685-47f8-a5c0-02f66230b1fe',expectedRevision:0,expectedSessionBinding:first.target.session.sessionBinding});
}
