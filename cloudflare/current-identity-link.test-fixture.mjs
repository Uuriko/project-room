// Synthetic actual Worker qualification; no deployed entrypoint.
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
export class IdentityLinkRoom extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.store=new RoomStore(null,{database:new DurableDatabase(ctx.storage),storagePlatform:durableStorage,integrity:'deferred'});}
 async fetch(request){try{
  const s=this.store,path=new URL(request.url).pathname;
  if(path==='/seed'){s.initialize(initialRoom(),{representation:'normalized-current-v1'});const identity=s.identities.create('Native existing identity'),key=s.issueAccessKey('commons','owner'),code=s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons'}).linkCode;await this.ctx.storage.put('fixture',{identity,key,code});return Response.json({ready:true});}
  const {identity,key,code}=await this.ctx.storage.get('fixture');s.room=()=>{throw Error('Full-room hydration forbidden');};
  const input={identityId:identity.identityId,permissions:['accept_work'],identityLinkCode:code};
  if(path==='/link'){
   const before=s.headSequence('commons'),original=s.identities.requireLinkHolderProof.bind(s.identities);let fault=false;
   s.identities.requireLinkHolderProof=(...args)=>{original(...args);throw Error('Native link saved-proof fault');};
   try{s.identities.link(key,'commons',input);}catch(e){if(e.message!=='Native link saved-proof fault')throw e;fault=true;}finally{s.identities.requireLinkHolderProof=original;}
   if(!fault||s.headSequence('commons')!==before||s.db.prepare('SELECT count(*) n FROM identity_links WHERE identity_id=?').get(identity.identityId).n!==0)throw Error('Failed link did not roll back');
   const linked=s.identities.link(key,'commons',input),member=s.authenticate(identity.secret,'commons').member;
   return Response.json({faultRolledBack:fault,linked:linked.memberId===identity.identityId,permissions:member.permissions,sequence:s.headSequence('commons')});
  }
  if(path==='/cold'){
   const auth=s.authenticate(identity.secret,'commons');let repeated=false;try{s.identities.link(key,'commons',input);}catch(e){if(e.code!=='identity_already_linked')throw e;repeated=true;}
   return Response.json({sameIdentity:auth.identityId===identity.identityId,permissions:auth.member.permissions,duplicateRefused:repeated,links:s.db.prepare('SELECT count(*) n FROM identity_links WHERE identity_id=?').get(identity.identityId).n,sequence:s.headSequence('commons')});
  }
  return new Response('Not found',{status:404});
 }catch(e){return Response.json({error:{message:e.message,code:e.code}},{status:500});}}
}
export default {fetch(request,env){return env.ROOM.getByName('identity-link').fetch(request);}};
