import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,realpathSync,writeFileSync,chmodSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramConnectionRegistry } from '../server/telegram-connection-registry.mjs';
import { TelegramReceiveQueue } from '../server/telegram-receive-queue.mjs';
import { createTelegramRuntime } from '../server/telegram-runtime.mjs';
import { MessagingReceiveGrants } from '../server/messaging-receive-grants.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createTelegramScheduler } from '../server/telegram-scheduler.mjs';

function fixture(t,accountId='account') {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'tg-runtime-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const key=Buffer.alloc(32,7),env={ROOM_TELEGRAM_REGISTRY_FILE:join(dir,'registry.sqlite'),ROOM_TELEGRAM_QUEUE_FILE:join(dir,'queue.sqlite'),ROOM_TELEGRAM_KEY_FILE:join(dir,'key'),ROOM_TELEGRAM_ACCOUNT_ID:accountId,ROOM_TELEGRAM_CONNECTION_ID:'telegram-one'};
  writeFileSync(env.ROOM_TELEGRAM_KEY_FILE,key,{mode:0o600});
  const binding={accountId,connectionId:'telegram-one',authEpoch:0};
  const rdb=new DatabaseSync(env.ROOM_TELEGRAM_REGISTRY_FILE),registry=new TelegramConnectionRegistry({db:rdb,key});
  registry.configure({...binding,expectedRevision:0,botId:'123456',token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]});rdb.close();
  const qdb=new DatabaseSync(env.ROOM_TELEGRAM_QUEUE_FILE);new TelegramReceiveQueue({db:qdb,key,...binding});qdb.close();
  chmodSync(env.ROOM_TELEGRAM_REGISTRY_FILE,0o600);chmodSync(env.ROOM_TELEGRAM_QUEUE_FILE,0o600);
  const store={account:()=>({id:accountId,active:true,authEpoch:0})};
  return {dir,env,open:extra=>createTelegramRuntime({env,store,...extra})};
}
test('runtime disabled without config; existing stores open and close without provider calls',t=>{
  assert.equal(createTelegramRuntime({env:{}}),null);const f=fixture(t);
  const runtime=f.open({fetchImpl:()=>{throw new Error('must not fetch');}});assert.ok(runtime.connections);runtime.close();runtime.close();f.open().close();
});
test('private receive grant runtime stays inert until consent; scheduler resolves revocation and persisted state',async t=>{
  const a=createAcceptanceFixture();t.after(()=>{a.store.close();rmSync(a.directory,{recursive:true,force:true});});
  const account=a.store.accountForMember('commons','owner'),f=fixture(t,account.id),slot=a.store.createAccountSessionSlot();
  const auth=a.store.loginAccountSession(slot.token,a.store.issueAccountAccessKey(account.id),0),session={token:slot.token,binding:auth.sessionBinding};
  f.env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE=join(f.dir,'grants.sqlite');
  const db=new DatabaseSync(f.env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE),grants=new MessagingReceiveGrants({db,store:a.store});grants.close();db.close();chmodSync(f.env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE,0o600);
  let polls=0;
  const runtime=f.open({store:a.store,fetchImpl:async()=>{polls++;return Response.json({ok:true,result:[]});}});
  let fire;const scheduler=createTelegramScheduler({sync:()=>runtime.connections.syncReceiving(account.id,'telegram-one'),setTimer(fn){fire=fn;return 1;},clearTimer(){fire=null;}});
  t.after(async()=>{await scheduler.stop();runtime.close();});
  assert.equal(runtime.connections.receivingStatus(session).connections[0].state,'missing');assert.equal(polls,0);
  scheduler.start();await fire();assert.equal(polls,0);
  runtime.connections.startReceiving(session,{connectionId:'telegram-one',expectedRevision:0,expectedConnectionRevision:1});
  await fire();assert.equal(polls,1);
  runtime.connections.stopReceiving(session,{connectionId:'telegram-one',expectedRevision:1});
  await fire();assert.equal(polls,1);
  await scheduler.stop();runtime.close();
  const reopened=f.open({store:a.store});assert.equal(reopened.connections.receivingStatus(session).connections[0].state,'revoked');reopened.close();
});
test('optional receive store must be preprovisioned, private, distinct and exact-schema',t=>{
  const f=fixture(t),path=join(f.dir,'grants.sqlite');
  assert.throws(()=>f.open({env:{ROOM_TELEGRAM_RECEIVE_GRANTS_FILE:path}}));
  f.env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE=path;assert.throws(()=>f.open());
  const db=new DatabaseSync(path);db.exec('CREATE TABLE messaging_receive_grants_v1 (junk TEXT)');db.close();chmodSync(path,0o600);
  assert.throws(()=>f.open(),{code:'telegram_private_configuration_invalid'});
  const inspect=new DatabaseSync(path,{readOnly:true});assert.equal(inspect.prepare('PRAGMA table_info(messaging_receive_grants_v1)').all()[0].name,'junk');inspect.close();
  assert.throws(()=>f.open({env:{...f.env,ROOM_TELEGRAM_RECEIVE_GRANTS_FILE:f.env.ROOM_TELEGRAM_QUEUE_FILE}}));
  chmodSync(path,0o644);assert.throws(()=>f.open());
});
test('partial configuration, weak permissions, symlinks and source-tree paths rejected',t=>{
  const f=fixture(t);assert.throws(()=>f.open({env:{ROOM_TELEGRAM_KEY_FILE:f.env.ROOM_TELEGRAM_KEY_FILE}}));
  assert.throws(()=>f.open({sourceRoot:f.dir}));
  chmodSync(f.env.ROOM_TELEGRAM_KEY_FILE,0o644);assert.throws(()=>f.open());chmodSync(f.env.ROOM_TELEGRAM_KEY_FILE,0o600);
  const link=join(f.dir,'link');symlinkSync(f.env.ROOM_TELEGRAM_KEY_FILE,link);assert.throws(()=>f.open({env:{...f.env,ROOM_TELEGRAM_KEY_FILE:link}}));
});
test('wrong key, mismatched epoch and foreign database schema fail without migration',t=>{
  const f=fixture(t);writeFileSync(f.env.ROOM_TELEGRAM_KEY_FILE,Buffer.alloc(32,8));assert.throws(()=>f.open());
  writeFileSync(f.env.ROOM_TELEGRAM_KEY_FILE,Buffer.alloc(32,7));
  assert.throws(()=>f.open({store:{account:()=>({id:'account',active:true,authEpoch:1})}}));
  const db=new DatabaseSync(f.env.ROOM_TELEGRAM_QUEUE_FILE);db.exec('CREATE TABLE rooms(id TEXT)');db.close();
  assert.throws(()=>f.open(),{code:'telegram_private_configuration_invalid'});
});
