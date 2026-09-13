import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import twilio from 'twilio';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { importTwilioMessage } from '../server/twilio-inbox-import.mjs';

for (const provider of ['sms','whatsapp']) test(`${provider} signed text renders privately in Inbox`, async t => {
  const f=createAcceptanceFixture(), account=f.store.accountForMember('commons','owner');
  const key=f.store.issueAccountAccessKey(account.id),slot=f.store.createAccountSessionSlot();
  const session=f.store.loginAccountSession(slot.token,key,0),prefix=provider==='sms'?'':'whatsapp:';
  const c={active:true,accountId:account.id,connectionId:'twilio-test',authEpoch:0,revision:1,accountSid:'AC'+'a'.repeat(32),
    authToken:'test-secret',webhookUrl:'https://example.test/incoming',addresses:[prefix+'+14155550100']};
  const p={AccountSid:c.accountSid,MessageSid:'SM'+'b'.repeat(32),From:prefix+'+14155550101',To:c.addresses[0],NumMedia:'0',Body:'Private signed message fixture'};
  importTwilioMessage({store:f.store,slot,session,withConnection:fn=>fn(c),request:{rawBody:new URLSearchParams(p).toString(),
    contentType:'application/x-www-form-urlencoded',signature:twilio.getExpectedTwilioSignature(c.authToken,c.webhookUrl,p)}});
  const server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);
  await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);
  await page.locator('#sign-in-entry').click();await page.locator('#access-key').fill(key);await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#main').waitFor({state:'visible'});await page.locator('#nav-inbox').click();
  await page.getByRole('heading',{name:provider==='sms'?'SMS message':'WhatsApp message',exact:true}).waitFor();
  await page.getByText('Private signed message fixture',{exact:true}).waitFor();
  assert.equal(await page.locator('#inbox-source-label').textContent(),`${provider==='sms'?'SMS':'WhatsApp'} · only you`);
  assert.equal(await page.locator('#inbox-ask').isVisible(),false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});
