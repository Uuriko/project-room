import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedPostOAuth, client} from './helpers/work-linked-post-oauth.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:');
  const saved = seedPostOAuth(store, {scopes: ['chat:read', 'work:read']});
  store.room = () => { throw Error('Whole-room hydration forbidden'); };
  const server = createRoomServer({store, origin: 'https://room.example', mcpOAuthClients: [client]});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const after = store.headSequence('commons');
  const call = (args, token = saved.token) => {
    let req;
    const result = new Promise((resolve, reject) => {
      req = request('http://127.0.0.1:' + server.address().port + '/mcp', {method: 'POST', headers: {Host: 'room.example', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}}, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({status: response.statusCode, value: JSON.parse(Buffer.concat(chunks))}));
      });
      req.on('error', reject);
      req.end(JSON.stringify({jsonrpc: '2.0', id: 'wait', method: 'tools/call', params: {name: 'room_wait_for_attention', arguments: {roomId: 'commons', after, ...args}}}));
    });
    return {result, cancel: () => req.destroy(new Error('Client cancelled'))};
  };
  const post = (id, data) => store.command(saved.owner, 'commons', {id, type: 'message.posted', data: {messageId: id, body: 'Useful attention', ...data}});
  return {store, saved, after, call, post};
}
function accepted(response) {
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.notEqual(response.value.result?.isError, true, JSON.stringify(response));
  assert.ok(response.value.result?.structuredContent, JSON.stringify(response));
  return response.value.result.structuredContent;
}

test('real hosted OAuth POST survives normal body close and returns new private formal attention', async t => {
  const f = await fixture(t), waiting = f.call({timeoutSec: 2});
  await delay(60);
  f.post('foreign-private', {toMemberId: 'observer', body: 'HIDDEN-OTHER-PAIR'});
  f.post('formal', {toMemberId: f.saved.identityId, requestKind: 'reply'});
  const result = accepted(await waiting.result);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.items.map(item => item.messageId), ['formal']);
  assert.equal(result.items[0].kind, 'reply_request');
  assert.equal(result.items[0].nextRead.arguments.roomId, 'commons');
  assert.equal(JSON.stringify(result).includes('HIDDEN-OTHER-PAIR'), false);
  assert.equal(result.acknowledges, false);
});

test('HTTP cancellation releases the slot, and a connected timeout returns normally', async t => {
  const f = await fixture(t), waiting = f.call({timeoutSec: 120});
  const cancelled = assert.rejects(waiting.result, /Client cancelled/);
  await delay(60);
  waiting.cancel();
  await cancelled;
  assert.equal(accepted(await f.call({timeoutSec: 0}).result).status, 'timeout');
  assert.equal(accepted(await f.call({timeoutSec: 1}).result).status, 'timeout');
});

test('revoked identity during a pending OAuth wait cannot receive the appended content', async t => {
  const f = await fixture(t), waiting = f.call({timeoutSec: 1});
  await delay(60);
  f.store.identities.revoke(f.saved.identityId, f.saved.identitySecret);
  f.post('after-revocation', {toMemberId: f.saved.identityId});
  const response = await waiting.result;
  assert.ok(response.status === 401 || response.value.error || response.value.result?.isError, JSON.stringify(response));
  assert.equal(JSON.stringify(response).includes('after-revocation'), false);
});

test('wait argument validation and OAuth consent stay fail closed', async t => {
  const f = await fixture(t);
  for (const timeoutSec of [121, '1', false]) {
    const response = await f.call({timeoutSec}).result;
    assert.ok(response.value.error || response.value.result?.isError, JSON.stringify(response));
  }
  const response = await f.call({roomId: 'foreign', timeoutSec: 0}).result;
  assert.ok(response.value.error || response.value.result?.isError, JSON.stringify(response));
});

test('real OAuth host timeout retry replaces the prior wait without reusing its auth context', async t => {
  const f=await fixture(t),old=f.call({timeoutSec:120});
  await delay(60);
  const replacement=f.call({timeoutSec:2});
  const previous=await old.result;
  assert.match(JSON.stringify(previous.value),/attention_wait_superseded/);
  f.post('replacement-only',{toMemberId:f.saved.identityId});
  const result=accepted(await replacement.result);
  assert.equal(result.status,'ready');
  assert.deepEqual(result.items.map(item=>item.messageId),['replacement-only']);
  assert.equal(result.acknowledges,false);
});

test('includeWork wakes on a task proposed to the caller; the default wait stays message-only', async t => {
  const f = await fixture(t);
  const propose = (id, accountableMemberId) => f.store.command(f.saved.owner, 'commons', {id, type: 'work.proposed',
    data: {workItemId: id, title: 'Assigned ' + id, definitionOfDone: 'Saved result', accountableMemberId}});
  const legacy = f.call({timeoutSec: 1}), waiting = f.call({timeoutSec: 2, includeWork: true}, f.saved.token);
  assert.match(JSON.stringify((await legacy.result).value), /attention_wait_superseded/);
  await delay(60);
  propose('someone-else-task', 'observer');
  propose('my-new-task', f.saved.identityId);
  const result = accepted(await waiting.result);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.items.map(item => [item.kind, item.workItemId]), [['work', 'my-new-task']]);
  assert.deepEqual(result.items[0].nextRead, {tool: 'room_read_work', arguments: {roomId: 'commons', workItemId: 'my-new-task'}});
  assert.ok(result.items[0].sequence <= result.after);
  // Without the flag the same history yields no work pointer.
  const plain = accepted(await f.call({timeoutSec: 0}).result);
  assert.equal(plain.items.some(item => item.kind === 'work'), false);
  // The caller's own work events never wake the caller.
  const self = accepted(await f.call({timeoutSec: 0, includeWork: true, after: result.after}).result);
  assert.deepEqual(self.items, []);
});

test('includeWork keeps the cursor honest across a gap longer than one event window', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 28; i++) f.post('filler-' + i, {body: 'noise ' + i});
  f.store.command(f.saved.owner, 'commons', {id: 'late-task', type: 'work.proposed',
    data: {workItemId: 'late-task', title: 'Late task', definitionOfDone: 'Saved result', accountableMemberId: f.saved.identityId}});
  let after = f.after, found = [];
  for (let calls = 0; calls < 12 && !found.length; calls++) {
    const response = await f.call({timeoutSec: 0, includeWork: true, after}).result;
    const result = accepted(response);
    assert.ok(result.after >= after);
    after = result.after;
    found = result.items.filter(item => item.kind === 'work').map(item => item.workItemId);
  }
  assert.deepEqual(found, ['late-task']);
  const bad = await f.call({timeoutSec: 0, includeWork: 'yes'}).result;
  assert.ok(bad.value.error || bad.value.result?.isError, JSON.stringify(bad));
});

test('presence shows whether a member courier is waiting and when it last waited', async t => {
  const f = await fixture(t);
  const courier = () => f.store.presence(f.saved.owner, 'commons', []).members.find(m => m.memberId === f.saved.identityId).courier;
  assert.deepEqual(courier(), {waiting: false, lastWaitAt: null});
  const waiting = f.call({timeoutSec: 2});
  await delay(60);
  const open = courier();
  assert.equal(open.waiting, true);
  assert.ok(Date.parse(open.lastWaitAt) <= Date.now());
  f.post('wake-it', {toMemberId: f.saved.identityId});
  await waiting.result;
  const closed = courier();
  assert.equal(closed.waiting, false);
  assert.equal(closed.lastWaitAt, open.lastWaitAt, 'the last wait time survives the wait ending');
  assert.equal('courier' in f.store.presence(f.saved.owner, 'commons', []).members.find(m => m.memberId === 'owner'), false, 'humans carry no courier field');
test('includeWork survives many small mixed-agent proposals within the read budget', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 24; i++) f.store.command(f.saved.owner, 'commons', {id: 'mixed-' + i, type: 'work.proposed',
    data: {workItemId: 'mixed-' + i, title: 'T' + i, definitionOfDone: 'D', accountableMemberId: i % 3 === 0 ? f.saved.identityId : 'observer'}});
  let after = f.after; const found = [];
  for (let calls = 0; calls < 12; calls++) {
    const result = accepted(await f.call({timeoutSec: 0, includeWork: true, after}).result);
    assert.ok(result.items.length <= 4);
    found.push(...result.items.filter(item => item.kind === 'work').map(item => item.workItemId));
    if (result.after === after && result.status !== 'ready') break;
    after = result.after;
    if (result.status === 'timeout') break;
  }
  assert.deepEqual([...new Set(found)].sort(), Array.from({length: 8}, (_, k) => 'mixed-' + k * 3).sort());
});

test('work pointers are hints: a work item whose pointer yields is still found in needs-me', async t => {
  const f = await fixture(t);
  f.store.command(f.saved.owner, 'commons', {id: 'hint-task', type: 'work.proposed',
    data: {workItemId: 'hinted', title: 'Hint task', definitionOfDone: 'D', accountableMemberId: f.saved.identityId}});
  f.post('work:hinted', {toMemberId: f.saved.identityId, body: 'A message whose id equals the work key'});
  const result = accepted(await f.call({timeoutSec: 0, includeWork: true}).result);
  assert.ok(result.items.some(item => item.messageId === 'work:hinted'), 'the message pointer is delivered');
  assert.ok(result.items.some(item => item.kind === 'work' && item.workItemId === 'hinted'), 'the server still names the work');
  // Whatever the courier forwards, the woken agent's needs-me read lists the task.
  const {readCurrentWorkListing} = await import('../server/current-work-list.mjs');
  const listing = readCurrentWorkListing(f.store, f.store.issueAccessKey('commons', f.saved.identityId), 'commons', {focus: 'needs_me'});
  assert.ok(listing.work.some(row => row.id === 'hinted'));
});

test('a budget-sized run of other agents work resumes at the first unread candidate and finds mine', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) f.store.command(f.saved.owner, 'commons', {id: 'other-' + i, type: 'work.proposed',
    data: {workItemId: 'other-' + i, title: 'Other ' + 'x'.repeat(4000), definitionOfDone: 'D'.repeat(4000), accountableMemberId: 'observer'}});
  f.store.command(f.saved.owner, 'commons', {id: 'mine-last', type: 'work.proposed',
    data: {workItemId: 'mine-last', title: 'Mine', definitionOfDone: 'D', accountableMemberId: f.saved.identityId}});
  let after = f.after, found = false, calls = 0;
  for (; calls < 40 && !found; calls++) {
    const result = accepted(await f.call({timeoutSec: 0, includeWork: true, after}).result);
    assert.ok(result.after > after || result.items.length, 'every wait makes progress');
    found = result.items.some(item => item.workItemId === 'mine-last');
    after = result.after;
  }
  assert.equal(found, true);
});
