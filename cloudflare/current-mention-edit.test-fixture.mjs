import entry,{IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';
import {readCurrentMessage} from '../server/current-room-repository.mjs';
export class MentionEditRoom extends IdentityLinkRoom {
 async fetch(request){const path=new URL(request.url).pathname;if(!['/edit','/edit-cold'].includes(path))return super.fetch(request);try{
  const s=this.store,{identity,key}=await this.ctx.storage.get('fixture');s.room=()=>{throw Error('Full room hydration forbidden');};
  if(path==='/edit'){
   s.command(key,'commons',{id:'native-mentioned-post',type:'message.posted',data:{messageId:'native-mentioned',body:'@'+identity.identityId+' Original body'}});
   const before=s.headSequence('commons'),command={id:'native-exact-edit',type:'message.edited',data:{messageId:'native-mentioned',expectedMessageRevision:0,body:'Latest body without handle'}};
   await this.ctx.storage.put('edit-command',command);const beforeChips=s.db.prepare('SELECT * FROM mention_states').all();let rollback=false;
   try{s.transaction(()=>{s.command(key,'commons',command);throw Error('Native edit save fault');});}catch(e){if(e.message!=='Native edit save fault')throw e;rollback=true;}
   if(s.headSequence('commons')!==before||readCurrentMessage(s.db,'commons','native-mentioned').value.body!=='@'+identity.identityId+' Original body')throw Error('Native edit rollback failed');
   const result=s.command(key,'commons',command),mentions=s.openDirectMentions('commons',identity.identityId);
   if(JSON.stringify(s.db.prepare('SELECT * FROM mention_states').all())!==JSON.stringify(beforeChips))throw Error('Edit changed original delivery');
   return Response.json({rollback,duplicate:result.duplicate,body:mentions.find(x=>x.messageId==='native-mentioned')?.body});
  }
  const command=await this.ctx.storage.get('edit-command'),result=s.command(key,'commons',command),value=readCurrentMessage(s.db,'commons','native-mentioned').value;
  return Response.json({duplicate:result.duplicate,body:value.body,revision:value.revision,mentions:s.openDirectMentions('commons',identity.identityId).map(x=>({id:x.messageId,body:x.body}))});
 }catch(e){return Response.json({error:{message:e.message,code:e.code}},{status:500});}}
}
export default entry;
