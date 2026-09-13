import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rmSync} from 'node:fs';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {TelegramReceiveQueue} from '../server/telegram-receive-queue.mjs';
import {TelegramConnectionRegistry} from '../server/telegram-connection-registry.mjs';
import {MessagingReceiveGrants} from '../server/messaging-receive-grants.mjs';
import {createTelegramBackgroundReceiver} from '../server/telegram-receiver.mjs';

function fixture(t){
  const f=createAcceptanceFixture(),databases=Array.from({length:3},()=>new DatabaseSync(':memory:'));
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0),session={token:slot.token,binding:auth.sessionBinding};
  const queue=new TelegramReceiveQueue({db:databases[0],key:Buffer.alloc(32,7),accountId:account.id,connectionId:'one',authEpoch:0});
  const registry=new TelegramConnectionRegistry({db:databases[1],key:Buffer.alloc(32,8)}),grants=new MessagingReceiveGrants({db:databases[2],store:f.store});
  t.after(()=>{registry.close();grants.close();databases.forEach(d=>d.close());f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const config={accountId:account.id,connectionId:'one',authEpoch:0,expectedRevision:0,botId:'123456',token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]};
  registry.configure(config);
  const consent={connectionId:'one',provider:'telegram',connectionRevision:1,expectedRevision:0,expiresAt:f.store.now()+60000};
  grants.issue(session,consent);
  const binding={accountId:account.id,connectionId:'one',provider:'telegram',connectionRevision:1,revision:1};
  const make=(fetchImpl,b=binding)=>createTelegramBackgroundReceiver({store:f.store,queue,registry,grants,binding:b,fetchImpl});
  const update=id=>({update_id:id,message:{message_id:id,chat:{id:44},from:{id:44},date:1700000000,text:`Message ${id}`}});
  return {...f,account,slot,auth,session,queue,registry,grants,config,consent,binding,make,update};
}
test('Telegram receive-only grant imports after logout and advances only the durable cursor',async t=>{
  const f=fixture(t),offsets=[],sequence=f.store.room('commons').sequence;
  f.store.logoutAccountSession(f.slot.token,f.auth.sessionRevision);
  const receiver=f.make(async(url,options)=>{const offset=JSON.parse(options.body).offset;offsets.push(offset);return Response.json({ok:true,result:offset===0?[f.update(9)]:[]});});
  assert.equal((await receiver.sync()).imported,1);assert.equal((await receiver.sync()).imported,0);
  assert.deepEqual(offsets,[0,10]);assert.equal(f.queue.pending().length,0);
  assert.equal(f.store.inbox.verify().versions,1);assert.equal(f.store.room('commons').sequence,sequence);
  assert.throws(()=>f.store.inbox.list(f.slot.token,f.auth.sessionBinding));
});
test('Telegram grant revocation during provider read prevents staging and further polling',async t=>{
  const f=fixture(t);let calls=0;
  const receiver=f.make(async()=>{calls++;f.grants.revoke(f.session,{connectionId:'one',expectedRevision:1});return Response.json({ok:true,result:[f.update(9)]});});
  await assert.rejects(receiver.sync());await assert.rejects(receiver.sync());
  assert.equal(calls,1);assert.equal(f.queue.nextOffset(),0);assert.equal(f.queue.pending().length,0);assert.equal(f.store.inbox.verify().versions,0);
});
test('Telegram background import rollback retains page and replays before requesting a higher offset',async t=>{
  const f=fixture(t),original=f.store.inbox.importGrantedMessage;let fail=true;const offsets=[];
  f.store.inbox.importGrantedMessage=function(...args){const result=original.apply(this,args);if(fail)throw new Error('storage fault');return result;};
  const receiver=f.make(async(url,options)=>{const offset=JSON.parse(options.body).offset;offsets.push(offset);
    if(offset>0)assert.equal(f.store.inbox.verify().versions,1);
    return Response.json({ok:true,result:offset===0?[f.update(9)]:[]});});
  await assert.rejects(receiver.sync());assert.equal(f.queue.pending().length,1);assert.equal(f.store.inbox.verify().versions,0);
  fail=false;assert.equal((await receiver.sync()).imported,1);assert.deepEqual(offsets,[0,10]);assert.equal(f.queue.pending().length,0);
});
test('narrower Telegram scope cannot import an old queued page with renewed permission',async t=>{
  const f=fixture(t),original=f.store.inbox.importGrantedMessage;
  f.store.inbox.importGrantedMessage=()=>{throw new Error('fault');};
  await assert.rejects(f.make(async()=>Response.json({ok:true,result:[f.update(9)]})).sync());
  f.store.inbox.importGrantedMessage=original;
  f.registry.configure({...f.config,expectedRevision:1,chatIds:[55]});
  f.grants.issue(f.session,{...f.consent,expectedRevision:1,connectionRevision:2});
  const receiver=f.make(async()=>{throw new Error('must not poll');},{...f.binding,revision:2,connectionRevision:2});
  await assert.rejects(receiver.sync());assert.equal(f.queue.pending().length,1);assert.equal(f.store.inbox.verify().versions,0);
});
