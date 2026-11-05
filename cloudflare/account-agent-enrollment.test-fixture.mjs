// Disposable Native qualification routes, never deployed.
import {DurableObject} from 'cloudflare:workers';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {seedAccountAgentEnrollment,enrollmentResource} from '../tests/helpers/account-agent-enrollment-source.mjs';
import {createAccountAgentEnrollment} from '../server/account-agent-enrollment.mjs';
import {listMcpOAuthAgents,validateMcpOAuthBinding} from '../server/mcp-oauth.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {replayNdjsonInto} from '../server/restore-ndjson.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export class AccountEnrollmentRoom extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});}
 async fetch(request){const s=this.store,path=new URL(request.url).pathname;
  try{
   if(path==='/seed'){
    const f=seedAccountAgentEnrollment(s),sourceDigest=hash(JSON.stringify(s.db.prepare("SELECT * FROM agent_connections WHERE room_id='source'").all()));
    await this.ctx.storage.put('enrollment',{slot:f.slot,binding:f.binding,identityId:f.identity.identityId,request:f.request,sourceDigest});
    return Response.json({request:f.request,identityId:f.identity.identityId});
   }
   if(path==='/restore'){
    const result=replayNdjsonInto(await request.text(),s);auditRecovery(s);
    return Response.json({verified:result.verified,proofs:s.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='account_agent_enrollment_v1'").get().n});
   }
   const f=await this.ctx.storage.get('enrollment');
   if(path==='/execute'||path==='/fault'){
    const input=await request.json(),prepare=s.db.prepare.bind(s.db);let fired=false;
    if(path==='/fault')s.db.prepare=sql=>{const st=prepare(sql);if(!sql.startsWith('INSERT INTO agent_connection_operations'))return st;return new Proxy(st,{get(target,key){const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;return(...args)=>{const result=value.apply(target,args);if(args[0]==='target'){fired=true;throw Error('synthetic Native enrollment save fault');}return result;};}});};
    try{
     const service=createAccountAgentEnrollment({store:s,resource:enrollmentResource,enabled:true}),result=service.apply(f.slot.token,'target',input,f.binding);
     return Response.json(result);
    }catch(error){if(!fired)throw error;return Response.json({faulted:true,targetLinks:s.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,proofs:s.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='account_agent_enrollment_v1'").get().n},{status:500});}
    finally{s.db.prepare=prepare;}
   }
   if(path==='/archive'){s.command(f.slot.token,'source',{id:'native-archive-source',type:'room.archived',data:{reason:'Synthetic cutover'}},f.binding);return Response.json({archived:true});}
   if(path==='/export')return new Response(exportNdjsonText(s.db));
   if(path==='/facts'){
    const report=auditRecovery(s),target=listMcpOAuthAgents(s,'john',enrollmentResource).find(choice=>choice.binding.roomId==='target');
    return Response.json({audit:report.ok,identityCount:s.db.prepare('SELECT count(*) n FROM agent_identities').get().n,targetLinks:s.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,
     sourceUnchanged:hash(JSON.stringify(s.db.prepare("SELECT * FROM agent_connections WHERE room_id='source'").all()))===f.sourceDigest,
     targetBinding:!!target&&!!validateMcpOAuthBinding(s,'john',target.binding),identityId:target?.binding.identityId,
     proofs:s.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='account_agent_enrollment_v1'").get().n});
   }
   return new Response('Not found',{status:404});
  }catch(error){return Response.json({error:{code:error.code??null,message:error.message}},{status:error.status??500});}
 }
}
export default{fetch(request,env){const url=new URL(request.url);return env.ROOM.getByName(url.searchParams.get('instance')??'enrollment').fetch(request);}};
