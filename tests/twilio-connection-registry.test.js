import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import twilio from 'twilio';
import { TwilioConnectionRegistry } from '../server/twilio-connection-registry.mjs';
import { importTwilioMessage } from '../server/twilio-inbox-import.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
const key=Buffer.alloc(32,9);
const config={accountId:'a',connectionId:'sms-one',authEpoch:0,expectedRevision:0,
  accountSid:'AC'+'a'.repeat(32),address:'+14155550100',authToken:'private-fixture-token',webhookUrl:'https://example.test/inbound'};

test('encrypted Twilio connection survives restart; stale grants and address reassignment fail',t=>{
  const directory=mkdtempSync(join(tmpdir(),'tw-registry-')),path=join(directory,'registry.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let db=new DatabaseSync(path),r=new TwilioConnectionRegistry({db,key});
  assert.deepEqual(r.configure(config),{state:'active',revision:1});r.close();db.close();
  assert.equal(readFileSync(path).includes(Buffer.from(config.authToken)),false);
  db=new DatabaseSync(path);r=new TwilioConnectionRegistry({db,key});t.after(()=>{r.close();db.close();});
  const binding={...config,expectedRevision:1};
  assert.equal(r.withGrant(binding,g=>g.authToken),config.authToken);
  assert.equal(JSON.stringify(r.status(binding)).includes(config.authToken),false);
  assert.throws(()=>r.withGrant({...binding,authEpoch:1},()=>{}));
  assert.throws(()=>r.configure({...config,accountId:'b'}));
  assert.throws(()=>r.configure({...config,expectedRevision:1,address:'+14155550199'}));
  assert.deepEqual(r.disconnect(binding),{state:'disconnected',revision:2});
  assert.throws(()=>r.withGrant(binding,()=>{}));
  assert.throws(()=>r.configure({...config,expectedRevision:1}));
  assert.throws(()=>r.configure({...config,accountId:'b'}));
  assert.equal(db.prepare('SELECT ciphertext FROM twilio_connections_v1').get().ciphertext,null);
  assert.equal(r.configure({...config,expectedRevision:2}).revision,3);
  const wrong=new TwilioConnectionRegistry({db,key:Buffer.alloc(32,4)});
  assert.throws(()=>wrong.withGrant({...binding,expectedRevision:3},()=>{}));wrong.close();
});

test('registry lock protects private import; disconnect blocks signed retries before receipt',t=>{
  const f=createAcceptanceFixture();t.after(()=>{f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const db=new DatabaseSync(':memory:'),r=new TwilioConnectionRegistry({db,key});t.after(()=>{r.close();db.close();});
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const session=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const c={...config,accountId:account.id};r.configure(c);const b={...c,expectedRevision:1};
  const p={AccountSid:c.accountSid,MessageSid:'SM'+'b'.repeat(32),From:'+14155550101',To:c.address,NumMedia:'0',Body:'Durable private text'};
  const receive=()=>importTwilioMessage({store:f.store,slot,session,withConnection:fn=>r.withGrant(b,fn),
    request:{rawBody:new URLSearchParams(p).toString(),contentType:'application/x-www-form-urlencoded',
      signature:twilio.getExpectedTwilioSignature(c.authToken,c.webhookUrl,p)}});
  assert.deepEqual(receive(),{imported:1,duplicate:false});
  assert.deepEqual(receive(),{imported:0,duplicate:true});
  r.withGrant(b,()=>assert.throws(()=>r.disconnect(b)));
  r.disconnect(b);assert.throws(receive);
  assert.equal(f.store.inbox.list(slot.token,session.sessionBinding).sources.length,1);
  assert.equal(f.store.inbox.verify().versions,1);
});

test('second registry handle cannot revoke a grant during its locked callback',t=>{
  const dir=mkdtempSync(join(tmpdir(),'tw-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'registry.sqlite'),db1=new DatabaseSync(path),db2=new DatabaseSync(path);
  const a=new TwilioConnectionRegistry({db:db1,key}),b=new TwilioConnectionRegistry({db:db2,key});
  t.after(()=>{a.close();b.close();db1.close();db2.close();});a.configure(config);
  const binding={...config,expectedRevision:1};
  a.withGrant(binding,()=>assert.throws(()=>b.disconnect(binding)));
  assert.equal(b.disconnect(binding).state,'disconnected');
  assert.throws(()=>a.withGrant(binding,()=>{}));
});
