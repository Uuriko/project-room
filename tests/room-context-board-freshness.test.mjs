import {legacyAgentRoom} from './helpers/legacy-agent-room.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createHostedRoomMcp } from '../server/mcp-room-profile.mjs';
import { readComposedRoomContext } from '../server/orient.mjs';

test('conditional room context refreshes when a newly posted board claim changes orientation', async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, Origin: origin, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify({ status: response.status, result }));
    return result;
  };
  const before = await request('/api/rooms/commons/context');
  const id = 'context-cache-new-claim';
  assert.equal(before.orient.availableClaims.some(item => item.id === id), false);
  await request('/api/rooms/commons/work-claims', { id, title: 'A newly available useful task' });
  const full = await request('/api/rooms/commons/context');
  assert.equal(full.orient.availableClaims.some(item => item.id === id), true, 'fresh full read sees the new claim');
  const conditional = await request(`/api/rooms/commons/context?since_version=${before.context_version}`);
  t.diagnostic(JSON.stringify({ beforeVersion: before.context_version, fullVersion: full.context_version,
    beforeAvailable: before.orient.availableClaims.map(item => item.id), fullAvailable: full.orient.availableClaims.map(item => item.id),
    conditionalNotModified: conditional.not_modified, conditionalHasOrient: Object.hasOwn(conditional, 'orient') }));
  assert.notEqual(conditional.not_modified, true, 'changed orientation must not be hidden behind not_modified');
  assert.notEqual(conditional.context_version, before.context_version);
  assert.equal(conditional.orient.availableClaims.some(item => item.id === id), true);
  await request(`/api/rooms/commons/work-claims/${id}/claim`, {});
  const claimed = await request(`/api/rooms/commons/context?since_version=${conditional.context_version}`);
  assert.notEqual(claimed.not_modified, true);
  assert.equal(claimed.orient.availableClaims.some(item => item.id === id), false);
  assert.equal(claimed.orient.claims.some(item => item.id === id && item.state === 'claimed'), true);
  assert.equal((await request(`/api/rooms/commons/context?since_version=${claimed.context_version}`)).not_modified, true);
});

test('composed context ignores clocks, cursor movement and unrelated private chat but reauthenticates', t => {
  let now = Date.parse('2026-11-01T12:00:00Z');
  const store = new RoomStore(':memory:', { now: () => now });
  t.after(() => store.close()); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  for (const memberId of ['peer', 'observer']) store.command(owner, 'commons', {
    id: 'add-' + memberId, type: 'member.added', data: { memberId, displayName: memberId, kind: 'human', permissions: [] }
  });
  store.dmConsents.request('commons', 'owner', 'peer', 'Synthetic privacy contrast');
  store.dmConsents.decide('commons', 'peer', 'owner', 'approve');
  const observer = store.issueAccessKey('commons', 'observer');
  const before = readComposedRoomContext(store, observer, 'commons');
  now += 60000;
  const clockOnly = readComposedRoomContext(store, observer, 'commons', { sinceVersion: before.context_version });
  assert.equal(clockOnly.not_modified, true);
  assert.notEqual(clockOnly.evaluatedAt, before.evaluatedAt);
  store.command(owner, 'commons', { id: 'private-unrelated', type: 'message.posted', data: {
    messageId: 'private-unrelated', toMemberId: 'peer', body: 'Private content must not invalidate the observer version'
  } });
  const privateChange = readComposedRoomContext(store, observer, 'commons', { sinceVersion: before.context_version });
  assert.equal(privateChange.not_modified, true);
  assert.equal(privateChange.evaluatedThrough, before.evaluatedThrough);
  assert.equal(JSON.stringify(privateChange).includes('Private content'), false);
  store.markCaughtUp(observer, 'commons', privateChange.cursors.roomSequence);
  const cursorChange = readComposedRoomContext(store, observer, 'commons', { sinceVersion: before.context_version });
  assert.equal(cursorChange.not_modified, true);
  assert.equal(cursorChange.cursors.caughtUp, privateChange.cursors.roomSequence);
  assert.throws(() => readComposedRoomContext(store, observer, 'commons', {
    sinceVersion: before.context_version, expectedSessionBinding: 'f'.repeat(64)
  }), error => error.status === 409);
  store.revoke(observer);
  assert.throws(() => readComposedRoomContext(store, observer, 'commons', { sinceVersion: before.context_version }), error => error.status === 401);
});

test('composed context reads the board once, preserves legacy version refresh and writes nothing', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close()); store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const oldVersion = store.roomContext(token, 'commons').context_version;
  const list = store.workClaims.list.bind(store.workClaims);
  let calls = 0;
  t.mock.method(store.workClaims, 'list', (...args) => { calls++; return list(...args); });
  const changes = store.db.prepare('SELECT total_changes() AS n').get().n;
  const refreshed = readComposedRoomContext(store, token, 'commons', { sinceVersion: oldVersion });
  assert.notEqual(refreshed.not_modified, true, 'legacy formal-only version receives a full composed projection');
  assert.ok(refreshed.orient);
  assert.notEqual(refreshed.context_version, oldVersion);
  assert.equal(calls, 1);
  const unchanged = readComposedRoomContext(store, token, 'commons', { sinceVersion: refreshed.context_version });
  assert.equal(unchanged.not_modified, true);
  assert.equal(Object.hasOwn(unchanged, 'roster'), false);
  assert.equal(Object.hasOwn(unchanged, 'orient'), false);
  assert.equal(calls, 2);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('unchanged structural context does not recompute transient action rankings', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close()); store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const first = readComposedRoomContext(store, token, 'commons');
  const list = store.nextActions.list.bind(store.nextActions);
  let rankings = 0;
  t.mock.method(store.nextActions, 'list', (...args) => { rankings++; return list(...args); });
  const quiet = readComposedRoomContext(store, token, 'commons', { sinceVersion: first.context_version });
  assert.equal(quiet.not_modified, true);
  assert.equal(rankings, 0, 'no transient ranking is returned or needed to validate an unchanged structural projection');
});

test('hosted MCP conditional context refreshes a changed current board projection', async t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const identity = store.identities.create('Context freshness owner');
  const rooms = new AgentRooms(store);
  const roomId = 'context-freshness-mcp';
  legacyAgentRoom(store,identity, { roomId, title: 'Context freshness', purpose: 'Synthetic current-board probe', kind: 'personal' });
  const mcp = createHostedRoomMcp(store, { agentRooms: rooms });
  const context = async since => {
    const reply = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'get_room_context', arguments: { roomId, ...(since ? { since_version: since } : {}) }
    } }, { authorization: `Bearer ${identity.secret}` });
    assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
    return reply.result.structuredContent;
  };
  const before = await context();
  const id = 'mcp-context-new-board';
  store.workClaims.set(roomId, { id, title: 'A new current board task', state: 'unclaimed', owner: null, history: [] });
  const full = await context();
  assert.equal(full.orient.availableClaims.some(item => item.id === id), true);
  const conditional = await context(before.context_version);
  t.diagnostic(JSON.stringify({ protocol: 'hosted MCP', beforeVersion: before.context_version, fullVersion: full.context_version,
    conditionalNotModified: conditional.not_modified, conditionalHasOrient: Object.hasOwn(conditional, 'orient') }));
  assert.notEqual(conditional.not_modified, true, 'MCP must refresh the changed current board projection');
  assert.notEqual(conditional.context_version, before.context_version);
  assert.equal(conditional.orient.availableClaims.some(item => item.id === id), true);
});

test('native MCP context refreshes canonical work without reopening the retired Board',async t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const identity=store.identities.create('Native context owner'),rooms=new AgentRooms(store),roomId='native-context-freshness';rooms.create(identity.secret,{roomId,title:'Native context',purpose:'Canonical freshness',kind:'personal'});store.room=()=>{throw Error('native whole room hydration');};store.workClaims.list=()=>{throw Error('retired Board must not serve native context');};
 const mcp=createHostedRoomMcp(store,{agentRooms:rooms}),read=async since=>{const result=await mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_room_context',arguments:{roomId,...(since?{since_version:since}:{})}}},{authorization:`Bearer ${identity.secret}`});assert.notEqual(result.result?.isError,true,JSON.stringify(result));assert.equal(result.error,undefined);return result.result.structuredContent;};
 const before=await read(),id='new-canonical';assert.equal(before.focusWork.some(item=>item.id===id),false);
 store.command(identity.secret,roomId,{id:'new-work',type:'work.proposed',data:{workItemId:id,title:'Useful canonical task',definitionOfDone:'Exact saved result',accountableMemberId:identity.identityId,mode:'read'}});
 // Hosted identity authentication records existing usage telemetry. Every
 // authoritative identity field and every other durable row must stay exact.
 const snapshot=()=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,store.db.prepare('SELECT * FROM "'+name+'"').all().map(row=>{if(name!=='agent_identities')return row;const{last_used_at:_at,last_used_ua:_ua,mcp_legacy_uses:_uses,...authority}=row;return authority;})]));
 const durableBefore=snapshot(),full=await read(),conditional=await read(before.context_version);assert.ok(full.focusWork.some(item=>item.id===id));assert.notEqual(conditional.not_modified,true);assert.notEqual(conditional.context_version,before.context_version);assert.ok(conditional.focusWork.some(item=>item.id===id));assert.equal((await read(conditional.context_version)).not_modified,true);assert.deepEqual(snapshot(),durableBefore,'native reads preserve every row except existing identity usage telemetry');
 assert.equal(store.workClaims.get(roomId,id),null,'canonical task must not acquire a legacy mirror');
});
