import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { localRequestContext } from '../client/local-request-context.mjs';
import { runLocalSession } from '../client/local-session-runner.mjs';

async function setup(t, viewport, automation = false) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let q;
  if (automation) {
    for (const [type, revision, key] of [['created', 0, f.keys.owner], ['enabled', 1, f.keys.owner], ['accepted', 2, f.keys.producer]]) f.store.command(key, 'commons', {
      id: `automation-${type}`, type: `automation.${type}`, data: { automationId: 'daily', expectedRevision: revision,
        ...(type === 'created' ? { definition: { title: 'Check', prompt: 'Answer this without creating a task', recipientId: 'producer', trigger: { kind: 'manual' }, maxRuns: 3, maxRuntimeMs: 15000, maxOutputBytes: 65536 } } : {}) }
    });
    q = f.store.command(f.keys.owner, 'commons', { id: 'question', type: 'message.posted', data: { messageId: 'question', automationId: 'daily', automationRevision: 3, automationSlot: 0 } });
  } else q = f.store.command(f.keys.owner, 'commons', { id: 'question', type: 'message.posted', data: { messageId: 'question', requestKind: 'reply', toMemberId: 'producer', body: 'Answer this without creating a task' } });
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
  await page.goto(origin); await page.locator('#access-key').fill(f.keys.owner);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click(); await page.locator('#main').waitFor();
  const claim = { id: 'claim', type: 'request_run.claimed', data: { requestMessageId: 'question', expectedRevision: 0, runId: 'run', contextEventId: q.event.id, instructionsRevision: 0, maxRuntimeMs: 10000, maxOutputBytes: 4096 } };
  return { ...f, page, origin, errors, claim, row: page.locator('[data-key="question"]') };
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) test(`request run ${name}: inline stop retries the original command`, async t => {
  const f = await setup(t, viewport), sent = [];
  f.store.command(f.keys.producer, 'commons', f.claim);
  await f.row.getByText('Run in progress', { exact: true }).waitFor();
  await f.page.route('**/api/rooms/commons/commands', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'request_run.stop_requested') return route.continue();
    sent.push(command); const response = await route.fetch();
    if (sent.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  const stopButton = f.row.getByRole('button', { name: 'Stop run', exact: true });
  assert.equal((await stopButton.innerText()).trim(), '⏹️');
  assert.match(await stopButton.getAttribute('aria-description'), /may still be running/);
  const target = await stopButton.boundingBox(); assert.ok(target.width >= 44 && target.height >= 44);
  await stopButton.click();
  await f.row.getByRole('button', { name: 'Retry stop', exact: true }).click();
  await f.row.getByText('Stop requested', { exact: true }).waitFor();
  await f.page.waitForFunction(() => !document.querySelector('[data-key="question"] [data-message-action="stop-request-run"]'));
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
  assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.messageAction), 'reply', 'focus returns to the conversation when Stop disappears');
  assert.equal(f.store.room('commons').state.replyRequests.question.status, 'open');
  mkdirSync('test-results', { recursive: true }); await f.row.screenshot({ path: `test-results/request-run-${name}.png` });
  f.store.command(f.keys.producer, 'commons', { id: 'finish', type: 'request_run.finished', data: { requestMessageId: 'question', expectedRevision: 2, runId: 'run', status: 'cancelled' } });
  await f.row.getByText('Run cancelled', { exact: true }).waitFor();
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(f.errors, []);
});

for (const automation of [false, true]) test(`chat Stop run terminates a real work-free ${automation ? 'automation' : 'direct'} process`, async t => {
  const f = await setup(t, { width: 1100, height: 850 }, automation), controller = new AbortController();
  t.after(() => controller.abort());
  const client = new RoomAgentClient({ origin: f.origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  const packet = await localRequestContext(client, 'question', null);
  const result = runLocalSession({ client, roomId: 'commons', memberId: 'producer', workItemId: null, runId: 'browser-run', expectedRevision: 0,
    command: process.execPath, args: ['-e', 'setInterval(()=>{},100)'], cwd: f.directory, maxRuntimeMs: 15000, pollMs: 50,
    input: packet.input, requestGuard: packet.requestGuard, signal: controller.signal });
  await f.row.getByRole('button', { name: 'Stop run', exact: true }).click();
  const ended = await result;
  assert.equal(ended.status, 'failed'); assert.equal(ended.recording, 'recorded');
  await f.row.getByText('Run failed', { exact: true }).waitFor();
  assert.equal(f.store.room('commons').state.replyRequests.question.status, 'open');
});

test('deadline refresh is local and access reset clears uncertain stop state', async t => {
  const f = await setup(t, { width: 1000, height: 800 });
  f.store.command(f.keys.producer, 'commons', { ...f.claim, data: { ...f.claim.data, maxRuntimeMs: 1500 } });
  await f.row.getByText('Run in progress', { exact: true }).waitFor();
  const sequence = f.store.room('commons').sequence;
  await f.row.getByText('Run unconfirmed', { exact: true }).waitFor();
  assert.equal(f.store.room('commons').sequence, sequence, 'expiry does not fabricate a stopped event');
  await f.page.route('**/api/rooms/commons/commands', async route => {
    if (route.request().postDataJSON().type !== 'request_run.stop_requested') return route.continue();
    await route.fetch(); await route.abort('failed');
  });
  await f.row.getByRole('button', { name: 'Stop run', exact: true }).click();
  await f.row.getByRole('button', { name: 'Retry stop', exact: true }).waitFor();
  assert.equal(await f.page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; }), true);
  const rotated = f.store.issueAccessKey('commons', 'owner');
  await f.page.locator('#auth-panel').waitFor({ state: 'visible' });
  await f.page.unroute('**/api/rooms/commons/commands');
  await f.page.locator('#access-key').fill(rotated); await f.page.getByRole('button', { name: 'Enter room', exact: true }).click();
  await f.row.getByText('Stop requested', { exact: true }).waitFor();
  assert.equal(await f.row.getByRole('button', { name: 'Retry stop', exact: true }).count(), 0);
  assert.deepEqual(f.errors, []);
});
