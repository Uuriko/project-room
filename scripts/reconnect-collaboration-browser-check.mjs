// Scripted protocol participants + simulated human browser. No model invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { openMcpTestClient } from './mcp-test-client.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomStore } from '../server/store.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { textVersion } from '../server/text-results.mjs';

for (const touch of [false, true]) test(`reconnect collaboration ${touch ? 'touch' : 'desktop'}: clarify, restart, contribute and review`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), handles = new Set(), traffic = [], errors = [];
  let server = createRoomServer({ store: f.store, streamInterval: 50 }), browser;
  const listen = port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const stopServer = async () => { server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve)); };
  const close = async handle => { handles.delete(handle); await handle.close(); };
  t.after(async () => { for (const handle of handles) await handle.close(); await browser?.close();
    await stopServer(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  await listen(0); const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const configs = Object.fromEntries(['producer', 'reviewer'].map(memberId => {
    const directory = join(f.directory, memberId);
    saveAgentConnection(directory, { version: 1, origin, roomId: 'commons', memberId, token: f.keys[memberId] });
    return [memberId, directory];
  }));
  const open = async member => {
    const handle = await openMcpTestClient(configs[member], member === 'producer'
      ? { attentionDirectory: join(f.directory, 'producer-v3'), attentionVersion: 3 } : {});
    handles.add(handle); return handle;
  };
  const call = async (handle, name, args = {}) => {
    const response = await handle.call(name, args);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result.structuredContent));
    traffic.push({ tool: name, status: response.result.structuredContent.status ?? 'read' });
    return response.result.structuredContent;
  };
  const read = async (handle, name, args = {}) => {
    const before = auditRecovery(f.store).dataSha256, result = await call(handle, name, args);
    assert.equal(auditRecovery(f.store).dataSha256, before, 'reading/observing does not mutate Room tables'); return result;
  };
  const workItemId = 'test-handoff', state = () => f.store.room('commons').state;
  let producer = await open('producer');
  const selected = (await read(producer, 'room_list_work', { focus: 'needs_me' })).work[0];
  assert.equal(selected.id, workItemId);
  const work = await read(producer, selected.nextRead.tool, selected.nextRead.arguments);
  assert.equal(work.context.source.status, 'not_requested');
  await call(producer, 'room_accept_work', { requestId: 'journey-accept', workItemId, expectedRevision: work.work.revision });
  await call(producer, 'room_start_work', { requestId: 'journey-start', workItemId, expectedRevision: 1 });
  const ask = { requestId: 'journey-question', toMemberId: 'owner', workItemId, body: 'How short should the agenda be, and who owns the final review?' };
  const question = await call(producer, 'room_request_reply', ask);
  await read(producer, 'room_read_attention'); // Persist the outgoing observation before disconnect.
  await close(producer);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
  const pageForOwner = async login => {
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    if (login) { await page.locator('#access-key').fill(f.keys.owner); await page.locator('#auth-form button[type=submit]').click(); }
    await page.locator('#main').waitFor({ state: 'visible' }); return page;
  };
  let page = await pageForOwner(true);
  await page.locator(`[data-message-id="${question.requestMessageId}"][data-message-action="request-answered"]`).click();
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled);
  const answer = 'Two bullets. Name Room owner and end with a concrete next step.';
  await page.locator('#message-input').fill(answer);
  if (touch) await page.locator('#message-form button[type=submit]').click();
  else await page.locator('#message-input').press('Enter');
  await page.locator('#request-mode-bar').waitFor({ state: 'hidden' });
  assert.equal(state().replyRequests[question.requestMessageId].status, 'answered');
  assert.equal(state().workItems[workItemId].state, 'working', 'a reply does not complete work');
  mkdirSync('test-results', { recursive: true });
  const prefix = `test-results/reconnect-collaboration-${touch ? 'touch' : 'desktop'}`;
  await page.screenshot({ path: `${prefix}-answered.png` });
  await page.close();

  const beforeRestart = auditRecovery(f.store);
  await stopServer(); f.store.close(); f.store = new RoomStore(join(f.directory, 'room.sqlite'));
  server = createRoomServer({ store: f.store, streamInterval: 50 }); await listen(port);
  assert.deepEqual(auditRecovery(f.store), beforeRestart, 'restart preserves every application table');
  producer = await open('producer');
  assert.equal((await read(producer, 'room_list_work', { focus: 'needs_me' })).work.length, 0, 'ongoing work is separate from request attention');
  const attention = await read(producer, 'room_read_attention');
  const notice = attention.items.find(item => item.request?.id === question.requestMessageId);
  assert.equal(notice.condition, 'answered');
  const request = await read(producer, notice.nextRead.tool, notice.nextRead.arguments);
  assert.equal(request.request.status, 'answered'); assert.equal(request.page.hasMore, false);
  assert.equal(request.page.items.at(-1).message.body, answer);
  const beforeAck = auditRecovery(f.store).dataSha256;
  assert.equal((await call(producer, 'room_acknowledge_attention', { noticeId: notice.id })).status, 'acknowledged');
  assert.equal(auditRecovery(f.store).dataSha256, beforeAck);
  const retriedQuestion = await call(producer, 'room_request_reply', ask);
  assert.equal(retriedQuestion.eventId, question.eventId); assert.equal(retriedQuestion.duplicate, true);
  assert.equal(auditRecovery(f.store).dataSha256, beforeAck, 'exact question retry does not reopen an answered request');

  let cursor, discussion = [];
  do {
    const page = await read(producer, 'room_read_work_discussion', { workItemId, limit: 1, ...(cursor ? { cursor } : {}) });
    discussion.push(...page.discussion.items); cursor = page.discussion.nextCursor;
  } while (cursor);
  assert.ok(discussion.some(row => row.message.body === answer));
  const body = '- Room owner: confirm the shared goal.\n- Everyone: choose one next step for Room owner to review.';
  const posted = await call(producer, 'room_post_draft', { requestId: 'journey-draft', workItemId, packetId: 'journey-packet', basisRevision: 2, body });
  const exactDraft = await read(producer, 'room_read_result', { workItemId, draftMessageId: posted.messageId });
  assert.equal(exactDraft.result.text.body, body); assert.equal(exactDraft.result.text.evidenceVersion, textVersion(body));
  const submission = { requestId: 'journey-result', workItemId, expectedRevision: 2, evidenceMessageId: posted.messageId,
    evidenceMessageEventId: posted.eventId, evidenceVersion: textVersion(body), previousCompletionEventId: null,
    producerId: 'producer', summary: 'A two-bullet agenda', nextAction: 'Review the exact agenda' };
  const completed = await call(producer, 'room_submit_text_result', submission);
  await close(producer); producer = await open('producer');
  const beforeRetry = auditRecovery(f.store).dataSha256;
  const retriedResult = await call(producer, 'room_submit_text_result', submission);
  assert.equal(retriedResult.eventId, completed.eventId); assert.equal(retriedResult.duplicate, true);
  assert.equal(auditRecovery(f.store).dataSha256, beforeRetry);

  const reviewer = await open('reviewer');
  const reviewStep = (await read(reviewer, 'room_list_work', { focus: 'needs_me' })).work[0];
  assert.equal(reviewStep.next.action, 'verify'); assert.equal(reviewStep.next.completionEventId, completed.eventId);
  const reviewContext = await read(reviewer, reviewStep.nextRead.tool, reviewStep.nextRead.arguments);
  const exactResult = await read(reviewer, 'room_read_result', { workItemId, completionEventId: completed.eventId });
  assert.equal(exactResult.result.text.body, body);
  await call(reviewer, 'room_record_verification', { requestId: 'journey-review', workItemId,
    expectedRevision: reviewContext.work.revision, result: 'pass', completionEventId: completed.eventId,
    evidenceVersion: textVersion(exactResult.result.text.body), summary: 'Two bullets, named owner, concrete next step.' });
  assert.equal(state().workItems[workItemId].verification.independenceConfirmed, true);
  assert.equal(state().workItems[workItemId].decision, null);

  page = await pageForOwner(false);
  await page.locator('[data-work-id="test-handoff"][data-action="decide"]').click();
  await page.waitForFunction(body => document.querySelector('#action-text-body').textContent === body, body);
  assert.equal(await page.locator('#action-fields [name="decision"]').inputValue(), '');
  assert.equal(await page.locator('#decision-review-label').textContent(), 'Independent check · Pass');
  assert.equal(await page.locator('#decision-review').evaluate(node => node.open), false);
  assert.ok((await page.locator('#decision-review > summary').boundingBox()).height >= 44, 'review disclosure has a touch-sized target');
  assert.equal(await page.locator('#action-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: `${prefix}-decision.png` });
  await page.locator('#decision-review > summary').click();
  assert.equal(await page.locator('#decision-review-by').textContent(), 'Test reviewer (reviewer)');
  assert.equal(await page.locator('#decision-review-text').textContent(), 'Two bullets, named owner, concrete next step.');
  assert.equal(await page.locator('#decision-review-version').textContent(), `Evidence ${textVersion(body)}`);
  await page.locator('#action-fields [name="reason"]').fill('Keep my decision notes.');
  await call(reviewer, 'room_record_verification', { requestId: 'journey-later-review', workItemId,
    expectedRevision: state().workItems[workItemId].revision, result: 'pass', completionEventId: completed.eventId,
    evidenceVersion: textVersion(body), summary: 'Later check: <b>still the exact version</b>.' });
  await page.locator('#refresh-action').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#decision-review-text').textContent(), 'Two bullets, named owner, concrete next step.', 'background reviews do not replace pinned evidence');
  assert.equal(await page.locator('#action-form button[type=submit]').isDisabled(), true);
  await page.locator('#refresh-action').click();
  await page.waitForFunction(() => document.querySelector('#decision-review-text').textContent.startsWith('Later check:'));
  assert.equal(await page.locator('#action-fields [name="reason"]').inputValue(), 'Keep my decision notes.');
  assert.equal(await page.locator('#decision-review-text b').count(), 0, 'review text is not interpreted as markup');
  assert.equal(await page.locator('#decision-review').evaluate(node => node.open), false);
  await page.locator('#decision-review > summary').click();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.locator('#action-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.locator('#decision-review').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${prefix}-review-large.png` });
  assert.equal(state().workItems[workItemId].decision, null, 'viewing the human decision never approves it');
  for (const member of ['owner', 'producer', 'reviewer']) {
    assert.equal(f.store.db.prepare('SELECT sequence FROM cursors WHERE room_id=? AND member_id=?').get('commons', member)?.sequence ?? 0, 0);
  }
  assert.deepEqual(errors, []);
  await page.locator('#cancel-action').click();
  await page.locator('#signout-button').click(); await page.locator('#auth-panel').waitFor({ state: 'visible' });
  for (const id of ['decision-review-label', 'decision-review-by', 'decision-review-text', 'decision-review-version']) {
    assert.equal(await page.locator(`#${id}`).textContent(), '', 'sign-out clears review context');
  }
  writeFileSync(`${prefix}.json`, JSON.stringify({ simulatedHuman: true, scriptedMcp: true, nativeModels: false,
    serviceRestarted: true, request: 'answered', exactQuestionRetry: true, exactResultRetry: true,
    resultVersion: textVersion(body), independentReviewRecorded: true, humanApproval: null,
    readMarkers: { owner: 0, producer: 0, reviewer: 0 }, traffic, finalAudit: auditRecovery(f.store) }, null, 2));
});
