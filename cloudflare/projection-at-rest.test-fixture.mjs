// Synthetic Worker entry point. Never deploy this fixture.
import assert from 'node:assert/strict';
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readConversation } from '../server/conversation-sync.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
const text='Worker retained text 😀 '.repeat(700);
const revised='Worker revised text 🚀 '.repeat(700);
const finish=store=>{for(let i=0;i<20;i++) if(store.backfillMessages({limit:400}).done)return;assert.fail('Small replay did not finish');};
export class ProjectionBodyRoom extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.db=new DurableDatabase(ctx.storage);
    this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,bodiesAtRest:env.ROOM_BODIES_AT_REST==='1'});
    this.enabled=env.ROOM_BODIES_AT_REST==='1';
  }
  async fetch(request) {
    const path=new URL(request.url).pathname,store=this.store;
    const bodies=()=>this.db.prepare('SELECT body FROM projection_bodies WHERE room_id=?').all('body-room');
    const raw=()=>JSON.parse(this.db.prepare('SELECT projection FROM rooms WHERE id=?').get('body-room').projection);
    if(path==='/seed') {
      store.initialize(initialRoom('body-room'));
      const owner=store.issueAccessKey('body-room','owner');
      store.command(owner,'body-room',{id:'long-command',type:'message.posted',data:{messageId:'long',body:text}});
      assert.equal(bodies().length,this.enabled?1:0);
      assert.equal(raw().messages.find(m=>m.id==='long').bodyRef!==undefined,this.enabled);
      finish(store);assert.equal(store.checkMessagesParity().checked,1);
      assert.equal(readConversation(store,owner,'body-room',{limit:10}).messages.find(m=>m.id==='long').body,text);
      return Response.json({owner});
    }
    if(path==='/resume') {
      const {owner}=await request.json();
      assert.equal(store.room('body-room').state.messages.find(m=>m.id==='long').body,text);
      assert.equal(readConversation(store,owner,'body-room',{limit:10}).messages.find(m=>m.id==='long').body,text);
      store.command(owner,'body-room',{id:'edit-command',type:'message.edited',data:{messageId:'long',body:revised,expectedMessageRevision:0}});
      assert.deepEqual(bodies().map(row=>row.body),this.enabled?[revised]:[]);
      finish(store);assert.equal(store.checkMessagesParity().checked,1);
      assert.equal(readConversation(store,owner,'body-room',{limit:10}).messages.find(m=>m.id==='long').body,revised);
      return Response.json({resumed:true,indexed:true,bodyRows:bodies().length});
    }
    if(path==='/disable') {
      const {owner}=await request.json();
      assert.equal(store.room('body-room').state.messages.find(m=>m.id==='long').body,revised);
      store.command(owner,'body-room',{id:'off-command',type:'message.posted',data:{messageId:'next',body:'Flag off writes full projection.'}});
      assert.equal(bodies().length,0);
      assert.equal(raw().messages.find(m=>m.id==='long').body,revised);
      return Response.json({disabled:true,fullProjection:true});
    }
    return new Response('Unknown fixture route',{status:404});
  }
}
export default {fetch:(request,env)=>env.ROOM.getByName('projection-body-owner').fetch(request)};
