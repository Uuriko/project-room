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

for (const touch of [false, true]) test(`simultaneous attention ${touch ? 'touch' : 'desktop'}: stable choices and independent resolution`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture({ managedProducer: true }), handles = [], traffic = [], errors = [];
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    for (const handle of handles) await handle.close();
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const actors = {};
  for (const memberId of ['producer', 'reviewer']) {
    const directory = join(f.directory, memberId);
    saveAgentConnection(directory, { version: 1, origin, roomId: 'commons', memberId, token: f.keys[memberId] });
    actors[memberId] = await openMcpTestClient(directory); handles.push(actors[memberId]);
  }
  const call = async (who, tool, args) => {
    const response = await actors[who].call(tool, args);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    traffic.push({ who, tool }); return response.result.structuredContent;
  };
  const send = (who, type, data) => f.store.command(f.keys[who], 'commons', { id: crypto.randomUUID(), type, data });
  const state = () => f.store.room('commons').state;
  const questions = [];
  for (const [i, body] of ['Which audience is this for?', 'Should we include a budget?', 'What is the delivery date?'].entries()) {
    questions.push(await call(i === 1 ? 'reviewer' : 'producer', 'room_request_reply', {
      requestId: `queue-question-${i}`, toMemberId: 'owner', workItemId: 'test-handoff', body }));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('#access-key').fill(f.keys.owner);
  await page.locator('#auth-form button[type=submit]').click(); await page.locator('#main').waitFor({ state: 'visible' });
  await page.locator('#contribution-open').focus();
  assert.equal(await page.locator('#contribution-open').getAttribute('data-step'), `request:${questions[0].requestMessageId}`);
  for (let i = 0; i < 6; i++) send('owner', 'work.proposed', { workItemId: `queue-work-${i}`, title: `Check source ${i + 1}`,
    definitionOfDone: 'Record the checked source.', accountableMemberId: 'owner', independentVerificationRequired: false, ownerDecisionRequired: false });
  send('owner', 'work.proposed', { workItemId: 'queue-decision', title: 'Choose the release note', definitionOfDone: 'Name the intended audience.',
    accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: 'owner', mode: 'read' });
  await call('producer', 'room_accept_work', { requestId: 'queue-accept', workItemId: 'queue-decision', expectedRevision: 0 });
  const body = 'This release note is for room owners.';
  const draft = await call('producer', 'room_post_draft', { requestId: 'queue-draft', workItemId: 'queue-decision', packetId: 'queue-packet', basisRevision: 1, body });
  await call('producer', 'room_submit_text_result', { requestId: 'queue-result', workItemId: 'queue-decision', expectedRevision: 1,
    evidenceMessageId: draft.messageId, evidenceMessageEventId: draft.eventId, evidenceVersion: textVersion(body), previousCompletionEventId: null,
    producerId: 'producer', summary: 'Release note for room owners', nextAction: 'Review the intended audience.' });
  await page.waitForFunction(() => document.querySelector('#contribution-more').textContent === '9 more');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'contribution-open');
  assert.equal(await page.locator('#contribution-open').getAttribute('data-step'), `request:${questions[0].requestMessageId}`,
    'A new higher-priority decision cannot replace the focused request action');
  const beforeRead = auditRecovery(f.store).dataSha256;
  await page.locator('#contribution-more').click();
  await page.waitForFunction(() => !document.querySelector('#rb-ack-button').disabled);
  assert.equal(await page.locator('#rb-attention-list a').count(), 5);
  assert.equal(await page.locator('#rb-show-all').textContent(), 'Show all (10)');
  await page.locator('#rb-show-all').click();
  assert.equal(await page.locator('#rb-attention-list a').count(), 10);
  assert.equal(auditRecovery(f.store).dataSha256, beforeRead, 'Opening the whole queue is read-only');
  mkdirSync('test-results', { recursive: true });
  const prefix = `test-results/simultaneous-attention-${touch ? 'touch' : 'desktop'}`;
  await page.locator('#return-brief-panel > summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${prefix}-queue.png` });
  const link = index => page.locator(`#rb-attention-list [data-open-message="${questions[index].requestMessageId}"]`);
  await link(1).focus();
  await call('reviewer', 'room_cancel_request', { requestId: 'queue-cancel', requestMessageId: questions[1].requestMessageId,
    expectedRequestRevision: 0, reason: 'Budget is already specified in the room brief.' });
  await link(1).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.openMessage), questions[2].requestMessageId,
    'When a focused request clears, focus moves to its surviving next neighbor rather than restarting the queue');
  await page.screenshot({ path: `${prefix}-neighbor.png` });
  await link(2).press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.messageRecordId), questions[2].requestMessageId);
  await page.locator(`[data-message-id="${questions[2].requestMessageId}"][data-message-action="request-answered"]`).click();
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled);
  await page.locator('#message-input').fill('Friday. Keep the audience question open for the project lead.');
  const arrival = send('owner', 'message.posted', { messageId: 'queue-background', body: 'A source note has been updated.' });
  await page.waitForFunction(sequence => document.querySelector('#event-count').textContent === String(sequence), arrival.sequence);
  assert.equal(await page.locator('#message-input').inputValue(), 'Friday. Keep the audience question open for the project lead.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-input', 'Background activity does not steal composer focus');
  if (touch) await page.locator('#message-form button[type=submit]').click(); else await page.locator('#message-input').press('Enter');
  await page.locator('#request-mode-bar').waitFor({ state: 'hidden' });
  if (!touch) assert.equal(await page.evaluate(() => document.activeElement.id), 'message-input', 'Keyboard send preserves composer focus');
  assert.deepEqual(questions.map(q => state().replyRequests[q.requestMessageId].status), ['open', 'cancelled', 'answered']);
  assert.equal(state().workItems['queue-decision'].decision, null);
  for (let i = 0; i < 6; i++) assert.equal(state().workItems[`queue-work-${i}`].state, 'proposed');
  const beforeAgentRead = auditRecovery(f.store).dataSha256;
  for (const [i, who] of ['producer', 'reviewer', 'producer'].entries()) {
    const result = await call(who, 'room_read_request', { requestMessageId: questions[i].requestMessageId });
    assert.equal(result.request.status, ['open', 'cancelled', 'answered'][i]);
    if (i === 2) assert.match(result.page.items.at(-1).message.body, /^Friday\./);
  }
  assert.equal(auditRecovery(f.store).dataSha256, beforeAgentRead);
  await page.locator('#return-brief-panel > summary').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#rb-attention-list a').count(), 8);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await link(0).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: `${prefix}-remaining-large.png` });
  // The remaining request is last in this queue: use the preceding surviving
  // work, not the first row, when its requester explicitly cancels it too.
  await link(0).focus();
  await call('producer', 'room_cancel_request', { requestId: 'queue-cancel-last', requestMessageId: questions[0].requestMessageId,
    expectedRequestRevision: 0, reason: 'The project lead supplied the audience separately.' });
  await link(0).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.openWork), 'queue-decision');
  assert.equal(await page.locator('#rb-attention-list a').count(), 7);
  const markers = Object.fromEntries(['owner', 'producer', 'reviewer'].map(member => [member,
    f.store.db.prepare('SELECT sequence FROM cursors WHERE room_id=? AND member_id=?').get('commons', member)?.sequence ?? 0]));
  assert.deepEqual(markers, { owner: 0, producer: 0, reviewer: 0 }); assert.deepEqual(errors, []);
  writeFileSync(`${prefix}.json`, JSON.stringify({ simulatedHuman: true, scriptedMcp: true, nativeModels: false,
    initialNeeds: 10, afterAnswerNeeds: 8, remainingNeeds: 7, requestStates: ['cancelled', 'cancelled', 'answered'], humanApproval: null,
    readMarkers: markers, traffic, finalAudit: auditRecovery(f.store) }, null, 2));
});

for (const crowded of [false, true]) for (const touch of [false, true]) test(`${crowded ? 'crowded ' : ''}reconnect collaboration ${touch ? 'touch' : 'desktop'}: clarify, restart, contribute and review`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture({ managedProducer: crowded }), handles = new Set(), traffic = [], errors = [];
  let server = createRoomServer({ store: f.store, streamInterval: 50 }), browser;
  const listen = port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const stopServer = async () => { server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve)); };
  const close = async handle => { handles.delete(handle); await handle.close(); };
  t.after(async () => { for (const handle of handles) await handle.close(); await browser?.close();
    await stopServer(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const background = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
  if (crowded) {
    for (let i = 0; i < 80; i++) background('work.proposed', { workItemId: `background-${i}`, title: `Observation archive ${i}`,
      definitionOfDone: 'File the synthetic observation note with its reference.', accountableMemberId: 'guest',
      independentVerificationRequired: false, ownerDecisionRequired: false });
    for (let i = 0; i < 240; i++) background('message.posted', { messageId: `background-message-${i}`,
      body: `Synthetic discussion ${i}: the observation archive has a new note. No action is requested here.` });
  }
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
  if (crowded) for (let i = 0; i < 30; i++) background('message.posted', { messageId: `later-background-${i}`,
    body: `Later synthetic discussion ${i}. The archive note is unchanged.` });

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
  mkdirSync('test-results', { recursive: true });
  const prefix = `test-results/${crowded ? 'crowded-' : ''}reconnect-collaboration-${touch ? 'touch' : 'desktop'}`;
  if (crowded) {
    const beforeNavigation = auditRecovery(f.store).dataSha256;
    assert.equal(await page.locator('[data-work-record-id]').count(), 81, 'All work remains reachable');
    assert.match(await page.locator('#contribution-title').textContent(), /agenda/i);
    await page.screenshot({ path: `${prefix}-arrival.png` });
    await page.locator('#return-brief-panel > summary').click();
    await page.waitForFunction(() => !document.querySelector('#rb-ack-button').disabled);
    assert.equal(await page.locator('#rb-attention-list a').count(), 1);
    assert.equal(await page.locator('#rb-attention-list [data-open-message]').getAttribute('data-open-message'), question.requestMessageId);
    for (const id of ['rb-involving-section', 'rb-history-section']) assert.equal(await page.locator(`#${id}`).evaluate(node => node.open), false);
    await page.screenshot({ path: `${prefix}-catchup.png` });
    await page.locator('#return-brief-panel > summary').click();
    await page.locator('#message-search').fill('prepare an agenda');
    const hit = page.locator('#search-list [data-open-work="test-handoff"]');
    await hit.focus(); await hit.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.workRecordId), workItemId);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: `${prefix}-selected.png` });
    await page.locator('#clear-search').click();
    await page.locator('#contribution-open').click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.messageRecordId), question.requestMessageId);
    assert.equal(auditRecovery(f.store).dataSha256, beforeNavigation, 'catch-up, search and navigation do not mark read or mutate Room data');
    const requestRow = page.locator(`[data-message-record-id="${question.requestMessageId}"]`);
    const beforeTop = await requestRow.evaluate(node => node.getBoundingClientRect().top);
    const arrival = background('message.posted', { messageId: 'while-reading-request', body: 'Another synthetic archive update while the owner reads the request.' });
    await page.waitForFunction(sequence => document.querySelector('#event-count').textContent === String(sequence), arrival.sequence);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.messageRecordId), question.requestMessageId);
    assert.ok(Math.abs(await requestRow.evaluate(node => node.getBoundingClientRect().top) - beforeTop) <= 2,
      `New discussion does not pull the reader away from the older request: ${JSON.stringify(await requestRow.evaluate((node, beforeTop) => ({ beforeTop,
        afterTop: node.getBoundingClientRect().top, list: document.querySelector('#message-list').getBoundingClientRect().toJSON(), scrollY,
        listScroll: document.querySelector('#message-list').scrollTop }), beforeTop))}`);
    assert.equal(await page.locator('#new-messages-button').isVisible(), true);
  }
  await page.locator(`[data-message-id="${question.requestMessageId}"][data-message-action="request-answered"]`).click();
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled);
  const answer = 'Two bullets. Name Room owner and end with a concrete next step.';
  await page.locator('#message-input').fill(answer);
  if (touch) await page.locator('#message-form button[type=submit]').click();
  else await page.locator('#message-input').press('Enter');
  await page.locator('#request-mode-bar').waitFor({ state: 'hidden' });
  assert.equal(state().replyRequests[question.requestMessageId].status, 'answered');
  assert.equal(state().workItems[workItemId].state, 'working', 'a reply does not complete work');
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
  if (crowded) {
    assert.match(await page.locator('#contribution-title').textContent(), /agenda/i);
    await page.screenshot({ path: `${prefix}-ready.png` });
    await page.locator('#contribution-open').click();
  } else await page.locator('[data-work-id="test-handoff"][data-action="decide"]').click();
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
  assert.equal(await page.locator('#action-error').textContent(), '', 'A successful same-evidence refresh is not presented as an error');
  assert.equal(await page.locator('#action-error').evaluate(node => node.classList.contains('error')), false);
  assert.equal(await page.locator('#decision-review-text b').count(), 0, 'review text is not interpreted as markup');
  assert.equal(await page.locator('#decision-review').evaluate(node => node.open), false);
  await page.locator('#decision-review > summary').click();
  const reviewFonts = await page.locator('#review-criteria, #decision-review-text, #decision-review-by, #decision-review-label')
    .evaluateAll(nodes => nodes.map(node => ({ id: node.id, pixels: parseFloat(getComputedStyle(node).fontSize) })));
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  for (const font of reviewFonts) assert.ok(await page.locator(`#${font.id}`).evaluate((node, pixels) =>
    parseFloat(getComputedStyle(node).fontSize) >= pixels * 1.9, font.pixels), `${font.id} follows the larger text preference`);
  await page.screenshot({ path: `${prefix}-scaled-layout.png` });
  assert.equal(await page.locator('#action-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true,
    JSON.stringify(await page.locator('#action-dialog').evaluate(dialog => [...dialog.querySelectorAll('*')]
      .filter(node => node.getBoundingClientRect().right > dialog.getBoundingClientRect().right)
      .map(node => ({ tag: node.tagName, id: node.id, class: node.className, width: node.getBoundingClientRect().width })))));
  await page.locator('#decision-review').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${prefix}-review-large.png` });
  for (const selector of ['#action-fields [name="decision"]', '#action-fields [name="reason"]', '#action-form button[type="submit"]']) {
    const control = page.locator(selector); await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= page.viewportSize().height, 'Decision controls remain reachable with enlarged text');
  }
  await page.screenshot({ path: `${prefix}-controls-large.png` });
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
    crowded, managedProducer: crowded, unrelatedWork: crowded ? 80 : 0, unrelatedMessages: crowded ? 271 : 0,
    serviceRestarted: true, request: 'answered', exactQuestionRetry: true, exactResultRetry: true,
    resultVersion: textVersion(body), independentReviewRecorded: true, humanApproval: null,
    readMarkers: { owner: 0, producer: 0, reviewer: 0 }, traffic, finalAudit: auditRecovery(f.store) }, null, 2));
});
