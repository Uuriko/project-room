import entry,{DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
export class DurableCoverageRoom extends Base{
 async fetch(request){const url=new URL(request.url),store=this.store;
  if(url.pathname==='/__pins-seed'){
   const n=Number(url.searchParams.get('n'));if(![1000,5000].includes(n))return new Response('Invalid size',{status:422});
   const events=initialRoom(),add=(type,data,actorId='owner')=>events.push(event({type,data,actorId,roomId:'commons'}));
   for(const memberId of ['alice','bob'])add('member.added',{memberId,displayName:memberId,kind:'human',permissions:[]});
   for(let i=0;i<n;i++)add('message.posted',{messageId:'irrelevant-'+i,body:'Unrelated coordination '+i});
   add('message.posted',{messageId:'target',body:'Useful pinned guidance'});store.initialize(events,{representation:'normalized-current-v1'});
   return Response.json({key:store.issueAccessKey('commons','owner')});
  }
  if(url.pathname==='/__pins-cost')return Response.json(this.lastCost);
  const sql=this.ctx.storage.sql,exec=sql.exec.bind(sql),rows=[];
  sql.exec=(text,...args)=>{const cursor=exec(text,...args),r={cursor,sql:text,bytes:0,carrierBytes:0};rows.push(r);const charge=row=>{r.bytes+=Buffer.byteLength(JSON.stringify(row));if(/^SELECT (?:r\.)?projection(?:,| FROM)/i.test(r.sql)&&typeof row.projection==='string')r.carrierBytes+=Buffer.byteLength(row.projection);return row;};return new Proxy(cursor,{get(o,k){if(k==='toArray')return()=>o.toArray().map(charge);if(k===Symbol.iterator)return function*(){for(const row of o)yield charge(row);};const v=Reflect.get(o,k,o);return typeof v==='function'?v.bind(o):v;}});};
  try{return await super.fetch(request);}finally{sql.exec=exec;this.lastCost={statements:rows.length,reads:0,writes:0,returnedBytes:0,unknown:0,carrierReads:rows.filter(r=>/^SELECT (?:r\.)?projection(?:,| FROM)/i.test(r.sql)).length,carrierBytes:rows.reduce((n,r)=>n+r.carrierBytes,0)};for(const r of rows){if(!Number.isSafeInteger(r.cursor.rowsRead)||!Number.isSafeInteger(r.cursor.rowsWritten))this.lastCost.unknown++;this.lastCost.reads+=r.cursor.rowsRead??0;this.lastCost.writes+=r.cursor.rowsWritten??0;this.lastCost.returnedBytes+=r.bytes;}}
 }
}
export default entry;
