// Disposable actual Native storage; reuses the existing holder-proof fixture.
import entry,{IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';
import {heartbeatWithListener} from '../server/agent-listener-contract.mjs';
import {assertListenerFence} from '../server/listener-fence.mjs';
export class HeartbeatRoom extends IdentityLinkRoom {
 async fetch(request){
  const path=new URL(request.url).pathname;if(!['/lease','/lease-cold','/observe'].includes(path))return super.fetch(request);
  try{const s=this.store,{identity,key}=await this.ctx.storage.get('fixture');if(path==='/observe'){const m=s.presence(key,'commons',[]).members.find(x=>x.ownerIdentityId===identity.identityId);return Response.json({state:m.state,watching:m.watching,host:m.presence?.status});}s.room=()=>{throw Error('Forbidden full heartbeat room hydration');};const auth={identityId:s.authenticate(identity.secret,'commons').identityId};
   if(path==='/lease'){
    const result=s.transaction(()=>heartbeatWithListener(s,auth,{hostId:'native-host',mode:'wakeable',cadenceSeconds:60,listenerLease:{roomId:'commons'}}));
    await this.ctx.storage.put('lease-token',result.listener.fencingToken);
    return Response.json({acquired:result.listener.acquired});
   }
   const token=await this.ctx.storage.get('lease-token');s.transaction(()=>assertListenerFence(s,auth,'commons',token));
   const result=s.transaction(()=>heartbeatWithListener(s,auth,{hostId:'native-host',mode:'wakeable',cadenceSeconds:60,listenerLease:{roomId:'commons'}}));
   return Response.json({valid:true,renewed:result.listener.renewed,sameToken:result.listener.fencingToken===token});
  }catch(e){return Response.json({error:{code:e.code,message:e.message}},{status:500});}
 }
}
export default entry;
