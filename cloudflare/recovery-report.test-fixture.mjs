import {initialRecoveryReportRow,advanceRecoveryReportRow} from '../server/recovery-report-source.mjs';
import {DurableDatabase} from './storage.mjs';
import {createHash} from 'node:crypto';
// Disposable algorithm qualification. NOT the production restore endpoint.
import {DurableObject} from 'cloudflare:workers';
import {initialRecoveryReportTable,appendRecoveryReportChunk,sealRecoveryReportTable,advanceRecoveryReportTable,recoveryReportTableResult,REPORT_CHUNK_UNITS} from '../server/recovery-report-continuation.mjs';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
export class ReportFixture extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;this.db=new DurableDatabase(ctx.storage);this.sql.exec('CREATE TABLE IF NOT EXISTS scratch(lane TEXT,room TEXT,domain TEXT,key TEXT,part INTEGER,payload_bytes INTEGER,payload TEXT,PRIMARY KEY(lane,room,domain,key,part))');this.sql.exec('CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY,payload TEXT)');}
 async fetch(request){
  const url=new URL(request.url),records=[];let writes=0;
  const query=(sql,...params)=>{const c=this.sql.exec(sql,...params),rows=c.toArray();records.push({statements:1,rowsRead:c.rowsRead,rowsWritten:c.rowsWritten,bytes:new TextEncoder().encode(JSON.stringify(rows)).length});return rows;};
  const scratch={get remaining(){return 128-writes;},get:(l,r,d,k,p=0)=>{const size=query('SELECT payload_bytes,length(CAST(payload AS BLOB)) bytes FROM scratch WHERE lane=? AND room=? AND domain=? AND key=? AND part=?',l,r,d,k,p)[0];if(!size)return undefined;if(size.bytes!==size.payload_bytes||size.bytes>133120)throw Error('bad size');return JSON.parse(query('SELECT payload FROM scratch WHERE lane=? AND room=? AND domain=? AND key=? AND part=?',l,r,d,k,p)[0].payload);},set:(l,r,d,k,v,p=0)=>{const payload=JSON.stringify(v);writes++;query('INSERT INTO scratch VALUES(?,?,?,?,?,?,?) ON CONFLICT(lane,room,domain,key,part) DO UPDATE SET payload_bytes=excluded.payload_bytes,payload=excluded.payload',l,r,d,k,p,new TextEncoder().encode(payload).length,payload);}};
  if(url.pathname==='/source-init'){
   this.sql.exec('CREATE TABLE IF NOT EXISTS input(z TEXT,a TEXT,n REAL,b BLOB)');this.sql.exec('DELETE FROM input');
   const text='🦉中é\u0000'.repeat(80000),blob=new Uint8Array(4096);this.sql.exec('INSERT INTO input VALUES(?,?,?,?)',text,'quoted \" \\ and BOM \ufeff',1e-7,blob);
   const row=this.db.prepare('SELECT * FROM input').get(),expected=createHash('sha256').update(canonical(row)).digest('hex'),id=this.db.prepare('SELECT rowid AS rid FROM input').get().rid;
   const state=initialRecoveryReportRow(this.db,'input',id,2*1024*1024);this.sql.exec('INSERT OR REPLACE INTO control VALUES(2,?)',JSON.stringify(state));return Response.json({expected,blobKind:row.b.constructor.name});
  }
  if(url.pathname==='/source-step'){
   const state=JSON.parse(this.sql.exec('SELECT payload FROM control WHERE id=2').one().payload),exec=this.sql.exec.bind(this.sql),observed=[];
   this.sql.exec=(sql,...params)=>{const cursor=exec(sql,...params),record={cursor,bytes:0};observed.push(record);return new Proxy(cursor,{get(o,k){if(k==='toArray')return()=>{const rows=o.toArray();record.bytes+=new TextEncoder().encode(JSON.stringify(rows)).length;return rows;};const v=Reflect.get(o,k,o);return typeof v==='function'?v.bind(o):v;}});};
   let result;try{result=advanceRecoveryReportRow(this.db,state);}finally{this.sql.exec=exec;}
   this.sql.exec('UPDATE control SET payload=? WHERE id=2',JSON.stringify(result.state));const cost=observed.reduce((a,r)=>({statements:a.statements+1,rowsRead:a.rowsRead+r.cursor.rowsRead,rowsWritten:a.rowsWritten+r.cursor.rowsWritten,bytes:a.bytes+r.bytes}),{statements:0,rowsRead:0,rowsWritten:0,bytes:0});
   return Response.json({chunk:result.chunk,last:result.last,cost});
  }
  if(url.pathname==='/init'){
   this.sql.exec('DELETE FROM scratch');const n=Number(url.searchParams.get('n'));let state=initialRecoveryReportTable('fixture');
   // Source fixture setup intentionally materializes one row; this does NOT
   // qualify the as-yet-unimplemented production source encoder.
   for(let i=0;i<n;i++){const row={id:n-i,body:i<2?'x'.repeat(160000)+'🦉':'item'+String(i%17),value:i%3};const text=canonical(row);for(let offset = 0; offset < text.length; offset += REPORT_CHUNK_UNITS){writes=0;state=appendRecoveryReportChunk(scratch,state,text.slice(offset, offset + REPORT_CHUNK_UNITS),offset + REPORT_CHUNK_UNITS >= text.length);}}
   state=sealRecoveryReportTable(state);this.sql.exec('INSERT OR REPLACE INTO control VALUES(1,?)',JSON.stringify(state));return Response.json({ready:true});
  }
  let state=JSON.parse(this.sql.exec('SELECT payload FROM control WHERE id=1').one().payload);const step=advanceRecoveryReportTable(scratch,state);state=step.state;this.sql.exec('UPDATE control SET payload=? WHERE id=1',JSON.stringify(state));
  const cost=records.reduce((a,r)=>{for(const k of Object.keys(a))a[k]+=r[k];return a;},{statements:0,rowsRead:0,rowsWritten:0,bytes:0});
  return Response.json({state:state.stage,units:step.units,cost,result:state.stage==='complete'?recoveryReportTableResult(state):null});
 }
}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('fixture')).fetch(request);}};
