import {ProjectRoom} from './room.mjs';
import {seedRecoveryWorkHelpSource} from '../tests/helpers/recovery-work-help-source.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
export class HelpRecoveryRoom extends ProjectRoom {
 async fetch(request){
  const u=new URL(request.url),s=this.store,db=s.db;
  try{
   if(u.pathname==='/__seed'){seedRecoveryWorkHelpSource(s,{extraOffers:12});return Response.json({events:s.headSequence('legacy-room'),helps:13,offers:14});}
   s.room=()=>{throw Error('whole room hydration');};
   if(u.pathname==='/__export'){auditRecovery(s);return new Response(exportNdjsonText(db));}
   if(u.pathname==='/__progress')return Response.json(restoreProgress(db));
   if(u.pathname==='/__poison'){
    const state=restoreProgress(db);withRestoreTransaction(s,()=>withRestoreAuditRows(db,state.restore_id,scratch=>{const offer=scratch.get('history','legacy-room','helpOffer','first-offer');if(!offer)throw Error('No qualified offer yet');scratch.set('history','legacy-room','helpIdentity',JSON.stringify([offer.workItemId,offer.invitation.eventId,offer.offererId]),'wrong-offer');}));return Response.json({poisoned:true});
   }
   const prepare=db.prepare.bind(db),observe=db.observeStatement,cost={statements:0,rowsRead:0,rowsWritten:0,unknown:0};let fired=false;
   const snapshot=()=>JSON.stringify({progress:restoreProgress(db),scratch:prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all()});
   const before=u.searchParams.has('fault')?snapshot():null;
   db.observeStatement=()=>sample=>{cost.statements++;for(const field of ['rowsRead','rowsWritten'])if(sample[field]===null)cost.unknown++;else cost[field]+=sample[field];};
   if(u.searchParams.has('fault'))db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);if(sql.startsWith('INSERT INTO current_restore_audit_scratch'))statement.run=(...args)=>{const result=run(...args);if(args[3]==='helpOffer'){fired=true;throw Error('help offer and index save interrupted');}return result;};return statement;};
   const start=performance.now();let response;try{response=await super.fetch(request);}finally{db.prepare=prepare;db.observeStatement=observe;}
   const body=await response.json();return Response.json({status:response.status,body,cost,clockMs:performance.now()-start,fired,unchanged:fired?before===snapshot():null});
  }catch(error){return Response.json({error:{message:error.message,stack:error.stack}},{status:error.status??500});}
 }
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'source';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
