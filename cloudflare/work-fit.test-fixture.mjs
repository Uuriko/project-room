// Synthetic fixture only: actual Worker SQLite owns persistence and rollback.
import assert from 'node:assert/strict';
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
export class WorkFitRoom extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage});}
 async fetch(req){
  const path=new URL(req.url).pathname,s=this.store;
  if(path==='/seed'){
   s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');const auth=()=>s.authenticate(key,'commons');
   const input={action:'update_self',requestId:'worker-interest',expectedRevision:0,preferences:{learn:['backend_contracts']},configuration:{model:null,runtime:'workerd',tools:null}};
   const receipt=s.workFit.apply('commons',input,auth);
   assert.throws(()=>s.transaction(()=>{s.workFit.apply('commons',{action:'update_self',requestId:'rolled-back',expectedRevision:1,preferences:{learn:[]}},auth);throw new Error('rollback');}),/rollback/);
   assert.equal(s.workFit.read('commons',{},auth).selfRevision,1);s.workFit.verify();
   return Response.json({key,input,receipt});
  }
  if(path==='/resume'){
   const {key,input,receipt}=await req.json(),auth=()=>s.authenticate(key,'commons');
   assert.deepEqual(s.workFit.apply('commons',input,auth),receipt);
   assert.deepEqual(s.workFit.read('commons',{},auth).preferences.learn,['backend_contracts']);
   assert.equal(s.workFit.read('commons',{},auth).configuration.runtime,'workerd');s.workFit.verify();
   assert.equal(this.db.prepare('SELECT COUNT(*) AS n FROM agent_work_fit_events').get().n,1);
   return Response.json({persisted:true,retryStable:true,rollbackAtomic:true});
  }
  return new Response('Unknown fixture method',{status:404});
 }
}
export default{fetch:(request,env)=>env.ROOM.getByName('work-fit').fetch(request)};
