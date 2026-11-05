import entry,{DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {withRestoreTransaction} from '../server/restore-admission.mjs';
export class DurableCoverageRoom extends Base {
 constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;this.lastCost=null;}
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/__report-t0')return Response.json(withRestoreTransaction(this.store,()=>auditRecovery(this.store)));
  if(path==='/__report-cost')return Response.json(this.lastCost);
  if(path==='/__report-workspace')return Response.json({rows:this.store.db.prepare('SELECT count(*) n FROM current_restore_audit_scratch').get().n});
  if(request.headers.get('x-report-measure')!=='1')return super.fetch(request);
  const exec=this.sql.exec.bind(this.sql),records=[];
  this.sql.exec=(sql,...params)=>{const cursor=exec(sql,...params),record={sql,cursor,bytes:0};records.push(record);const charge=rows=>{for(const row of rows)record.bytes+=new TextEncoder().encode(JSON.stringify(row)).length;return rows;};return new Proxy(cursor,{get(o,k){if(k==='toArray')return()=>charge(o.toArray());if(k===Symbol.iterator)return function*(){for(const row of o){charge([row]);yield row;}};const value=Reflect.get(o,k,o);return typeof value==='function'?value.bind(o):value;}});};
  try{return await super.fetch(request);}finally{
   this.sql.exec=exec;this.lastCost={statements:records.length,rowsRead:0,rowsWritten:0,bytes:0,drops:0,unknown:0};
   for(const r of records){const read=r.cursor.rowsRead,write=r.cursor.rowsWritten;if(!Number.isSafeInteger(read)||!Number.isSafeInteger(write))this.lastCost.unknown++;this.lastCost.rowsRead+=read??0;this.lastCost.rowsWritten+=write??0;this.lastCost.bytes+=r.bytes;if(r.sql.startsWith('DROP TRIGGER '))this.lastCost.drops++;}
   const groups=new Map();for(const r of records){const sql=r.sql.replace(/\s+/g,' ').trim(),g=groups.get(sql)??{sql,statements:0,rowsRead:0,rowsWritten:0,bytes:0};g.statements++;g.rowsRead+=r.cursor.rowsRead??0;g.rowsWritten+=r.cursor.rowsWritten??0;g.bytes+=r.bytes;groups.set(sql,g);}this.lastCost.topRows=[...groups.values()].sort((a,b)=>b.rowsRead-a.rowsRead).slice(0,8);this.lastCost.topBytes=[...groups.values()].sort((a,b)=>b.bytes-a.bytes).slice(0,5);

  }
 }
}
export default entry;
