import {seedPostOAuth} from './work-linked-post-oauth.mjs';
import {textVersion} from '../../server/text-results.mjs';
export function seedOAuthWorkRead(store){
 const saved=seedPostOAuth(store,{permissions:['accept_work','complete_work'],scopes:['rooms:read','chat:read','work:read'],memberPermissions:{verifier:['verify']}});
 const send=(id,type,data,token=saved.identitySecret)=>store.command(token,'commons',{id,type,data});
 send('accept','work.accepted',{workItemId:'task',expectedRevision:0});send('start','work.started',{workItemId:'task',expectedRevision:1});
 const body='Saved useful result. '.repeat(80),post=send('saved-result','message.posted',{messageId:'saved-result',body,workItemId:'task'}),evidenceVersion=textVersion(body);
 const completed=send('completed','work.completed',{workItemId:'task',expectedRevision:2,evidenceKind:'room_text',evidenceMessageId:'saved-result',evidenceMessageEventId:post.event.id,evidenceVersion,previousCompletionEventId:null,producerId:saved.identityId,summary:'Saved exact result',nextAction:'Independent review'});
 send('verified','verification.recorded',{workItemId:'task',expectedRevision:3,result:'pass',completionEventId:completed.event.id,evidenceVersion,summary:'Independent verification'},store.issueAccessKey('commons','verifier'));
 send('second-task','work.proposed',{workItemId:'other-task',title:'Unrelated work',definitionOfDone:'Other saved result',accountableMemberId:'observer'},saved.owner);
 for(let i=0;i<12;i++)send('later-'+i,'message.posted',{messageId:'later-'+i,body:'Later room conversation'},saved.owner);
 return{...saved,body,completionEventId:completed.event.id};
}
