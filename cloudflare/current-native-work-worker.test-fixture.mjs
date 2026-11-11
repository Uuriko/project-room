import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
const delta=(a,b)=>Object.fromEntries(Object.keys(b).map(k=>[k,a[k]-b[k]]));
export class NativeWorkProbe extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.stats={statements:0,rowsRead:0,rowsWritten:0,unknown:0};this.sqlErrors=[];this.raw={statements:0,rowsWritten:0,unknown:0};
  const native=ctx.storage.sql,exec=native.exec.bind(native),sql=new Proxy(native,{get:(target,key)=>{if(key==='exec')return(query,...args)=>{let cursor;try{cursor=exec(query,...args);}catch(error){this.sqlErrors.push({sql:query,message:error.message});throw error;}if(/^UPDATE room_writer_permit SET version=/.test(query)){this.raw.statements++;if(Number.isSafeInteger(cursor.rowsWritten))this.raw.rowsWritten+=cursor.rowsWritten;else this.raw.unknown++;}return cursor;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const storage=new Proxy(ctx.storage,{get:(target,key)=>{if(key==='sql')return sql;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  this.db=new DurableDatabase(storage,{observeStatement:()=>sample=>{this.stats.statements++;this.stats.rowsRead+=sample.rowsRead??0;this.stats.rowsWritten+=sample.rowsWritten??0;if(sample.rowsRead===null||sample.rowsWritten===null)this.stats.unknown++;}});this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:'deferred'});this.startup={...this.stats};
 }
 traceQueries(){if(this.tracing)return;this.tracing=true;this.byQuery=new Map();const db=this.db,prepare=db.prepare.bind(db),observe=db.observeStatement;
  db.prepare=query=>new Proxy(prepare(query),{get:(target,key)=>{const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;if(!['get','all','run'].includes(key))return value.bind(target);return(...args)=>{const previous=this.activeQuery;this.activeQuery=query;try{return value.apply(target,args);}finally{this.activeQuery=previous;}};}});
  db.observeStatement=()=>{const query=this.activeQuery,finish=observe();return sample=>{finish(sample);if(query){const row=this.byQuery.get(query)??{rowsRead:0,rowsWritten:0,calls:0};row.rowsRead+=sample.rowsRead??0;row.rowsWritten+=sample.rowsWritten??0;row.calls++;this.byQuery.set(query,row);}};};
 }

 async fetch(request){this.traceQueries();this.byQuery.clear();const u=new URL(request.url),s=this.store,db=this.db,before={...this.stats},rawBefore={...this.raw};
  try{let result,operationCost,operationRuntime,operationQueries;
   if(u.pathname==='/seed'){
    const count=Number(u.searchParams.get('count'));if(![32,128,500].includes(count))throw Error('invalid count');const events=initialRoom();
    for(let i=0;i<count;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'task-'+String(i).padStart(4,'0'),title:'Useful '+i,definitionOfDone:'Saved useful evidence',mode:'read',accountableMemberId:'owner'}}));
    for(let i=0;i<Number(u.searchParams.get('active')??0);i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.accepted',data:{workItemId:'task-'+String(i).padStart(4,'0'),expectedRevision:0}}));
    s.initialize(events,{representation:'normalized-current-v1'});await this.ctx.storage.put('key',s.issueAccessKey('commons','owner'));result={count};
   }else if(u.pathname==='/accept'){
    s.room=()=>{throw Error('whole room hydration');};const key=await this.ctx.storage.get('key'),id=u.searchParams.get('id')??'task-0000';
    result=s.command(key,'commons',{id:'accept-'+id,type:'work.accepted',data:{workItemId:id,expectedRevision:0}});
   }else if(u.pathname==='/cap'){
    s.workClaims.configure('commons',{maxOpenClaims:Number(u.searchParams.get('cap')??1)});const key=await this.ctx.storage.get('key');
    const prior=db.prepare('SELECT count(*) n FROM events').get().n,audits=db.prepare('SELECT count(*) n FROM operator_actions').get().n;
    const commandStart={...this.stats},runtimeStart={...this.raw};this.byQuery.clear();
    try{s.command(key,'commons',{id:'refused-second',type:'work.accepted',data:{workItemId:u.searchParams.get('id')??'task-0001',expectedRevision:0}});result={unexpected:true};}catch(error){operationCost=delta(this.stats,commandStart);operationRuntime=delta(this.raw,runtimeStart);operationQueries=[...this.byQuery].map(([sql,counts])=>({sql,...counts}));result={code:error.code,eventsUnchanged:prior===db.prepare('SELECT count(*) n FROM events').get().n,auditUnchanged:audits===db.prepare('SELECT count(*) n FROM operator_actions').get().n};}
   }else throw Error('missing route');
   return Response.json({result,cost:operationCost??delta(this.stats,before),rawRuntime:operationRuntime??delta(this.raw,rawBefore),capacityQueries:(operationQueries??[...this.byQuery].map(([sql,counts])=>({sql,...counts}))).filter(row=>row.sql.includes('FROM current_room_records INDEXED BY current_native_capacity_')),topQueries:(operationQueries??[...this.byQuery].map(([sql,counts])=>({sql,...counts}))).sort((a,b)=>b.rowsRead-a.rowsRead).slice(0,8),legacyClaims:db.prepare('SELECT count(*) n FROM work_claims').get().n,startup:this.startup});
  }catch(error){return Response.json({error:{message:error.message,stack:error.stack},cost:delta(this.stats,before),rawRuntime:delta(this.raw,rawBefore)},{status:500});}
 }
}
export default{fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'small').fetch(request);}};
