import {httpServerHandler} from 'cloudflare:node';
import {WorkLinkedPostRoom} from './work-linked-post-native.test-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {historicalDiscussionEvents} from '../tests/helpers/current-discussion-large-openings.mjs';
export class CurrentWorkDiscussionRoom extends WorkLinkedPostRoom{
 async fetch(request){
  const url=new URL(request.url),s=this.store;
  try{
   if(url.pathname==='/seed-historical'){
    const source=historicalDiscussionEvents();s.initialize(source.events,{representation:'normalized-current-v1'});
    await this.ctx.storage.put('key',s.issueAccessKey('commons','reader'));return Response.json({since:source.since,sequence:s.headSequence('commons')});
   }
   if(url.pathname==='/seed'){
    const n=Number(url.searchParams.get('n')),hidden=url.searchParams.get('hidden')==='1';if(![1000,5000].includes(n))throw Error('Invalid fixture size');
    const events=initialRoom(),add=(id,type,data,actorId='owner')=>events.push(event({id,roomId:'commons',actorId,type,data}));
    add('reader','member.added',{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]});
    add('other','member.added',{memberId:'other',displayName:'Other',kind:'agent',permissions:[]});
    add('source','message.posted',{messageId:'source',body:'Task source'});
    add('task','work.proposed',{workItemId:'task',title:'Selected work',definitionOfDone:'Read selected conversation',sourceMessageId:'source',accountableMemberId:'reader',independentVerificationRequired:false,ownerDecisionRequired:false});
    for(let i=0;i<n;i++)add('unrelated-'+i,'message.posted',{messageId:'unrelated-'+i,body:hidden?'PRIVATE-'+i:'Unrelated room conversation',...(hidden?{toMemberId:'other'}:{})});
    add('linked','message.posted',{messageId:'linked',body:'Useful linked result',workItemId:'task'});
    s.initialize(events,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','reader');await this.ctx.storage.put('key',key);
    return Response.json({sequence:s.headSequence('commons'),key});
   }
   s.room=()=>{throw Error('Whole-room hydration');};
   const before={...this.stats},input={...this.input},raw={...this.raw},started=performance.now(),key=await this.ctx.storage.get('key');
   this.discussionHttp??=httpServerHandler(createRoomServer({store:s,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No assets');}}));
   const query=url.searchParams;query.delete('surface');
   const response=await this.discussionHttp.fetch(new Request('http://localhost/api/rooms/commons/work-discussion?workItemId=task&limit=2&'+query,{headers:{host:'localhost',authorization:'Bearer '+key}}));
   return Response.json({status:response.status,page:await response.json(),cost:{...Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),...Object.fromEntries(Object.keys(input).map(k=>[k,this.input[k]-input[k]])),rawRuntime:Object.fromEntries(Object.keys(raw).map(k=>[k,this.raw[k]-raw[k]])),observedWorkerWallMs:performance.now()-started}});
  }catch(error){return Response.json({code:error.code,message:error.message},{status:error.status??500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'small').fetch(request);}};
