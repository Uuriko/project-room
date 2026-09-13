import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import twilio from 'twilio';
import {createAcceptanceFixture} from './acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {TwilioConnectionRegistry} from '../server/twilio-connection-registry.mjs';
import {MessagingReceiveGrants} from '../server/messaging-receive-grants.mjs';
import {createTwilioConnections} from '../server/twilio-connections.mjs';
import {importTwilioBackgroundMessage} from '../server/twilio-inbox-import.mjs';
import {createTwilioWebhookServer} from '../server/twilio-webhook.mjs';

for(const provider of ['sms','whatsapp'])for(const width of [390,1280])test(`${provider} browser consent → signed receive after logout → persistent stop at ${width}px`,async t=>{
  const f=createAcceptanceFixture(),db=new DatabaseSync(join(f.directory,'provider.sqlite')),grantPath=join(f.directory,'grants.sqlite'),gd=new DatabaseSync(grantPath);
  const registry=new TwilioConnectionRegistry({db,key:Buffer.alloc(32,7)}),grants=new MessagingReceiveGrants({db:gd,store:f.store});
  let app,webhook,browser;
  t.after(async()=>{await browser?.close();for(const s of [app,webhook])if(s){s.closeStreams?.();s.closeAllConnections();await new Promise(r=>s.close(r));}
    grants.close();registry.close();gd.close();db.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const account=f.store.accountForMember('commons','owner'),key=f.store.issueAccountAccessKey(account.id),prefix=provider==='sms'?'':'whatsapp:';
  const config={accountId:account.id,connectionId:'one',authEpoch:0,expectedRevision:0,accountSid:'AC'+'a'.repeat(32),address:prefix+'+14155550100',
    authToken:'fixture-secret',webhookUrl:'https://example.test/receive'};
  registry.configure(config);
  app=createRoomServer({store:f.store,twilioConnections:createTwilioConnections({store:f.store,registry,receiveGrants:grants,connections:[{accountId:account.id,connectionId:'one',provider}]})});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  const binding={accountId:account.id,connectionId:'one',provider,connectionRevision:1,revision:1};
  webhook=createTwilioWebhookServer({store:f.store,routes:[{path:'/webhooks/twilio/one',background:{registry,grants,getBinding:()=>binding}}]});
  await new Promise(r=>webhook.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width,height:844}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const login=async()=>{await page.locator('#sign-in-entry').click();await page.locator('#access-key').fill(key);
    await page.locator('#auth-form button[type=submit]').click();
    // Re-entry restores the Inbox route directly; the room chat main stays
    // hidden there. Wait for authenticated navigation, not the room view.
    await page.locator('#nav-inbox').waitFor({state:'visible'});await page.locator('#nav-inbox').click();};
  const connections=async()=>{if(await page.locator('#inbox-back').isVisible())await page.locator('#inbox-back').click();
    if(!(await page.locator('#inbox-connections').evaluate(e=>e.open)))await page.locator('#inbox-connections > summary').click();};
  await page.goto(`http://127.0.0.1:${app.address().port}/?room=commons`);await login();await connections();
  const name=provider==='sms'?'SMS':'WhatsApp';
  await page.locator('#inbox-messaging-list summary').click();
  await page.getByText('Allow incoming messages for 24 hours, even after sign-out. No sending or sharing.',{exact:true}).waitFor();
  await page.getByRole('button',{name:`Allow for 24 hours · ${name}`,exact:true}).click();
  await page.getByText('Receiving allowed for 24 hours.',{exact:true}).waitFor();
  await page.locator('#signout-button').click();await page.locator('#sign-in-entry').waitFor({state:'visible'});
  assert.equal(await page.locator('#inbox-messaging-list').textContent(),'');
  const params={AccountSid:config.accountSid,MessageSid:'SM'+'b'.repeat(32),From:prefix+'+14155550101',To:config.address,NumMedia:'0',Body:'Received while signed out'};
  const receive=(p=params,g=grants)=>importTwilioBackgroundMessage({store:f.store,registry,grants:g,binding,
    request:{rawBody:new URLSearchParams(p).toString(),contentType:'application/x-www-form-urlencoded',signature:twilio.getExpectedTwilioSignature(config.authToken,config.webhookUrl,p)}});
  const sequence=f.store.room('commons').sequence;
  const deliver=p=>fetch(`http://127.0.0.1:${webhook.address().port}/webhooks/twilio/one`,{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':twilio.getExpectedTwilioSignature(config.authToken,config.webhookUrl,p)},body:new URLSearchParams(p).toString()});
  const tampered=await fetch(`http://127.0.0.1:${webhook.address().port}/webhooks/twilio/one`,{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':'invalid'},body:new URLSearchParams(params).toString()});
  assert.equal(tampered.status,503);assert.equal(f.store.inbox.verify().versions,0);
  const delivered=await deliver(params);assert.equal(delivered.status,200);assert.ok((await delivered.text()).includes('<Response></Response>'));
  assert.equal((await deliver(params)).status,200);assert.equal(f.store.inbox.verify().versions,1);
  await login();await page.getByText(params.Body,{exact:true}).waitFor();
  assert.equal(await page.locator('#inbox-source-label').textContent(),`${name} · only you`);
  await connections();await page.locator('#inbox-messaging-list summary').click();
  await page.getByRole('button',{name:`Stop receiving · ${name}`,exact:true}).click();
  await page.getByText('Receiving stopped. Saved messages remain.',{exact:true}).waitFor();
  const next={...params,MessageSid:'SM'+'c'.repeat(32),Body:'Must not import'};
  assert.equal((await deliver(next)).status,503);assert.throws(()=>receive(next));
  const reopenedDb=new DatabaseSync(grantPath),reopened=new MessagingReceiveGrants({db:reopenedDb,store:f.store});
  try{assert.throws(()=>receive(next,reopened));}finally{reopened.close();reopenedDb.close();}
  assert.equal(registry.status(config).state,'active');assert.equal(f.store.inbox.verify().versions,1);
  await page.locator('#inbox-list button').first().click();await page.getByText(params.Body,{exact:true}).waitFor();
  assert.equal(f.store.room('commons').sequence,sequence);assert.deepEqual(errors,[]);
});
