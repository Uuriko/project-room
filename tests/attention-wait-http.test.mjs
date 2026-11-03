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
