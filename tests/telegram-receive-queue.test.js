import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramReceiveQueue } from '../server/telegram-receive-queue.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { readTelegramBotPage } from '../server/telegram-bot-reader.mjs';
import { importTelegramPage } from '../scripts/telegram-local-sync.mjs';
import { receiveTelegramTick } from '../server/telegram-receive-tick.mjs';

const options={key:Buffer.alloc(32,7),accountId:'account',connectionId:'telegram-one',authEpoch:0};
const page=(id,text='Private message')=>({nextOffset:id+1,observations:[{provider:'telegram',accountId:'account',connectionId:'telegram-one',providerRevision:String(id),text}],skipped:[]});

test('lease excludes another database handle and fences expired owners', t => {
  const dir=mkdtempSync(join(tmpdir(),'tg-lease-')),path=join(dir,'queue.sqlite');let now=1000;
  const a=new DatabaseSync(path),b=new DatabaseSync(path);t.after(()=>{a.close();b.close();rmSync(dir,{recursive:true,force:true});});
  const q1=new TelegramReceiveQueue({db:a,...options,now:()=>now}),q2=new TelegramReceiveQueue({db:b,...options,now:()=>now});
  const first=q1.acquireLease();assert.throws(()=>q2.acquireLease(),/busy/);
  now+=60001;const next=q2.acquireLease();assert.ok(next.generation>first.generation);
  assert.throws(()=>q1.stage(0,page(1),first),/lease_lost/);assert.equal(q1.nextOffset(),0);
  q1.releaseLease(first);q2.assertLease(next);q2.stage(0,page(1),next);q2.releaseLease(next);
});

test('pruning keeps undelivered work and frees delivered staging capacity', t => {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const q=new TelegramReceiveQueue({db,...options,maxPages:2});
  q.stage(0,page(1));q.stage(2,page(2));const [first]=q.pending();
  assert.equal(q.pruneDelivered(0),0);q.markDelivered(first.startOffset,first.fingerprint);
  assert.equal(q.pruneDelivered(0),1);assert.equal(q.pending().length,1);assert.equal(q.nextOffset(),3);
  q.stage(3,page(3));assert.equal(q.pending().length,2);
});

test('lease loss during fetch prevents page commit and releases only own lease', async t => {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=1000;
  const queue=new TelegramReceiveQueue({db,...options,now:()=>now});
  const grant={active:true,accountId:'account',connectionId:'telegram-one',authEpoch:0,revision:1,token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]};
  let replacement;
  await assert.rejects(receiveTelegramTick({queue,authorize:()=>grant,commitPage:()=>{throw new Error('must not import');},fetchImpl:async()=>{
    now+=60001;replacement=queue.acquireLease();return Response.json({ok:true,result:[]});
  }}));
  assert.equal(queue.nextOffset(),0);queue.assertLease(replacement);queue.releaseLease(replacement);
});

test('receive tick replays failed import before advancing provider request', async t => {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const queue=new TelegramReceiveQueue({db,...options});
  const grant={active:true,accountId:'account',connectionId:'telegram-one',authEpoch:0,revision:1,token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]};
  const offsets=[]; let failImport=true;
  const args={queue,authorize:()=>grant,commitPage:async()=>{if(failImport)throw new Error('storage failed');return {committed:true};},fetchImpl:async(url,options)=>{
    const n=JSON.parse(options.body).offset;offsets.push(n);return Response.json({ok:true,result:n===0?[{update_id:9,message:{message_id:2,chat:{id:44},from:{id:44},date:1700000000,text:'Test'}}]:[]});}};
  await assert.rejects(receiveTelegramTick(args));assert.equal(queue.pending().length,1);assert.deepEqual(offsets,[0]);
  failImport=false;await receiveTelegramTick(args);assert.deepEqual(offsets,[0,10]);assert.equal(queue.pending().length,0);
  await assert.rejects(receiveTelegramTick({...args,authorize:()=>({...grant,active:false})}));assert.deepEqual(offsets,[0,10]);
});

test('page and provider cursor persist together; encrypted pending work survives restart', t => {
  const dir=mkdtempSync(join(tmpdir(),'tg-queue-')),path=join(dir,'queue.sqlite'); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let db=new DatabaseSync(path),q=new TelegramReceiveQueue({db,...options});
  assert.deepEqual(q.stage(0,page(9)),{nextOffset:10,duplicate:false}); db.close();
  assert.equal(readFileSync(path).includes(Buffer.from('Private message')),false);
  db=new DatabaseSync(path);t.after(()=>db.close());q=new TelegramReceiveQueue({db,...options});
  assert.equal(q.nextOffset(),10);assert.equal(q.pending()[0].page.observations[0].text,'Private message');
  assert.equal(q.stage(0,page(9)).duplicate,true);
  assert.throws(()=>q.stage(0,page(9,'different')),/unconfirmed/);
  q.markDelivered(0,q.pending()[0].fingerprint);assert.equal(q.pending().length,0);
});

test('storage failure and stale pollers cannot advance cursor or lose pending data', t => {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const q=new TelegramReceiveQueue({db,...options});
  db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON telegram_queue_meta BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>q.stage(0,page(1)));assert.equal(q.nextOffset(),0);assert.equal(q.pending().length,0);
  db.exec('DROP TRIGGER fail_cursor');q.stage(0,page(1));
  assert.throws(()=>q.stage(0,page(2)));assert.equal(q.nextOffset(),2);assert.equal(q.pending().length,1);
});

test('scope, encryption integrity, capacity and malformed page fail closed', t => {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const q=new TelegramReceiveQueue({db,...options,maxPages:1});
  assert.throws(()=>new TelegramReceiveQueue({db,...options,accountId:'other'}));
  assert.throws(()=>new TelegramReceiveQueue({db,...options,key:Buffer.alloc(32,8)}));
  assert.throws(()=>q.stage(0,{...page(1),nextOffset:0}));
  assert.throws(()=>q.stage(0,{...page(1),observations:[{...page(1).observations[0],accountId:'other'}]}));
  q.stage(0,page(1));assert.throws(()=>q.stage(2,page(2)));assert.equal(q.nextOffset(),2);
  db.exec("UPDATE telegram_queue_pages SET ciphertext=X'00'");assert.throws(()=>q.pending(),/unconfirmed/);
});

test('crash after Inbox commit replays the pending page without duplicate messages', async t => {
  const f=createAcceptanceFixture(),db=new DatabaseSync(':memory:');
  t.after(()=>{db.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const session=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const grant={active:true,accountId:account.id,connectionId:'telegram-one',authEpoch:0,revision:1,token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]};
  const observed=await readTelegramBotPage({authorize:()=>grant,fetchImpl:async()=>Response.json({ok:true,result:[{update_id:9,message:{message_id:2,chat:{id:44},from:{id:44},date:1700000000,text:'Crash recovery test'}}]})});
  const q=new TelegramReceiveQueue({db,...options,accountId:account.id});q.stage(0,observed);
  assert.equal(importTelegramPage(f.store,slot,session,q.pending()[0].page).imported,1);
  // Simulate process loss before recording delivery; both stores remain durable.
  const resumed=new TelegramReceiveQueue({db,...options,accountId:account.id}),pending=resumed.pending()[0];
  assert.equal(importTelegramPage(f.store,slot,session,pending.page).imported,0);
  resumed.markDelivered(pending.startOffset,pending.fingerprint);
  assert.equal(resumed.pending().length,0);assert.equal(resumed.nextOffset(),10);
  assert.equal(f.store.inbox.verify().versions,1);
});
