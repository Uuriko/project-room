import entry,{IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {operatorLifecycleArchive} from '../server/operator-lifecycle-archive.mjs';
import {auditRecovery} from '../server/recovery.mjs';
export class OperatorLifecycleRoom extends IdentityLinkRoom {
 async fetch(request){try{const s=this.store,path=new URL(request.url).pathname;
 if(path==='/seed'){
  s.initialize(initialRoom('muse-room').map(e=>e.type==='member.added'?{...e,data:{...e.data,kind:'agent'}}:e));
  s.initialize(initialRoom('target'),{representation:'normalized-current-v1'});
  const key=s.issueAccessKey('muse-room','owner'),target=s.issueAccessKey('target','owner');
  const input={roomId:'muse-room',confirmRoomId:'muse-room',reason:'Synthetic Native lifecycle cutover'},plan=operatorLifecycleArchive(s,input),execute={...input,requestId:'native-exact',planHash:plan.planHash};
  const before=s.headSequence('muse-room'),original=s.archiveLifecycleRoomAsOperator.bind(s);let fault=false;
  s.archiveLifecycleRoomAsOperator=(...args)=>{original(...args);throw Error('Native archive save fault');};
  try{operatorLifecycleArchive(s,execute,true);}catch(e){if(e.message!=='Native archive save fault')throw e;fault=true;}finally{s.archiveLifecycleRoomAsOperator=original;}
  if(!fault||s.headSequence('muse-room')!==before||s.db.prepare('SELECT archived_at FROM rooms WHERE id=?').get('muse-room').archived_at!==null)throw Error('Archive fault rollback failed');
  const receipt=operatorLifecycleArchive(s,execute,true);await this.ctx.storage.put('lifecycle',{key,target,execute,receipt});
 }
 const saved=await this.ctx.storage.get('lifecycle'),retry=operatorLifecycleArchive(s,saved.execute,true);
 if(JSON.stringify(retry)!==JSON.stringify({...saved.receipt,duplicate:true}))throw Error('Lost ACK receipt changed');
 if(s.authenticate(saved.key,'muse-room').member.id!=='owner'||s.authenticate(saved.target,'target').member.id!=='owner')throw Error('Archive damaged existing access');
 const audit=auditRecovery(s);return Response.json({duplicate:retry.duplicate,rooms:audit.rooms,archived:true,preservedAccess:true});
 }catch(e){return Response.json({error:{message:e.message,code:e.code}},{status:500});}}
}
export default entry;
