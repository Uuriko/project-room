// Synthetic pending journals only; this fixture never contacts an external host.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorWakeIndex } from '../server/operator-wake-index.mjs';
import { readWakeWindow, WAKE_INDEXES } from '../server/wake-delivery-window.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class NewestWakeProbe extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage});}
 async fetch(request){
  const {count,table,oversize=false}=await request.json(),s=this.store,db=this.db;
  s.initialize(initialRoom());
  s.transaction(()=>{
   if(table==='agent_wake_signals'){
    const insert=db.prepare("INSERT INTO agent_wake_signals VALUES(?,'agent','mention',?,?,1,NULL)");
    for(let n=0;n<count;n++)insert.run('signal-'+String(n).padStart(5,'0'),'commons','message-'+n);
    for(let n=0;n<count;n++)insert.run('foreign-'+n,'foreign','private-'+n);
   }else{
    const insert=db.prepare("INSERT INTO agent_work_wakes VALUES(?,'agent','commons','worker','task',0,?,'owner',?,1,NULL,NULL)");
    for(let n=0;n<count;n++)insert.run('work-'+String(n).padStart(5,'0'),'event-'+n,' '.repeat(n>=count-40?8192:100));
   }
  });
  const reason='Synthetic reverse Worker',plan=operatorWakeIndex(s,{reason});operatorWakeIndex(s,{reason,planHash:plan.planHash,requestId:'install'},true);
  if(oversize)s.transaction(()=>db.prepare("UPDATE agent_wake_signals SET message_id=? WHERE signal_id=?").run('x'.repeat(1025),'signal-'+String(count-1).padStart(5,'0')));
  let payloadReads=0,scalarRows=0,scalarReads=0;
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{
   const st=prepare(sql);
   if(/WHERE rowid=\?/.test(sql)) {const get=st.get.bind(st);st.get=(...args)=>{payloadReads++;return get(...args);};}
   if(/INDEXED BY/.test(sql)){const all=st.all.bind(st);st.all=(...args)=>{const before=db.rowsRead,result=all(...args);scalarRows+=result.length;scalarReads+=db.rowsRead-before;return result;};}
   return st;
  };
  const before=db.rowsRead;
  try{
   const page=readWakeWindow(db,table,'agent',null,'commons','newest');
   const totalRowsRead=db.rowsRead-before;
   const index=WAKE_INDEXES.find(i=>i.table===table&&i.scoped);
   const plans=prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM ${table} INDEXED BY ${index.name} WHERE agent_id=? AND room_id=? AND delivered_at IS NULL${table==='agent_work_wakes'?' AND invalidated_at IS NULL':''} AND (created_at,signal_id)<(?,?) ORDER BY created_at DESC,signal_id DESC LIMIT 129`).all('agent','commons',2,'z').map(r=>r.detail);
   return Response.json({count,table,first:page.rows[0]?.signal_id,last:page.rows.at(-1)?.signal_id,more:page.more,admitted:page.admitted,payloadReads,scalarRows,scalarReads,totalRowsRead,plans});
  }catch(error){return Response.json({code:error.code,payloadReads,scalarRows,scalarReads},{status:error.status??500});}
 }
}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName(new URL(request.url).pathname)).fetch(request);}};
