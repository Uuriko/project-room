import {CurrentAttachmentsRoom} from './current-attachments-worker.test-fixture.mjs';
import {prepareSupersession} from '../tests/helpers/current-work-supersession.mjs';
import {textVersion} from '../server/text-results.mjs';
export class CurrentSupersessionRoom extends CurrentAttachmentsRoom {
 async fetch(request) {
  const path=new URL(request.url).pathname,s=this.store,db=this.db,before={...this.stats},rawBefore={...this.raw};
  const cost=()=>({...Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),rawRuntime:Object.fromEntries(Object.keys(rawBefore).map(k=>[k,this.raw[k]-rawBefore[k]]))});
  const item=id=>JSON.parse(db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('commons',id).body);
  try {
   if(path==='/prepare'){const f=prepareSupersession(s,{privateSource:true});await this.ctx.storage.put({keys:f.keys,request:f.command(),old:item('original')});return Response.json({ready:true});}
   const keys=await this.ctx.storage.get('keys'),command=await this.ctx.storage.get('request');
   s.room=()=>{throw Error('legacy room hydration');};s.workClaims.set=()=>{throw Error('legacy mirror');};
   if(path==='/supersede') {const result=s.command(keys.owner,'commons',command);return Response.json({result,cost:cost(),old:item('original'),replacement:item('successor')});}
   if(path==='/unauthorized'){const counts=()=>({ledger:db.prepare('SELECT count(*) n FROM operator_actions').get().n,commands:db.prepare('SELECT count(*) n FROM commands').get().n,head:db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence});const persistedBefore=counts();let status=null;try{s.command(keys.other,'commons',command);}catch(e){status=e.status;}return Response.json({status,persistedBefore,persistedAfter:counts(),cost:cost()});}
   if(path==='/resume') {
    const cmd=(who,id,type,data)=>s.command(keys[who],'commons',{id,type,data});
    cmd('replacement','accept','work.accepted',{workItemId:'successor',expectedRevision:0});cmd('replacement','start','work.started',{workItemId:'successor',expectedRevision:1});
    const body='Useful resumed result',post=cmd('replacement','result','message.posted',{messageId:'result',body,workItemId:'successor'}),version=textVersion(body);
    const completion=cmd('replacement','complete','work.completed',{workItemId:'successor',expectedRevision:2,evidenceKind:'room_text',evidenceMessageId:'result',evidenceMessageEventId:post.event.id,evidenceVersion:version,producerId:'replacement',previousCompletionEventId:null,summary:'Saved resumed work',nextAction:'Independent review'});
    const context=s.workContext(keys.replacement,'commons','original',{includeSource:true});
    return Response.json({old:item('original'),replacement:item('successor'),privateLeak:JSON.stringify(context).includes('Private previous contract'),completionEventId:completion.event.id,version,cost:cost()});
   }
   return new Response('not found',{status:404});
  }catch(e){return Response.json({code:e.code,message:e.message,cost:cost()},{status:e.status??500});}
 }
}
export default{fetch(request,env){return env.ROOM.getByName('supersession').fetch(request);}};
