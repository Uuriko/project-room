import entry,{IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {setTier} from '../server/autonomy-tiers.mjs';
import {readCurrentRecord} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
export class NativeBondsRoom extends IdentityLinkRoom {
 async fetch(request){try{
 const s=this.store,path=new URL(request.url).pathname,roomId='native-bonds';
 if(path==='/bond-seed'){
  const owner=s.identities.create('Native Lena'),friend=s.identities.create('Native Ari'),other=s.identities.create('Native Mika');
  new AgentRooms(s).create(owner.secret,{roomId,title:'Native bonds',purpose:'Bond consent',kind:'personal',displayName:'Native Lena',starter:false});
  for(const identity of [friend,other]){
   const code=s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId}).linkCode;
   const linked=s.identities.link(owner.secret,roomId,{identityId:identity.identityId,identityLinkCode:code,permissions:[]});
   setTier(s.db,roomId,linked.memberId,'t2_standard',{updatedBy:owner.identityId,nowMs:s.now()});
  }
  await this.ctx.storage.put('bond-fixture',{owner,friend,other});return Response.json({seeded:true});
 }
 const saved=await this.ctx.storage.get('bond-fixture'),{owner,friend,other}=saved;
 s.room=()=>{throw Error('Full room hydration forbidden');};
 const command=(who,id,type,data)=>s.command(who.secret,roomId,{id,type,data});
 if(path==='/bond-flow'){
  const proposal=command(owner,'proposal','bond.propose',{to:friend.identityId,scopes:['peer.dm','peer.context'],note:'Independent consent'}),bondId=proposal.event.data.bondId;
  command(friend,'accept','bond.accept',{bondId,scopes:['peer.dm']});
  const bond=readCurrentRecord(s.db,roomId,'bonds',bondId);if(bond.note!=='Independent consent'||bond.proposedScopes.length!==2||bond.acceptedScopes.join()!=='peer.dm')throw Error('Prior bond fields lost');
  const seal=s.bonds.sealDm.bind(s.bonds);s.bonds.sealDm=(...args)=>{seal(...args);throw Error('Native interrupted peer save');};
  let rolledBack=false;try{command(owner,'dm','dm.posted',{to:friend.identityId,messageId:'useful-dm',body:'Saved useful work'});}catch(e){if(e.message!=='Native interrupted peer save')throw e;rolledBack=s.db.prepare('SELECT count(*) n FROM peer_dm_messages').get().n===0&&s.db.prepare('SELECT count(*) n FROM peer_dm_threads').get().n===0;}finally{s.bonds.sealDm=seal;}
  if(!rolledBack)throw Error('Native peer fault did not roll back');
  const dm=command(owner,'dm','dm.posted',{to:friend.identityId,messageId:'useful-dm',body:'Saved useful work'});
  const inbox=s.agentInbox(friend.secret,roomId,{limit:10});if(inbox.peerMessages[0]?.body!=='Saved useful work')throw Error('Native peer inbox omitted saved work');
  await this.ctx.storage.put('bond-fixture',{...saved,bondId,dm});return Response.json({priorFields:true,rolledBack,inbox:true});
 }
 if(path==='/bond-cold'){
  const retry=command(owner,'dm','dm.posted',{to:friend.identityId,messageId:'useful-dm',body:'Saved useful work'});
  if(!retry.duplicate||retry.event.id!==saved.dm.event.id)throw Error('Cold exact retry differed');
  let hidden=false;try{s.bonds.readThread(roomId,other.identityId,retry.event.data.threadId);}catch(e){if(e.code!=='thread_not_found')throw e;hidden=true;}
  command(friend,'revoke','bond.revoke',{bondId:saved.bondId});
  const old=readCurrentRecord(s.db,roomId,'bonds',saved.bondId);if(old.note!=='Independent consent'||old.state!=='revoked')throw Error('Revocation lost prior fields');
  let denied=false;try{command(owner,'denied','dm.posted',{to:friend.identityId,messageId:'denied',body:'No grant'});}catch(e){if(e.code!=='bond_revoked')throw e;denied=true;}
  auditRecovery(s);
  return Response.json({exactRetry:true,private:hidden,revoked:denied,oracle:true,messages:s.db.prepare('SELECT count(*) n FROM peer_dm_messages').get().n,closed:s.db.prepare('SELECT enabled FROM current_room_writer_permit').get().enabled===0});
 }
 return new Response('Not found',{status:404});
 }catch(e){return Response.json({error:{code:e.code,message:e.message}},{status:500});}}
}
export default entry;
