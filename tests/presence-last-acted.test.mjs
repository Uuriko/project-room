import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedPostOAuth, client} from './helpers/work-linked-post-oauth.mjs';

// An agent deciding whether to wait on someone needs to know when they last
// acted. Presence and the MCP activation pack carry lastActedAt from the
// actor index, so a member gone for hours is visible without a log scan.
test('presence and the MCP activation pack report when each member last acted', async t => {
  const store = new RoomStore(':memory:');
  const saved = seedPostOAuth(store, {scopes: ['chat:read', 'work:read', 'rooms:read']});
  store.room = () => { throw Error('Whole-room hydration forbidden'); };
  const server = createRoomServer({store, origin: 'https://room.example', mcpOAuthClients: [client]});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  store.command(saved.owner, 'commons', {id: 'owner-post', type: 'message.posted', data: {messageId: 'owner-post', body: 'Owner was here'}});
  const ownerEvent = store.db.prepare("SELECT json_extract(body,'$.at') AS at FROM events WHERE room_id='commons' AND json_extract(body,'$.actorId')='owner' ORDER BY sequence DESC LIMIT 1").get().at;
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='events_room_actor'").get(), 'actor index is created with the other event indexes');
  const presence = store.presence(saved.owner, 'commons', []).members;
  assert.equal(presence.find(m => m.memberId === 'owner').lastActedAt, ownerEvent);
  assert.equal(presence.find(m => m.memberId === 'observer').lastActedAt, null, 'a member who never acted has no time');
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(body,'$.at') FROM events INDEXED BY events_room_actor WHERE room_id=? AND json_extract(body,'$.actorId')=? ORDER BY sequence DESC LIMIT 1").all('commons', 'owner').map(r => r.detail).join(' ');
  assert.match(plan, /events_room_actor/); assert.doesNotMatch(plan, /TEMP B-TREE/);
  const response = await new Promise((resolve, reject) => {
    const req = request('http://127.0.0.1:' + server.address().port + '/mcp', {method: 'POST', headers: {Host: 'room.example', Authorization: 'Bearer ' + saved.token, 'Content-Type': 'application/json'}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
    });
    req.on('error', reject);
    req.end(JSON.stringify({jsonrpc: '2.0', id: 'pack', method: 'tools/call', params: {name: 'room_activation_pack', arguments: {roomId: 'commons'}}}));
  });
  const pack = response.result?.structuredContent;
  assert.ok(pack?.members, JSON.stringify(response).slice(0, 400));
  const owner = pack.members.find(m => m.id === 'owner');
  assert.equal(owner.lastActedAt, ownerEvent);
  assert.ok(pack.members.every(m => 'lastActedAt' in m && 'hostStatus' in m));
});

test('without the actor index presence answers null instead of scanning', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const saved = seedPostOAuth(store, {scopes: ['chat:read']});
  store.db.exec('DROP INDEX IF EXISTS events_room_actor'); store._actorIndexReady = undefined;
  assert.equal(store.lastActedAt('commons', 'owner'), null);
  void saved;
});
