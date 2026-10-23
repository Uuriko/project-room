import assert from 'node:assert/strict';
import test from 'node:test';
import {rmSync,mkdirSync} from 'node:fs';
import {chromium,webkit} from 'playwright';
import {createAcceptanceFixture} from './acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {signInFixture} from './auth-signin.mjs';
const engine=process.env.ROOM_BROWSER_ENGINE??'chromium';
if(!['chromium','webkit'].includes(engine))throw new Error('ROOM_BROWSER_ENGINE must be chromium or webkit');
test('assistant setup guidance respects audience and owner authority across host states', {timeout:90000}, async()=>{
const f=createAcceptanceFixture(), server=createRoomServer({store:f.store,streamInterval:40});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true});
const errors=[];
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await signInFixture(page,f.keys.owner);
 await page.locator('#assistant-setup-hint').waitFor({state:'visible'});
 assert.match(await page.locator('#assistant-setup-hint').innerText(),/No room assistant/);
 mkdirSync('test-results/setup-guidance',{recursive:true});
 for(const width of [1280,390])for(const theme of ['dark','light']) {
  await page.setViewportSize({width,height:900});await page.evaluate(v=>document.documentElement.dataset.theme=v,theme);
  const button=page.locator('#assistant-setup-hint button'); await button.scrollIntoViewIfNeeded();
  await button.focus();await page.keyboard.press('Enter');await page.locator('#room-assistant-setup').waitFor({state:'visible'});
  await page.keyboard.press('Escape');await page.locator('#room-assistant-setup').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`test-results/setup-guidance/${width}-${theme}.png`});
 }
 await page.selectOption('#message-to-select','guest');await page.locator('#assistant-setup-hint').waitFor({state:'hidden'});
 await page.selectOption('#message-to-select','');await page.locator('#assistant-setup-hint').waitFor({state:'visible'});
 await page.locator('#message-input').fill('@Room Please help with this example.');
 await page.locator('#message-form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#message-input').value==='');
 const snapshot=await fetch(`${origin}/api/rooms/commons/assistant`,{headers:{Authorization:`Bearer ${f.keys.owner}`}});
 assert.equal(snapshot.ok,true);assert.equal((await snapshot.json()).runs.length,0,'guidance must not start an assistant or change routing');
 const guest=await browser.newPage();await guest.goto(origin);await signInFixture(guest,f.keys.guest);
 await guest.locator('#assistant-setup-hint').waitFor({state:'visible'});
 assert.match(await guest.locator('#assistant-setup-hint').innerText(),/Ask the room owner/);
 assert.equal(await guest.locator('#assistant-setup-hint button').isVisible(),false);
 await page.locator('#assistant-setup-hint button').click();await page.selectOption('#room-assistant-setup select','producer');
 await page.locator('#room-assistant-setup button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#assistant-setup-hint').textContent.includes('waiting for its host'));
 assert.equal(await page.locator('#assistant-setup-hint button').isVisible(),false);
 // Drive read-only host availability observations without invoking a model.
 for(const availability of ['paused','connected']) {
  await page.route('**/api/rooms/commons/assistant',async route=>{
   if(route.request().method()!=='GET')return route.fallback();
   const response=await route.fetch();const body=await response.json();body.assistant.availability=availability;
   await route.fulfill({response,json:body});
  });
  if(availability==='paused')await page.waitForFunction(()=>document.querySelector('#assistant-setup-hint').textContent.includes('is paused'));
  else await page.locator('#assistant-setup-hint').waitFor({state:'hidden'});
  await page.unroute('**/api/rooms/commons/assistant');
 }
 assert.deepEqual(errors,[]); console.log('PASS owner/member setup, keyboard action, private audience, waiting/paused/connected states; desktop/phone and light/dark; no page errors.');
}finally{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});}
});
