import entry,{IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createWork} from '../server/work-claims.mjs';
export class ArchivedClaimRoom extends IdentityLinkRoom {
 async fetch(request){try{
 const path=new URL(request.url).pathname,s=this.store;
 if(path==='/seed'){
  s.initialize(initialRoom(),{representation:'normalized-current-v1'});
  s.workClaims.set('commons',{...createWork({id:'old'},{agentId:'owner'}),state:'closed'});
  s.workClaims.configure('commons',{staleSweep:true});
  const key=s.issueAccessKey('commons','owner'),command={id:'native-archive',type:'room.archived',data:{}};
  const receipt=s.command(key,'commons',command);await this.ctx.storage.put('archive',{key,command,sequence:receipt.sequence});
 }
 const saved=await this.ctx.storage.get('archive');s.room=()=>{throw Error('Archived projection hydration forbidden');};let refused=0;
 for(const change of [()=>s.workClaims.set('commons',{...s.workClaims.get('commons','old'),title:'changed'}),()=>s.workClaims.delete('commons','old'),()=>s.workClaims.configure('commons',{staleSweep:false})]){
  try{change();throw Error('Mutation unexpectedly accepted');}catch(e){if(e.code!=='room_archived')throw e;refused++;}
 }
 const retry=s.command(saved.key,'commons',saved.command);
 if(!retry.duplicate||retry.sequence!==saved.sequence)throw Error('Original archive receipt changed');
 return Response.json({refused,duplicate:retry.duplicate,config:s.workClaims.rawConfig('commons').staleSweep,state:s.workClaims.get('commons','old').state});
 }catch(e){return Response.json({error:{message:e.message,code:e.code}},{status:500});}}
}
export default entry;
