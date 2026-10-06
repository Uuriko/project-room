// Synthetic fixture, never deploy. Actual workerd SQLite and crypto own the contract.
import assert from 'node:assert/strict';
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {seedRecordRails} from '../scripts/record-rails-fixture.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
export class RecordRailRoom extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage});}
 async fetch(request){const path=new URL(request.url).pathname,store=this.store;
  if(path==='/seed'){store.initialize(initialRoom());const {receipt,completed}=seedRecordRails(store);assert.equal(completed.status,'completed');assert.equal(store.trialTasks.verified('commons','rail-trial',receipt.receiptId).candidateId,'rail-worker');return Response.json({receiptId:receipt.receiptId,recordOnly:completed.recordOnly});}
  if(path==='/resume'){const {receiptId}=await request.json();assert.equal(store.trialTasks.verified('commons','rail-trial',receiptId).state,'receipted');assert.equal(store.demigodContracts.get('commons','rail-contract').status,'completed');assert.throws(()=>store.trialTasks.read('commons','stranger','rail-trial'),{code:'access_denied'});assert.throws(()=>store.trialTasks.raw('other-room','rail-trial'),{code:'trial_task_not_found'});assert.equal(store.trialTasks.apply('commons','owner',{action:'configure',requestId:'key-rail-trial',expectedRevision:0,pubkey:JSON.parse(this.db.prepare('SELECT value FROM room_vetting_keys').get().value).pubkey}).revision,1);return Response.json({persisted:true,private:true,version:store.storagePlatform.version(this.db),paymentStatus:store.demigodContracts.get('commons','rail-contract').paymentStatus});}
  return new Response('Unknown fixture method',{status:404});
 }
}
export default {fetch:(request,env)=>env.ROOM.getByName('record-rails').fetch(request)};
