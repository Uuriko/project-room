import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { TelegramConnectionRegistry } from '../server/telegram-connection-registry.mjs';
import { TelegramReceiveQueue } from '../server/telegram-receive-queue.mjs';
import { createTelegramConnections } from '../server/telegram-connections.mjs';

async function setup(t) {
  const f=createAcceptanceFixture(),rdb=new DatabaseSync(':memory:'),qdb=new DatabaseSync(':memory:');
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const b={accountId:account.id,connectionId:'telegram-one',authEpoch:account.authEpoch};
  const registry=new TelegramConnectionRegistry({db:rdb,key:Buffer.alloc(32,9)});
  registry.configure({...b,expectedRevision:0,botId:'123456',token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]});
  const queue=new TelegramReceiveQueue({db:qdb,key:Buffer.alloc(32,8),...b});let calls=0;
  const connections=createTelegramConnections({store:f.store,registry,connections:[{...b,queue}],fetchImpl:async()=>{calls++;return Response.json({ok:true,result:[{update_id:9,message:{message_id:1,chat:{id:44},from:{id:44},date:1700000000,text:'Private Telegram HTTP test'}}]});}});
  const server=createRoomServer({store:f.store,telegramConnections:connections});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rdb.close();qdb.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,headers={Cookie:`account_session=${slot.token}`,Origin:origin,'Content-Type':'application/json','X-Session-Binding':auth.sessionBinding,'X-CSRF-Token':auth.csrf};
  const path='/api/inbox/connections/telegram';
  return {...f,slot,auth,headers,connections,registry,queue,origin,calls:()=>calls,
    get:()=>fetch(origin+path,{headers}),post:(action,data={connectionId:'telegram-one',expectedRevision:1},h=headers)=>fetch(origin+path+'/'+action,{method:'POST',headers:h,body:JSON.stringify(data)})};
}

test('Telegram HTTP status, private receive and revision-bound disconnect work end to end',async t=>{
  const f=await setup(t),status=await(await f.get()).json();
  assert.equal(status.enabled,true);assert.deepEqual(status.connections,[{connectionId:'telegram-one',state:'active',revision:1}]);
  assert.ok(!JSON.stringify(status).includes('token'));
  const received=await(await f.post('sync')).json();assert.equal(received.imported,1);assert.equal(f.store.inbox.verify().versions,1);
  assert.equal((await f.post('disconnect',{connectionId:'telegram-one',expectedRevision:2})).status,409);
  assert.equal((await f.post('disconnect')).status,200);assert.equal((await f.get()).status,200);
  assert.equal((await f.post('sync')).status,409);assert.equal(f.calls(),1);
});

test('Telegram HTTP refuses missing authority, cross-origin, extra fields and foreign connection',async t=>{
  const f=await setup(t);
  for(const changes of [{Cookie:''},{'X-CSRF-Token':''},{'X-Session-Binding':'0'.repeat(64)},{Origin:'https://evil.test'},{Authorization:`Bearer ${f.keys.owner}`}])
    assert.ok((await f.post('sync',undefined,{...f.headers,...changes})).status>=400);
  assert.equal((await f.post('sync',{connectionId:'telegram-one',expectedRevision:1,token:'injected'})).status,422);
  assert.equal((await f.post('sync',{connectionId:'other',expectedRevision:1})).status,409);assert.equal(f.calls(),0);
});

test('Telegram HTTP conceals internal errors and rechecks session before response',async t=>{
  const f=await setup(t);
  f.connections.sync=()=>{throw new Error('SECRET_TOKEN');};
  const response=await f.post('sync');assert.equal(response.status,409);assert.ok(!(await response.text()).includes('SECRET'));
  f.connections.sync=()=>{f.store.logoutAccountSession(f.slot.token,f.auth.sessionRevision);return {imported:99};};
  const switched=await f.post('sync');assert.equal(switched.status,409);assert.ok(!(await switched.text()).includes('99'));
});
