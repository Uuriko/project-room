// Disposable local browser fixtures; the real runtime trial is recorded separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync} from 'node:fs';
import {chromium} from 'playwright';
import {createAcceptanceFixture} from './acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {signInFixture} from './auth-signin.mjs';
import {openWorkFromSearch,openComposerOptions} from './room-chrome.mjs';
import {makeTestSigner} from './helpers/signed-evidence.mjs';
for(const theme of ['dark','light'])for(const width of [390,1440]){
 test(`task focus ${theme} ${width}: goal, exact current summary and next step together`,{timeout:60000},async t=>{
  const f=createAcceptanceFixture(),server=createRoomServer({store:f.store,streamInterval:60});let browser=null;
  t.after(async()=>{await browser?.close();server.closeStreams();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const id='focus-task', title='Review one bounded contribution';
  const send=(role,type,data)=>f.store.command(f.keys[role],'commons',{id:crypto.randomUUID(),type,data});
  send('owner','work.proposed',{workItemId:id,title,definitionOfDone:'Confirm the source and attach a useful check. '+ 'long-source-ref-'.repeat(30),accountableMemberId:'producer',verifierMemberId:'reviewer',independentVerificationRequired:true,mode:'read'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await signInFixture(page,f.keys.owner);
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  let card=await openWorkFromSearch(page,id,title);
  assert.equal(await card.locator('.work-details').evaluate(n=>n.open),false);
  assert.equal(await card.locator('[data-work-focus-goal]').isVisible(),true);
  assert.equal(await card.locator('[data-work-focus-result]').count(),0);
  assert.match(await card.locator('[data-next-step]').textContent(),/Accept the assignment/);
  send('producer','work.accepted',{workItemId:id,expectedRevision:0});
  send('producer','work.completed',{workItemId:id,expectedRevision:1,summary:'A checked result <img src=x onerror=alert(1)>',evidenceUrl:'https://example.invalid/result',signedEvidence:makeTestSigner(f.store)(),evidenceVersion:'focus-v1',producerId:'producer',nextAction:'Review this exact result'});
  await page.reload();await page.locator('#main').waitFor();await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  card=await openWorkFromSearch(page,id,title);
  assert.equal(await card.locator('[data-work-focus-goal]').isVisible(),true);
  assert.equal(await card.locator('[data-work-focus-result]').isVisible(),true);
  assert.match(await card.locator('[data-work-focus-result]').textContent(),/A checked result <img/);
  assert.equal(await card.locator('[data-work-focus-result] img').count(),0,'result text remains escaped');
  assert.equal(await card.locator('.work-details').evaluate(n=>n.open),false);
  assert.match(await card.locator('[data-next-step="verify"]').textContent(),/Review the exact submitted version/);
  const detail=card.locator('.work-details > summary');await detail.focus();await page.keyboard.press('Space');
  assert.equal(await card.locator('.work-details').evaluate(n=>n.open),true);await page.keyboard.press('Space');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  mkdirSync('test-results',{recursive:true});await card.screenshot({path:`test-results/task-focus-${theme}-${width}.png`});
  await page.keyboard.press('Escape');await openComposerOptions(page);await page.locator('#new-work-button').click();
  await page.locator('#new-work-form').waitFor();assert.match(await page.locator('#work-brief-help').textContent(),/one output, the allowed scope/);
  assert.equal(await page.locator('#work-done-input').getAttribute('aria-describedby'),'work-brief-help');
  await page.locator('#cancel-work-button').click();assert.deepEqual(errors,[]);
 });
}
