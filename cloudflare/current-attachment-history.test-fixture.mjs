import entry,{IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
export class AttachmentHistoryRoom extends IdentityLinkRoom {
 async fetch(request){const path=new URL(request.url).pathname;if(!['/file-seed','/file-read'].includes(path))return super.fetch(request);try{
  const s=this.store;
  if(path==='/file-seed'){
   const events=initialRoom(),add=(type,data,at)=>events.push(event({roomId:'commons',actorId:'owner',type,data,at}));
   add('room.history_visibility_set',{historyVisibility:'since_join'},'2026-01-01T00:00:00Z');
   add('message.posted',{messageId:'old-message',body:'Old pointer'},'2026-01-02T00:00:00Z');
   for(const id of ['worker','other'])add('member.added',{memberId:id,displayName:id,kind:'agent',permissions:[]},'2026-01-03T00:00:00Z');
   add('message.posted',{messageId:'fresh-message',body:'Fresh pointer'},'2026-01-04T00:00:00Z');
   add('message.posted',{messageId:'private-message',body:'Private pointer',toMemberId:'other'},'2026-01-04T00:00:00Z');
   s.initialize(events,{representation:'normalized-current-v1'});const owner=s.issueAccessKey('commons','owner'),worker=s.issueAccessKey('commons','worker');
   for(const [id,messageId]of [['old-file','old-message'],['fresh-file','fresh-message'],['private-file','private-message'],['staged-file',null]]){
    s.roomAttachments.stage(owner,'commons',{id,filename:'note.txt',mediaType:'text/plain',data:'VXNlZnVsIGJ5dGVz'});
    if(messageId)s.roomAttachments.commit(owner,'commons',{id,messageId});
   }
   await this.ctx.storage.put('file-keys',{owner,worker});return Response.json({seeded:true});
  }
  const {owner,worker}=await this.ctx.storage.get('file-keys');s.room=()=>{throw Error('Full room hydration forbidden');};const denied=[];
  const prepare=s.db.prepare.bind(s.db);s.db.prepare=query=>{if(query==='SELECT bytes FROM room_attachments WHERE room_id=? AND id=?')throw Error('Unauthorized blob fetch attempted');return prepare(query);};
  try{for(const id of ['old-file','private-file','staged-file','unknown-file']){try{s.roomAttachments.get(worker,'commons',id);throw Error('Hidden bytes disclosed');}catch(e){if(e.code!=='attachment_not_found'||e.status!==404)throw e;denied.push(id);}}}finally{s.db.prepare=prepare;}
  return Response.json({denied,fresh:s.roomAttachments.get(worker,'commons','fresh-file').attachment.data,owner:s.roomAttachments.get(owner,'commons','old-file').attachment.data});
 }catch(e){return Response.json({error:{code:e.code,message:e.message}},{status:500});}}
}
export default entry;
