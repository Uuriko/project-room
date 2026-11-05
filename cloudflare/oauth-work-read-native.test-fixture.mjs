import {WorkLinkedPostRoom} from './work-linked-post-native.test-fixture.mjs';
import {seedOAuthWorkRead} from '../tests/helpers/oauth-work-read-source.mjs';
import {providerFor,resource} from '../tests/helpers/work-linked-post-oauth.mjs';
import {runMcpOAuthRequest,resolveMcpOAuthPrincipal} from '../server/mcp-oauth.mjs';
import {callHostedStdioTool} from '../server/mcp-full-profile.mjs';
import {readWorkSelection} from '../client/work-preparation.mjs';
export class OAuthWorkReadRoom extends WorkLinkedPostRoom {
 async fetch(request){
  const path=new URL(request.url).pathname,s=this.store;
  try{
   if(path==='/seed'){await this.ctx.storage.put('workRead',seedOAuthWorkRead(s));return Response.json({members:s.db.prepare("SELECT count(*) n FROM current_room_records WHERE domain='members'").get().n});}
   const saved=await this.ctx.storage.get('workRead');s.room=()=>{throw Error('whole-room hydration');};
   const inputBefore={...this.input},before={...this.stats},rawBefore={...this.raw},started=performance.now();
   // Match hosted MCP's principal resolution before the tool's read transaction.
   const auth={store:s,provider:providerFor(s),token:saved.token,resource,roomId:'commons'};
   if(!resolveMcpOAuthPrincipal({...auth,requiredScopes:['rooms:read','chat:read','work:read']}))throw Error('OAuth principal refused');
   const value=await runMcpOAuthRequest(auth,()=>path.startsWith('/messages')?callHostedStdioTool(s,saved.token,'room_read_messages',{roomId:'commons',limit:path==='/messages-query'?100:1,...(path==='/messages-latest'?{latest:true}:{after:0}),...(path==='/messages-query'?{query:'LaTeR'}:{})}).then(r=>{if(r.isError)throw Error(JSON.stringify(r.value));return r.value;}):readWorkSelection({
    workContext:(id,options)=>s.workContext(saved.token,'commons',id,options),
    workResult:(id,options)=>s.workResult(saved.token,'commons',id,options)
   },path==='/batch'?{workItemIds:['task','other-task'],brief:true}:{workItemId:'task',brief:true,includeResult:true},{hosted:true}));
   return Response.json({value,cost:{...Object.fromEntries(Object.keys(inputBefore).map(k=>[k,this.input[k]-inputBefore[k]])),...Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),rawRuntime:Object.fromEntries(Object.keys(rawBefore).map(k=>[k,this.raw[k]-rawBefore[k]])),observedWorkerWallMs:performance.now()-started}});
  }catch(error){return Response.json({code:error.code,message:error.message},{status:error.status??500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName('oauth-work-read').fetch(request);}};
