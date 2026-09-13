import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import twilio from 'twilio';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { TwilioConnectionRegistry } from '../server/twilio-connection-registry.mjs';
import { createTwilioConnections } from '../server/twilio-connections.mjs';
import { createTwilioWebhookServer } from '../server/twilio-webhook.mjs';
import { auditRecovery } from '../server/recovery.mjs';

for(const provider of ['sms','whatsapp'])for(const width of [390,1280])test(`${provider} signed webhook → private Inbox → persistent disconnect at ${width}px`,async t=>{
  const f=createAcceptanceFixture(),path=join(f.directory,'messaging.sqlite'),key=Buffer.alloc(32,5);
  const db=new DatabaseSync(path),registry=new TwilioConnectionRegistry({db,key});
  let app,webhook,browser;
  t.after(async()=>{
    await browser?.close();
    for(const server of [app,webhook])if(server){server.closeStreams?.();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}
    registry.close();db.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});
  });
  const account=f.store.accountForMember('commons','owner'),accountKey=f.store.issueAccountAccessKey(account.id),slot=f.store.createAccountSessionSlot();
  const session=f.store.loginAccountSession(slot.token,accountKey,0),prefix=provider==='sms'?'':'whatsapp:';
  const binding={accountId:account.id,connectionId:'direct-one',authEpoch:0,expectedRevision:1};
  const config={...binding,expectedRevision:0,accountSid:'AC'+'a'.repeat(32),address:prefix+'+14155550100',
    authToken:'disposable-fixture-only',webhookUrl:'https://example.test/webhooks/twilio/direct-one'};
  registry.configure(config);
  webhook=createTwilioWebhookServer({store:f.store,routes:[{path:'/webhooks/twilio/direct-one',getSession:()=>({slot,session}),withConnection:fn=>registry.withGrant(binding,fn)}]});
  app=createRoomServer({store:f.store,twilioConnections:createTwilioConnections({store:f.store,registry,connections:[{...binding,provider}]})});
  await Promise.all([app,webhook].map(server=>new Promise(r=>server.listen(0,'127.0.0.1',r))));
  const payload={AccountSid:config.accountSid,MessageSid:'SM'+'b'.repeat(32),From:prefix+'+14155550101',To:config.address,NumMedia:'0',Body:'Private end-to-end message'};
  const deliver=(value=payload)=>fetch(`http://127.0.0.1:${webhook.address().port}/webhooks/twilio/direct-one`,{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':twilio.getExpectedTwilioSignature(config.authToken,config.webhookUrl,value)},body:new URLSearchParams(value).toString()});
  const sequence=f.store.room('commons').sequence;
  assert.equal((await deliver()).status,200);assert.equal((await deliver()).status,200);
  assert.equal(f.store.inbox.verify().versions,1);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width,height:844}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.address().port}/?room=commons`);
  await page.locator('#sign-in-entry').click();await page.locator('#access-key').fill(accountKey);await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#main').waitFor({state:'visible'});await page.locator('#nav-inbox').click();
  await page.getByText(payload.Body,{exact:true}).waitFor();
  const name=provider==='sms'?'SMS':'WhatsApp';assert.equal(await page.locator('#inbox-source-label').textContent(),`${name} · only you`);
  if(await page.locator('#inbox-back').isVisible())await page.locator('#inbox-back').click();
  await page.locator('#inbox-connections > summary').click();
  await page.getByRole('button',{name:`Disconnect ${name}`,exact:true}).click();
  await page.getByText('Disconnected here. Saved messages remain.',{exact:true}).waitFor();
  assert.equal(registry.status(binding).state,'disconnected');
  assert.equal((await deliver({...payload,MessageSid:'SM'+'c'.repeat(32),Body:'Must not import'})).status,503);
  assert.equal(f.store.inbox.verify().versions,1);
  const restartedDb=new DatabaseSync(path),restarted=new TwilioConnectionRegistry({db:restartedDb,key});
  try {assert.equal(restarted.status(binding).state,'disconnected');assert.throws(()=>restarted.withGrant(binding,()=>{}));}finally{restarted.close();restartedDb.close();}
  await page.locator('#inbox-list button').first().click();await page.getByText(payload.Body,{exact:true}).waitFor();
  assert.equal(f.store.room('commons').sequence,sequence);assert.ok(auditRecovery(f.store));
  page.on('dialog',d=>d.accept());await page.locator('#signout-button').click();
  await page.waitForFunction(()=>document.querySelector('#inbox-messaging-list').childElementCount===0);
  assert.deepEqual(errors,[]);
});
