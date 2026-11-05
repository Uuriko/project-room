import {ProjectRoom} from './room.mjs';
import {seedHistoricalRedactionSource} from '../tests/helpers/historical-redaction-source.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
export class TextRecoveryRoom extends ProjectRoom {
 async fetch(request){
  const u=new URL(request.url),s=this.store,db=s.db;
  try{
   if(u.pathname==='/__seed'){
    const f=seedHistoricalRedactionSource(s);let now=s.now();s.now=()=>now;for(let n=0;n<70;n++){now+=3000;s.command(f.key,'legacy-room',{id:'text-background-'+n,type:'message.posted',data:{messageId:'text-background-'+n,body:'Unrelated retained context '+n}});}now+=3000;
    s.command(f.key,'legacy-room',{id:'withdraw-native-text',type:'message.deleted',data:{messageId:'saved-modern-result',expectedMessageRevision:0}});auditRecovery(s);return Response.json({events:s.headSequence('legacy-room')});
   }
   s.room=()=>{throw Error('whole room hydration');};
   if(u.pathname==='/__export'){auditRecovery(s);return new Response(exportNdjsonText(db));}
   if(u.pathname==='/__progress')return Response.json(restoreProgress(db));
   if(u.pathname==='/__poison'){
    const state=restoreProgress(db);withRestoreTransaction(s,()=>withRestoreAuditRows(db,state.restore_id,scratch=>{const work=scratch.get('actual','legacy-room','workBody','task');work.receipt.summary='substituted native receipt';scratch.set('actual','legacy-room','workBody','task',work);}));return Response.json({poisoned:true});
   }
   const prepare=db.prepare.bind(db),observe=db.observeStatement,cost={statements:0,rowsRead:0,rowsWritten:0,unknown:0};let fired=false;
   db.observeStatement=()=>sample=>{cost.statements++;for(const field of ['rowsRead','rowsWritten'])if(sample[field]===null)cost.unknown++;else cost[field]+=sample[field];};
   if(u.searchParams.has('fault'))db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);if(/^UPDATE current_restore_admission SET phase=/.test(sql))statement.run=(...args)=>{run(...args);fired=true;throw Error('text result checkpoint interrupted');};return statement;};
   const start=performance.now();let response;
   try{response=await super.fetch(request);}finally{db.prepare=prepare;db.observeStatement=observe;}
   const body=await response.json();return Response.json({status:response.status,body,cost,clockMs:performance.now()-start,fired});
  }catch(error){return Response.json({error:{message:error.message,stack:error.stack}},{status:error.status??500});}
 }
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'source';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
