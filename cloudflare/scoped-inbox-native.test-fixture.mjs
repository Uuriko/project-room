import entry,{DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
import {seedScopedInbox} from '../tests/helpers/scoped-inbox-source.mjs';
export class DurableCoverageRoom extends Base{
 async fetch(request){const path=new URL(request.url).pathname,store=this.store;
  if(path==='/__inbox-seed'){const saved=seedScopedInbox(store);return Response.json({token:saved.token,after:saved.after,head:store.headSequence('commons')});}
  if(path==='/__inbox-cost')return Response.json(this.lastCost);
  store.room=()=>{throw Error('Whole-room hydration forbidden');};
  const sql=this.ctx.storage.sql,exec=sql.exec.bind(sql),rows=[];
  const bytes=value=>value==null?0:typeof value==='string'?Buffer.byteLength(value):value instanceof ArrayBuffer?value.byteLength:ArrayBuffer.isView(value)?value.byteLength:Buffer.byteLength(JSON.stringify(value));
  sql.exec=(text,...args)=>{const cursor=exec(text,...args),row={cursor,sqlBytes:bytes(text),boundBytes:args.reduce((sum,value)=>sum+bytes(value),0),returnedBytes:0};rows.push(row);const charge=value=>{row.returnedBytes+=bytes(JSON.stringify(value));return value;};return new Proxy(cursor,{get(target,key){if(key==='toArray')return()=>target.toArray().map(charge);if(key===Symbol.iterator)return function*(){for(const value of target)yield charge(value);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
  const started=performance.now();try{return await super.fetch(request);}finally{sql.exec=exec;this.lastCost={statements:rows.length,reads:0,writes:0,unknown:0,sqlBytes:0,boundBytes:0,returnedBytes:0,observedWorkerWallMs:performance.now()-started};for(const row of rows){for(const k of ['sqlBytes','boundBytes','returnedBytes'])this.lastCost[k]+=row[k];for(const [field,key]of [['rowsRead','reads'],['rowsWritten','writes']]){if(Number.isSafeInteger(row.cursor[field]))this.lastCost[key]+=row.cursor[field];else this.lastCost.unknown++;}}}
 }
}
export default entry;
