// Anonymous starter task: first hosted /mcp call (initialize, no credential)
// returns one public task, creates no claim, and has a defined empty case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { starterTaskMeta, STARTER_EMPTY_ACTION } from '../server/mcp-starter-task.mjs';

async function fixture(t, { withTask = true } = {}) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  if (withTask) {
    store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'starter:task', reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'Starter volunteer task', summary: 'Synthetic public work', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', 'starter:task', 'publish', { requestId: 'publish', expectedRevision: 1 });
    store.publicWorkClaims.enable('commons', 'owner', 'starter:task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.js'] });
  }
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const init = async (headers = {}) => {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'starter-test', version: '1' } } }) });
    return { status: response.status, body: await response.json() };
  };
  return { store, init };
}
const claims = store => JSON.stringify(['work_claims', 'public_work_requests', 'identity_links', 'bounty_journal'].map(name => store.db.prepare('SELECT * FROM ' + name).all()));

test('anonymous first call returns one starter task with only public fields', async t => {
  const f = await fixture(t);
  const reply = await f.init();
  assert.equal(reply.status, 200);
  const starter = reply.body.result._meta.starterTask;
  assert.equal(starter.state, 'available');
  assert.equal(starter.claimed, false);
  assert.equal(starter.untrusted, true);
  assert.deepEqual(Object.keys(starter.task).sort(), Object.keys(starter.task).filter(key => ['taskId', 'title', 'summary', 'acceptanceCriteria', 'repositoryUrl', 'repositoryRef', 'files', 'termsVersion'].includes(key)).sort());
  assert.equal(starter.task.taskId, 'starter:task');
  assert.equal(starter.task.title, 'Starter volunteer task');
  const text = JSON.stringify(starter);
  for (const leak of ['commons', 'namespaceId', 'owner', 'reviewer', 'claim"', 'roomId']) assert.equal(text.includes(leak), false, leak);
  assert.deepEqual(starter.suggestedFirstAction.tool, 'public_work_read_task');
  assert.deepEqual(starter.suggestedFirstAction.arguments, { taskId: 'starter:task' });
  // Protocol fields are unchanged.
  assert.equal(reply.body.result.protocolVersion, '2025-06-18');
  assert.ok(reply.body.result.instructions);
});

test('starter task never claims: no claim, request journal, link or credit rows are written', async t => {
  const f = await fixture(t);
  const before = claims(f.store);
  await f.init(); await f.init();
  assert.equal(claims(f.store), before);
  const task = f.store.publicWorkClaims.read('starter:task');
  assert.equal(task.claim.state, 'unclaimed');
});

test('empty board: starter task is none with a defined suggested first action', async t => {
  const f = await fixture(t, { withTask: false });
  const reply = await f.init();
  assert.equal(reply.status, 200);
  const starter = reply.body.result._meta.starterTask;
  assert.equal(starter.state, 'none');
  assert.equal(starter.task, null);
  assert.deepEqual(starter.suggestedFirstAction, { ...STARTER_EMPTY_ACTION });
});

test('authenticated initialize does not get an anonymous starter task', async t => {
  const f = await fixture(t);
  const identity = f.store.identities.create('Starter authed');
  const reply = await f.init({ Authorization: 'Bearer ' + identity.secret });
  assert.equal(reply.body.result?._meta?.starterTask, undefined);
});

test('starterTaskMeta degrades to the empty case on error replies and strips unknown fields', () => {
  assert.equal(starterTaskMeta(null).state, 'none');
  assert.equal(starterTaskMeta({ result: { isError: true, structuredContent: {} } }).state, 'none');
  const meta = starterTaskMeta({ result: { structuredContent: { recommendations: [{ task: { taskId: 't1', title: 'x', namespaceId: 'secret-room', claim: { holder: 'a' } } }] } } });
  assert.deepEqual(meta.task, { taskId: 't1', title: 'x' });
});
