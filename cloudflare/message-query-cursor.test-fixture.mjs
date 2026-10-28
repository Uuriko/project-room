import {DurableObject} from 'cloudflare:workers';
import {DurableDatabase} from './storage.mjs';
import {messageInHistory} from '../server/history-visibility.mjs';
import {cursorFixture} from '../tests/helpers/message-query-cursor-fixture.mjs';
export class MessageCursorRoom extends DurableObject {
 async fetch(){
  const db=new DurableDatabase(this.ctx.storage);db.isTransaction=true;
  let statements=0; const prepare=db.prepare.bind(db); db.prepare=(...args)=>{statements++;return prepare(...args);};
  const f=cursorFixture(db,20000);db.rowsRead=0;statements=0;
  const measures={}; const measure=(name,fn)=>{db.rowsRead=0;statements=0;const value=fn();measures[name]={rowsRead:db.rowsRead,statements:statements};return value;};
  const q=f.queries;
  const result={ascending:measure('ascending',()=>[...q.records()]),descending:measure('descending',()=>[...q.records({descending:true})]),
   after:measure('after',()=>[...q.records({afterId:'m000255'})]),before:measure('before',()=>[...q.records({afterId:'m000256',descending:true})]),
   visible:measure('visible',()=>[...q.records({visibility:{viewerId:'viewer'}})]),recent:measure('recent',()=>q.recent(100,f.visible)),
   count:measure('count',()=>q.countMetadata(f.visible)),first:measure('first',()=>[...q.firstPostedAtByAuthor()])};
  const counts=[];
  for(const viewer of ['viewer','other','private','outsider']) for(const floor of [null,{at:'2026-10-27T00:00:30.000Z',sameInstant:new Set(['m000030','m000150'])},{at:'9999-12-31T23:59:59.999Z',sameInstant:new Set()}]) {
   const key=`${viewer}:${floor?.at??'all'}`;
   const visible=m=>messageInHistory(m,floor)&&(!m.toMemberId||m.authorId===viewer||m.toMemberId===viewer);
   const legacy=measure(`legacy:${key}`,()=>q.countMetadata(visible));
   const aggregate=measure(`aggregate:${key}`,()=>q.countViewerVisible(viewer,floor));
   counts.push({key,legacy,aggregate});
  }
  return Response.json({counts,result,expected:f.expected,measures,rowsRead:Object.values(measures).reduce((n,r)=>n+r.rowsRead,0),statements:Object.values(measures).reduce((n,r)=>n+r.statements,0)});
 }
}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('cursor')).fetch(request);}};
