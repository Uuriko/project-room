import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
export function historicalDiscussionEvents(){
 const events=initialRoom();
 const add=(id,type,data)=>events.push(event({id,roomId:'commons',actorId:'owner',type,data}));
 for(const memberId of ['reader','other'])add(memberId,'member.added',{memberId,displayName:memberId,kind:'agent',permissions:[]});
 add('task','work.proposed',{workItemId:'task',title:'Historical text, current discussion',definitionOfDone:'Read only current text',accountableMemberId:'reader',independentVerificationRequired:false,ownerDecisionRequired:false});
 const since=events.length;
 for(const [id,body,toMemberId] of [['cjk','界'.repeat(65536),null],['control','\u0001'.repeat(65536),null],['private','界'.repeat(65536),'other']]){
  add('opening-'+id,'message.posted',{messageId:id,body,workItemId:'task',...(toMemberId?{toMemberId}:{})});
  for(let i=0;i<26;i++)add('edit-'+id+'-'+i,'message.edited',{messageId:id,expectedMessageRevision:i,body:'Current '+id+' revision '+i});
 }
 add('tail','message.posted',{messageId:'tail',body:'Current small tail',workItemId:'task'});
 return {events,since};
}
