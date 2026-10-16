import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { clickChrome } from './room-chrome.mjs';
import { signInFixture } from './auth-signin.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { axeSerious, assertAxeClean } from './a11y-axe-helper.mjs';

const output = process.env.ROOM_BROWSER_OUTPUT;
async function fixture(t, { width = 1280, theme = 'dark', member = 'owner', prepare, setupPage } = {}) {
  const f = createAcceptanceFixture();
  prepare?.(f);
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await setupPage?.(page);
  await page.goto(origin); await signInFixture(page, f.keys[member]);
  await page.locator('#main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.body.classList.contains('human-experience'));
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  const state = () => f.store.room('commons').state;
  const api = async input => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${f.keys.owner}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }) } : {}) });
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
  };
  const configure = async () => { const view = await api(); await api({ action: 'configure', name: 'Room', coordinatorMemberId: 'producer', expectedRevision: view.assistant.revision }); };
  const access = (id, active, permissions) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'member.access_changed', data: { memberId: id, expectedMemberRevision: state().members[id].revision, active, permissions } });
  const send = async body => {
    await page.locator('#message-input').fill(body);
    await page.locator('#message-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#message-input').value === '');
  };
  const capture = async name => { if (output) { mkdirSync(output, { recursive: true }); await page.screenshot({ path: `${output}/${name}-${width}-${theme}.png`, fullPage: true }); } };
  return { ...f, page, origin, state, api, configure, access, send, capture, errors };
}

for (const width of [1280, 390]) for (const theme of ['dark', 'light']) {
  test(`plain send stays plain across human membership changes; explicit Ask queues once (${width}, ${theme})`, { timeout: 45000 }, async t => {
    const f = await fixture(t, { width, theme });
    const humans = Object.values(f.state().members).filter(m => m.kind === 'human' && m.id !== 'owner');
    for (const m of humans) f.access(m.id, false, []);
    await f.configure();
    await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Waiting for connection');
    assert.equal(await f.page.locator('#room-assistant').isVisible(), false, 'idle agent chrome does not occupy the conversation');
    assert.equal(await f.page.locator('#composer-intent').isVisible(), false, 'ordinary chat needs no visible mode label');
    assert.equal(await f.page.locator('.site-footer').isVisible(), false, 'legal links stay out of the conversation');
    assert.match(await f.page.locator('#composer-intent-description').textContent(), /Post a message in this channel/);
    await f.capture('quiet-idle');
    await f.page.locator('#room-more > summary').click();
    assert.equal(await f.page.locator('#assistant-setup').isVisible(), true, 'setup remains reachable in More');
    assert.equal(await f.page.locator('#human-project-open').isVisible(), true);
    await f.page.keyboard.press('Escape');
    await f.send('Ordinary solo note, no execution requested.');
    assert.equal((await f.api()).runs.length, 0, 'room population never converts ordinary Send into execution');
    const peer = humans[0]; assert.ok(peer);
    f.access(peer.id, true, peer.permissions);
    await f.send('Ordinary note with a second human.');
    assert.equal((await f.api()).runs.length, 0);
    f.access(peer.id, false, []);
    await f.send('Ordinary note after the second human leaves.');
    assert.equal((await f.api()).runs.length, 0);
    await f.page.locator('#ask-room').click();
    await f.page.locator('#message-input').fill('Explicitly ask the configured agent.');
    const cue = f.page.locator('#composer-intent');
    await cue.waitFor({ state: 'visible' });
    assert.equal(await cue.textContent(), 'Shared · Room');
    assert.match(await f.page.locator('#composer-intent-description').textContent(), /handled by Test producer.*Visible in this channel/);
    assert.equal(await cue.getAttribute('aria-hidden'), 'true');
    assert.ok((await f.page.locator('#message-input').getAttribute('aria-describedby') ?? '').split(/\s+/).includes('composer-intent-description'), 'composer intent is programmatically described');
    assertAxeClean(await axeSerious(f.page, { include: ['#message-form', '#composer-intent'] }), `explicit composer ${width}/${theme}`);
    const bounds = await f.page.locator('#ask-room').boundingBox(); assert.ok(bounds.width >= 44 && bounds.height >= 44);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await f.capture('explicit-intent');
    await f.page.locator('#message-form button[type=submit]').click();
    await f.page.waitForFunction(() => document.querySelector('#message-input').value === '');
    await f.page.waitForFunction(() => document.querySelector('#assistant-runs').textContent.includes('Explicitly ask'));
    assert.equal((await f.api()).runs.length, 1);
    assert.equal(await f.page.locator('#room-assistant').isVisible(), true, 'pending work stays visible');
    assert.equal(await f.page.locator('#assistant-face [data-cancel]').isVisible(), true);
    await f.capture('pending-ask');
    assert.equal(f.state().messages.filter(m => m.body === 'Explicitly ask the configured agent.').length, 1);
    assert.deepEqual(f.errors, []);
  });
}

test('missing coordinator keeps owner draft and posts nothing; setup requires a fresh manual send', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await f.page.locator('#ask-room').click();
  const text = 'Keep this intent while I connect an agent.';
  await f.page.locator('#message-input').fill(text);
  await f.page.locator('#message-form button[type=submit]').click();
  await f.page.locator('#room-assistant-setup').waitFor({ state: 'visible' });
  assert.equal(await f.page.locator('#message-input').inputValue(), text);
  assert.equal(f.state().messages.filter(m => m.body === text).length, 0);
  assert.equal((await f.api()).runs.length, 0);
  assertAxeClean(await axeSerious(f.page, { include: ['#room-assistant-setup'] }), 'missing coordinator setup');
  await f.capture('setup-needed');
  await f.page.locator('#room-assistant-setup select').selectOption('producer');
  await f.page.locator('#room-assistant-setup button[type=submit]').click();
  await f.page.locator('#room-assistant-setup').waitFor({ state: 'hidden' });
  await f.page.waitForFunction(() => document.activeElement === document.querySelector('#message-input')); // dialog close dispatches its focus restoration asynchronously.
  assert.equal(await f.page.locator('#message-input').inputValue(), text);
  assert.equal(f.state().messages.filter(m => m.body === text).length, 0, 'configuration does not send the draft');
  await f.page.locator('#message-form button[type=submit]').click();
  await f.page.waitForFunction(() => document.querySelector('#message-input').value === '');
  await f.page.waitForFunction(() => document.querySelector('#assistant-runs').textContent.includes('Keep this intent'));
  assert.equal((await f.api()).runs.length, 1);
  assert.equal(f.state().messages.filter(m => m.body === text).length, 1);
  assert.deepEqual(f.errors, []);
});

test('nonowner sees actionable setup guidance without posting or losing the draft', { timeout: 30000 }, async t => {
  const f = await fixture(t, { member: 'guest' });
  await f.page.locator('#ask-room').click();
  await f.page.locator('#message-input').fill('Please help after the owner connects an agent.');
  await f.page.locator('#message-form button[type=submit]').click();
  await f.page.waitForFunction(() => /owner/i.test(document.querySelector('#composer-intent')?.textContent + document.querySelector('#assistant-error')?.textContent));
  assert.equal(await f.page.locator('#message-input').inputValue(), 'Please help after the owner connects an agent.');
  assert.equal(f.state().messages.filter(m => m.body === 'Please help after the owner connects an agent.').length, 0);
  assert.equal((await f.api()).runs.length, 0);
});

test('private message remains private even when Ask Room was selected', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.configure();
  await f.page.locator('#ask-room').click();
  await f.page.locator('#message-to-select').selectOption('producer', { force: true });
  assert.equal(await f.page.locator('#composer-intent').textContent(), 'Private · Test producer');
  assert.match(await f.page.locator('#composer-intent-description').textContent(), /Private message to Test producer/);
  const body = 'A private note, not a shared assistant invocation.';
  await f.send(body);
  const messages = f.state().messages.filter(m => m.body === body);
  assert.equal(messages.length, 1); assert.equal(messages[0].toMemberId, 'producer');
  assert.equal((await f.api()).runs.length, 0);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function holdAssistantReads(page) {
  const captured = deferred(), release = deferred();
  let count = 0;
  await page.route('**/api/rooms/commons/assistant', async route => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    const response = await route.fetch(); count++; captured.resolve(); await release.promise;
    try { await route.fulfill({ response }); } catch (error) {
      if (!/Route is already handled/.test(error.message)) throw error; // Session reset can cancel the old fetch.
    }
  });
  return { captured: captured.promise, release: release.resolve, count: () => count };
}

test('editing a draft during preflight does not post old or changed text automatically', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.configure();
  await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Waiting for connection');
  await f.page.locator('#ask-room').click();
  await f.page.locator('#message-input').fill('Original preflight draft.');
  const held = await holdAssistantReads(f.page); t.after(held.release);
  await f.page.locator('#message-form button[type=submit]').click();
  await held.captured;
  await f.page.locator('#message-input').fill('Edited while checking the recipient.');
  held.release();
  await f.page.waitForFunction(() => !document.querySelector('#message-form button[type=submit]').disabled);
  assert.equal(await f.page.locator('#message-input').inputValue(), 'Edited while checking the recipient.');
  assert.equal(f.state().messages.filter(m => ['Original preflight draft.', 'Edited while checking the recipient.'].includes(m.body)).length, 0);
  assert.equal((await f.api()).runs.length, 0);
  await f.page.unroute('**/api/rooms/commons/assistant');
  await f.page.locator('#message-form button[type=submit]').click();
  await f.page.waitForFunction(() => document.querySelector('#message-input').value === '');
  await f.page.waitForFunction(() => document.querySelector('#assistant-runs').textContent.includes('Edited while'));
  assert.equal((await f.api()).runs.length, 1);
});

for (const recovery of ['toggle', 'reload', 'thread-reload']) test(`lost message response preserves original invocation intent across ${recovery} and retry`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.configure();
  await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Waiting for connection');
  if (recovery === 'thread-reload') {
    f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'retry-thread', body: 'Thread retry source.' } });
    f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'retry-thread-reply', body: 'Initial reply.', replyToId: 'retry-thread' } });
    await f.page.locator('.thread-link[data-message-id="retry-thread"]').click();
    await f.page.locator('#also-send-to-channel').check();
  }
  const body = 'Retry the same committed prompt without changing its intent.';
  const commands = [];
  let lose = true;
  await f.page.route('**/api/rooms/commons/commands', async route => {
    const command = route.request().postDataJSON();
    if (command?.data?.body !== body) { await route.fallback(); return; }
    commands.push(command);
    if (lose) { lose = false; await route.fetch(); await route.abort('connectionfailed'); }
    else await route.continue();
  });
  await f.page.locator('#ask-room').click();
  await f.page.locator('#message-input').fill(body);
  await f.page.locator('#message-form button[type=submit]').click();
  await f.page.waitForFunction(() => !document.querySelector('#message-form button[type=submit]').disabled);
  assert.equal(f.state().messages.filter(m => m.body === body && !m.id.endsWith(':channel')).length, 1);
  assert.equal((await f.api()).runs.length, 0);
  if (recovery === 'toggle') await f.page.locator('#ask-room').click();
  else { await f.page.reload(); await f.page.locator('#main').waitFor({ state: 'visible' }); }
  assert.equal(await f.page.locator('#ask-room').getAttribute('aria-pressed'), 'false');
  assert.equal(await f.page.locator('#message-input').inputValue(), body);
  await f.page.locator('#message-form button[type=submit]').click();
  await f.page.waitForFunction(() => document.querySelector('#message-input').value === '');
  await f.page.waitForFunction(() => document.querySelector('#assistant-runs').textContent.includes('Retry the same'));
  assert.equal((await f.api()).runs.length, 1);
  assert.equal(f.state().messages.filter(m => m.body === body && !m.id.endsWith(':channel')).length, 1);
  assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
  if (recovery === 'thread-reload') {
    assert.equal(commands[0].data.alsoSendToChannel, true);
    assert.equal(f.state().messages.filter(m => m.body === body).length, 2, 'one thread reply and its one channel copy');
  }
});


test('late preflight cannot post into a replacement room or erase its draft', { timeout: 45000 }, async t => {
  const memberId = 'preflight-human', otherId = 'preflight-other';
  const f = await fixture(t, { member: 'race', prepare(f) {
    f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'member.added', data: {
      memberId, displayName: 'Preflight reader', kind: 'human', permissions: f.store.room('commons').state.members.owner.permissions
    } });
    f.store.createAccount('preflight-account'); f.store.completeOnboarding('preflight-account');
    f.store.bindHumanAccount('commons', memberId, 'preflight-account');
    const other = initialRoom(otherId, memberId); other[0].data.title = 'Other preflight room';
    f.store.initialize(other); f.store.bindHumanAccount(otherId, memberId, 'preflight-account');
    f.keys.race = f.store.issueAccessKey('commons', memberId);
    f.keys.other = f.store.issueAccessKey(otherId, memberId);
  } });
  await f.configure();
  await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Waiting for connection');
  await f.page.locator('#ask-room').click(); await f.page.locator('#message-input').fill('Old room preflight request.');
  const held = await holdAssistantReads(f.page); t.after(held.release);
  await f.page.locator('#message-form button[type=submit]').click(); await held.captured;
  // Another tab replaces the real browser credential while this request is in flight.
  // The current page remains alive, so its delayed callback must still be fenced.
  const restored = await f.page.context().request.post(`${f.origin}/api/session`, { headers: { Origin: f.origin }, data: { accessKey: f.keys.other }, maxRedirects: 0 });
  assert.equal(restored.status(), 201);
  await f.page.evaluate(() => history.replaceState(null, '', '/'));
  await f.page.locator('#refresh-button').evaluate(button => button.click());
  await f.page.locator('#auth-panel').waitFor({ state: 'visible' });
  await f.page.locator('#refresh-button').evaluate(button => button.click());
  await f.page.locator('#main').waitFor({ state: 'visible' });
  await f.page.waitForFunction(() => document.querySelector('#room-title').textContent === 'Other preflight room');
  await f.page.locator('#message-input').fill('A replacement-room draft.');
  held.release();
  await f.page.unroute('**/api/rooms/commons/assistant');
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator('#message-input').inputValue(), 'A replacement-room draft.');
  for (const roomId of ['commons', otherId]) assert.equal(f.store.room(roomId).state.messages.filter(m => m.body === 'Old room preflight request.').length, 0);
  assert.equal((await f.api()).runs.length, 0);
  assert.deepEqual(f.errors, []);
});

test('delayed message receipt preserves the destination channel draft and invokes the original ask', { timeout: 30000 }, async t => {
  const f = await fixture(t, { prepare(f) { f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'channel.created', data: { name: 'design' } }); } });
  const channelId = Object.values(f.state().channels).find(channel => channel.name === 'design').id;
  await f.configure();
  await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Waiting for connection');
  const original = 'Original general-channel request.', destination = 'Unsent design-channel thought.';
  await f.page.locator(`#channel-list [data-channel="${channelId}"]`).click();
  await f.page.locator('#message-input').fill(destination);
  await f.page.locator('#channel-list [data-channel="general"]').click();
  const captured = deferred(), release = deferred(); t.after(release.resolve);
  await f.page.route('**/api/rooms/commons/commands', async route => {
    if (route.request().postDataJSON()?.data?.body !== original) { await route.fallback(); return; }
    const response = await route.fetch(); captured.resolve(); await release.promise; await route.fulfill({ response });
  });
  await f.page.locator('#ask-room').click(); await f.page.locator('#message-input').fill(original);
  await f.page.locator('#message-form button[type=submit]').click();
  const received = await Promise.race([captured.promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
  assert.ok(received, JSON.stringify(await f.page.evaluate(() => ({ input: document.querySelector('#message-input').value, cue: document.querySelector('#composer-intent').textContent, error: document.querySelector('#assistant-error').textContent, body: document.body.innerText.slice(-1800) }))));
  await f.page.locator(`#channel-list [data-channel="${channelId}"]`).click();
  assert.equal(await f.page.locator('#message-input').inputValue(), original, 'navigation waits for the pending send');
  release.resolve();
  await f.page.waitForFunction(() => !document.querySelector('#message-form button[type=submit]').disabled);
  await f.page.locator(`#channel-list [data-channel="${channelId}"]`).click();
  assert.equal(await f.page.locator('#message-input').inputValue(), destination);
  const view = await f.api(); assert.equal(view.runs.length, 1);
  const source = f.state().messages.find(m => m.id === view.runs[0].sourceMessageId);
  assert.equal(source.body, original); assert.equal(source.channelId ?? 'general', 'general');
  assert.equal(f.state().messages.filter(m => m.body === destination).length, 0);
  assert.deepEqual(f.errors, []);
});

test('adding context to an existing ask stays available after coordinator disconnection', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.configure();
  await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Waiting for connection');
  await f.page.locator('#ask-room').click(); await f.send('An existing shared request.');
  await f.page.waitForFunction(() => document.querySelector('#assistant-face').textContent.includes('An existing shared request.'));
  const view = await f.api(), run = view.runs[0];
  await f.api({ action: 'configure', name: 'Room', coordinatorMemberId: null, expectedRevision: view.assistant.revision });
  await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Not connected');
  await f.page.locator(`#assistant-face [data-contribute-run="${run.id}"]`).first().click();
  await f.send('Preserve this extra context until a host returns.');
  const current = (await f.api()).runs.find(item => item.id === run.id);
  assert.equal(current.inputs.length, 2);
  assert.equal((await f.api()).runs.length, 1);
  assert.equal(await f.page.locator('#room-assistant-setup').isVisible(), false);
});

for (const phase of ['preflight', 'message receipt']) test(`Pause and Stop cannot replace an Ask during pending ${phase}`, { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.configure();
  await f.page.waitForFunction(() => document.querySelector('#room-assistant-status').textContent === 'Waiting for connection');
  await f.page.locator('#ask-room').click(); await f.send('Existing request for competing controls.');
  const run = (await f.api()).runs[0];
  await f.page.locator(`#assistant-face [data-pause-run="${run.id}"]`).first().waitFor();
  const pending = 'A separately requested second Ask.';
  let held;
  if (phase === 'preflight') held = await holdAssistantReads(f.page);
  else {
    const captured = deferred(), release = deferred();
    await f.page.route('**/api/rooms/commons/commands', async route => {
      if (route.request().postDataJSON()?.data?.body !== pending) { await route.fallback(); return; }
      const response = await route.fetch(); captured.resolve(); await release.promise; await route.fulfill({ response });
    });
    held = { captured: captured.promise, release: release.resolve };
  }
  t.after(held.release);
  await f.page.locator('#ask-room').click(); await f.page.locator('#message-input').fill(pending);
  await f.page.locator('#message-form button[type=submit]').click(); await held.captured;
  for (const selector of [`#assistant-runs [data-pause-run="${run.id}"]:not([data-cancel])`, `#assistant-face [data-pause-run="${run.id}"][data-cancel]`]) {
    await f.page.locator(selector).first().evaluate(button => button.click());
    assert.equal((await f.api()).runs.find(item => item.id === run.id).status, 'queued');
  }
  held.release();
  await f.page.waitForFunction(() => document.querySelector('#message-input').value === '');
  assert.equal((await f.api()).runs.length, 2);
  assert.equal((await f.api()).runs.find(item => item.id === run.id).status, 'queued');
  assert.deepEqual(f.errors, []);
});

for (const width of [1280, 390]) test(`quiet controls restore in Advanced and legal links restore after signout (${width})`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { width });
  await f.page.locator('#room-more > summary').click();
  await f.page.locator('#assistant-setup').click();
  await f.page.locator('#room-assistant-setup').waitFor({ state: 'visible' });
  await f.page.locator('#room-assistant-setup [data-close-setup]').click();
  await f.page.locator('#room-more > summary').click();
  await f.page.locator('#topbar-settings').click();
  assert.equal(await f.page.locator('#settings-dialog .site-footer').isVisible(), true);
  await f.page.locator('#advanced-room-tools > summary').click();
  await f.page.locator('#human-advanced').check();
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('#room-assistant .assistant-heading').isVisible(), true);
  await f.page.locator('#room-more > summary').click(); await f.page.locator('#topbar-settings').click();
  await f.page.locator('#human-advanced').uncheck(); await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('#room-assistant').isVisible(), false);
  await clickChrome(f.page, '#signout-button');
  await f.page.locator('#auth-panel').waitFor({ state: 'visible' });
  await f.page.waitForFunction(() => !document.querySelector('.site-footer')?.closest('#settings-dialog'));
  assert.equal(await f.page.locator('.site-footer').isVisible(), false, 'the existing minimal sign-in surface hides its footer');
  assert.equal(await f.page.locator('#settings-dialog .site-footer').count(), 0);
  assert.deepEqual(f.errors, []);
});

test('quiet idle layout still exposes an initial assistant connection failure', { timeout: 30000 }, async t => {
  const f = await fixture(t, { setupPage: page => page.route('**/api/rooms/commons/assistant', route => route.fulfill({ status: 503, json: { error: { code: 'assistant_unavailable', message: 'Assistant connection is temporarily unavailable.' } } })) });
  await f.page.locator('#assistant-error').getByText('Assistant connection is temporarily unavailable.', { exact: true }).waitFor();
  assert.equal(await f.page.locator('#room-assistant').isVisible(), true);
  assert.equal(await f.page.locator('#assistant-face').isVisible(), false);
  await f.page.locator('#message-input').fill('Ordinary conversation remains available.');
  await f.page.locator('#message-form button[type=submit]').click();
  await f.page.waitForFunction(() => document.querySelector('#message-input').value === '');
  assert.equal(f.state().messages.filter(message => message.body === 'Ordinary conversation remains available.').length, 1);
});
