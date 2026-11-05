import assert from 'node:assert/strict';
import {RoomStore} from '../../server/store.mjs';
import {AgentRooms} from '../../server/agent-rooms.mjs';
import {collectNeedsMe} from '../../server/needs-me.mjs';
import {linkWithProof} from './link-with-proof.mjs';
import {textVersion} from '../../server/text-results.mjs';
export function canonicalNeedsMeRoom(t){
 let clock=Date.now(),serial=0;const store=new RoomStore(':memory:',{now:()=>clock});t.after(()=>store.close());
 const owner=store.identities.create('Canonical owner'),worker=store.identities.create('Canonical worker'),reviewer=store.identities.create('Canonical reviewer'),other=store.identities.create('Canonical observer'),roomId='native-attention';
 new AgentRooms(store).create(owner.secret,{roomId,title:'Canonical coordination',purpose:'Save useful work and independently review it',starter:false});
 for(const identity of [worker,reviewer,other])linkWithProof(store,owner.secret,roomId,identity,{displayName:identity===worker?'Canonical worker':identity===reviewer?'Canonical reviewer':'Canonical observer',permissions:identity===other?[]:['accept_work','complete_work','verify']});
 const send=(who,type,data,id='canonical-'+serial++)=>{clock+=3000;return store.command(who.secret,roomId,{id,type,data});};
 const item=id=>store.workContext(owner.secret,roomId,id).work;
 const propose=(id,{review=false,accountable=worker.identityId}={})=>send(owner,'work.proposed',{workItemId:id,title:'Useful '+id,definitionOfDone:'A saved useful result',accountableMemberId:accountable,mode:'read',...(review?{independentVerificationRequired:true,verifierMemberId:reviewer.identityId}:{})});
 const finish=(id)=>{const body='Saved useful result '+id,posted=send(worker,'message.posted',{messageId:'result-'+id,workItemId:id,body});return {receipt:send(worker,'work.completed',{workItemId:id,expectedRevision:item(id).revision,evidenceKind:'room_text',evidenceMessageId:'result-'+id,evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),producerId:worker.identityId,previousCompletionEventId:null,summary:'Saved result',nextAction:'Review exact evidence'}),body,posted,version:textVersion(body)};};
 return {store,owner,worker,reviewer,other,roomId,send,item,propose,finish};
}
export function drainCanonicalNeedsMe(store,identity,options={}){
 let page=collectNeedsMe(store,identity.secret,options),calls=1;const items=[...page.items];
 while(page.hasMore){assert.ok(calls++<200,'finite fixture source must complete with committed continuations');page=collectNeedsMe(store,identity.secret,{...options,since:page.cursor});items.push(...page.items);}
 return {page,items,calls};
}
