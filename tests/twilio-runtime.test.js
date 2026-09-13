import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,realpathSync,writeFileSync,chmodSync,symlinkSync,linkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwilioConnectionRegistry } from '../server/twilio-connection-registry.mjs';
import { createTwilioRuntime } from '../server/twilio-runtime.mjs';
import { MessagingReceiveGrants } from '../server/messaging-receive-grants.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import twilio from 'twilio';
function fixture(t) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'tw-runtime-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const key=Buffer.alloc(32,7),env={ROOM_TWILIO_REGISTRY_FILE:join(dir,'registry.sqlite'),ROOM_TWILIO_KEY_FILE:join(dir,'key'),ROOM_TWILIO_ACCOUNT_ID:'account',ROOM_TWILIO_CONNECTION_ID:'one'};
  writeFileSync(env.ROOM_TWILIO_KEY_FILE,key,{mode:0o600});
  const binding={accountId:'account',connectionId:'one',authEpoch:0};
  const db=new DatabaseSync(env.ROOM_TWILIO_REGISTRY_FILE),r=new TwilioConnectionRegistry({db,key});
  r.configure({...binding,expectedRevision:0,accountSid:'AC'+'a'.repeat(32),address:'whatsapp:+14155550100',authToken:'private-test-key',webhookUrl:'https://example.test/inbound'});r.close();db.close();
  chmodSync(env.ROOM_TWILIO_REGISTRY_FILE,0o600);
  const account={id:'account',active:true,authEpoch:0},store={account:()=>account,authenticateAccountSession:()=>({account})};
  return {dir,env,binding,open:extra=>createTwilioRuntime({env,store,...extra})};
}
test('optional runtime opens existing connection controls and persisted disconnect, without a receiver',t=>{
  assert.equal(createTwilioRuntime({env:{}}),null);const f=fixture(t),r=f.open();
  assert.deepEqual(r.connections.list({}),[{connectionId:'one',provider:'whatsapp',state:'active',revision:1}]);
  assert.equal(r.connections.disconnect({},'one',1).state,'disconnected');r.close();r.close();
  const again=f.open();assert.equal(again.connections.list({})[0].state,'disconnected');again.close();
  assert.throws(()=>again.connections.list({}));
});
test('partial config, source paths, loose permissions, symlinks and hardlinks fail closed',t=>{
  const f=fixture(t);assert.throws(()=>f.open({env:{ROOM_TWILIO_KEY_FILE:f.env.ROOM_TWILIO_KEY_FILE}}));
  assert.throws(()=>f.open({sourceRoot:f.dir}));
  chmodSync(f.env.ROOM_TWILIO_KEY_FILE,0o644);assert.throws(()=>f.open());chmodSync(f.env.ROOM_TWILIO_KEY_FILE,0o600);
  symlinkSync(f.env.ROOM_TWILIO_KEY_FILE,join(f.dir,'link'));assert.throws(()=>f.open({env:{...f.env,ROOM_TWILIO_KEY_FILE:join(f.dir,'link')}}));
  linkSync(f.env.ROOM_TWILIO_KEY_FILE,join(f.dir,'hard'));assert.throws(()=>f.open());
});
test('wrong encryption key, old epoch, inactive account and foreign schema rejected',t=>{
  const f=fixture(t);writeFileSync(f.env.ROOM_TWILIO_KEY_FILE,Buffer.alloc(32,8));assert.throws(()=>f.open(),{code:'twilio_private_configuration_invalid'});
  writeFileSync(f.env.ROOM_TWILIO_KEY_FILE,Buffer.alloc(32,7));
  for(const account of [{id:'account',active:true,authEpoch:1},{id:'account',active:false,authEpoch:0}])assert.throws(()=>f.open({store:{account:()=>account}}));
  const db=new DatabaseSync(f.env.ROOM_TWILIO_REGISTRY_FILE);db.exec('CREATE TABLE unrelated(id TEXT)');db.close();assert.throws(()=>f.open());
});

test('existing private receive store assembles an unstarted listener; consent renewal resolves current grants',async t=>{
  const f=fixture(t),a=createAcceptanceFixture();a.store.createAccount('account');
  const env={...f.env,ROOM_TWILIO_RECEIVE_GRANTS_FILE:join(f.dir,'receive.sqlite'),ROOM_TWILIO_WEBHOOK_PATH:'/webhooks/twilio/one'};
  const gdb=new DatabaseSync(env.ROOM_TWILIO_RECEIVE_GRANTS_FILE),g=new MessagingReceiveGrants({db:gdb,store:a.store});g.close();gdb.close();chmodSync(env.ROOM_TWILIO_RECEIVE_GRANTS_FILE,0o600);
  // The configured signature URL must agree with the exact route.
  assert.throws(()=>f.open({env,store:a.store}));
  const db=new DatabaseSync(env.ROOM_TWILIO_REGISTRY_FILE),registry=new TwilioConnectionRegistry({db,key:Buffer.alloc(32,7)});
  registry.configure({...f.binding,expectedRevision:1,accountSid:'AC'+'a'.repeat(32),address:'whatsapp:+14155550100',authToken:'private-test-key',webhookUrl:'https://example.test/webhooks/twilio/one'});registry.close();db.close();
  for(const bad of [{...f.env,ROOM_TWILIO_RECEIVE_GRANTS_FILE:env.ROOM_TWILIO_RECEIVE_GRANTS_FILE},
    {...env,ROOM_TWILIO_RECEIVE_GRANTS_FILE:env.ROOM_TWILIO_REGISTRY_FILE},
    {...env,ROOM_TWILIO_WEBHOOK_PATH:'/wrong'}])assert.throws(()=>f.open({env:bad,store:a.store}));
  chmodSync(env.ROOM_TWILIO_RECEIVE_GRANTS_FILE,0o644);assert.throws(()=>f.open({env,store:a.store}));chmodSync(env.ROOM_TWILIO_RECEIVE_GRANTS_FILE,0o600);
  const runtime=f.open({env,store:a.store});t.after(()=>{runtime.close();a.store.close();rmSync(a.directory,{recursive:true,force:true});});
  assert.equal(runtime.webhook.listening,false);
  const slot=a.store.createAccountSessionSlot(),auth=a.store.loginAccountSession(slot.token,a.store.issueAccountAccessKey('account'),0),session={token:slot.token,binding:auth.sessionBinding};
  assert.equal(runtime.connections.receivingStatus(session).connections[0].state,'missing');
  await new Promise(r=>runtime.webhook.listen(0,'127.0.0.1',r));
  const params={AccountSid:'AC'+'a'.repeat(32),MessageSid:'SM'+'b'.repeat(32),From:'whatsapp:+14155550101',To:'whatsapp:+14155550100',NumMedia:'0',Body:'Startup test'};
  const deliver=()=>fetch(`http://127.0.0.1:${runtime.webhook.address().port}/webhooks/twilio/one`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',
    'x-twilio-signature':twilio.getExpectedTwilioSignature('private-test-key','https://example.test/webhooks/twilio/one',params)},body:new URLSearchParams(params).toString()});
  assert.equal((await deliver()).status,503);
  runtime.connections.startReceiving(session,{connectionId:'one',expectedRevision:0,expectedConnectionRevision:2});assert.equal((await deliver()).status,200);
  runtime.connections.stopReceiving(session,{connectionId:'one',expectedRevision:1});assert.equal((await deliver()).status,503);
  runtime.connections.startReceiving(session,{connectionId:'one',expectedRevision:2,expectedConnectionRevision:2});assert.equal((await deliver()).status,200);
  assert.equal(a.store.inbox.verify().versions,1);
});
