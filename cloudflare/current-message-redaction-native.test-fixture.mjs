import assert from 'node:assert/strict';
import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
export class RedactionNativeRoom extends ProjectRoom {
 constructor(ctx,env){super(ctx,env);const storage=this.store.db.storage,native=storage.sql,exec=native.exec.bind(native),owner=this,observedExec=(query,...args)=>{const cursor=exec(query,...args),sample=owner.rawPermitSample;if(sample&&/^UPDATE room_writer_permit SET version=/.test(query)){sample.statements++;for(const key of ['rowsRead','rowsWritten'])if(Number.isSafeInteger(cursor[key]))sample[key]+=cursor[key];else sample.unknown++;}return cursor;},sql=new Proxy(native,{get(target,key){if(key==='exec')return observedExec;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});this.store.db.storage=new Proxy(storage,{get(target,key){if(key==='sql')return sql;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}

 async fetch(request) {
  const u=new URL(request.url),s=this.store,db=s.db;
  try {
   if(u.pathname==='/__seed') {
    const n=Number(u.searchParams.get('n')),es=initialRoom();
    for(const id of ['worker','other'])es.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind:'agent',permissions:[]}}));
    for(let i=0;i<n;i++)es.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'old-'+i,body:'Unrelated retained history '+i}}));
    es.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'private',toMemberId:'worker',body:'native-private-original-needle'}}));
    es.push(event({roomId:'commons',actorId:'owner',type:'message.edited',data:{messageId:'private',body:'native-private-current-needle',expectedMessageRevision:0}}));
    s.initialize(es,{representation:'normalized-current-v1'});
    for(const id of ['owner','worker','other'])await this.ctx.storage.put(id,s.issueAccessKey('commons',id));
    if(u.searchParams.has('archive'))s.command(await this.ctx.storage.get('owner'),'commons',{id:'archive-before-erasure',type:'room.archived',data:{reason:'Synthetic owner privacy qualification'}});
    return Response.json({n,key:await this.ctx.storage.get('owner')});
   }
   if(u.pathname==='/__export')return new Response(exportNdjsonText(db));
   if(u.pathname==='/__audit'){auditRecovery(s);return Response.json({verified:true});}
   s.room=()=>{throw Error('legacy full room hydration');};
   if(u.pathname==='/__check') {
    const row=db.prepare("SELECT body,record_json,reducer_extras_json FROM messages WHERE room_id='commons' AND message_id='private'").get();
    let leaks=0;for(const table of ['events','messages','current_room_records','work_entities'])for(const item of db.prepare('SELECT * FROM '+table).all())for(const value of Object.values(item))if(String(value).includes('native-private-'))leaks++;
    return Response.json({row,leaks,permit:db.prepare('SELECT enabled FROM current_room_writer_permit').get().enabled});
   }
   if(u.pathname==='/__read') {
    const token=await this.ctx.storage.get(u.searchParams.get('who')??'worker');
    const response=await super.fetch(new Request('https://room.example.test/api/rooms/commons/conversation?messageId=private',{headers:{host:'room.example.test','x-room-visitor-ip':'192.0.2.1',authorization:'Bearer '+token}}));
    return Response.json({status:response.status,body:await response.json()});
   }
   if(u.pathname==='/__delete') {
    const tables=['rooms','events','commands','messages','current_room_head','current_room_records','current_room_record_proofs','operator_actions'],snapshot=()=>JSON.stringify(Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table).all()])));
    const before=u.searchParams.has('fault')?snapshot():null,prepare=db.prepare.bind(db),observer=db.observeStatement;
    const cost={statements:0,rowsRead:0,rowsWritten:0,unknown:0,sourceRows:0,sourceBytes:0},queries=[],rawPermit={statements:0,rowsRead:0,rowsWritten:0,unknown:0};this.rawPermitSample=rawPermit;const started=performance.now();
    db.observeStatement=()=>sample=>{cost.statements++;for(const key of ['rowsRead','rowsWritten'])if(sample[key]===null)cost.unknown++;else cost[key]+=sample[key];};
    db.prepare=sql=>{
     const statement=prepare(sql);
     if(sql.includes('INDEXED BY current_redaction_message_events')){queries.push(sql);const iterate=statement.iterate.bind(statement);statement.iterate=function*(...args){for(const row of iterate(...args)){cost.sourceRows++;if(row.body)cost.sourceBytes+=Buffer.byteLength(row.body);yield row;}};}
     if(u.searchParams.has('fault')&&sql==='UPDATE events SET body=? WHERE room_id=? AND sequence=?'){const run=statement.run.bind(statement);statement.run=(...args)=>{run(...args);throw Error('native erasure interrupted');};}
     return statement;
    };
    let response,body;
    try {
     const token=await this.ctx.storage.get(u.searchParams.get('who')??'owner');
     response=await super.fetch(new Request('https://room.example.test/api/rooms/commons/commands',{method:'POST',headers:{'x-room-visitor-ip':'192.0.2.1',host:'room.example.test',origin:'https://room.example.test',authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:'native-delete-once',type:'message.deleted',data:{messageId:'private',expectedMessageRevision:1,reason:'remove'}})}));
     body=await response.json();
    }finally{db.prepare=prepare;db.observeStatement=observer;this.rawPermitSample=null;}
    if(before)assert.equal(snapshot(),before);
    return Response.json({status:response.status,body,cost,rawPermit,clockMs:performance.now()-started,sourceQueries:queries.length,sourcePlans:queries.map(sql=>db.prepare('EXPLAIN QUERY PLAN '+sql).all('commons','private').map(row=>row.detail)),unchanged:before?before===snapshot():null,lostAfterCommit:u.searchParams.has('lost')},{status:u.searchParams.has('lost')?503:200});
   }
   return super.fetch(request);
  }catch(error){return Response.json({message:error.message,stack:error.stack},{status:error.status??500});}
 }
}
export default {fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'source';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
