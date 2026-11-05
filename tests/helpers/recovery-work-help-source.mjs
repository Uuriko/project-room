import {seedHistoricalRedactionSource} from './historical-redaction-source.mjs';
import {auditRecovery} from '../../server/recovery.mjs';
import {textVersion} from '../../server/text-results.mjs';
import {setTier} from '../../server/autonomy-tiers.mjs';
export function seedRecoveryWorkHelpSource(store,{checkpoint=true,extraOffers=0,beforeCapture:extendBeforeCapture,captureOptions}={}){
 let saved=null,serial=0,now=Date.now(),helpEventId;
 const f=seedHistoricalRedactionSource(store,{beforeCapture(s,{key,workerKey}){
  s.now=()=>now;const send=(who,type,data)=>{now+=3000;return s.command(who,'legacy-room',{id:'help-audit-'+serial++,type,data});};
  send(key,'member.added',{memberId:'helper-two',displayName:'Second helper',kind:'agent',permissions:[]});send(key,'member.added',{memberId:'heir',displayName:'Next human owner',kind:'human',permissions:[]});
  const second=s.issueAccessKey('legacy-room','helper-two'),heir=s.issueAccessKey('legacy-room','heir');for(const id of ['worker','helper-two'])setTier(s.db,'legacy-room',id,'t2_standard',{updatedBy:'owner',nowMs:now});
  send(key,'work.proposed',{workItemId:'help-task',title:'Useful contribution',definitionOfDone:'Save the coordinated contribution',accountableMemberId:'owner'});send(key,'work.accepted',{workItemId:'help-task',expectedRevision:0});
  const help=send(key,'work.help_updated',{workItemId:'help-task',expectedRevision:1,expectedHelpRevision:0,status:'open',scope:'Review one exact result',expiresAt:new Date(now+3600000).toISOString()});helpEventId=help.event.id;
  send(workerKey,'work.help_offer_opened',{workItemId:'help-task',expectedRevision:1,expectedHelpRevision:1,helpEventId,offerId:'first-offer',plan:'Inspect the saved result'});
  send(key,'work.help_offer_updated',{workItemId:'help-task',expectedRevision:1,expectedOfferRevision:0,status:'selected',offerId:'first-offer',reason:'Review this result',expectedHelpRevision:1,helpEventId});
  const state=s.room('legacy-room');saved={sequence:state.sequence,projection:JSON.stringify(state.state)};
  send(key,'work.help_offer_updated',{workItemId:'help-task',expectedRevision:1,expectedOfferRevision:1,status:'released',offerId:'first-offer',reason:'Contribution returned',externalActivityUnverified:true});
  send(second,'work.help_offer_opened',{workItemId:'help-task',expectedRevision:1,expectedHelpRevision:1,helpEventId,offerId:'second-offer',plan:'Inspect remaining uncertainty'});
  send(key,'work.help_offer_updated',{workItemId:'help-task',expectedRevision:1,expectedOfferRevision:0,status:'declined',offerId:'second-offer',reason:'Existing review sufficient'});
  send(key,'ownership.transferred',{toMemberId:'worker',reason:'Agent coordinates the handoff'});send(workerKey,'ownership.transferred',{toMemberId:'heir',reason:'Human accepts room ownership'});
  send(heir,'work.help_updated',{workItemId:'help-task',expectedRevision:1,expectedHelpRevision:1,status:'withdrawn'});
  const body='Saved coordinated contribution',posted=send(key,'message.posted',{messageId:'help-result',workItemId:'help-task',body});send(key,'work.completed',{workItemId:'help-task',expectedRevision:1,evidenceKind:'room_text',evidenceMessageId:'help-result',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Coordinated result saved',nextAction:'Review'});
  for(let i=0;i<extraOffers;i++){
   const workItemId='extra-help-'+i,offerId='extra-offer-'+i;
   send(key,'work.proposed',{workItemId,title:'Additional saved contribution '+i,definitionOfDone:'Preserve exact coordination',accountableMemberId:'owner'});send(key,'work.accepted',{workItemId,expectedRevision:0});
   const invitation=send(key,'work.help_updated',{workItemId,expectedRevision:1,expectedHelpRevision:0,status:'open',scope:'Review additional result '+i,expiresAt:new Date(now+3600000).toISOString()});
   send(workerKey,'work.help_offer_opened',{workItemId,expectedRevision:1,expectedHelpRevision:1,helpEventId:invitation.event.id,offerId,plan:'Review the exact result'});
   send(key,'work.help_offer_updated',{workItemId,expectedRevision:1,expectedOfferRevision:0,offerId,status:'declined',reason:'Sufficient review recorded'});
   const body='Additional contribution '+i,posted=send(key,'message.posted',{messageId:'extra-result-'+i,workItemId,body});send(key,'work.completed',{workItemId,expectedRevision:1,evidenceKind:'room_text',evidenceMessageId:'extra-result-'+i,evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Additional saved result',nextAction:'Review'});
  }

  extendBeforeCapture?.(s,{key,workerKey,send});
 },captureOptions});
 if(checkpoint)store.transaction(()=>store.db.prepare('INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)').run('legacy-room',saved.sequence,saved.projection));
 auditRecovery(store);return{...f,helpEventId,checkpointSequence:checkpoint?saved.sequence:null};
}
