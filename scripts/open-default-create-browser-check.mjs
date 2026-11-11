// Disposable local browser fixtures: verifies rendered creation choices and
// actual blank/template POST payloads, independently of server default tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {chromium} from 'playwright';
import {createAcceptanceFixture} from './acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {signInFixture} from './auth-signin.mjs';
import {readCurrentRecord,withCurrentReadContext} from '../server/current-room-repository.mjs';

for(const [name,viewport,visibility,template] of [
  ['desktop-open',{width:1280,height:900},'open',false],
  ['desktop-private-template',{width:1280,height:900},'private',true],
  ['mobile-open-template',{width:390,height:844},'open',true],
  ['mobile-private',{width:390,height:844},'private',false]
]) test(name+' creation sends the visible privacy choice',{timeout:30000},async t=>{
  const f=createAcceptanceFixture(),accountId='creation-'+name;
  f.store.createAccount(accountId);f.store.completeOnboarding(accountId);
  const server=createRoomServer({store:f.store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,...(process.env.ROOM_TEST_CHROMIUM_PATH?{executablePath:process.env.ROOM_TEST_CHROMIUM_PATH}:{})});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const page=await browser.newPage({viewport,reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.goto(origin+'/?account=1');
  await signInFixture(page,f.store.issueAccountAccessKey(accountId));
  await page.locator('#account-rooms-panel').waitFor();
  await page.locator('#account-room-create summary').click();
  const choice=page.getByRole('checkbox',{name:'Private room',exact:true});
  assert.equal(await choice.isChecked(),false);
  assert.equal(await choice.isVisible(),true);
  assert.match(await page.locator('#account-room-visibility-hint').innerText(),/New rooms are open/);
  if(visibility==='private')await choice.check();
  if(template){await page.waitForFunction(()=>document.querySelector('#account-room-template').options.length>1);await page.locator('#account-room-template').selectOption({index:1});}
  await page.locator('#account-room-title').fill('Creation '+name);
  await page.locator('#account-room-purpose').fill('Check the chosen joining policy');
  await page.locator('#account-room-name').fill('Room owner');
  await choice.scrollIntoViewIfNeeded();
  const box=await choice.boundingBox();assert.ok(box.width<60&&box.width>0,'checkbox keeps normal control width: '+JSON.stringify(box));
  await page.screenshot({path:`/tmp/open-default-${name}.png`,fullPage:true});
  const endpoint=template?'/api/account-rooms/from-template':'/api/account-rooms';
  const posted=page.waitForResponse(response=>new URL(response.url()).pathname===endpoint&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Create room',exact:true}).click();
  const response=await posted,payload=response.request().postDataJSON();
  assert.equal(payload.visibility,visibility);assert.equal(response.status(),201,await response.text());
  if(template)assert.equal(typeof payload.template,'string');
  const created=await response.json(),roomId=created.room.id;
  const metadata=withCurrentReadContext(f.store.db,roomId,()=>readCurrentRecord(f.store.db,roomId,'metadata','room'));
  assert.equal(metadata.publicPage?.enabled===true,visibility==='open');
  assert.equal(metadata.joinLink?.enabled===true,visibility==='open');
  await page.waitForFunction(()=>document.querySelector('#account-room-form').dataset.busy!=="true");
  assert.equal(await page.locator('#account-room-private').isChecked(),false,'successful creation resets privacy choice for the next room');
  assert.deepEqual(errors,[]);
});
