import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rmSync} from 'node:fs';
import {chromium} from 'playwright';
import {createAcceptanceFixture} from './acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {TelegramConnectionRegistry} from '../server/telegram-connection-registry.mjs';
import {TelegramReceiveQueue} from '../server/telegram-receive-queue.mjs';
import {MessagingReceiveGrants} from '../server/messaging-receive-grants.mjs';
import {createTelegramConnections} from '../server/telegram-connections.mjs';

for(const width of [390,1280])test(`Telegram browser permission, logout receive and stop at ${width}px`,async t=>{
  const f=createAcceptanceFixture(),dbs=Array.from({length:3},()=>new DatabaseSync(':memory:'));
  const registry=new TelegramConnectionRegistry({db:dbs[0],key:Buffer.alloc(32,8)}),grants=new MessagingReceiveGrants({db:dbs[1],store:f.store});
  const account=f.store.accountForMember('commons','owner'),key=f.store.issueAccountAccessKey(account.id);
  const queue=new TelegramReceiveQueue({db:dbs[2],key:Buffer.alloc(32,7),accountId:account.id,connectionId:'one',authEpoch:0});
  registry.configure({accountId:account.id,connectionId:'one',authEpoch:0,expectedRevision:0,botId:'123456',token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]});
  let polls=0,app,browser;
  const service=createTelegramConnections({store:f.store,registry,receiveGrants:grants,connections:[{accountId:account.id,connectionId:'one',queue}],fetchImpl:async()=>{
    polls++;return Response.json({ok:true,result:polls===1?[{update_id:9,message:{message_id:9,chat:{id:44},from:{id:44},date:1700000000,text:'Telegram while signed out'}}]:[]});
  }});
  t.after(async()=>{await browser?.close();if(app){app.closeStreams?.();app.closeAllConnections();await new Promise(r=>app.close(r));}
    registry.close();grants.close();dbs.forEach(d=>d.close());f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  app=createRoomServer({store:f.store,telegramConnections:service});await new Promise(r=>app.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width,height:844}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const login=async()=>{await page.locator('#sign-in-entry').click();await page.locator('#access-key').fill(key);await page.locator('#auth-form button[type=submit]').click();
    await page.locator('#nav-inbox').waitFor({state:'visible'});await page.locator('#nav-inbox').click();};
  const connections=async()=>{if(await page.locator('#inbox-back').isVisible())await page.locator('#inbox-back').click();
    if(!(await page.locator('#inbox-connections').evaluate(e=>e.open)))await page.locator('#inbox-connections > summary').click();};
  await page.goto(`http://127.0.0.1:${app.address().port}/?room=commons`);await login();await connections();
  await page.getByRole('button',{name:'Sync Telegram',exact:true}).waitFor();
  await page.locator('#inbox-telegram-list summary').click();
  await page.getByRole('button',{name:'Allow for 24 hours · Telegram',exact:true}).click();
  await page.getByText('Receiving allowed for 24 hours.',{exact:true}).waitFor();
  assert.equal(polls,0);
  await page.locator('#signout-button').click();await page.locator('#sign-in-entry').waitFor({state:'visible'});
  assert.equal(await page.locator('#inbox-telegram-list').textContent(),'');
  assert.equal((await service.syncReceiving(account.id,'one')).imported,1);
  await login();await page.getByText('Telegram while signed out',{exact:true}).waitFor();await connections();
  await page.locator('#inbox-telegram-list summary').click();
  await page.getByRole('button',{name:'Stop receiving · Telegram',exact:true}).click();
  await page.getByText('Receiving stopped. Saved messages remain.',{exact:true}).waitFor();
  await assert.rejects(service.syncReceiving(account.id,'one'));assert.equal(polls,1);
  // Permission may commit even when the response is lost. Never offer a
  // blind retry with the old revision; require a fresh account-bound read.
  await page.route('**/connections/telegram/receiving/start',async route=>{await route.fetch();await route.abort();},{times:1});
  await page.locator('#inbox-telegram-list summary').click();
  await page.getByRole('button',{name:'Allow for 24 hours · Telegram',exact:true}).click();
  await page.getByText('Action unconfirmed. Refresh before trying again.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Allow for 24 hours · Telegram',exact:true}).count(),0);
  await page.getByRole('button',{name:'Refresh Telegram connections',exact:true}).click();
  await page.locator('#inbox-telegram-list summary').click();
  await page.getByRole('button',{name:'Stop receiving · Telegram',exact:true}).click();
  await page.getByText('Receiving stopped. Saved messages remain.',{exact:true}).waitFor();
  assert.equal(f.store.inbox.verify().versions,1);assert.deepEqual(errors,[]);
});
