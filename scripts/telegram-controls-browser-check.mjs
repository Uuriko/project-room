import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for(const mobile of [false,true])test(`Telegram controls stay quiet and clear on sign-out (${mobile?'mobile':'desktop'})`,async t=>{
  const f=createAcceptanceFixture(),calls=[];let state='active',revision=1;
  const key=f.store.issueAccountAccessKey(f.store.accountForMember('commons','owner').id);
  const telegramConnections={list:()=>[{connectionId:'telegram-one',state,revision}],
    sync:(session,id,expected)=>{calls.push(['sync',id,expected]);return {connectionId:id,revision,imported:2};},
    disconnect:(session,id,expected)=>{calls.push(['disconnect',id,expected]);state='disconnected';revision++;return {connectionId:id,state,revision};}};
  const server=createRoomServer({store:f.store,telegramConnections});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);await page.locator('#sign-in-entry').click();
  await page.locator('#access-key').fill(key);await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#main').waitFor({state:'visible'});await page.locator('#nav-inbox').click();
  assert.equal(await page.getByRole('button',{name:'Sync Telegram',exact:true}).count(),0);
  await page.locator('#inbox-connections > summary').click();
  await page.getByRole('button',{name:'Sync Telegram',exact:true}).click();
  await page.getByText('2 messages synced.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Disconnect Telegram',exact:true}).click();
  await page.getByText('Disconnected here. Saved messages remain.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sync Telegram',exact:true}).count(),0);
  assert.deepEqual(calls,[['sync','telegram-one',1],['disconnect','telegram-one',1]]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  page.on('dialog',d=>d.accept());await page.locator('#signout-button').click();
  await page.waitForFunction(()=>document.querySelector('#inbox-telegram-list').childElementCount===0&&document.querySelector('#inbox-telegram-status').textContent==='');
  assert.deepEqual(errors,[]);
});
