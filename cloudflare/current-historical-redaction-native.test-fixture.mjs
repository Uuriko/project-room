import assert from 'node:assert/strict';
import {ProjectRoom} from './room.mjs';
import {seedHistoricalRedactionSource} from '../tests/helpers/historical-redaction-source.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
export class HistoricalPrivacyRoom extends ProjectRoom {
 async fetch(request){
  const u=new URL(request.url),s=this.store,db=s.db;
  const original=()=>db.prepare("SELECT id,counts_json FROM operator_actions WHERE action IN ('legacy_session_backfill_reconciled','legacy_session_replay_lookup') ORDER BY id").all();
  try{
   if(u.pathname==='/__seed'){const f=seedHistoricalRedactionSource(s);await this.ctx.storage.put({owner:f.key,worker:f.workerKey,original:f.original});return Response.json({key:f.key,workerKey:f.workerKey,head:f.head,prefix:f.repair.replayContract.throughSequence});}
   s.room=()=>{throw Error('whole room hydration');};
   if(u.pathname==='/__export'){auditRecovery(s);return new Response(exportNdjsonText(db));}
   if(u.pathname==='/__audit'){auditRecovery(s);let leaks=0;for(const table of ['events','messages','operator_actions','current_room_records'])for(const row of db.prepare('SELECT * FROM '+table).all())for(const value of Object.values(row))if(String(value).includes('sensitive-prefix-'))leaks++;
    return Response.json({leaks,original:original(),proofs:db.prepare("SELECT action,count(*) n,sum(length(CAST(counts_json AS BLOB))) bytes FROM operator_actions WHERE action IN ('historical_replay_privacy_basis','historical_replay_erased') GROUP BY action ORDER BY action").all()});}
   if(u.pathname==='/__erase'){
    const id=u.searchParams.get('id'),who=u.searchParams.get('who')??'owner',key=await this.ctx.storage.get(who),command={id:'erase-'+id,type:'message.deleted',data:{messageId:id,expectedMessageRevision:id==='prefix-one'?1:0,reason:'Authorized removal'}},prepare=db.prepare.bind(db),observe=db.observeStatement,tables=['rooms','events','commands','messages','work_entities','current_room_records','current_room_record_proofs','current_room_head','operator_actions'],snapshot=()=>JSON.stringify(Object.fromEntries(tables.map(table=>[table,prepare('SELECT * FROM '+table).all()])));
    const before=u.searchParams.has('fault')?snapshot():null,cost={statements:0,rowsRead:0,rowsWritten:0,unknown:0};let fired=false,response,body;const start=performance.now();
    db.observeStatement=()=>sample=>{cost.statements++;for(const field of ['rowsRead','rowsWritten'])if(sample[field]===null)cost.unknown++;else cost[field]+=sample[field];};
    db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);statement.run=(...args)=>{const result=run(...args);if(u.searchParams.has('fault')&&args[2]==='historical_replay_erased'){fired=true;throw Error('Native historical privacy receipt save fault');}return result;};return statement;};
    try{response=await super.fetch(new Request('https://room.example.test/api/rooms/legacy-room/commands',{method:'POST',headers:{host:'room.example.test','x-room-visitor-ip':'192.0.2.1',origin:'https://room.example.test',authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(command)}));body=await response.json();}
    finally{db.prepare=prepare;db.observeStatement=observe;}
    if(before)assert.equal(snapshot(),before);
    return Response.json({status:response.status,body,cost,clockMs:performance.now()-start,fired,unchanged:before?before===snapshot():null},{status:u.searchParams.has('lost')?503:200});
   }
   return super.fetch(request);
  }catch(error){return Response.json({error:{code:error.code,message:error.message,stack:error.stack}},{status:error.status??500});}
 }
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'source';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
