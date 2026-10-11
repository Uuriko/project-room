// Synthetic restart journey in a real browser; no real user data or agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { signInFixture } from './auth-signin.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { join } from 'node:path';
import { nativeWorkDraft, parseWorkReturn } from '../src/work-packet.js';
import { textVersion } from '../server/text-results.mjs';

for (const mobile of [false, true]) test(`resume handoff ${mobile ? 'phone' : 'desktop'}: visible next step, opt-in export and no writes`, { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const send = (type, data) => f.store.command(f.keys.producer, 'commons', { id: crypto.randomUUID(), type, data });
  send(T.WORK_ACCEPTED, { workItemId: 'test-handoff', expectedRevision: 0 });
  send(T.WORK_HANDOFF_RECORDED, { workItemId: 'test-handoff', expectedRevision: 1,
    doneSummary: 'Parser built; escaped separators still need testing.', nextAction: 'Check escaped separators.', limitReason: '<script>window.handoffExecuted=true</script>Session ended.' });
  const before = f.store.snapshot(f.keys.owner, 'commons');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  const card = page.locator('[data-work-record-id="test-handoff"]');
  const handoff = card.locator('[data-work-handoff]'); await handoff.waitFor({ state: 'visible' });
  assert.match(await handoff.innerText(), /Check escaped separators/);
  assert.equal(await handoff.getByRole("link", { name: "Open discussion" }).count(), 1);
  await handoff.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/project-room-resume-${mobile ? 'phone' : 'desktop'}.png`, fullPage: true });
  assert.equal(await handoff.getByText('Session ended.', { exact: false }).isVisible(), false);
  await handoff.getByText('Why work paused', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.handoffExecuted), undefined);
  await card.locator('details.work-details > summary').click();
  await card.getByRole('button', { name: 'Use my AI', exact: true }).click();
  const preview = page.locator('#packet-preview');
  assert.equal((await preview.inputValue()).includes('Parser built'), false);
  await page.locator('#portable-progress').check();
  assert.match(await preview.inputValue(), /Parser built/);
  await page.screenshot({ path: `/tmp/project-room-resume-prompt-${mobile ? 'phone' : 'desktop'}.png`, fullPage: true });
  assert.match(await preview.inputValue(), /Check escaped separators/);
  assert.match(await preview.inputValue(), /does not authorize external changes/);
  assert.equal((await preview.inputValue()).includes('Please prepare an agenda'), false);
  await page.locator('#portable-progress').uncheck();
  assert.equal((await preview.inputValue()).includes('Parser built'), false);
  await page.locator('#portable-close').click();
  await card.getByRole('button', { name: 'Use my AI', exact: true }).click();
  assert.equal(await page.locator('#portable-progress').isChecked(), false);
  await page.locator('#portable-close').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(f.store.snapshot(f.keys.owner, 'commons').state.workItems, before.state.workItems);
  assert.deepEqual(errors, []);
  // A subsequent real transition closes the handoff; its urgent card disappears.
  send(T.WORK_STARTED, { workItemId: 'test-handoff', expectedRevision: 2 });
  await handoff.waitFor({ state: 'detached' });
});

test('two people and two scripted agents continue one artifact after restart, with stale returns and revoked access fenced', { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture();
  let server, origin, browser;
  const start = async () => {
    server = createRoomServer({ store: f.store, streamInterval: 40 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close();
  };
  t.after(async () => { await browser?.close(); await stop(); rmSync(f.directory, { recursive: true, force: true }); });
  await start();
  const actor = role => new RoomAgentClient({ origin, roomId: 'commons', token: f.keys[role] });
  const command = (role, type, data) => actor(role).command({ id: crypto.randomUUID(), type, data });
  const work = async () => (await actor('producer').workContext('shared-journey')).work;
  await command('owner', T.WORK_PROPOSED, { workItemId: 'shared-journey', title: 'Continue the shared agenda',
    definitionOfDone: 'Agenda names its owner; a different member checks the exact text.', accountableMemberId: 'producer',
    verifierMemberId: 'owner', independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: 'owner',
    sourceMessageId: 'test-request', mode: 'read' });
  await command('producer', T.WORK_ACCEPTED, { workItemId: 'shared-journey', expectedRevision: 0 });
  const session = await fetch(`${origin}/api/rooms/commons/work-sessions`, { method: 'POST', headers: {
    Authorization: `Bearer ${f.keys.producer}`, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ requestId: crypto.randomUUID(), workItemId: 'shared-journey', expectedRevision: 1, action: 'set_status', status: 'processing' }) });
  assert.equal(session.status, 201);
  await command('producer', T.WORK_HANDOFF_RECORDED, { workItemId: 'shared-journey', expectedRevision: (await work()).revision,
    doneSummary: 'Agenda draft saved; the owner is missing.', nextAction: 'Add the named owner without losing the agenda.', limitReason: 'Scripted adapter interrupted.' });
  const stopped = await fetch(`${origin}/api/rooms/commons/work-sessions`, { method: 'POST', headers: {
    Authorization: `Bearer ${f.keys.producer}`, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ requestId: crypto.randomUUID(), workItemId: 'shared-journey', expectedRevision: (await work()).revision, action: 'set_status', status: 'failed' }) });
  assert.equal(stopped.status, 201);
  await command('owner', T.MESSAGE_POSTED, { messageId: 'unselected-context', body: 'Unrelated conversation must not enter the continuation packet.' });
  await stop(); f.store = new RoomStore(join(f.directory, 'room.sqlite')); await start();
  assert.equal((await actor('reviewer').workContext('shared-journey')).work.handoff.doneSummary, 'Agenda draft saved; the owner is missing.');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await signInFixture(page, f.keys.guest);
  const card = page.locator('[data-work-record-id="shared-journey"]');
  await card.getByRole('button', { name: 'Continue with saved context', exact: true }).click();
  assert.equal(await page.locator('#portable-progress').isChecked(), true);
  const packet = await page.locator('#packet-preview').inputValue();
  assert.match(packet, /Agenda draft saved; the owner is missing/);
  assert.match(packet, /Add the named owner/);
  assert.match(packet, /does not authorize external changes/);
  assert.equal(packet.includes('Unrelated conversation'), false);
  const reference = packet.split('\n').find(line => line.startsWith('ROOM-RETURN '));
  await page.screenshot({ path: 'test-results/shared-continuation.png', fullPage: true });
  await page.locator('#portable-close').click();
  // A second human contributes the correction through their own browser.
  await page.locator('#message-input').fill('Use Room owner as the named owner.');
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#message-input').value === '');
  const current = await work();
  const result = 'Owner: Room owner. Agenda: review the proposal and record the decision.';
  const draft = nativeWorkDraft(result, { workItemId: 'shared-journey', packetId: 'second-agent-draft', basisRevision: current.revision });
  await command('reviewer', T.MESSAGE_POSTED, { ...draft, messageId: 'continued-artifact' });
  // The original producer remains accountable and submits the second agent's
  // immutable Room text; this does not manufacture a permission transfer.
  await command('producer', T.WORK_ACCEPTED, { workItemId: 'shared-journey', expectedRevision: (await work()).revision });
  await command('producer', T.WORK_STARTED, { workItemId: 'shared-journey', expectedRevision: (await work()).revision });
  const oldReturn = parseWorkReturn(reference + '\n\nStale replacement', { roomId: 'commons', workItemId: 'shared-journey' });
  await assert.rejects(command('guest', T.MESSAGE_POSTED, { ...oldReturn, messageId: 'stale-artifact' }), error => error.status === 409);
  const context = await actor('reviewer').workResult('shared-journey', { draftMessageId: 'continued-artifact' });
  await command('producer', T.WORK_COMPLETED, { workItemId: 'shared-journey', expectedRevision: (await work()).revision,
    evidenceKind: 'room_text', evidenceMessageId: 'continued-artifact', evidenceMessageEventId: context.result.text.messageEventId,
    evidenceVersion: textVersion(result), previousCompletionEventId: null, producerId: 'reviewer',
    summary: result, nextAction: 'Review this exact agenda.' });
  const selected = await actor('guest').workResult('shared-journey');
  assert.equal(selected.result.text.body, result);
  assert.equal(selected.result.text.postedById, 'reviewer');
  assert.equal(selected.result.receipt.producerId, 'reviewer');
  assert.match(selected.result.text.body, /^Owner: Room owner\./);
  assert.equal(selected.result.text.evidenceVersion, textVersion(result));
  await command('owner', T.VERIFICATION_RECORDED, { workItemId: 'shared-journey', expectedRevision: (await work()).revision,
    result: 'pass', completionEventId: selected.result.receipt.eventId, evidenceVersion: textVersion(result),
    summary: 'Scripted check: exact text hash matches and the agenda names its owner.' });
  await command('owner', T.MESSAGE_POSTED, { messageId: 'acceptance-rationale', body: 'Accept the corrected agenda: its text names the owner and matches the reviewed hash.' });
  await command('owner', T.OWNER_DECISION_RECORDED, { workItemId: 'shared-journey', expectedRevision: (await work()).revision,
    decision: 'approved', completionEventId: selected.result.receipt.eventId, evidenceVersion: textVersion(result),
    reason: 'Synthetic human acceptance of the corrected agenda.', sourceMessageId: 'acceptance-rationale' });
  assert.equal((await actor('owner').workContext('shared-journey')).next.action, 'complete');
  const snapshot = await actor('guest').snapshot();
  assert.ok(snapshot.state.messages.some(m => m.authorId === 'guest' && m.body === 'Use Room owner as the named owner.'));
  assert.equal(snapshot.state.messages.some(m => m.id === 'stale-artifact'), false);
  f.store.issueAccessKey('commons', 'guest');
  await assert.rejects(actor('guest').workContext('shared-journey'), error => error.status === 401);
  assert.deepEqual(errors, []);
});
