import {DurableObject} from 'cloudflare:workers';
import {DurableDatabase} from './storage.mjs';
import {cursorFixture} from '../tests/helpers/message-query-cursor-fixture.mjs';
export class MessageCursorRoom extends DurableObject {
 async fetch(){
  const costs=[];const db=new DurableDatabase(this.ctx.storage,{observeStatement:()=>row=>costs.push(row)});db.isTransaction=true;
  const f=cursorFixture(db,20000);costs.length=0;
  const measures={}; const measure=(name,fn)=>{costs.length=0;const value=fn();measures[name]={rowsRead:costs.reduce((n,r)=>n+(r.rowsRead??0),0),statements:costs.length};return value;};
  const q=f.queries;
  const result={ascending:measure('ascending',()=>[...q.records()]),descending:measure('descending',()=>[...q.records({descending:true})]),
   after:measure('after',()=>[...q.records({afterId:'m000255'})]),before:measure('before',()=>[...q.records({afterId:'m000256',descending:true})]),
   visible:measure('visible',()=>[...q.records({visibility:{viewerId:'viewer'}})]),recent:measure('recent',()=>q.recent(100,f.visible)),
   count:measure('count',()=>q.countMetadata(f.visible)),first:measure('first',()=>[...q.firstPostedAtByAuthor()])};
  return Response.json({result,expected:f.expected,measures,rowsRead:Object.values(measures).reduce((n,r)=>n+r.rowsRead,0),statements:Object.values(measures).reduce((n,r)=>n+r.statements,0)});
 }
}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('cursor')).fetch(request);}};
