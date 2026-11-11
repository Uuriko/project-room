import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
export function prepareSupersession(store,{completed=false,privateSource=false}={}) {
 const events=initialRoom();
 const add=(actorId,type,data)=>events.push(event({roomId:'commons',actorId,type,data}));
 for(const id of ['departed','replacement','verifier','other'])add('owner','member.added',{memberId:id,displayName:id,kind:'agent',permissions:['accept_work','complete_work',...(id==='verifier'?['verify']:[]),...(id==='departed'?['write_external']:[])]});
 if(privateSource)add('departed','message.posted',{messageId:'private-source',toMemberId:'owner',body:'Private previous contract'});
 add('owner','work.proposed',{workItemId:'original',title:'Original accepted contract',definitionOfDone:'Saved useful result',accountableMemberId:'departed',mode:'write',...(privateSource?{sourceMessageId:'private-source'}:{})});
 add('departed','work.accepted',{workItemId:'original',expectedRevision:0});
 add('departed','claim.acquired',{workItemId:'original',expectedRevision:1,repository:'synthetic/project',ref:'main',paths:['result.txt'],expiresAt:'2099-01-01T00:00:00.000Z'});
 add('departed','work.handoff_recorded',{workItemId:'original',expectedRevision:2,doneSummary:'Stage one saved',nextAction:'Finish original contract',limitReason:'Agent departed'});
 if(completed)add('departed','work.completed',{workItemId:'original',expectedRevision:3,summary:'Existing result retained',evidenceUrl:'https://example.invalid/original',evidenceVersion:'v1',producerId:'departed',nextAction:'Review'});
 add('owner','work.proposed',{workItemId:'successor',title:'Replacement contract',definitionOfDone:'Finish and save useful result',accountableMemberId:'replacement',verifierMemberId:'verifier',independentVerificationRequired:true,ownerDecisionRequired:true,humanDecisionMakerId:'owner',mode:'read'});
 add('owner','member.access_changed',{memberId:'departed',expectedMemberRevision:0,permissions:[],active:false});
 store.initialize(events,{representation:'normalized-current-v1'});
 const keys=Object.fromEntries(['owner','replacement','verifier','other'].map(id=>[id,store.issueAccessKey('commons',id)]));
 const item=id=>JSON.parse(store.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('commons',id).body);
 const cmd=(actor,id,type,data)=>store.command(keys[actor],'commons',{id,type,data});
 const command=()=>({id:'supersede',type:'work.superseded',data:{workItemId:'original',expectedRevision:item('original').revision,supersededByWorkItemId:'successor',reason:'Authorized replacement of departed agent'}});
 return{keys,item,cmd,command};
}
