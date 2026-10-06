import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { openCatchUpPanel } from './room-chrome.mjs';
import { signInFixture } from './auth-signin.mjs';

test('two humans share public assistant prompts, constraints, confirmed activity and results; banter stays quiet', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  for (const [type,data] of [
    ['work.proposed',{workItemId:'human-result-task',title:'Write a short result',definitionOfDone:'A readable result is saved',accountableMemberId:'owner',mode:'read',independentVerificationRequired:false,ownerDecisionRequired:false}],
    ['work.accepted',{workItemId:'human-result-task',expectedRevision:0}],
    ['work.started',{workItemId:'human-result-task',expectedRevision:1}]
  ]) f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type,data});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({headless:true});
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  const errors = [], pages = [];
  for(const member of ['owner','guest']) {
    const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage();
    page.on('pageerror', e=>errors.push(e.message)); await page.goto(origin); await signInFixture(page,f.keys[member]);
    await page.locator('#main').waitFor({state:'visible'}); await page.waitForFunction(()=>document.body.classList.contains('human-experience')); pages.push(page);
  }
  const [owner,peer] = pages;
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {method:input?'POST':'GET',headers:{Authorization:`Bearer ${f.keys[actor]}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify({requestId:crypto.randomUUID(),...input})}:{})});
    const json=await response.json(); assert.ok(response.ok,JSON.stringify(json));return json;
  };
  assert.equal(await owner.locator('#tasks-destination').isVisible(),false);
  await owner.locator('#assistant-setup').click(); await owner.locator('#room-assistant-setup select').selectOption('producer');
  await owner.locator('#room-assistant-setup button[type=submit]').click(); await owner.locator('#room-assistant-setup').waitFor({state:'hidden'});
  await owner.waitForFunction(()=>document.querySelector('#room-assistant-status').textContent==='Waiting for connection');
  const send = async (page, body) => { await page.locator('#message-input').fill(body); await page.locator('#message-form button[type=submit]').click(); await page.waitForFunction(()=>document.querySelector('#message-input').value===''); };
  await send(peer,'Hey friends, good to see you!'); assert.equal((await api('owner')).runs.length,0);
  await owner.locator('#ask-room').click(); await send(owner,'Compare our launch ideas.');
  await owner.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Compare our launch ideas.'));
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Compare our launch ideas.'));
  let run=(await api('producer')).runs[0]; assert.equal(run.status,'queued');
  await peer.locator('#assistant-activity').evaluate(n=>{n.open=true;});
  await peer.getByRole('button',{name:'Add context',exact:true}).click(); await send(peer,'Keep the design mobile first.');
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('mobile first'));
  run=(await api('producer')).runs[0]; assert.equal(run.inputs.length,2); assert.equal(run.inputs[1].status,'pending');
  run=(await api('producer',{action:'claim',runId:run.id,attemptId:'test-host',expectedRevision:run.revision})).result;
  run=(await api('producer',{action:'report',runId:run.id,attemptId:'test-host',expectedRevision:run.revision,state:'working',summary:'Comparing mobile readability.',appliedInputMessageIds:run.inputs.map(i=>i.sourceMessageId)})).result;
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Comparing mobile readability.'));
  const post = await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{Authorization:`Bearer ${f.keys.producer}`,'Content-Type':'application/json'},body:JSON.stringify({id:'public-result-command',type:'message.posted',data:{messageId:'public-result',body:'Recommendation: choose the simpler mobile layout.'}})});assert.ok(post.ok);
  await api('producer',{action:'report',runId:run.id,attemptId:'test-host',expectedRevision:run.revision,state:'done',summary:'The recommendation is ready.',resultMessageId:'public-result'});
  for(const page of pages) { await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Result ready')); await page.locator('[data-message-record-id="public-result"]').waitFor(); }
  await owner.locator('#room-more > summary').click(); await owner.locator('#topbar-settings').click();
  await owner.locator('#human-advanced').check(); assert.equal(await owner.locator('#human-advanced').isChecked(),true);
  await owner.locator('#human-advanced').uncheck();
  await owner.keyboard.press('Escape');
  const resultTask = owner.locator('[data-work-record-id="human-result-task"]');
  await resultTask.locator('details.work-details > summary').click();
  await resultTask.locator('[data-action="complete"]').click();
  const humanResultBody = 'A result written by a human, without protocol fields.';
  await owner.locator('#human-share-result textarea').fill(humanResultBody);
  // The task changes after opening the result editor. The real server rejects
  // the old proposal revision; recovery must preserve text and require review.
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'work.blocked',data:{workItemId:'human-result-task',expectedRevision:2,reason:'New requirement',nextAction:'Review the updated task'}});
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'work.started',data:{workItemId:'human-result-task',expectedRevision:3,resolvedBlocker:'Requirement reviewed'}});
  const rejectedDraft = owner.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.data?.body === humanResultBody);
  await owner.locator('#human-share-result button[type=submit]').click();
  assert.equal((await rejectedDraft).status(),409);
  assert.equal(f.store.room('commons').state.messages.filter(m=>m.body===humanResultBody).length,0);
  await owner.locator('#human-share-refresh').waitFor({state:'visible',timeout:3000});
  assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
  await owner.locator('#human-share-refresh').click();
  await owner.waitForFunction(()=>!document.querySelector('#human-share-result textarea').disabled);
  assert.equal(await owner.locator('#human-share-result textarea').isEnabled(),true);
  assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
  // A committed draft with a lost response is a different case: retry the
  // same immutable command, even if transport confirmation is unavailable.
  const draftCommands = [];
  await owner.route('**/api/rooms/commons/commands',async route=>{
    const command=route.request().postDataJSON();
    if(command?.data?.body===humanResultBody) {
      draftCommands.push(command);
      if(draftCommands.length===1) { await route.fetch(); await route.abort(); return; }
    }
    await route.continue();
  });
  await owner.locator('#human-share-result button[type=submit]').click();
  await owner.locator('#human-share-result button[type=submit]').filter({hasText:'Retry original draft'}).waitFor();
  assert.equal(await owner.locator('#human-share-refresh').isVisible(),false);
  await owner.locator('#human-share-result button[type=submit]').click();
  await owner.locator('#action-dialog').waitFor({state:'visible'});
  await owner.unroute('**/api/rooms/commons/commands');
  assert.equal(draftCommands.length,2); assert.deepEqual(draftCommands[1],draftCommands[0]);
  assert.equal(draftCommands[0].data.basisRevision,4);
  assert.equal(f.store.room('commons').state.messages.filter(m=>m.body===humanResultBody).length,1);
  assert.equal(await owner.locator('#action-fields [name=signedEvidence]').count(),0);
  await owner.locator('#action-fields [name=producerId]').selectOption('owner');
  await owner.locator('#action-fields [name=summary]').fill('Simple human result');
  await owner.locator('#action-fields [name=nextAction]').fill('Discuss together');
  await owner.locator('#action-form button[type=submit]').click(); await owner.locator('#action-dialog').waitFor({state:'hidden'});
  assert.ok(f.store.room('commons').state.workItems['human-result-task'].receipt.nativeText);
  // An invocation committed on the server but its response was lost. Reload + exact retry
  // must recover one run, while keeping the already-posted prompt in the transcript.
  await owner.route('**/api/rooms/commons/assistant', async route => {
    const payload = route.request().postDataJSON();
    if (route.request().method() === 'POST' && payload?.action === 'invoke') {
      await route.fetch(); await route.abort(); await owner.unroute('**/api/rooms/commons/assistant');
    } else await route.continue();
  });
  await owner.locator('#ask-room').click(); await send(owner,'Recover this request exactly once.');
  await owner.locator('#assistant-retry').waitFor({state:'visible'});
  const beforeRetry = (await api('owner')).runs;
  assert.equal(beforeRetry.length,2);
  await owner.reload(); await owner.locator('#main').waitFor({state:'visible'});
  await owner.locator('#assistant-retry').waitFor({state:'visible'}); await owner.locator('#assistant-retry').click();
  await owner.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal((await api('owner')).runs.length,2);
  // Select context at revision N; the host claims N+1 before the human sends.
  // A rejected stale write needs review and a new explicit confirmation, not an endless retry.
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Recover this request exactly once.'));
  let recovery = (await api('producer')).runs.find(r=>r.id!==run.id);
  await peer.locator(`[data-assistant-run="${recovery.id}"] [data-contribute-run]`).first().click();
  recovery = (await api('producer',{action:'claim',runId:recovery.id,attemptId:'recovery-host',expectedRevision:recovery.revision})).result;
  await send(peer,'Please include our latest constraint.');
  await peer.locator('#assistant-review').waitFor({state:'visible'});
  assert.equal((await api('producer')).runs.find(r=>r.id===recovery.id).inputs.length,1);
  await peer.locator('#assistant-review').click(); await peer.locator('#assistant-retry').click();
  await peer.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal((await api('producer')).runs.find(r=>r.id===recovery.id).inputs.length,2);
  // The result link returns to the exact public answer, rather than a different run.
  await peer.locator('[data-assistant-message="public-result"]').click();
  assert.equal(await peer.locator('[data-message-record-id="public-result"]').count(),1);
  mkdirSync('test-results',{recursive:true}); await peer.screenshot({path:'test-results/human-shared-conversation.png',fullPage:false});
  assert.deepEqual(errors,[]);
});

// Owns post-login discovery, preference persistence, draft recovery and first-screen simplicity.
test('human Advanced tools stay out of the door and preserve squad drafts and saved preferences', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({store:f.store, streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const page=await browser.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/#join-agent');
  assert.equal(await page.locator('#connect-guide-dialog').isVisible(),false);
  assert.equal(await page.locator('#connect-guide-open').isVisible(),false);
  assert.equal(await page.getByRole('link',{name:'Demo conversation'}).isVisible(),false);
  await signInFixture(page,f.keys.owner);
  await page.locator('#connect-guide-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#connect-guide-copy').innerText(),/running host/);
  await page.locator('#connect-guide-close').click();
  assert.equal(await page.locator('#squads-open').isVisible(),false);
  await page.locator('#room-more > summary').click(); await page.locator('#topbar-settings').click();
  await page.keyboard.press('Escape'); await openCatchUpPanel(page,'notification-panel');
  await page.locator('#human-push-prefs').waitFor({state:'visible'});
  await page.route('**/api/rooms/commons/human-push', async route => {
    if (route.request().method() === 'PATCH') await new Promise(resolve=>setTimeout(resolve,250));
    await route.continue();
  });
  await page.locator('#human-push-pref-dm').uncheck();
  f.store.command(f.keys.guest,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:crypto.randomUUID(),body:'chat during preference save'}});
  await page.waitForFunction(()=>document.querySelector('#human-push-note').textContent==='Notification preferences saved.');
  assert.equal(f.store.humanPush.preferences(f.keys.owner,'commons').preferences.dm,false);
  assert.equal(await page.locator('#human-push-pref-dm').isEnabled(),true);
  await page.keyboard.press('Escape'); await page.locator('#room-more > summary').click(); await page.locator('#topbar-settings').click();
  await page.locator('#advanced-room-tools > summary').click();
  assert.equal(await page.getByRole('link',{name:'Demo conversation'}).isVisible(),true);
  await page.locator('#connect-guide-open').click(); await page.locator('#connect-guide-close').click();
  await page.locator('#human-advanced').check(); await page.keyboard.press('Escape');
  await page.locator('#squads-open').click();
  await page.locator('#squads-list input[name=name]').fill('team');
  await page.locator('#squads-list input[name=goal]').fill('Ship together');
  await page.locator('#squads-list input[name=memberId][value=guest]').check();
  f.store.command(f.keys.guest,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:crypto.randomUUID(),body:'chat while drafting'}});
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#squads-list input[name=goal]').inputValue(),'Ship together');
  await page.locator('#squads-list button[type=submit]').click();
  await page.locator('#squads-list .squad-card').waitFor();
  assert.match(f.store.db.prepare("SELECT members_json FROM squads WHERE name='team'").get().members_json,/guest/);
  await page.locator('#squads-list input[name=name]').fill('team');
  await page.locator('#squads-list input[name=goal]').fill('Keep this rejected draft');
  await page.locator('#squads-list button[type=submit]').click();
  await page.locator('#squads-list [role=alert]').waitFor();
  assert.equal(await page.locator('#squads-list input[name=goal]').inputValue(),'Keep this rejected draft');
  assert.deepEqual(errors,[]);
});
