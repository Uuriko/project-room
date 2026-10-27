import assert from 'node:assert/strict';
import { RoomStore as OldStore } from 'qualification-old-store';
import { DurableDatabase as OldDatabase, durableStorage as oldStorage } from 'qualification-old-storage';
import { RoomStore as Candidate } from '../server/store.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { RoomStore as Fallback } from 'qualification-fallback-store';
import { DurableDatabase as FallbackDatabase, durableStorage as fallbackStorage } from 'qualification-fallback-storage';
import { initialRoom } from '../server/bootstrap.mjs';
export class JoinQualification {
 constructor(ctx) { this.ctx = ctx; }
 async fetch(request) {
  const path = new URL(request.url).pathname;
  const open = (Store, Database, platform) => new Store(null, {database: new Database(this.ctx.storage), storagePlatform: platform});
  if (path === '/seed42') {
   const store = open(OldStore, OldDatabase, oldStorage);
   assert.equal(oldStorage.version(store.db), 42);
   store.initialize(initialRoom()); store.createAccount('preserved-account');
   return Response.json({version:42});
  }
  const store = path === '/fallback' ? open(Fallback, FallbackDatabase, fallbackStorage) : open(Candidate, DurableDatabase, durableStorage);
  assert.equal(durableStorage.version(store.db),43);
  if (path === '/upgrade') {
   assert.equal(store.account('preserved-account').active,true);
   const stale = new OldDatabase(this.ctx.storage);
   assert.throws(()=>stale.prepare("UPDATE accounts SET revision=revision WHERE id='preserved-account'").run(), /reconciliation/);
   assert.throws(()=>open(OldStore,OldDatabase,oldStorage), /newer than this service/);
   store.roomDirectory.set('commons','owner',true);
   const owner=store.issueAccessKey('commons','owner');
   await this.ctx.storage.put('qualificationOwner',owner);
   for (const status of ['pending','approved','denied']) {
    store.createAccount(status); const slot=store.createAccountSessionSlot();
    const session=store.loginAccountSession(slot.token,store.issueAccountAccessKey(status),0);
    store.accountJoinRequests.request(slot.token,session.sessionBinding,{roomId:'commons',requestId:'humanjoin-'+status,displayName:status});
    if(status!=='pending') store.accountJoinRequests.decide(owner,'commons',null,'humanjoin-'+status,{decision:status==='approved'?'approve':'deny',expectedRevision:0});
   }
  }
  const snapshot=()=>({rows:store.db.prepare('SELECT * FROM account_join_requests ORDER BY request_id').all(),bindings:store.db.prepare('SELECT * FROM member_accounts ORDER BY room_id,member_id').all()});
  if(path==='/fallback') { assert.equal(store.accountJoinRequests,undefined); store.createAccount('fallback-ordinary-write'); }
  if(path==='/resume') {
   assert.equal(store.account('fallback-ordinary-write').active,true);
   const before=snapshot(), owner=await this.ctx.storage.get('qualificationOwner');
   const resumed=store.accountJoinRequests.decide(owner,'commons',null,'humanjoin-pending',{decision:'approve',expectedRevision:0});
   assert.equal(resumed.status,'approved');
   assert.equal(store.db.prepare('SELECT account_id FROM member_accounts WHERE member_id=?').get(resumed.memberId).account_id,'pending');
   return Response.json({before,resumed:true});
  }
  return Response.json(snapshot());
 }
}
export default {fetch(request,env){return env.ROOM.getByName('qualification').fetch(request);}};
