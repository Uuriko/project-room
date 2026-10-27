import {DurableObject} from 'cloudflare:workers';
import {DurableDatabase} from './storage.mjs';
import {messageQueries} from '../server/message-queries.mjs';
import {messageInHistory} from '../server/history-visibility.mjs';
// 20k archived messages, same shape as the room read's window count.
// One request = one method, so outer wall time isolates it (workerd freezes
// timers during synchronous execution, so in-object timing is not usable).
export class CountRoom extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.ready=false;}
 setup(){
  if(this.ready)return; const s=this.ctx.storage.sql;
  s.exec(`CREATE TABLE IF NOT EXISTS messages(room_id TEXT,message_id TEXT,seq INTEGER,author_id TEXT,to_member_id TEXT,channel_id TEXT,created_at TEXT,deleted_at TEXT,record_json TEXT,body TEXT,PRIMARY KEY(room_id,message_id))`);
  s.exec(`CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id,seq)`);
  if([...s.exec('SELECT COUNT(*) AS n FROM messages')][0].n===0){
   for(let i=0;i<20000;i++){const id='m'+String(i).padStart(6,'0');const to=i%7===0?'viewer':i%11===0?'other':null;
    s.exec('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)','room',id,Math.floor(i/2),i%3?'viewer':'other',to,'general',`2026-10-27T00:${String(Math.floor(i/60)%60).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`,null,JSON.stringify({id}),'body '+i);}
  }
  this.ready=true;
 }
 async fetch(request){
  this.setup(); const method=new URL(request.url).searchParams.get('m');
  const db=new DurableDatabase(this.ctx.storage); db.isTransaction=true;
  let statements=0; const prepare=db.prepare.bind(db); db.prepare=sql=>{const st=prepare(sql);return new Proxy(st,{get(t,k){const v=t[k];return typeof v==='function'&&['all','get','run','iterate'].includes(k)?(...a)=>{statements++;return v.apply(t,a);}:v;}});};
  const q=messageQueries({db},'room',{messages:[]},{throughSeq:9999,retainedJson:'[]'});
  const floor={at:'2026-10-27T00:05:00.000Z',sameInstant:new Set(['m000300'])}, viewer='viewer';
  const visible=m=>messageInHistory(m,floor)&&(!m.toMemberId||m.authorId===viewer||m.toMemberId===viewer);
  db.rowsRead=0;
  const value = method==='old' ? q.countMetadata(visible) : method==='new' ? q.countViewerVisible(viewer,floor) : null;
  return Response.json({method,value,rowsRead:db.rowsRead,statements});
 }
}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('count')).fetch(request);}};
