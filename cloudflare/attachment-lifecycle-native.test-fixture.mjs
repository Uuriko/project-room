import {CurrentAttachmentsRoom} from './current-attachments-worker.test-fixture.mjs';
export class AttachmentLifecycleRoom extends CurrentAttachmentsRoom {
 async fetch(request) {
  const path=new URL(request.url).pathname,s=this.store,db=this.db;
  try {
   if(path==='/prepare') {
    await super.fetch(new Request('http://local/seed?count=1000'));
    const key=s.issueAccessKey('commons','alice'),other=s.issueAccessKey('commons','reader'),bob=s.issueAccessKey('commons','bob');
    await this.ctx.storage.put({alice:key,other,bob});
    s.room=()=>{throw Error('legacy full room hydration');};
    for(const id of ['expire','private','fault'])s.roomAttachments.stage(key,'commons',{id,filename:'result.txt',mediaType:'text/plain',data:'YQ=='});
    for(const id of ['private','fault'])s.roomAttachments.commit(key,'commons',{id,messageId:'private'});
    return Response.json({prepared:true});
   }
   s.room=()=>{throw Error('legacy full room hydration');};
   const key=await this.ctx.storage.get('alice');
   if(path==='/expire') {
    s.roomAttachments.expire('commons',Date.now()+2*86400000);
    return Response.json({rows:db.prepare("SELECT id,state,bytes IS NULL cleared FROM room_attachments WHERE id IN ('expire','private','fault') ORDER BY id").all()});
   }
   if(path==='/fault') {
    const before=db.prepare('SELECT count(*) n FROM operator_actions').get().n,prepare=db.prepare.bind(db);
    db.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith("UPDATE room_attachments SET state='deleted'")){const run=stmt.run.bind(stmt);stmt.run=(...args)=>{run(...args);throw Error('synthetic interrupted save');};}return stmt;};
    let failed=false;try{s.roomAttachments.discard(key,'commons','fault');}catch(error){if(!error.message.includes('synthetic interrupted'))throw error;failed=true;}finally{db.prepare=prepare;}
    return Response.json({failed,before,after:db.prepare('SELECT count(*) n FROM operator_actions').get().n,state:db.prepare("SELECT state FROM room_attachments WHERE id='fault'").get().state,permit:db.prepare('SELECT enabled FROM current_room_writer_permit').get().enabled});
   }
   if(path==='/delete')return Response.json(s.roomAttachments.discard(key,'commons','private'));
   if(path==='/privacy') {
    const outcomes={};for(const [name,token]of [['other',await this.ctx.storage.get('other')],['bob',await this.ctx.storage.get('bob')]])try{s.roomAttachments.get(token,'commons','private');outcomes[name]=200;}catch(e){outcomes[name]=e.status;}
    return Response.json(outcomes);
   }
   if(path==='/old') {
    const errors=[];for(const sql of ["UPDATE room_attachments SET bytes=NULL WHERE id='fault'","DELETE FROM room_attachments WHERE id='fault'","INSERT INTO room_attachments SELECT room_id,'old',uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id FROM room_attachments WHERE id='fault'"])try{db.prepare(sql).run();errors.push(null);}catch(e){errors.push(e.message);}
    return Response.json({errors});
   }
   return new Response('not found',{status:404});
  }catch(error){return Response.json({code:error.code,message:error.message},{status:error.status??500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName('lifecycle').fetch(request);}};
