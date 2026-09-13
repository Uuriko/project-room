import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { TelegramReceiveQueue } from '../server/telegram-receive-queue.mjs';
import { createTelegramReceiver } from '../server/telegram-receiver.mjs';
import { TelegramConnectionRegistry } from '../server/telegram-connection-registry.mjs';

function fixture(t) {
  const f=createAcceptanceFixture(),db=new DatabaseSync(':memory:');
  t.after(()=>{db.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const session=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const queue=new TelegramReceiveQueue({db,key:Buffer.alloc(32,7),accountId:account.id,connectionId:'telegram-one',authEpoch:account.authEpoch});
  const grant={active:true,accountId:account.id,connectionId:'telegram-one',authEpoch:account.authEpoch,revision:1,token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]};
  const args={store:f.store,queue,token:slot.token,sessionBinding:session.sessionBinding,getGrant:()=>grant};
  const update=id=>({update_id:id,message:{message_id:id,chat:{id:44},from:{id:44},date:1700000000,text:`Message ${id}`}});
  return {...f,db,account,slot,session,queue,grant,args,update};
}

test('authorized runtime receives into private Inbox and advances durable offset on next call',async t=>{
  const f=fixture(t),offsets=[],before=f.store.room('commons').sequence;
  const receiver=createTelegramReceiver({...f.args,fetchImpl:async(url,options)=>{const offset=JSON.parse(options.body).offset;offsets.push(offset);return Response.json({ok:true,result:offset===0?[f.update(9)]:[]});}});
  assert.equal((await receiver.sync()).imported,1);assert.equal((await receiver.sync()).imported,0);
  assert.deepEqual(offsets,[0,10]);assert.equal(f.queue.pending().length,0);assert.equal(f.store.inbox.verify().versions,1);
  assert.equal(f.store.room('commons').sequence,before);
});

test('persisted registry authorizes Inbox delivery and disconnect stops further requests',async t=>{
  const f=fixture(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const registry=new TelegramConnectionRegistry({db,key:Buffer.alloc(32,9)});
  const binding={accountId:f.account.id,connectionId:'telegram-one',authEpoch:f.account.authEpoch};
  registry.configure({...binding,expectedRevision:0,botId:'123456',token:f.grant.token,chatIds:[44]});
  let calls=0;
  const receiver=createTelegramReceiver({...f.args,getGrant:()=>registry.grant(binding),withGrant:fn=>registry.withGrant(binding,fn),
    fetchImpl:async()=>{calls++;return Response.json({ok:true,result:[f.update(9)]});}});
  assert.equal((await receiver.sync()).imported,1);
  registry.disconnect({...binding,expectedRevision:1});
  await assert.rejects(receiver.sync());assert.equal(calls,1);assert.equal(f.store.inbox.verify().versions,1);
});

test('account sign-out during provider read prevents staging and import',async t=>{
  const f=fixture(t);
  const receiver=createTelegramReceiver({...f.args,fetchImpl:async()=>{f.store.logoutAccountSession(f.slot.token,f.session.sessionRevision);return Response.json({ok:true,result:[f.update(9)]});}});
  await assert.rejects(receiver.sync());assert.equal(f.queue.nextOffset(),0);assert.equal(f.queue.pending().length,0);assert.equal(f.store.inbox.verify().versions,0);
});

test('connection revocation during import rolls back whole page, retaining encrypted retry',async t=>{
  const f=fixture(t),original=f.store.inbox.importMessage.bind(f.store.inbox);
  f.store.inbox.importMessage=(...args)=>{const result=original(...args);f.grant.active=false;return result;};
  const receiver=createTelegramReceiver({...f.args,fetchImpl:async()=>Response.json({ok:true,result:[f.update(9),f.update(10)]})});
  await assert.rejects(receiver.sync());assert.equal(f.queue.pending().length,1);assert.equal(f.store.inbox.verify().versions,0);
  await assert.rejects(receiver.sync());assert.equal(f.store.inbox.verify().versions,0);
});

test('pending page cannot be imported after allowed chat scope narrows',async t=>{
  const f=fixture(t),original=f.store.inbox.importMessage.bind(f.store.inbox);
  f.store.inbox.importMessage=()=>{throw new Error('storage unavailable');};
  const receiver=createTelegramReceiver({...f.args,fetchImpl:async()=>Response.json({ok:true,result:[f.update(9)]})});
  await assert.rejects(receiver.sync());f.store.inbox.importMessage=original;
  f.grant.chatIds=[55];f.grant.revision++;
  const narrowed=createTelegramReceiver({...f.args,fetchImpl:async()=>{throw new Error('must not poll');}});
  await assert.rejects(narrowed.sync(),/chat_not_authorized/);
  assert.equal(f.queue.pending().length,1);assert.equal(f.store.inbox.verify().versions,0);
});
