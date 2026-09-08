// Simulated accountable human, actual scripted MCP helper and reviewer. No models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { openMcpTestClient } from './mcp-test-client.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { createRoomServer } from '../server/http.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { textVersion } from '../server/text-results.mjs';
import { EVENT_TYPES as T } from '../src/events.js';

for (const multiple of [false, true]) for (const touch of [false, true]) test(`${multiple ? 'alternative contributions' : 'voluntary help'} ${touch ? 'touch' : 'desktop'}: offer, answer, draft, adopt and independently review`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture({ managedProducer: true }), handles = new Set(), traffic = [], errors = [];
  const server = createRoomServer({ store: f.store, streamInterval: 50 }); let browser;
  t.after(async () => {
    for (const handle of handles) await handle.close(); await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const workItemId = 'shared-guide', title = 'Contributor guide', state = () => f.store.room('commons').state;
  if (multiple) {
    f.store.command(f.keys.owner, 'commons', { id: 'add-alternate', type: T.MEMBER_ADDED, data: {
      memberId: 'alternate', displayName: 'Test alternate', kind: 'agent', accountableHumanId: 'owner', permissions: ['accept_work', 'complete_work'] } });
    f.keys.alternate = f.store.issueAccessKey('commons', 'alternate');
  }
  f.store.command(f.keys.owner, 'commons', { id: 'help-work', type: 'work.proposed', data: { workItemId, title,
    definitionOfDone: 'Two steps: offer bounded help, then preserve attribution when adopting the draft.', mode: 'read',
    accountableMemberId: 'owner', verifierMemberId: 'reviewer', independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: 'owner' } });
  if (multiple) f.store.command(f.keys.owner, 'commons', { id: 'ask-alternative', type: T.MESSAGE_POSTED, data: {
    messageId: 'ask-alternative', workItemId, toMemberId: 'alternate',
    body: 'Test alternate: contribute a second two-step guide here for comparison. I will inspect both and choose; do not take over the assignment or use external tools.' } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`, dirs = {};
  for (const memberId of ['producer', 'reviewer', ...(multiple ? ['alternate'] : [])]) {
    dirs[memberId] = join(f.directory, memberId);
    saveAgentConnection(dirs[memberId], { version: 1, origin, roomId: 'commons', memberId, token: f.keys[memberId] });
  }
  const open = async who => { const handle = await openMcpTestClient(dirs[who]); handles.add(handle); return handle; };
  const close = async handle => { handles.delete(handle); await handle.close(); };
  const call = async (handle, tool, args = {}, read = false) => {
    const before = read ? auditRecovery(f.store).dataSha256 : null;
    const response = await handle.call(tool, args);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    if (read) assert.equal(auditRecovery(f.store).dataSha256, before, `${tool} is read-only`);
    traffic.push({ tool, readOnly: read }); return response.result.structuredContent;
  };
  let helper = await open('producer');
  const found = await call(helper, 'room_list_work', { query: title }, true);
  assert.equal(found.work.length, 1);
  const context = await call(helper, found.work[0].nextRead.tool, found.work[0].nextRead.arguments, true);
  assert.equal(context.work.accountableMemberId, 'owner'); assert.deepEqual(context.suggestedActions, []);
  assert.equal(context.collaboration.status, 'may_offer');
  const offer = context.collaboration.offer;
  const previous = await call(helper, offer.checkExisting.tool, offer.checkExisting.arguments, true);
  assert.equal(previous.requests.filter(request => request.workItemId === workItemId).length, 0);
  await call(helper, offer.readDiscussion.tool, offer.readDiscussion.arguments, true);
  const requestInput = { ...offer.request.arguments, requestId: 'help-offer',
    body: 'I can draft a two-step contributor guide here. Would that help? I will not take over the task or edit an external repository.' };
  const question = await call(helper, offer.request.tool, requestInput);
  const beforeRefusal = auditRecovery(f.store).dataSha256;
  const refused = await helper.call('room_accept_work', { requestId: 'help-not-assigned', workItemId, expectedRevision: 0 });
  assert.equal(refused.result.isError, true); assert.equal(auditRecovery(f.store).dataSha256, beforeRefusal);
  assert.equal(state().workItems[workItemId].state, 'proposed');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('#access-key').fill(f.keys.owner);
  await page.locator('#auth-form button[type=submit]').click(); await page.locator('#main').waitFor({ state: 'visible' });
  mkdirSync('test-results', { recursive: true }); const prefix = `test-results/${multiple ? 'help-alternatives' : 'help-contribution'}-${touch ? 'touch' : 'desktop'}`;
  await page.locator('#contribution-open').click();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.messageRecordId), question.requestMessageId);
  await page.screenshot({ path: `${prefix}-offer.png` });
  assert.equal(await page.locator(`[data-message-record-id="${question.requestMessageId}"]`).evaluate(row => {
    const list = document.querySelector('#message-list').getBoundingClientRect(), bounds = row.getBoundingClientRect();
    return bounds.top >= list.top - 1 && bounds.top < Math.min(list.bottom, innerHeight);
  }), true, 'Opening an offer shows its beginning, not only its bottom action buttons');
  await page.locator(`[data-message-id="${question.requestMessageId}"][data-message-action="request-answered"]`).click();
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled);
  const answer = 'Yes, draft those two steps here. I remain accountable and will inspect and adopt the result; the reviewer will check it.';
  await page.locator('#message-input').fill(answer);
  if (touch) await page.locator('#message-form button[type=submit]').click(); else await page.locator('#message-input').press('Enter');
  await page.locator('#request-mode-bar').waitFor({ state: 'hidden' });
  assert.equal(state().workItems[workItemId].revision, 0, 'A conversational yes is not assignment, acceptance or completion');
  await page.locator(`[data-work-id="${workItemId}"][data-action="accept"]`).click();
  await page.locator('#action-form button[type=submit]').click(); await page.locator('#action-dialog').waitFor({ state: 'hidden' });
  assert.equal(state().workItems[workItemId].state, 'accepted');
  if (touch) {
    await page.locator(`[data-work-id="${workItemId}"][data-action="start"]`).click();
    await page.locator('#action-form button[type=submit]').click(); await page.locator('#action-dialog').waitFor({ state: 'hidden' });
    assert.equal(state().workItems[workItemId].state, 'working');
  }
  // Service-driven events exercise browser replay, not human invitation controls.
  // This existing conversational offer predates the invitation and is not
  // falsely presented as an invitation-bound offer or automated dispatch.
  const unsent = 'Keep this unsent note while help changes.';
  await page.locator('#message-input').fill(unsent); await page.locator('#message-input').focus();
  const basis = state().workItems[workItemId].revision;
  const help = f.store.command(f.keys.owner, 'commons', { id: 'browser-help-open', type: T.WORK_HELP_UPDATED,
    data: { workItemId, expectedRevision: basis, expectedHelpRevision: 0, status: 'open',
      scope: 'Suggest one additional guide improvement in this Room.', expiresAt: new Date(Date.now() + 3600000).toISOString() } });
  await page.locator(`[data-event-record-id="${help.event.id}"]`).waitFor({ state: 'attached' });
  const invitations = await call(helper, 'room_list_work', { focus: 'help_wanted' }, true);
  assert.equal(invitations.work.find(item => item.id === workItemId)?.help.canOffer, true);
  assert.equal((await call(helper, 'room_read_work', { workItemId }, true)).help.help.eventId, help.event.id);
  const withdrawn = f.store.command(f.keys.owner, 'commons', { id: 'browser-help-withdraw', type: T.WORK_HELP_UPDATED,
    data: { workItemId, expectedRevision: basis, expectedHelpRevision: 1, status: 'withdrawn' } });
  await page.locator(`[data-event-record-id="${withdrawn.event.id}"]`).waitFor({ state: 'attached' });
  assert.equal((await call(helper, 'room_list_work', { focus: 'help_wanted' }, true)).work.some(item => item.id === workItemId), false);
  assert.equal(await page.locator('#message-input').inputValue(), unsent);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-input');
  assert.equal(state().workItems[workItemId].revision, basis);
  await page.screenshot({ path: `${prefix}-help-storage.png` });
  await page.locator('#message-input').fill('');
  await close(helper); helper = await open('producer');
  const response = await call(helper, 'room_read_request', { requestMessageId: question.requestMessageId }, true);
  assert.equal(response.request.status, 'answered'); assert.equal(response.page.items.at(-1).message.body, answer);
  const beforeRetry = auditRecovery(f.store).dataSha256;
  const retry = await call(helper, offer.request.tool, requestInput);
  assert.equal(retry.duplicate, true); assert.equal(retry.eventId, question.eventId);
  assert.equal(auditRecovery(f.store).dataSha256, beforeRetry);
  const current = await call(helper, 'room_read_work', { workItemId }, true);
  const body = '1. Offer bounded help and agree on the scope.\n2. The accountable person adopts the draft with its contributor named.';
  const draftInput = { requestId: 'help-draft', workItemId, packetId: 'help-guide', basisRevision: current.work.revision, body };
  const beforeStale = auditRecovery(f.store).dataSha256;
  assert.equal((await helper.call('room_post_draft', { ...draftInput, requestId: 'help-stale-draft', basisRevision: 0 })).result.isError, true);
  assert.equal(auditRecovery(f.store).dataSha256, beforeStale, 'The offer does not waive a current draft basis');
  const draft = await call(helper, 'room_post_draft', draftInput);
  const exact = await call(helper, 'room_read_result', { workItemId, draftMessageId: draft.messageId }, true);
  assert.equal(exact.result.text.postedById, 'producer'); assert.equal(exact.result.text.evidenceVersion, textVersion(body));
  let alternateDraft = null;
  if (multiple) {
    const alternate = await open('alternate');
    const alternateContext = await call(alternate, 'room_read_work', { workItemId }, true);
    assert.equal(alternateContext.work.revision, current.work.revision);
    const before = await call(alternate, 'room_read_work_discussion', { workItemId }, true);
    assert.ok(before.discussion.items.some(row => row.message.id === 'ask-alternative'));
    alternateDraft = await call(alternate, 'room_post_draft', { requestId: 'alternate-draft', workItemId,
      packetId: 'alternate-guide', basisRevision: alternateContext.work.revision,
      body: '1. Agree on a bounded contribution.\n2. Compare drafts and credit the selected contributor.' });
    const discussion = await call(helper, 'room_read_work_discussion', { workItemId }, true);
    assert.deepEqual(discussion.discussion.items.filter(row => row.message.proposal).map(row => row.message.id), [draft.messageId, alternateDraft.messageId]);
  }
  const beforeDraftRetry = auditRecovery(f.store).dataSha256;
  assert.equal((await call(helper, 'room_post_draft', draftInput)).duplicate, true);
  assert.equal(auditRecovery(f.store).dataSha256, beforeDraftRetry);
  assert.equal(state().workItems[workItemId].receipt, null, 'Posting help is not adopting it');
  const takeover = await helper.call('room_submit_text_result', { requestId: 'help-cannot-complete', workItemId,
    expectedRevision: current.work.revision, evidenceMessageId: draft.messageId, evidenceMessageEventId: draft.eventId,
    evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: 'producer', summary: 'Contributor guide', nextAction: 'Review' });
  assert.equal(takeover.result.isError, true);
  assert.equal(auditRecovery(f.store).dataSha256, beforeDraftRetry, 'A positive reply does not authorize completing another member’s work');
  await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
  await page.screenshot({ path: `${prefix}-return.png` });
  await page.waitForFunction(label => document.querySelector('#contribution-label').textContent === label, multiple ? 'Drafts to inspect' : 'Draft to inspect');
  await page.locator('#return-brief-panel > summary').click();
  const draftStep = page.locator(multiple ? `#rb-attention-list [data-open-work="${workItemId}"]` : `#rb-attention-list [data-open-message="${draft.messageId}"]`);
  await draftStep.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#rb-attention-list .rb-event').count(), 1, 'One draft replaces the same work start step');
  assert.equal(await page.locator(`#rb-involving-list [data-open-work="${workItemId}"]`).count(), 0, 'The same work is not repeated as other open work');
  await page.screenshot({ path: `${prefix}-return-catchup.png` });
  if (multiple) {
    await draftStep.click();
    const choices = page.locator(`[data-work-record-id="${workItemId}"] .work-drafts`);
    assert.equal(await choices.evaluate(node => node.open), true, 'Catch-up opens the same choices as the primary shortcut');
    await choices.locator('summary').click();
  }
  await page.locator('#return-brief-panel > summary').click();
  await page.locator('#contribution-open').focus();
  await page.locator('#contribution-open').press('Enter');
  if (multiple) {
    const choices = page.locator(`[data-work-record-id="${workItemId}"] .work-drafts`);
    assert.equal(await choices.evaluate(node => node.open), true);
    assert.equal(await choices.locator('a[data-open-message]').count(), 2);
    assert.deepEqual(await choices.locator('a[data-open-message]').evaluateAll(nodes => nodes.map(node => node.dataset.openMessage)), [alternateDraft.messageId, draft.messageId]);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), `work-drafts:${workItemId}`);
    assert.equal(await page.locator(`[data-work-record-id="${workItemId}"] .work-details`).evaluate(node => node.open), false, 'Draft inspection does not expand unrelated settings');
    await page.screenshot({ path: `${prefix}-choices.png` });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await choices.locator('summary').focus();
    await choices.locator('summary').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await choices.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: `${prefix}-choices-large.png` });
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await choices.locator(`[data-open-message="${draft.messageId}"]`).click();
  }
  assert.equal(await page.evaluate(() => document.activeElement.dataset.messageRecordId), draft.messageId);
  await page.screenshot({ path: `${prefix}-return-draft.png` });
  assert.equal(auditRecovery(f.store).dataSha256, beforeDraftRetry, 'Returning and opening a draft do not change work or read markers');
  await page.locator(`[data-message-id="${draft.messageId}"][data-message-action="result"]`).click();
  await page.waitForFunction(body => document.querySelector('#action-text-body').textContent === body, body);
  await page.locator('#action-fields [name=producerId]').selectOption('producer');
  await page.locator('#action-fields [name=summary]').fill('A two-step contributor guide');
  await page.locator('#action-fields [name=nextAction]').fill('Independently check the exact text.');
  assert.equal(await page.locator('#action-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: `${prefix}-adopt.png` });
  await page.locator('#action-form button[type=submit]').click(); await page.locator('#action-dialog').waitFor({ state: 'hidden' });
  const receipt = state().workItems[workItemId].receipt;
  assert.equal(receipt.nativeText.messageId, draft.messageId, 'Adoption preserves the deliberately chosen nonlatest draft');
  assert.equal(receipt.reportedById, 'owner'); assert.equal(receipt.producerId, 'producer'); assert.equal(receipt.nativeText.postedById, 'producer');
  assert.equal(state().workItems[workItemId].accountableMemberId, 'owner'); assert.equal(Object.keys(state().workItems).length, 2);
  const reviewer = await open('reviewer'), review = await call(reviewer, 'room_read_work', { workItemId }, true);
  assert.equal(review.collaboration.status, 'closed');
  const evidence = await call(reviewer, 'room_read_result', { workItemId, completionEventId: receipt.eventId }, true);
  assert.equal(evidence.result.text.body, body);
  await call(reviewer, 'room_record_verification', { requestId: 'help-review', workItemId, expectedRevision: review.work.revision,
    result: 'pass', completionEventId: receipt.eventId, evidenceVersion: textVersion(body), summary: 'Two steps preserve scope and contributor attribution.' });
  assert.equal(state().workItems[workItemId].verification.independenceConfirmed, true);
  await page.locator(`[data-work-id="${workItemId}"][data-action="decide"]`).click();
  await page.waitForFunction(() => document.querySelector('#decision-review-label').textContent === 'Independent check · Pass');
  await page.waitForFunction(body => document.querySelector('#action-text-body').textContent === body, body);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.locator('#action-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: `${prefix}-review.png` });
  assert.equal(state().workItems[workItemId].decision, null);
  const markers = Object.fromEntries(['owner', 'producer', 'reviewer'].map(member => [member,
    f.store.db.prepare('SELECT sequence FROM cursors WHERE room_id=? AND member_id=?').get('commons', member)?.sequence ?? 0]));
  assert.deepEqual(markers, { owner: 0, producer: 0, reviewer: 0 }); assert.deepEqual(errors, []);
  await page.locator('#cancel-action').click(); await page.locator('#signout-button').click();
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#action-text-body').textContent(), '');
  writeFileSync(`${prefix}.json`, JSON.stringify({ simulatedHuman: true, scriptedMcp: true, nativeModels: false,
    workItemId, oneSharedRecord: true, contributors: multiple ? ['producer', 'alternate'] : ['producer'], selectedEarlierDraft: multiple,
    returnedFrom: touch ? 'working' : 'accepted', draftShortcut: true, helpEventsApplied: true, helpDiscovery: true, helpInvitationUITested: false,
    accountable: 'owner', postedBy: 'producer', reportedProducer: 'producer', reportedBy: 'owner',
    request: 'answered', reconnect: true, exactOfferRetry: true, exactDraftRetry: true, review: 'pass', humanApproval: null,
    evidenceVersion: textVersion(body), readMarkers: markers, traffic, finalAudit: auditRecovery(f.store) }, null, 2));
});
