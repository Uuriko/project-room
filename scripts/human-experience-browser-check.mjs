import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
const browserEngine = process.env.ROOM_BROWSER_ENGINE ?? 'chromium';
if (!['chromium', 'webkit'].includes(browserEngine)) throw new Error('ROOM_BROWSER_ENGINE must be chromium or webkit');
const browserType = browserEngine === 'webkit' ? webkit : chromium;
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { clickChrome, openCatchUpPanel, openSettings, closeSettings, ensureSidebarClosed } from './room-chrome.mjs';
import { signInFixture } from './auth-signin.mjs';


async function configureAssistant(page) {
  await openSettings(page);
  await page.locator('#assistant-setup').click();
  await page.locator('#room-assistant-setup select').selectOption('producer');
  await page.locator('#room-assistant-setup button[type=submit]').click();
  await page.locator('#room-assistant-setup').waitFor({ state: 'hidden' });
  await closeSettings(page);
}

function deferredResultResponse() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function openHumanResult(page, workId) {
  const task = page.locator(`[data-work-record-id="${workId}"]`), details = task.locator('details.work-details');
  if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
  await task.locator('[data-action="complete"]').click();
  await page.locator('#human-share-result').waitFor({state:'visible'});
}

async function holdResultResponse(page, body, { offline = false, roomId = 'commons' } = {}) {
  const captured = deferredResultResponse(), release = deferredResultResponse();
  let intercepted = false;
  await page.route(`**/api/rooms/${roomId}/commands`, async route => {
    const command = route.request().postDataJSON();
    if (intercepted || command?.data?.body !== body) { await route.fallback(); return; }
    intercepted = true;
    const response = offline ? null : await route.fetch();
    captured.resolve({ command, response });
    await release.promise;
    if (offline) await route.abort('connectionfailed');
    else await route.fulfill({ response });
  });
  return {
    captured: captured.promise, release: release.resolve,
    async deliver() {
      const finished = offline
        ? page.waitForEvent('requestfailed', request => request.postDataJSON()?.data?.body === body)
        : page.waitForResponse(response => response.request().postDataJSON()?.data?.body === body);
      release.resolve();
      const response = await finished;
      if (!offline) await response.finished();
      // Let the response's promise handlers and the resulting paint finish.
      // Successful receipts are already visible in the stream before release.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  };
}

test('two humans share public assistant prompts, constraints, confirmed activity and results; banter stays quiet', { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  const peerMember = f.store.room('commons').state.members.guest;
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'member.access_changed',data:{memberId:'guest',expectedMemberRevision:peerMember.revision,permissions:[...new Set([...peerMember.permissions,'steer'])],active:true}});
  for (const [type,data] of [
    ['work.proposed',{workItemId:'human-result-task',title:'Write a short result',definitionOfDone:'A readable result is saved',accountableMemberId:'owner',mode:'read',independentVerificationRequired:false,ownerDecisionRequired:false}],
    ['work.accepted',{workItemId:'human-result-task',expectedRevision:0}],
    ['work.started',{workItemId:'human-result-task',expectedRevision:1}]
  ]) f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type,data});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({headless:true});
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
  await configureAssistant(owner);
  await owner.waitForFunction(()=>document.querySelector('#room-assistant-status').textContent==='Waiting for connection');
  const send = async (page, body) => { await page.locator('#message-input').fill(body); await page.locator('#message-form button[type=submit]').click(); await page.waitForFunction(()=>document.querySelector('#message-input').value===''); };
  await send(peer,'Hey friends, good to see you!'); assert.equal((await api('owner')).runs.length,0);
  await send(owner,'@Room Compare our launch ideas.');
  await owner.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Compare our launch ideas.'));
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Compare our launch ideas.'));
  let run=(await api('producer')).runs[0]; assert.equal(run.status,'queued');
  // HS2 3a: the request and its state are on the card face, with Activity still closed.
  for(const page of pages) {
    await page.locator(`[data-message-record-id="${run.sourceMessageId}"] #assistant-face`).waitFor();
    assert.equal(await page.locator('#assistant-face .assistant-face-request').isVisible(), false, 'the source message supplies the prompt without repetition');
    assert.match(await page.locator('#assistant-face .assistant-face-status').textContent(), /^(Asked|Not picked up yet)/);
    assert.equal(await page.locator('#assistant-activity').evaluate(n=>n.open), false);
  }
  const original = peer.locator(`[data-message-record-id="${run.sourceMessageId}"]`);
  await original.hover();
  await original.locator('[data-message-action="reply"]').click();
  await send(peer,'Keep the design mobile first.');
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('mobile first'));
  run=(await api('producer')).runs[0]; assert.equal(run.inputs.length,2); assert.equal(run.inputs[1].status,'pending');
  run=(await api('producer',{action:'claim',runId:run.id,attemptId:'test-host',expectedRevision:run.revision})).result;
  run=(await api('producer',{action:'report',runId:run.id,attemptId:'test-host',expectedRevision:run.revision,state:'working',summary:'Comparing mobile readability.',appliedInputMessageIds:run.inputs.map(i=>i.sourceMessageId)})).result;
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Comparing mobile readability.'));
  for (const page of pages) await page.locator('#assistant-face .assistant-face-progress').getByText('Comparing mobile readability.', { exact: true }).waitFor();
  const post = await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{Authorization:`Bearer ${f.keys.producer}`,'Content-Type':'application/json'},body:JSON.stringify({id:'public-result-command',type:'message.posted',data:{messageId:'public-result',body:'Recommendation: choose the simpler mobile layout.'}})});assert.ok(post.ok);
  await api('producer',{action:'report',runId:run.id,attemptId:'test-host',expectedRevision:run.revision,state:'done',summary:'The recommendation is ready.',resultMessageId:'public-result'});
  for(const page of pages) { await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Result ready')); await page.locator('#assistant-face [data-assistant-message="public-result"]').click(); await page.locator('[data-message-record-id="public-result"]').waitFor(); }
  for(const page of pages) {
    await page.locator('#assistant-face .assistant-face-status').getByText('Result ready',{exact:true}).waitFor();
    assert.equal(await page.locator('#assistant-face').getByRole('button',{name:'Open result',exact:true}).count(), 1, 'the result is one tap from the card face');
    assert.equal(await page.locator('#assistant-face').getByRole('button',{name:'Stop',exact:true}).count(), 0, 'a finished ask has no Stop');
  }
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
  const draftCommands = [], draftPending = deferredResultResponse(), releaseDraft = deferredResultResponse();
  await owner.route('**/api/rooms/commons/commands',async route=>{
    const command=route.request().postDataJSON();
    if(command?.data?.body===humanResultBody) {
      draftCommands.push(command);
      if(draftCommands.length===1) { await route.fetch(); draftPending.resolve(); await releaseDraft.promise; await route.abort(); return; }
    }
    await route.continue();
  });
  await owner.locator('#human-share-result button[type=submit]').click();
  await draftPending.promise;
  try {
    await owner.locator('#human-share-result [data-close-share]').click();
    await openHumanResult(owner,'human-result-task');
    assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
    assert.equal(await owner.locator('#human-share-result button[type=submit]').isDisabled(),true,'reopening the same task keeps its pending send locked');
  } finally { releaseDraft.resolve(); }
  await owner.locator('#human-share-result button[type=submit]').filter({hasText:'Retry original draft'}).waitFor();
  await owner.locator('#human-share-result [data-close-share]').click();
  await openHumanResult(owner,'human-result-task');
  assert.equal(await owner.locator('#human-share-result textarea').isDisabled(),true);
  assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
  assert.match(await owner.locator('#human-share-result button[type=submit]').textContent(),/Retry original draft/);
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
    if (route.request().method() === 'POST' && payload?.action === 'submit') {
      await route.fetch(); await route.abort(); await owner.unroute('**/api/rooms/commons/assistant');
    } else await route.continue();
  });
  await owner.locator('#message-input').fill('@Room Recover this request exactly once.');
  await owner.locator('#message-form button[type=submit]').click();
  await owner.locator('#assistant-retry').waitFor({state:'visible'});
  const beforeRetry = (await api('owner')).runs;
  assert.equal(beforeRetry.length,2);
  await owner.reload(); await owner.locator('#main').waitFor({state:'visible'});
  await owner.locator('#assistant-retry').waitFor({state:'visible'}); await owner.locator('#assistant-retry').click();
  await owner.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal((await api('owner')).runs.length,2);
  assert.equal(await owner.locator('#message-input').inputValue(), '', 'confirmed retry clears its restored draft');
  // Select context at revision N; the host claims N+1 before the human sends.
  // A rejected stale write needs review and a new explicit confirmation, not an endless retry.
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Recover this request exactly once.'));
  let recovery = (await api('producer')).runs.find(r=>r.id!==run.id);
  await peer.locator(`#assistant-face [data-contribute-run="${recovery.id}"]`).click(); // the newest open ask is on the card face
  recovery = (await api('producer',{action:'claim',runId:recovery.id,attemptId:'recovery-host',expectedRevision:recovery.revision})).result;
  await peer.locator('#composer-file').setInputFiles({ name: 'accepted.txt', mimeType: 'text/plain', buffer: Buffer.from('Original attachment') });
  await peer.waitForFunction(() => document.querySelector('#composer-attachments').textContent === 'accepted.txt×');
  await peer.locator('#message-input').fill('Please include our latest constraint.');
  await peer.locator('#message-form button[type=submit]').click();
  await peer.locator('#assistant-review').waitFor({state:'visible'});
  assert.equal((await api('producer')).runs.find(r=>r.id===recovery.id).inputs.length,1);
  await peer.locator('#assistant-review').click();
  const retryCommitted = deferredResultResponse(), releaseRetry = deferredResultResponse();
  await peer.route('**/api/rooms/commons/assistant', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON()?.action !== 'submit') { await route.fallback(); return; }
    const response = await route.fetch(); retryCommitted.resolve();
    await releaseRetry.promise; await route.fulfill({ response });
  });
  await peer.locator('#assistant-retry').click(); await retryCommitted.promise;
  await peer.locator('#message-input').fill('A newer thought, still unsent.');
  await peer.locator('#composer-file').setInputFiles({ name: 'next.txt', mimeType: 'text/plain', buffer: Buffer.from('New unsent attachment') });
  await peer.waitForFunction(() => document.querySelector('#composer-attachments').textContent.includes('next.txt×'));
  await peer.locator('#thread-back').click();
  await peer.locator('#message-input').fill('An unrelated room draft.');
  releaseRetry.resolve();
  await peer.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal((await api('producer')).runs.find(r=>r.id===recovery.id).inputs.length,2);
  assert.equal(await peer.locator('#message-input').inputValue(), 'An unrelated room draft.', 'late retry receipt leaves the current conversation alone');
  await peer.locator(`#assistant-face [data-contribute-run="${recovery.id}"]`).click();
  assert.equal(await peer.locator('#message-input').inputValue(), 'A newer thought, still unsent.', 'late retry receipt preserves newer text');
  assert.equal(await peer.locator('#composer-attachments').textContent(), 'next.txt×', 'only accepted files leave the draft');
  await peer.unroute('**/api/rooms/commons/assistant');
  await peer.locator('#message-input').fill('');
  // Stop is available for ordinary requests, without deleting the prompt.
  // Losing the committed response must preserve one exact cancellation for retry.
  const ownerRun = owner.locator(`[data-assistant-run="${recovery.id}"]`);
  const peerRun = peer.locator(`[data-assistant-run="${recovery.id}"]`);
  await owner.locator('#assistant-activity').evaluate(n => { n.open = true; });
  await ownerRun.getByRole('button', {name:'Stop', exact:true}).waitFor({timeout:3000});
  assert.equal(await peerRun.getByRole('button', {name:'Stop', exact:true}).count(), 0);
  recovery = (await api('producer')).runs.find(r => r.id === recovery.id);
  await owner.waitForFunction(({id, revision}) => Number(document.querySelector(`[data-assistant-run="${id}"] [data-cancel]`)?.dataset.revision) === revision, {id:recovery.id, revision:recovery.revision});
  const stops = [];
  await owner.route('**/api/rooms/commons/assistant', async route => {
    const payload = route.request().postDataJSON();
    if (payload?.action !== 'cancel') { await route.continue(); return; }
    stops.push(payload);
    if (stops.length === 1) { await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await ownerRun.getByRole('button', {name:'Stop', exact:true}).click();
  await owner.locator('#assistant-retry').waitFor({state:'visible'});
  recovery = (await api('producer')).runs.find(r => r.id === recovery.id);
  assert.equal(recovery.status, 'cancel_requested');
  await ownerRun.locator('.assistant-run-status').getByText('Stopping · waiting for confirmation', {exact:true}).waitFor();
  assert.equal(await ownerRun.getByRole('button', {name:'Add to this ask', exact:true}).count(), 0);
  assert.equal(await ownerRun.getByRole('button', {name:'Stop', exact:true}).count(), 0);
  await owner.locator('#assistant-retry').click();
  await owner.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[1], stops[0]);
  await api('producer', {action:'report', runId:recovery.id, attemptId:'recovery-host', expectedRevision:recovery.revision, state:'cancelled', summary:'Stopped.'});
  await owner.waitForFunction(id => document.querySelector(`[data-assistant-run="${id}"]`).textContent.includes('Cancelled'), recovery.id);
  assert.equal(await ownerRun.getByRole('button', {name:'Stop', exact:true}).count(), 0);
  // The result link returns to the exact public answer, rather than a different run.
  await peer.locator('#assistant-activity').evaluate(n=>{n.open=true;}); // an older request's result lives in Activity
  await peer.locator('#assistant-runs [data-assistant-message="public-result"]').click();
  assert.equal(await peer.locator('[data-message-record-id="public-result"]').count(),1);
  // A completed answer can be revised through ordinary chat by the other person.
  const previous = (await api('producer')).runs.find(item => item.id === run.id);
  await peer.locator('#assistant-activity').evaluate(node => { node.open = true; });
  await peer.locator('#assistant-runs [data-assistant-reply="public-result"]').click();
  await peer.locator('#message-input').fill('Make the recommendation one sentence.');
  await peer.locator('#message-form button[type=submit]').click();
  await peer.waitForFunction(() => document.querySelector('#message-input').value === '');
  let followup = (await api('producer')).runs.find(item => ![run.id, recovery.id].includes(item.id));
  assert.ok(followup, 'replying to a completed result starts a new execution');
  const followupMessage = f.store.room('commons').state.messages.find(message => message.id === followup.sourceMessageId);
  assert.equal(followupMessage.replyToId, 'public-result');
  assert.equal(followupMessage.authorId, 'guest');
  assert.equal((await api('producer')).runs.find(item => item.id === run.id).revision, previous.revision, 'completed execution is not reopened');
  followup = (await api('producer', { action:'claim', runId:followup.id, attemptId:'followup-host', expectedRevision:followup.revision })).result;
  const publication = { action:'publish', requestId:'followup-publication', runId:followup.id, attemptId:'followup-host', expectedRevision:followup.revision,
    body:'Choose the simpler mobile layout.', summary:'Revised recommendation ready.', appliedInputMessageIds:followup.inputs.map(input => input.sourceMessageId) };
  const delivered = await api('producer', publication);
  assert.equal((await api('producer', publication)).result.resultMessageId, delivered.result.resultMessageId);
  await peer.reload();
  await peer.locator('#main').waitFor({ state:'visible' });
  await peer.locator('#assistant-face [data-assistant-reply]').waitFor();
  await peer.locator('#assistant-face [data-assistant-message]').click();
  await peer.locator(`[data-message-record-id="${delivered.result.resultMessageId}"]`).waitFor();
  mkdirSync('test-results/chat-result',{recursive:true});
  for (const width of [390,1280]) {
    await peer.setViewportSize({width,height:900});
    for (const theme of ['dark','light']) {
      await peer.evaluate(value => document.documentElement.dataset.theme=value, theme);
      await peer.locator(`[data-message-record-id="${delivered.result.resultMessageId}"]`).scrollIntoViewIfNeeded();
      const faceBounds = await peer.locator('#assistant-face').boundingBox();
      assert.ok(faceBounds.width > 200, 'inline progress occupies the message content column, not the avatar column');
      await peer.screenshot({path:`test-results/chat-result/${width}-${theme}.png`,fullPage:false});
      assert.equal(await peer.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    }
  }
  assert.deepEqual(errors,[]);
});

// Result-editor ownership belongs at this real browser boundary. The active-entry
// conflict and exact-retry cases above cannot detect a closed editor's delayed
// catch/finally mutating its replacement. Routes delay real responses, without
// exposing production state or adding an alternate implementation of the editor.
test('a closed result editor cannot mutate its replacement after a delayed response', {timeout:90000}, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({store:f.store,streamInterval:40});
  const memberId = 'result-race-human', accountId = 'result-race-account', otherRoom = 'result-race-other';
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'member.added',data:{memberId,displayName:'Result reader',kind:'human',permissions:f.store.room('commons').state.members.owner.permissions}});
  f.store.createAccount(accountId); f.store.completeOnboarding(accountId);
  f.store.bindHumanAccount('commons',memberId,accountId);
  const other = initialRoom(otherRoom,memberId);
  other[0].data.title = 'Other result room';
  f.store.initialize(other);
  f.store.bindHumanAccount(otherRoom,memberId,accountId);
  const roomKeys = {commons:f.store.issueAccessKey('commons',memberId),[otherRoom]:f.store.issueAccessKey(otherRoom,memberId)};
  for (const [roomId,key] of Object.entries(roomKeys)) for (const workItemId of ['result-race-a','result-race-b']) {
    for (const [type,data] of [
      ['work.proposed',{workItemId,title:workItemId,definitionOfDone:'Save a readable result',accountableMemberId:memberId,mode:'read',independentVerificationRequired:false,ownerDecisionRequired:false}],
      ['work.accepted',{workItemId,expectedRevision:0}],
      ['work.started',{workItemId,expectedRevision:1}]
    ]) f.store.command(key,roomId,{id:crypto.randomUUID(),type,data});
  }
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser = null;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  browser = await browserType.launch({headless:true});
  for (const outcome of ['offline','conflict','success','new session','new room']) {
    await t.test(`late ${outcome} leaves the current result editor owned by its own request`, async t => {
      const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage(), held = [], errors = [];
      t.after(async () => { for (const response of held) response.release(); await page.unrouteAll({behavior:'wait'}); await context.close(); });
      page.on('pageerror', failure => errors.push(failure.message));
      await page.goto(origin); await signInFixture(page,roomKeys.commons);
      await page.waitForFunction(() => document.body.classList.contains('human-experience'));
      const oldBody = `Old result: ${outcome}`, currentBody = `Current result: ${outcome}`;
      const crossesBoundary = outcome === 'new session' || outcome === 'new room', pendingReplacement = outcome === 'success' || crossesBoundary;
      const currentRoom = outcome === 'new room' ? otherRoom : 'commons';
      await openHumanResult(page,'result-race-a');
      await page.locator('#human-share-result textarea').fill(oldBody);
      if (outcome === 'conflict') {
        const revision = f.store.room('commons').state.workItems['result-race-a'].revision;
        f.store.command(roomKeys.commons,'commons',{id:crypto.randomUUID(),type:'work.blocked',data:{workItemId:'result-race-a',expectedRevision:revision,reason:'Changed requirement',nextAction:'Review the task'}});
        f.store.command(roomKeys.commons,'commons',{id:crypto.randomUUID(),type:'work.started',data:{workItemId:'result-race-a',expectedRevision:revision+1,resolvedBlocker:'Requirement reviewed'}});
      }
      const old = await holdResultResponse(page,oldBody,{offline:outcome === 'offline'}); held.push(old);
      await page.locator('#human-share-result button[type=submit]').click();
      const captured = await old.captured;
      if (captured.response) assert.equal(captured.response.status(),outcome === 'conflict' ? 409 : 201);
      assert.equal(await page.locator('#human-share-result button[type=submit]').isDisabled(),true);
      if (pendingReplacement) {
        await page.locator(`[data-message-record-id="${captured.command.data.messageId}"]`).waitFor({state:'attached'});
      }
      await page.locator('#human-share-result [data-close-share]').click();
      if (crossesBoundary) {
        // Restore the same human, optionally in another room, without reloading:
        // the old callback must survive to exercise the actual boundary guard.
        await clickChrome(page,'#signout-button');
        await page.locator('#auth-panel').waitFor({state:'visible'});
        const restored = await context.request.post(`${origin}/api/session`,{headers:{Origin:origin},data:{accessKey:roomKeys[currentRoom]},maxRedirects:0});
        assert.equal(restored.status(),201);
        assert.equal((await restored.json()).roomId,currentRoom);
        await page.evaluate(() => history.replaceState(null,'','/'));
        await page.locator('#refresh-button').evaluate(button => button.click());
        await page.locator('#main').waitFor({state:'visible'});
        await page.waitForFunction(title => document.querySelector('#room-title').textContent === title,f.store.room(currentRoom).state.room.title);
      }
      const currentWork = crossesBoundary ? 'result-race-a' : 'result-race-b';
      await openHumanResult(page,currentWork);
      await page.locator('#human-share-result textarea').fill(currentBody);
      let current;
      if (pendingReplacement) {
        current = await holdResultResponse(page,currentBody,{roomId:currentRoom}); held.push(current);
        await page.locator('#human-share-result button[type=submit]').click();
        const pending = await current.captured;
        assert.equal(pending.response.status(),201);
        await page.locator(`[data-message-record-id="${pending.command.data.messageId}"]`).waitFor({state:'attached'});
        assert.equal(await page.locator('#human-share-result button[type=submit]').isDisabled(),true);
      }
      await old.deliver();
      assert.equal(await page.locator('#human-share-result').isVisible(),true);
      assert.equal(await page.locator('#human-share-result textarea').inputValue(),currentBody);
      assert.equal(await page.locator('#human-share-result textarea').isEnabled(),true,'an obsolete failure must not lock the current draft');
      assert.equal(await page.locator('#human-share-error').textContent(),'','an obsolete failure must not replace the current error');
      assert.equal(await page.locator('#human-share-refresh').isVisible(),false);
      assert.equal(await page.locator('#human-share-result button[type=submit]').textContent(),'Review result');
      assert.equal(await page.locator('#human-share-result button[type=submit]').isDisabled(),Boolean(current),'an obsolete completion must not unlock a newer pending send');
      assert.equal(await page.locator('#action-dialog').isVisible(),false,'an obsolete success must not select its result');
      if (current) {
        await current.deliver();
        await page.locator('#human-share-result').waitFor({state:'hidden'});
        await page.locator('#action-dialog').waitFor({state:'visible'});
        assert.equal(f.store.room(currentRoom).state.messages.find(message => message.body === currentBody).workItemId,currentWork);
      }
      assert.deepEqual(errors,[]);
    });
  }
});

// Owns post-login discovery, preference persistence, draft recovery and first-screen simplicity.
for (const [width, height] of [[1280, 800], [390, 844]]) {
  test(`the conversation has no duplicate attention preview (${width}x${height})`, { timeout: 60000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
    const post = (key, data) => f.store.command(key, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data });
    const mine = [];
    for (let i = 0; i < 45; i++) { const mineNow = i % 3 === 0; post(mineNow ? f.keys.owner : i % 3 === 1 ? f.keys.guest : f.keys.producer, { messageId: `m${i}`, body: `Message ${i} in a long running conversation.` }); if (mineNow) mine.push(`m${i}`); }
    for (let i = 0; i < 4; i++) post(f.keys.reviewer, { messageId: `reply${i}`, body: i === 3 ? `Reply 3 ${'to your earlier message '.repeat(5)}` : `Reply ${i} to your earlier message`, replyToId: mine[i] });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({ headless: true });
    t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    await page.goto(origin); await signInFixture(page, f.keys.owner);
    await page.locator('#main').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#activity-preview').count(), 0);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  });
}

test('human settings preserve saved preferences without a squad surface', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({store:f.store, streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser=await browserType.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const page=await browser.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  await page.locator('#auth-panel').waitFor({state:'visible'});
  assert.equal(await page.getByRole('link',{name:'Agent sign in',exact:true}).count(),1);
  assert.equal(await page.locator('#static-hero').count(),0);
  assert.equal(await page.locator('#connect-guide-dialog').isVisible(),false);
  assert.equal(await page.locator('#connect-guide-open').isVisible(),false);
  assert.equal(await page.getByRole('link',{name:'Demo conversation'}).isVisible(),false);
  await page.goto(origin+'/#join-agent');
  await page.locator('#connect-guide-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#connect-guide-copy').innerText(),/running host/);
  await page.locator('#connect-guide-close').click();
  await page.goto(origin);
  await signInFixture(page,f.keys.owner);
  assert.equal(await page.locator('#connect-guide-dialog').isVisible(),false);
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
  assert.equal(await page.locator('#squads-open, #squads-dialog').count(), 0);
  assert.deepEqual(errors,[]);
});

test('deleted assistant prompt shows only content-free stop controls and preserves the conversation draft', {timeout:60000}, async t => {
  const f=createAcceptanceFixture(), server=createRoomServer({store:f.store,streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`, browser=await browserType.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const api=async(actor,input)=>{
    const response=await fetch(`${origin}/api/rooms/commons/assistant`,{method:'POST',headers:{authorization:`Bearer ${f.keys[actor]}`,'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),...input})});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.result;
  };
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:'erase-browser-prompt',body:'ERASED-BROWSER-PROMPT'}});
  await api('owner',{action:'invoke',runId:'deleted-browser-run',sourceMessageId:'erase-browser-prompt'});
  await api('producer',{action:'claim',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:0});
  await api('producer',{action:'report',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:1,state:'working',summary:'ERASED-BROWSER-PROMPT'});
  const page=await browser.newPage();await page.goto(origin);await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'});
  await page.locator('#assistant-activity > summary').click();
  const panel=page.locator('[data-assistant-run="deleted-browser-run"]');
  await panel.getByRole('button',{name:'Original prompt',exact:true}).waitFor();
  await page.locator('#message-input').fill('Keep my unsent conversation draft.');
  // Keep the old assistant projection cached while real message deletion arrives.
  await page.route('**/api/rooms/commons/assistant',route=>route.request().method()==='GET'?route.abort():route.continue());
  const deletion=await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{authorization:`Bearer ${f.keys.owner}`,'content-type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),type:'message.deleted',data:{messageId:'erase-browser-prompt',expectedMessageRevision:0}})});
  assert.equal(deletion.status,201,await deletion.text());
  await panel.locator('summary strong').getByText('Deleted request',{exact:true}).waitFor({timeout:5000});
  assert.doesNotMatch(await panel.textContent(),/ERASED-BROWSER-PROMPT/);
  await page.unroute('**/api/rooms/commons/assistant');
  for(const name of ['Original prompt','Add to this ask','Change direction','Resolve direction','Resume']) assert.equal(await panel.getByRole('button',{name,exact:true}).count(),0);
  await panel.getByRole('button',{name:'Pause',exact:true}).click();
  await panel.locator('.assistant-run-status').getByText('Pausing · waiting for confirmation',{exact:true}).waitFor();
  await api('producer',{action:'report',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:3,state:'paused',summary:'Stopped'});
  await panel.locator('.assistant-run-status').getByText('Paused',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Resume',exact:true}).count(),0);
  await panel.getByRole('button',{name:'Stop',exact:true}).click();
  await panel.locator('.assistant-run-status').getByText('Stopping · waiting for confirmation',{exact:true}).waitFor();
  await api('producer',{action:'report',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:5,state:'cancelled',summary:'Cancelled'});
  await panel.locator('.assistant-run-status').getByText('Cancelled',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('button').count(),0);
  assert.equal(await page.locator('#message-input').inputValue(),'Keep my unsent conversation draft.');
});

test('keyboard Stop on the card face keeps focus and the status change is announced (R5-1, R5-2)', {timeout:60000}, async t => {
  const f=createAcceptanceFixture(), server=createRoomServer({store:f.store,streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`, browser=await browserType.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const api=async(actor,input)=>{
    const response=await fetch(`${origin}/api/rooms/commons/assistant`,{method:'POST',headers:{authorization:`Bearer ${f.keys[actor]}`,'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),...input})});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.result;
  };
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:'kbd-ask',body:'Plan the offsite'}});
  await api('owner',{action:'invoke',runId:'kbd-run',sourceMessageId:'kbd-ask'});
  await api('producer',{action:'claim',runId:'kbd-run',attemptId:'kbd-host',expectedRevision:0});
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(origin);await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'});
  const status=page.locator('#assistant-face [role=status]');
  await status.getByText('Working',{exact:true}).waitFor();
  assert.equal(await status.getAttribute('aria-live'),'polite');
  assert.equal(await page.locator('#assistant-setup').textContent(),'Change','a connected assistant offers Change, not Connect');
  const snapshot = await (await fetch(`${origin}/api/rooms/commons/assistant`, {headers:{authorization:`Bearer ${f.keys.owner}`}})).json();
  let frozen = true, stopPayload;
  await page.route('**/api/rooms/commons/assistant', async route => {
    if (route.request().method() === 'GET' && frozen) { await route.fulfill({json:snapshot}); return; }
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'cancel') {
      stopPayload = route.request().postDataJSON(); frozen = false;
    }
    await route.continue();
  });
  // A progress event advances revision after this human saw the card. The same
  // attempt must remain stoppable without an extra Review/retry interaction.
  await api('producer',{action:'report',runId:'kbd-run',attemptId:'kbd-host',expectedRevision:1,state:'working',summary:'More progress.'});
  await page.locator('#assistant-face [data-cancel]').focus(); await page.keyboard.press('Enter');
  await status.getByText('Stopping…',{exact:true}).waitFor();
  assert.equal(stopPayload.expectedAttemptId, 'kbd-host');
  assert.equal(stopPayload.expectedRevision, 1, 'the UI sent its observed revision rather than silently refreshing the control');
  const focus=await page.evaluate(()=>({ body: document.activeElement===document.body, inCard: Boolean(document.activeElement?.closest('#assistant-face')) }));
  assert.deepEqual(focus,{body:false,inCard:true},'focus stays on the Room card after a keyboard Stop');
  await api('producer',{action:'report',runId:'kbd-run',attemptId:'kbd-host',expectedRevision:3,state:'cancelled',summary:'Stopped.'});
  await status.getByText('Stopped',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement===document.body),false,'focus survives the Stop button disappearing');
});
for (const theme of ['dark', 'light']) test(`visible resolution preserves drafts, authority and stale review on a phone (${theme})`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.keys[actor]}`, ...(input ? { 'content-type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }) } : {}) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return input ? value.result : value;
  };
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'resolve-source', body: 'Choose a launch date.' } });
  let run = await api('owner', { action: 'invoke', runId: 'resolve-run', sourceMessageId: 'resolve-source' });
  run = await api('producer', { action: 'claim', runId: run.id, attemptId: 'resolve-host', expectedRevision: run.revision });
  run = await api('producer', { action: 'report', runId: run.id, attemptId: 'resolve-host', expectedRevision: run.revision, state: 'needs_input', summary: 'Choose Friday or Monday.' });
  const pages = [];
  for (const actor of ['owner', 'guest']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(origin); await signInFixture(page, f.keys[actor]);
    await page.locator('#assistant-face .assistant-face-status').getByText('Needs a decision', { exact: true }).waitFor();
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    pages.push(page);
  }
  const [owner, peer] = pages, control = owner.locator('#assistant-face').getByRole('button', { name: 'Resolve direction', exact: true });
  assert.equal(await owner.locator('#assistant-activity').evaluate(node => node.open), false);
  assert.equal(await peer.locator('#assistant-face [data-resolve]').count(), 0, 'another participant cannot resolve the owner’s ask');
  f.store.command(f.keys.guest, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'unapproved-resolution', body: 'Choose my date.', replyToId: 'resolve-source' } });
  const forbidden = await fetch(`${origin}/api/rooms/commons/assistant`, { method: 'POST', headers: { authorization: `Bearer ${f.keys.guest}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), action: 'resolve', runId: run.id, expectedRevision: run.revision, sourceMessageId: 'unapproved-resolution' }) });
  assert.equal(forbidden.status, 403, 'hiding the control does not replace server authorization');
  await control.waitFor({ state: 'visible' });
  assert.ok((await control.boundingBox()).height >= 24, 'the inline action retains its accessible target');
  mkdirSync('test-results', { recursive: true });
  await owner.screenshot({ path: `test-results/visible-resolution-${theme}.png` });
  await owner.locator('#message-input').fill('Keep my unrelated draft.');
  await control.focus(); await owner.keyboard.press('Enter');
  assert.equal(await owner.locator('#message-input').inputValue(), '');
  assert.equal(await owner.locator('#assistant-context').textContent(), 'Resolve direction');
  assert.equal((await api('owner')).runs[0].inputs.length, 1, 'opening the composer sends nothing');
  await owner.locator('#assistant-context').click();
  await owner.locator('#thread-back').click();
  assert.equal(await owner.locator('#message-input').inputValue(), 'Keep my unrelated draft.');
  await control.click();
  await owner.locator('#message-input').fill('Choose Monday after the review.');
  const observedRevision = run.revision;
  run = await api('producer', { action: 'report', runId: run.id, attemptId: 'resolve-host', expectedRevision: run.revision, state: 'needs_input', summary: 'The review also needs an owner.' });
  await owner.locator('#message-form button[type=submit]').click();
  await owner.locator('#assistant-review').waitFor({ state: 'visible' });
  assert.equal((await api('owner')).runs[0].inputs.length, 1, 'a stale resolution is not applied');
  await owner.locator('#assistant-review').click();
  assert.equal((await api('owner')).runs[0].status, 'needs_input', 'review requires a separate confirmation');
  await owner.locator('#assistant-retry').click();
  await owner.locator('#assistant-retry').waitFor({ state: 'hidden' });
  run = (await api('owner')).runs[0];
  assert.ok(run.revision > observedRevision);
  assert.equal(run.status, 'pause_requested', 'the original host must pause before continuing with the resolution');
  assert.equal(run.attemptId, 'resolve-host');
  assert.equal(run.inputs.length, 2);
  assert.equal(run.inputs[1].memberId, 'owner');
  assert.equal(run.inputs[1].resolution, true);
  assert.equal(await owner.locator('#assistant-activity').evaluate(node => node.open), false);
  await owner.locator('#thread-back').click();
  assert.equal(await owner.locator('#message-input').inputValue(), 'Keep my unrelated draft.');
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('@Room stays visible in the draft and routes without a separate composer mode', { timeout: 45000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  await page.waitForFunction(() => document.body.classList.contains('human-experience'));
  const input = page.locator('#message-input');
  // Before the assistant is configured there is nothing called Room to mention.
  await input.fill('@Roo');
  const roomOptions = () => page.locator('#mention-list .mention-option').evaluateAll(n => n.map(o => o.textContent.trim()).filter(t => /^Room(?! owner)/.test(t)).length);
  assert.equal(await roomOptions(), 0);
  await input.fill('');
  await configureAssistant(page);
  await input.fill('@Roo');
  await page.waitForFunction(() => [...document.querySelectorAll('#mention-list .mention-option')].some(o => /^Room(?! owner)/.test(o.textContent.trim())));
  assert.equal(await page.locator('#ask-room').count(), 0);
  await page.locator('#mention-list .mention-option').filter({ hasText: /^\s*Room(?! owner)/ }).first().click();
  assert.equal(await input.inputValue(), '@Room ', 'the address remains visible');
  await input.pressSequentially('can you help?');
  assert.equal(await page.locator('#mention-list').isHidden(), true);
  // Sending now goes out as an invocation: a run exists for the message.
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#assistant-runs').textContent.includes('can you help?'));
});

for (const [width, colorScheme] of [[1280, 'dark'], [390, 'light']]) test(`ask card shows not-picked-up and stalled statuses with the result on the card (${width}, ${colorScheme})`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({headless:true});
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  const errors = [];
  const context = await browser.newContext({viewport:{width,height:900}, colorScheme}), page = await context.newPage();
  page.on('pageerror', e=>errors.push(e.message)); await page.goto(origin); await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'}); await page.waitForFunction(()=>document.body.classList.contains('human-experience'));
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {method:input?'POST':'GET',headers:{Authorization:`Bearer ${f.keys[actor]}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify({requestId:crypto.randomUUID(),...input})}:{})});
    const json=await response.json(); assert.ok(response.ok,JSON.stringify(json));return json;
  };
  await configureAssistant(page);
  await page.locator('#message-input').fill('@Room What is the plan?');
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#message-input').value==='');
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('What is the plan?'));
  // A queued run nobody claims for 10s reads not picked up on the card.
  const base = f.store.now(); f.store.now = () => base + 11000;
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Not picked up'));
  await page.waitForFunction(()=>document.querySelector('.assistant-face-status').dataset.faceStatus === 'not_picked_up');
  let run = (await api('producer')).runs[0]; assert.equal(run.status,'queued'); assert.equal(run.displayStatus,'not_picked_up');
  run = (await api('producer',{action:'claim',runId:run.id,attemptId:'host-3a',expectedRevision:run.revision})).result;
  assert.equal(run.status,'working');
  // A working run whose host goes silent for 2min reads stalled on the card.
  const claimedAt = f.store.now(); f.store.now = () => claimedAt + 121000;
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Stalled'));
  await page.waitForFunction(()=>document.querySelector('.assistant-face-status').dataset.faceStatus === 'stalled');
  assert.equal((await api('producer')).runs[0].displayStatus,'stalled');
  // The published answer lands on the card itself.
  run = (await api('producer',{action:'publish',runId:run.id,attemptId:'host-3a',expectedRevision:run.revision,summary:'Plan ready.',body:'The plan is to ship the fence first.',appliedInputMessageIds:run.inputs.map(i=>i.sourceMessageId)})).result;
  assert.equal(run.status,'done');
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('The plan is to ship the fence first.'));
  assert.equal(await page.locator('#assistant-runs .assistant-run-resultline').count(),1);
  await page.waitForFunction(()=>document.querySelector('.assistant-face-status').dataset.faceStatus === 'done');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors,[]);
});

for (const [width, colorScheme] of [[1280, 'dark'], [390, 'light']]) {
  test(`a shared ask keeps additions in its own conversation (${width}, ${colorScheme})`, { timeout: 45000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
    const command = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
    command('channel.created', { name: 'design' });
    const channelId = Object.values(f.store.room('commons').state.channels).find(c => c.name === 'design').id;
    command('message.posted', { messageId: 'design-root', body: 'Our design conversation', channelId });
    command('message.posted', { messageId: 'shared-ask', body: 'Compare our launch ideas.', channelId, replyToId: 'design-root' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const api = async (actor, input) => {
      const res = await fetch(`${origin}/api/rooms/commons/assistant`, {
        method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${f.keys[actor]}`, 'Content-Type': 'application/json' },
        ...(input ? { body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }) } : {})
      });
      const value = await res.json(); assert.equal(res.status, 200, JSON.stringify(value)); return value;
    };
    await api('owner', { action: 'configure', name: 'Room', coordinatorMemberId: 'producer', expectedRevision: 0 });
    await api('owner', { action: 'invoke', runId: 'shared', sourceMessageId: 'shared-ask' });
    const browser = await browserType.launch({ headless: true });
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await signInFixture(page, f.keys.guest);
    await page.locator('#assistant-runs [data-assistant-run="shared"]').waitFor({ state: 'attached' });
    await page.locator('#assistant-activity > summary').click();
    await page.locator('#assistant-runs [data-assistant-message="shared-ask"]').click();
    await page.locator('#message-input').fill('Keep the existing design thread draft.');
    if (width === 390) {
      await page.locator('#composer-options > summary').click();
      await page.locator('#message-to-select').selectOption('producer');
      await page.locator('#composer-options > summary').click();
    }
    await openSettings(page); await page.locator('#advanced-room-tools > summary').click();
    await page.locator('#human-advanced').check(); await closeSettings(page);
    if (width < 700) await page.locator('#sidebar-toggle').click();
    await page.locator('#channel-list [data-channel="general"]').click(); await ensureSidebarClosed(page);
    await page.locator('#message-input').fill('Keep this unrelated general draft.');
    const historyContribution = async () => {
      await page.locator('#assistant-activity').evaluate(node => { node.open = true; });
      await page.locator('[data-assistant-run="shared"]').evaluate(node => { node.open = true; });
      return page.locator('#assistant-runs [data-contribute-run="shared"]:not([data-conflict])');
    };
    assert.equal(await page.locator('#assistant-face').isVisible(), false, 'another channel does not show unrelated progress');
    await (await historyContribution()).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#message-input').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#message-input').inputValue(), '', 'adding context does not repurpose the destination draft');
    assert.equal(await page.locator('#message-to-select').isDisabled(), true, 'shared context cannot silently become private');
    await page.locator('#message-input').fill('Keep the design mobile first.');
    await page.locator('#cancel-reply').click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep the existing design thread draft.');
    await (await historyContribution()).click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep the design mobile first.', 'cancelling the contribution preserves its own draft');
    const response = page.waitForResponse(res => res.url().endsWith('/assistant') && res.request().method() === 'POST');
    await page.locator('#message-form button[type=submit]').click();
    const sent = await response;
    assert.equal(sent.status(), 200, await sent.text());
    await page.waitForFunction(() => !document.querySelector('#message-form button[type=submit]').disabled);
    const run = (await api('producer')).runs.find(r => r.id === 'shared');
    assert.equal(run.inputs.length, 2);
    const added = f.store.room('commons').state.messages.find(m => m.id === run.inputs[1].sourceMessageId);
    assert.equal(added.authorId, 'guest');
    assert.equal(added.channelId, channelId);
    assert.equal(added.replyToId, 'shared-ask');
    assert.equal(added.toMemberId, null);
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep the existing design thread draft.');
    assert.equal(await page.locator('#message-to-select').inputValue(), width === 390 ? 'producer' : '');
    assert.equal(await page.locator('#reply-bar').isVisible(), false, 'the restored thread draft still replies to its original root');
    if (width < 700) await page.locator('#sidebar-toggle').click();
    await page.locator('#channel-list [data-channel="general"]').click();
    await ensureSidebarClosed(page);
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep this unrelated general draft.');
    await (await historyContribution()).click();
    await page.locator('#message-input').fill('Unsent additional context.');
    if (width < 700) await page.locator('#sidebar-toggle').click();
    await page.locator('#channel-list [data-channel="general"]').click(); await ensureSidebarClosed(page);
    assert.equal(await page.locator('#assistant-context').isVisible(), false);
    await page.locator('#message-input').fill('Ordinary group banter.');
    const posted = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().postDataJSON()?.data?.body === 'Ordinary group banter.');
    await page.locator('#message-form button[type=submit]').click(); assert.equal((await posted).status(), 201);
    await page.waitForFunction(() => document.querySelector('#message-input').value === '');
    assert.equal((await api('producer')).runs.length, 1, 'leaving context mode does not turn ordinary chat into a new ask');
    await (await historyContribution()).click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent additional context.');
    assert.deepEqual(errors, []);
  });
}


for (const width of [1280, 390]) test(`one shared answer streams in place and becomes the final result (${width})`, {timeout:30000}, async t => {
  const f=createAcceptanceFixture(), server=createRoomServer({store:f.store,streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`, browser=await browserType.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const api=async(actor,input)=>{
    const res=await fetch(`${origin}/api/rooms/commons/assistant`,{method:'POST',headers:{authorization:`Bearer ${f.keys[actor]}`,'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),...input})});
    const value=await res.json();assert.equal(res.status,200,JSON.stringify(value));return value.result;
  };
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:'stream-ui',body:'Compare the options'}});
  await api('owner',{action:'invoke',runId:'stream-ui-run',sourceMessageId:'stream-ui'});
  await api('producer',{action:'claim',runId:'stream-ui-run',attemptId:'stream-ui-host',expectedRevision:0});
  const page=await browser.newPage({viewport:{width,height:900}});await page.goto(origin);await signInFixture(page,f.keys.owner);
  const answer=page.locator('#assistant-answer');
  const emit=(sequence,body)=>api('producer',{action:'draft',runId:'stream-ui-run',attemptId:'stream-ui-host',expectedRevision:1,sequence,body});
  await emit(1,'First finding <script>bad()</script>');
  await answer.getByText('First finding <script>bad()</script>',{exact:true}).waitFor();
  const node=await answer.elementHandle();
  await page.locator('#assistant-face [data-cancel]').focus();
  await page.evaluate(() => { const range=document.createRange(); range.setStart(document.querySelector('#assistant-answer').firstChild,0); range.setEnd(document.querySelector('#assistant-answer').firstChild,5); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await emit(2,'First finding <script>bad()</script> Second finding.');
  await answer.getByText('First finding <script>bad()</script> Second finding.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>getSelection().toString()),'First');
  assert.equal(await node.evaluate(n=>n===document.querySelector('#assistant-answer')),true);
  assert.equal(await page.locator('#assistant-face [data-cancel]').evaluate(n=>n===document.activeElement),true);
  assert.equal(await answer.locator('script').count(),0);
  assert.equal(await answer.isVisible(),true);
  await api('producer',{action:'publish',runId:'stream-ui-run',attemptId:'stream-ui-host',expectedRevision:1,summary:'Ready',body:'The final shared answer.',appliedInputMessageIds:['stream-ui']});
  await answer.waitFor({state:'hidden'});
  assert.equal(await answer.textContent(),'');
  await page.locator('#assistant-face').getByRole('button',{name:'Open result',exact:true}).click();
  await page.locator('#message-list .message-body').getByText('The final shared answer.',{exact:true}).waitFor();
  assert.equal(await node.evaluate(n=>n===document.querySelector('#assistant-answer')),true);
  assert.equal(f.store.room('commons').state.messages.filter(m=>m.body==='The final shared answer.').length,1);
  assert.equal(await page.locator('#assistant-activity').evaluate(n=>n.open),false);
});
test('each ask renders as one foldable row; the row keeps its open state', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({headless:true});
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  const errors = [];
  const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage();
  page.on('pageerror', e=>errors.push(e.message)); await page.goto(origin); await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'}); await page.waitForFunction(()=>document.body.classList.contains('human-experience'));
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {method:input?'POST':'GET',headers:{Authorization:`Bearer ${f.keys[actor]}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify({requestId:crypto.randomUUID(),...input})}:{})});
    const json=await response.json(); assert.ok(response.ok,JSON.stringify(json));return json;
  };
  await configureAssistant(page);
  const send = async body => { await page.locator('#message-input').fill(`@Room ${body}`); await page.locator('#message-form button[type=submit]').click(); await page.waitForFunction(()=>document.querySelector('#message-input').value===''); };
  await send('First question for the room?');
  await send('Second question for the room?');
  await page.waitForFunction(()=>document.querySelectorAll('#assistant-runs details.assistant-run').length===2);
  await page.locator('#assistant-activity').evaluate(n=>{n.open=true;});
  assert.equal(await page.locator('#settings-dialog').evaluate(n => n.open), false);
  assert.equal(await page.locator('#assistant-activity > summary').textContent(), 'Work · 2 active');
  await page.locator('#assistant-activity > summary').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#assistant-activity').evaluate(n => n.open), false);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#assistant-activity').evaluate(n => n.open), true);
  // One line per ask: the summary carries the prompt and the status.
  const summaries = await page.locator('#assistant-runs details.assistant-run > summary').allTextContents();
  assert.equal(summaries.length,2);
  assert.ok(summaries.some(s => s.includes('First question for the room?') && s.includes('Waiting for assistant')));
  assert.ok(summaries.some(s => s.includes('Second question for the room?') && s.includes('Waiting for assistant')));
  // Rows start folded; the full card is one click away.
  assert.equal(await page.locator('#assistant-runs details.assistant-run[open]').count(),0);
  await page.locator('#assistant-runs details.assistant-run > summary').first().click();
  await page.waitForFunction(()=>document.querySelector('#assistant-runs details.assistant-run[open]')!==null);
  await page.locator('#assistant-runs details.assistant-run[open]').getByRole('button',{name:'Original prompt',exact:true}).waitFor();
  // Original prompt is reachable on a folded row too (it lives in the summary).
  await page.locator('#assistant-runs details.assistant-run:not([open]) > summary').getByRole('button',{name:'Original prompt',exact:true}).waitFor();
  // The open row survives a repaint triggered by new run activity.
  const run = (await api('producer')).runs[0];
  await api('producer',{action:'claim',runId:run.id,attemptId:'fold-host',expectedRevision:run.revision});
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Working'));
  assert.equal(await page.locator('#assistant-runs details.assistant-run[open]').count(),1,'the open row stays open across repaints');
  // Using the summary Stop does not collapse the row.
  await page.evaluate(()=>{ document.querySelector('#assistant-runs details.assistant-run[open] summary [data-cancel]').click(); });
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Stopping'));
  assert.equal(await page.locator('#assistant-runs details.assistant-run[open]').count(),1,'summary controls do not toggle the fold');
  mkdirSync('test-results', { recursive: true });
  for (const [width, theme] of [[1280, 'dark'], [1280, 'light'], [390, 'dark'], [390, 'light']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `test-results/work-disclosure-${width}-${theme}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#assistant-activity > summary').click();
    await page.screenshot({ path: `test-results/work-collapsed-${width}-${theme}.png` });
    const composer = await page.locator('#message-input').boundingBox();
    assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= 900);
    await page.locator('#assistant-activity > summary').click();
  }
  assert.deepEqual(errors,[]);
});

test('Add to this ask wires the composer into the run and names the ask', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({headless:true});
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  const errors = [];
  const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage();
  page.on('pageerror', e=>errors.push(e.message)); await page.goto(origin); await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'}); await page.waitForFunction(()=>document.body.classList.contains('human-experience'));
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {method:input?'POST':'GET',headers:{Authorization:`Bearer ${f.keys[actor]}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify({requestId:crypto.randomUUID(),...input})}:{})});
    const json=await response.json(); assert.ok(response.ok,JSON.stringify(json));return json;
  };
  await configureAssistant(page);
  await page.locator('#message-input').fill('@Room What should we prioritize?');
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#message-input').value==='');
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('What should we prioritize?'));
  await page.locator('#assistant-activity').evaluate(n=>{n.open=true;});
  await page.locator('details.assistant-run').evaluate(n=>{n.open=true;});
  // The ask card offers "Add to this ask"; the composer names the ask.
  await page.locator('details.assistant-run').getByRole('button',{name:'Add to this ask',exact:true}).click();
  assert.equal(await page.locator('#assistant-context').textContent(), "Adding to Room owner's ask");
  assert.equal(await page.locator('#assistant-context').isVisible(), true);
  // Sending wires the message into the existing run as a contribution.
  await page.locator('#message-input').fill('One more constraint: keep it simple.');
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#message-input').value==='');
  const run = (await api('producer')).runs[0];
  assert.equal(run.inputs.length,2);
  assert.equal(run.inputs[1].status,'pending');
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('keep it simple'));
  assert.deepEqual(errors,[]);
});

for (const width of [1280, 390]) {
  test(`Stop rejected because the host claimed after the card rendered: Review then Retry stops the new attempt (${width}px)`, { timeout: 60000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({ headless: true });
    t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const api = async (actor, input) => {
      const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: 'POST', headers: { authorization: `Bearer ${f.keys[actor]}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value.result;
    };
    await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
    f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'race-ask', body: 'Plan the offsite' } });
    await api('owner', { action: 'invoke', runId: 'race-run', sourceMessageId: 'race-ask' });
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
    await page.goto(origin); await signInFixture(page, f.keys.owner); await page.locator('#main').waitFor({ state: 'visible' });
    await page.locator('#assistant-face [data-cancel]').waitFor();
    // The human still sees the unclaimed card while the host claims it.
    const snapshot = await (await fetch(`${origin}/api/rooms/commons/assistant`, { headers: { authorization: `Bearer ${f.keys.owner}` } })).json();
    let frozen = true; const stops = [];
    await page.route('**/api/rooms/commons/assistant', async route => {
      if (route.request().method() === 'GET' && frozen) { await route.fulfill({ json: snapshot }); return; }
      if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'cancel') stops.push(route.request().postDataJSON());
      await route.continue();
    });
    await api('producer', { action: 'claim', runId: 'race-run', attemptId: 'race-host', expectedRevision: 0 });
    await page.locator('#assistant-face [data-cancel]').click();
    await page.locator('#assistant-review').waitFor({ state: 'visible' });
    assert.equal(stops.length, 1);
    assert.equal(stops[0].expectedAttemptId, null, 'the first Stop carried the attempt the human saw');
    frozen = false;
    await page.locator('#assistant-review').click();
    await page.locator('#assistant-retry').waitFor({ state: 'visible' });
    await page.locator('#assistant-retry').click();
    await page.waitForFunction(() => document.querySelector('#assistant-error')?.textContent === '' );
    assert.equal(stops.length, 2);
    assert.equal(stops[1].expectedRevision, 1);
    assert.equal(stops[1].expectedAttemptId, 'race-host', 'Review rebinds Stop to the attempt it just showed, still as an exact id');
    const run = (await (await fetch(`${origin}/api/rooms/commons/assistant`, { headers: { authorization: `Bearer ${f.keys.owner}` } })).json()).runs.find(r => r.id === 'race-run');
    assert.equal(run.status, 'cancel_requested');
    await page.screenshot({ path: `/tmp/probe/race-${width}.png` });
  });
}

async function claimRaceFixture(t, width, ids) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await browserType.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: 'POST', headers: { authorization: `Bearer ${f.keys[actor]}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value.result;
  };
  const read = async () => (await (await fetch(`${origin}/api/rooms/commons/assistant`, { headers: { authorization: `Bearer ${f.keys.owner}` } })).json()).runs.find(r => r.id === ids.run);
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: ids.ask, body: 'Plan the offsite' } });
  await api('owner', { action: 'invoke', runId: ids.run, sourceMessageId: ids.ask });
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
  await page.goto(origin); await signInFixture(page, f.keys.owner); await page.locator('#main').waitFor({ state: 'visible' });
  await page.locator('#assistant-face [data-cancel]').waitFor();
  const snapshot = await (await fetch(`${origin}/api/rooms/commons/assistant`, { headers: { authorization: `Bearer ${f.keys.owner}` } })).json();
  const state = { frozen: true, controls: [], failNext: false };
  await page.route('**/api/rooms/commons/assistant', async route => {
    const request = route.request();
    if (request.method() === 'GET' && state.frozen) { await route.fulfill({ json: snapshot }); return; }
    if (request.method() === 'POST' && ['cancel', 'pause'].includes(request.postDataJSON()?.action)) {
      state.controls.push(request.postDataJSON());
      if (state.failNext) { state.failNext = false; await route.fulfill({ status: 409, json: { error: { code: 'assistant_attempt_changed', message: 'The execution changed; read it before controlling it' } } }); return; }
    }
    await route.continue();
  });
  return { api, page, read, state };
}

for (const width of [1280, 390]) {
  test(`a Stop rejected again after Review is not rebound or retried on its own, and the run keeps running (${width}px)`, { timeout: 60000 }, async t => {
    const { api, page, read, state } = await claimRaceFixture(t, width, { run: 'again-run', ask: 'again-ask' });
    await api('producer', { action: 'claim', runId: 'again-run', attemptId: 'again-host', expectedRevision: 0 });
    await page.locator('#assistant-face [data-cancel]').click();
    await page.locator('#assistant-review').waitFor({ state: 'visible' });
    state.frozen = false;
    await page.locator('#assistant-review').click();
    await page.locator('#assistant-retry').waitFor({ state: 'visible' });
    // The execution changes again before the human presses Retry: the server rejects the exact attempt.
    state.failNext = true;
    await page.locator('#assistant-retry').click();
    await page.locator('#assistant-review').waitFor({ state: 'visible' });
    await page.waitForTimeout(1200);
    assert.equal(state.controls.length, 2, 'first Stop, one Retry after Review, and nothing automatic after the second rejection');
    assert.equal(state.controls[0].expectedAttemptId, null);
    assert.equal(state.controls[1].expectedAttemptId, 'again-host');
    assert.equal(await page.locator('#assistant-retry').isVisible(), false, 'no Retry is offered until a fresh Review');
    assert.match(await page.locator('#assistant-error').textContent(), /rejected/);
    assert.equal((await read()).status, 'working', 'a rejected Stop never cancels the newer execution');
  });

  test(`Pause rejected because the host claimed after the card rendered: Review then Retry pauses the new attempt (${width}px)`, { timeout: 60000 }, async t => {
    const { api, page, read, state } = await claimRaceFixture(t, width, { run: 'pause-run', ask: 'pause-ask' });
    await api('producer', { action: 'claim', runId: 'pause-run', attemptId: 'pause-host', expectedRevision: 0 });
    const pause = page.locator('#assistant-runs [data-pause-run]:not([data-cancel]):not([data-resume])').first();
    await page.locator('#assistant-activity summary').first().click().catch(() => {});
    await pause.click();
    await page.locator('#assistant-review').waitFor({ state: 'visible' });
    assert.equal(state.controls[0].action, 'pause');
    assert.equal(state.controls[0].expectedAttemptId, null);
    state.frozen = false;
    await page.locator('#assistant-review').click();
    await page.locator('#assistant-retry').click();
    await page.waitForFunction(() => document.querySelector('#assistant-error')?.textContent === '');
    assert.equal(state.controls.length, 2);
    assert.equal(state.controls[1].action, 'pause');
    assert.equal(state.controls[1].expectedAttemptId, 'pause-host');
    assert.equal((await read()).status, 'pause_requested');
  });
}

// These failures leave the server untouched: the browser must retain the exact
// replacement operation even when an abandoned retry finishes afterwards.
test('discarded assistant retry cannot erase the replacement pending operation', { timeout: 60000 }, async t => {
  const { page } = await claimRaceFixture(t, 1280, { run: 'discard-run', ask: 'discard-ask' });
  const oldCaptured = deferredResultResponse(), replacementCaptured = deferredResultResponse();
  const releaseOld = deferredResultResponse(), releaseReplacement = deferredResultResponse();
  t.after(() => { releaseOld.resolve(); releaseReplacement.resolve(); });
  let calls = 0;
  await page.route('**/api/rooms/commons/assistant', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const call = ++calls;
    if (call === 2) { oldCaptured.resolve(); await releaseOld.promise; }
    if (call === 3) { replacementCaptured.resolve(); await releaseReplacement.promise; }
    await route.fulfill({ status: call === 1 ? 503 : 409, json: { error: {
      code: call === 1 ? 'service_unavailable' : 'assistant_attempt_changed', message: 'Synthetic interrupted control'
    } } });
  });
  await page.locator('#assistant-face [data-cancel]').click();
  await page.locator('#assistant-retry').waitFor({ state: 'visible' });
  await page.locator('#assistant-retry').click(); await oldCaptured.promise;
  await page.locator('#assistant-discard').click();
  await page.locator('#assistant-activity').evaluate(node => { node.open = true; });
  await page.locator('#assistant-runs [data-cancel]').click(); await replacementCaptured.promise;
  const before = await page.evaluate(() => sessionStorage.getItem('room-assistant-pending:commons:owner'));
  assert.ok(before, 'the replacement operation is durably pending before the abandoned response');
  const delivered = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/assistant') && response.status() === 409);
  releaseOld.resolve(); await (await delivered).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('room-assistant-pending:commons:owner')), before,
    'a stale rejection must not delete the replacement operation or offer review of the abandoned one');
  assert.equal(await page.locator('#assistant-review').isVisible(), false);
});

test('discarding an uncertain assistant control restores the face control accessibility state', { timeout: 60000 }, async t => {
  const { page } = await claimRaceFixture(t, 1280, { run: 'discard-face-run', ask: 'discard-face-ask' });
  await page.route('**/api/rooms/commons/assistant', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status: 503, json: { error: { code: 'service_unavailable', message: 'Synthetic interrupted control' } } });
  });
  const stop = page.locator('#assistant-face [data-cancel]');
  await stop.click(); await page.locator('#assistant-discard').waitFor({ state: 'visible' });
  await page.locator('#assistant-discard').click();
  assert.equal(await stop.isEnabled(), true, 'Discard restores the unchanged face control for assistive technology');
  await stop.click(); await page.locator('#assistant-retry').waitFor({ state: 'visible' });
});
