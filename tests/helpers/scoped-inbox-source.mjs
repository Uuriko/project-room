import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
import {linkWithProof} from './link-with-proof.mjs';
export function seedScopedInbox(store){
 const identity=store.identities.create('Scoped worker'),events=initialRoom(),add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
 for(const id of ['worker','other','third','observer'])add('member.added',{memberId:id,displayName:id==='worker'?'Worker':id,kind:'agent',permissions:['accept_work','complete_work'],...(id==='worker'?{identityId:identity.identityId}:{})});
 add('work.proposed',{workItemId:'assigned',title:'Assigned useful work',definitionOfDone:'Saved result',accountableMemberId:'worker'});
 add('work.accepted',{workItemId:'assigned',expectedRevision:0},'worker');add('work.started',{workItemId:'assigned',expectedRevision:1},'worker');
 add('work.proposed',{workItemId:'waiting',title:'Pending useful work',definitionOfDone:'Saved result',accountableMemberId:'worker'});
 add('message.posted',{messageId:'mine',body:'A selected question'},'worker');
 add('message.posted',{messageId:'mine-2',body:'Second selected question'},'worker');
 while(events.length<42)add('message.posted',{messageId:'old-'+events.length,body:'Older harmless context'});
 store.initialize(events,{representation:'normalized-current-v1'});const owner=store.issueAccessKey('commons','owner');
 linkWithProof(store,owner,'commons',identity,{memberId:'worker',permissions:['accept_work','complete_work']});
 const scopes=['inbox:read','rooms:read','rooms:write','heartbeats:report','heartbeats:read'],issued=store.agentPlugin.issueApiKey({identityId:identity.identityId,scopes,expiresAt:store.now()+3600000});
 const send=(id,data)=>store.command(owner,'commons',{id,type:'message.posted',data:{messageId:id,...data}});
 send('mention',{body:'@Worker please inspect the useful result'});send('dm',{body:'@Worker private instruction',toMemberId:'worker',requestKind:'reply'});send('reply',{body:'@Worker reply to your question',replyToId:'mine'});send('overlap',{body:'@Worker another direct ask',toMemberId:'worker',replyToId:'mine-2'});send('hidden',{body:'PRIVATE-OTHER-PAIR',toMemberId:'other'});
 return{token:'rak_'+issued.secret,keyId:issued.keyId,identityId:identity.identityId,owner,after:42};
}
