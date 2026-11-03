// Synthetic local-only Durable Object fixture; not part of the deployed worker.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class SessionRenewTestRoom extends DurableObject {
  constructor(ctx,env) { super(ctx,env); this.store=new RoomStore(null,{database:new DurableDatabase(ctx.storage),storagePlatform:durableStorage}); }
  async fetch(request) {
    const s=this.store,path=new URL(request.url).pathname;
    try {
      if(path==='/seed') {
        s.initialize(initialRoom()); const owner=s.issueAccessKey('commons','owner'),accountId=s.authenticate(owner).account.id;
        const realNow=s.now; s.now=()=>Date.now()-29*86400000;
        let slot; try {slot=s.createAccountSessionSlot();} finally {s.now=realNow;}
        const renewed=s.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true});
        return Response.json({oldToken:slot.token,token:renewed.token,accountId});
      }
      const {token}=await request.json();
      if(path==='/read') {const x=s.authenticateAccountSession(token);return Response.json({accountId:x.account.id,revision:x.sessionRevision,expiresAt:x.expiresAt,lineage:x.draftRecoveryLineage,binding:x.sessionBinding,now:s.now()});}
      if(path==='/legacy') {s.db.exec('ALTER TABLE account_session_slots DROP COLUMN draft_recovery_lineage');return Response.json({ok:true});}
      if(path==='/rotate') {const x=s.authenticateAccountSession(token);const next=s.loginAccountSessionWithMethod(token,x.account.id,x.sessionRevision,{method:{kind:'password'},rotateSlot:true});return Response.json({token:next.token,lineage:next.session.draftRecoveryLineage});}
      if(path==='/logout') {const x=s.authenticateAccountSession(token);s.logoutAccountSession(token,x.sessionRevision);return Response.json({ok:true});}
      return new Response('Not found',{status:404});
    }catch(e){return Response.json({error:{code:e.code??'internal'}},{status:e.status??500});}
  }
}
export default {fetch(request,env){return env.ROOM.getByName('session-renew-restart').fetch(request);}};
