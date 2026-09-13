import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,realpathSync,writeFileSync,chmodSync,symlinkSync,linkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwilioConnectionRegistry } from '../server/twilio-connection-registry.mjs';
import { createTwilioRuntime } from '../server/twilio-runtime.mjs';
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
