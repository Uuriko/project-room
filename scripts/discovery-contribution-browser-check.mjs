// Scripted MCP participants and simulated people; never invokes a native model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { openMcpTestClient } from './mcp-test-client.mjs';
import { createRoomServer } from '../server/http.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { textVersion } from '../server/text-results.mjs';

for (const touch of [false, true]) test(`discovery to contribution ${touch ? 'touch' : 'desktop'}: reuse, fresh authority and changed evidence`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  const handles = [], traffic = [], errors = []; let browser;
  t.after(async () => {
    for (const handle of handles) await handle.close();
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, state = () => f.store.room('commons').state;
  const open = async memberId => {
    const directory = join(f.directory, memberId);
    saveAgentConnection(directory, { version: 1, origin, roomId: 'commons', memberId, token: f.keys[memberId] });
    const handle = await openMcpTestClient(directory); handles.push(handle); return handle;
  };
  const producer = await open('producer'), reviewer = await open('reviewer');
  const call = async (handle, tool, args = {}) => {
    const response = await handle.call(tool, args);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result.structuredContent));
    traffic.push({ tool, status: response.result.structuredContent.status ?? 'read' });
    return response.result.structuredContent;
  };
  const read = async (handle, tool, args = {}) => {
    const before = auditRecovery(f.store).dataSha256, result = await call(handle, tool, args);
    assert.equal(auditRecovery(f.store).dataSha256, before); return result;
  };
  const action = async (handle, tool, workItemId, extra = {}) => {
    const context = await read(handle, 'room_read_work', { workItemId });
    return call(handle, tool, { requestId: crypto.randomUUID(), workItemId, expectedRevision: context.work.revision, ...extra });
  };
  const submit = async (workItemId, body, summary) => {
    const context = await read(producer, 'room_read_work', { workItemId });
    const draft = await call(producer, 'room_post_draft', { requestId: crypto.randomUUID(), workItemId,
      packetId: crypto.randomUUID(), basisRevision: context.work.revision, body });
    const preview = await read(producer, 'room_read_result', { workItemId, draftMessageId: draft.messageId });
    assert.equal(preview.result.text.body, body);
    return call(producer, 'room_submit_text_result', { requestId: crypto.randomUUID(), workItemId,
      expectedRevision: context.work.revision, evidenceMessageId: draft.messageId, evidenceMessageEventId: draft.eventId,
      evidenceVersion: textVersion(body), previousCompletionEventId: context.work.receipt?.eventId ?? null,
      producerId: 'producer', summary, nextAction: 'Review the exact agenda' });
  };
  const sourceId = 'test-handoff';
  await action(producer, 'room_accept_work', sourceId); await action(producer, 'room_start_work', sourceId);
  const oldBody = '- Room owner: set a goal.\n- Everyone: agree on the next step.';
  const old = await submit(sourceId, oldBody, 'Reusable telescope agenda');
  await action(reviewer, 'room_record_verification', sourceId, { result: 'pass', completionEventId: old.eventId,
    evidenceVersion: textVersion(oldBody), summary: 'Prior agenda names an owner.' });
  const original = structuredClone(state().workItems[sourceId]);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('#access-key').fill(f.keys.owner);
  await page.locator('#auth-form button[type=submit]').click(); await page.locator('#main').waitFor({ state: 'visible' });
  const beforeDiscovery = auditRecovery(f.store).dataSha256;
  await page.locator('#message-search').fill('telescope');
  const hit = page.locator(`#search-list [data-open-work="${sourceId}"]`);
  await hit.focus(); await hit.press('Enter');
  await page.locator(`[data-reuse-work="${sourceId}"]`).click();
  const form = page.locator('#new-work-form'); await form.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#work-title-input').inputValue(), original.title);
  assert.equal(await page.locator('#work-done-input').inputValue(), original.definitionOfDone);
  for (const id of ['assignee-select', 'verifier-select', 'source-message-id']) assert.equal(await page.locator(`#${id}`).inputValue(), '');
  assert.equal(await page.locator('#work-mode-select').inputValue(), 'read');
  for (const id of ['require-verification', 'require-decision']) assert.equal(await page.locator(`#${id}`).isChecked(), true);
  assert.equal(auditRecovery(f.store).dataSha256, beforeDiscovery);
  await page.locator('#work-title-input').fill('Next telescope session');
  await page.locator('#assignee-select').selectOption('producer'); await page.locator('#verifier-select').selectOption('reviewer');
  mkdirSync('test-results', { recursive: true });
  const prefix = `test-results/discovery-contribution-${touch ? 'touch' : 'desktop'}`;
  await page.screenshot({ path: `${prefix}-reuse.png` });
  await form.locator('button[type=submit]').click(); await form.waitFor({ state: 'hidden' });
  const workItemId = Object.keys(state().workItems).find(id => id !== sourceId);
  assert.ok(workItemId); const fresh = state().workItems[workItemId];
  assert.equal(fresh.revision, 0); assert.equal(fresh.state, 'proposed');
  for (const key of ['receipt', 'verification', 'decision', 'claim', 'sourceMessageId']) assert.equal(fresh[key], null);
  assert.deepEqual(state().workItems[sourceId], original);

  const selected = (await read(producer, 'room_list_work', { query: 'Next telescope', focus: 'needs_me' })).work[0];
  assert.equal(selected.id, workItemId);
  // A charter change does not change the task revision; the selected read must expose it.
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'room.charter_updated', data: {
    expectedRevision: 0, purpose: 'Prepare a short observation session', outputs: 'Two bullets and a named owner',
    boundaries: 'Do not operate equipment', escalation: 'Ask Room owner for any outside action' } });
  const current = await read(producer, selected.nextRead.tool, selected.nextRead.arguments);
  assert.equal(current.work.revision, selected.revision);
  assert.equal(current.context.charter.revision, 1); assert.equal(current.context.charter.authority, 'context_only');
  assert.equal(current.context.source.status, 'not_requested');
  const beforeRefusal = auditRecovery(f.store).dataSha256;
  const refused = await reviewer.call('room_accept_work', { requestId: 'wrong-assignee', workItemId, expectedRevision: 0 });
  assert.equal(refused.result.isError, true); assert.equal(refused.result.structuredContent.code, 'command_rejected');
  assert.equal(auditRecovery(f.store).dataSha256, beforeRefusal);
  await action(producer, 'room_accept_work', workItemId); await action(producer, 'room_start_work', workItemId);
  assert.equal((await read(producer, 'room_list_work', { query: 'Next telescope', focus: 'needs_me' })).work.length, 0);
  const firstBody = '- Room owner: choose a target.\n- Everyone: plan a viewing time.';
  const first = await submit(workItemId, firstBody, 'First telescope plan');
  const reviewStep = (await read(reviewer, 'room_list_work', { query: 'Next telescope', focus: 'needs_me' })).work[0];
  const pinned = await read(reviewer, reviewStep.nextRead.tool, reviewStep.nextRead.arguments);
  const firstRead = await read(reviewer, 'room_read_result', { workItemId, completionEventId: first.eventId });
  assert.equal(firstRead.result.text.body, firstBody);
  await action(producer, 'room_block_work', workItemId, { reason: 'The next step needs a clear owner', nextAction: 'Revise the agenda' });
  await action(producer, 'room_resolve_blocker', workItemId, { resolution: 'New wording prepared' });
  await action(producer, 'room_start_work', workItemId);
  const finalBody = '- Room owner: choose a target.\n- Room owner: confirm a viewing time with everyone.';
  const latest = await submit(workItemId, finalBody, 'Revised telescope plan');
  const staleArgs = { requestId: 'stale-review', workItemId, expectedRevision: pinned.work.revision, result: 'pass',
    completionEventId: first.eventId, evidenceVersion: textVersion(firstBody), summary: 'First version checked only.' };
  const beforeStale = auditRecovery(f.store).dataSha256;
  const stale = await reviewer.call('room_record_verification', staleArgs);
  assert.equal(stale.result.isError, true); assert.equal(stale.result.structuredContent.code, 'command_rejected');
  assert.equal(auditRecovery(f.store).dataSha256, beforeStale);
  await action(reviewer, 'room_record_verification', workItemId, { result: 'pass', completionEventId: first.eventId,
    evidenceVersion: textVersion(firstBody), summary: 'Historical first version only.' });
  assert.equal(state().workItems[workItemId].verification, null);
  assert.equal(state().workItems[workItemId].decision, null);
  const now = (await read(reviewer, 'room_list_work', { query: 'Next telescope', focus: 'needs_me' })).work[0];
  assert.equal(now.next.completionEventId, latest.eventId);
  const finalRead = await read(reviewer, 'room_read_result', { workItemId, completionEventId: latest.eventId });
  assert.equal(finalRead.result.text.body, finalBody);
  await action(reviewer, 'room_record_verification', workItemId, { result: 'pass', completionEventId: latest.eventId,
    evidenceVersion: textVersion(finalBody), summary: 'Current version: two bullets and a named owner for both steps.' });
  assert.equal(state().workItems[workItemId].verification.independenceConfirmed, true);
  assert.deepEqual(state().workItems[sourceId], original);

  await page.locator(`[data-work-id="${workItemId}"][data-action="decide"]`).click();
  await page.waitForFunction(body => document.querySelector('#action-text-body').textContent === body, finalBody);
  assert.equal(await page.locator('#action-fields [name="decision"]').inputValue(), '');
  assert.equal(await page.locator('#decision-review-label').textContent(), 'Independent check · Pass');
  assert.equal(await page.locator('#decision-review').evaluate(node => node.open), false);
  await page.screenshot({ path: `${prefix}-decision.png` });
  await page.locator('#decision-review > summary').click();
  assert.match(await page.locator('#decision-review-text').textContent(), /^Current version:/);
  assert.equal(await page.locator('#decision-review-version').textContent(), `Evidence ${textVersion(finalBody)}`);
  assert.equal(await page.locator('#action-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: `${prefix}-current-review.png` });
  if (touch) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const decisionControl = page.locator('#action-fields [name="decision"]');
  await decisionControl.scrollIntoViewIfNeeded(); await decisionControl.focus();
  assert.equal(await decisionControl.evaluate(node => node === document.activeElement), true);
  const submitControl = page.locator('#action-form button[type=submit]');
  await submitControl.scrollIntoViewIfNeeded();
  assert.equal(await submitControl.isVisible(), true);
  const bounds = await submitControl.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height);
  assert.equal(await page.locator('#action-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: `${prefix}-controls.png` });
  assert.equal(state().workItems[workItemId].decision, null);
  for (const member of ['owner', 'producer', 'reviewer']) assert.equal(
    f.store.db.prepare('SELECT sequence FROM cursors WHERE room_id=? AND member_id=?').get('commons', member)?.sequence ?? 0, 0);
  await page.locator('#cancel-action').click(); await page.locator('#signout-button').click();
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#search-list').textContent(), ''); assert.equal(await page.locator('#decision-review-text').textContent(), '');
  assert.deepEqual(errors, []);
  writeFileSync(`${prefix}.json`, JSON.stringify({ simulatedHuman: true, scriptedMcp: true, nativeModels: false,
    sourcePreserved: true, freshAssignment: true, updatedCharterRead: true, staleReviewRefused: true,
    historicalReviewSeparate: true, exactCurrentReview: true, humanApproval: null, readMarkersUnchanged: true,
    finalVersion: textVersion(finalBody), traffic, audit: auditRecovery(f.store) }, null, 2));
});
