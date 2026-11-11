import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {restoreProgress} from '../server/restore-admission.mjs';
import {messageProofMatches,projectionDigest} from '../server/write-integrity.mjs';
export class PendingProtocolRoom extends ProjectRoom{
 async fetch(request){const u=new URL(request.url),s=this.store;
  if(u.pathname==='/__seed'){s.initialize(initialRoom(),{representation:'normalized-current-v1'});return Response.json({key:s.issueAccessKey('commons','owner')});}
  if(u.pathname==='/__export')return new Response(exportNdjsonText(s.db));
  if(u.pathname==='/__partial'){const text=await request.text(),session=createBackupReplaySession(s,{staged:true});session.writeText(text.slice(0,text.lastIndexOf('{"kind":"trailer"')));return Response.json({pending:restoreProgress(s.db).state==='pending'});}
  if(u.pathname==='/__proof'){const row=s.db.prepare("SELECT * FROM messages WHERE room_id='commons' AND message_id='native-after-publish'").get(),room=s.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get(),proof=s.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get();return Response.json({message:messageProofMatches(row),metadata:proof.metadata_hash===projectionDigest(room.projection)});}
  return super.fetch(request);
 }
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'target';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
