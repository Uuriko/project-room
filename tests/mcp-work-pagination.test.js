import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { openMcpTestClient } from '../scripts/mcp-test-client.mjs';

test('hosted and stdio work tools traverse more than 25 query matches and reject changed selections', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-page-')), store = new RoomStore(join(directory, 'room.sqlite'));
  const identity = store.identities.create('Owen');
  new AgentRooms(store).create(identity.secret, { roomId: 'test-room', title: 'Test', purpose: 'Paging', kind: 'personal', displayName: 'Owner' });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, config = join(directory, 'agent'); let stdio = null;
  t.after(async () => { if (stdio) await stdio.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const send = (type, data) => store.command(identity.secret, 'test-room', { id: crypto.randomUUID(), type, data });
  for (let i = 0; i < 63; i++) send('work.proposed', { workItemId: `task-${i}`, title: `Paging task ${i}`, definitionOfDone: 'Return a useful answer', mode: 'read', accountableMemberId: identity.identityId });
  saveAgentConnection(config, { version: 1, origin, roomId: 'test-room', memberId: identity.identityId, token: identity.secret });
  stdio = await openMcpTestClient(config);
  const unwrap = response => response.result ?? { isError: true, protocolError: response.error };
  const hosted = async args => unwrap( (await (await fetch(`${origin}/room/mcp?profile=full`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'tools/call', params: { name: 'room_list_work', arguments: { roomId: 'test-room', ...args } } }) })).json()));
  const bound = async args => unwrap(await stdio.call('room_list_work', args));
  for (const call of [hosted, bound]) {
    for (const query of [undefined, 'Paging']) {
      const ids = []; let args = query ? { query } : {}, first, result;
      do {
        result = await call(args); assert.ok(!result.isError, JSON.stringify(result));
        const data = result.structuredContent; first ??= data;
        assert.equal(data.page.totalWork, 63); assert.ok(data.work.length <= 25);
        ids.push(...data.work.map(x => x.id)); args = data.page.nextRead?.arguments;
      } while (result.structuredContent.page.hasMore);
      assert.equal(ids.length, 63); assert.equal(new Set(ids).size, 63);
      assert.deepEqual([...ids].sort(), Array.from({ length: 63 }, (_, i) => `task-${i}`).sort());
      const mismatch = await call({ ...first.page.nextRead.arguments, query: 'different' });
      assert.equal(mismatch.isError, true); assert.match(JSON.stringify(mismatch), /stale_work_cursor|selection changed/);
    }
    for (const limit of [0, 101, 1.5]) assert.equal((await call({ limit })).isError, true);
    const first = (await call({})).structuredContent;
    const all = (await call({ limit: 100 })).structuredContent;
    t.diagnostic(JSON.stringify({ transport: call === hosted ? 'hosted' : 'stdio', fixtureWork: 63,
      defaultPageBytes: Buffer.byteLength(JSON.stringify(first)), allRowsBytes: Buffer.byteLength(JSON.stringify(all)),
      metric: 'structured response bytes, not snapshot read cost' }));
    send('message.posted', { messageId: crypto.randomUUID(), body: 'Advance observed room revision' });
    const stale = await call(first.page.nextRead.arguments);
    assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /stale_work_cursor|selection changed/);
  }
});

test('stdio invitation pages tolerate observation time advancing and reject expiry', async t => {
  const { createAcceptanceFixture } = await import('../scripts/acceptance-fixture.mjs');
  const f = createAcceptanceFixture(); let now = Date.now(), stdio = null; f.store.now = () => now;
  const send = (actor, type, data) => f.store.command(f.keys[actor], 'commons', { id: crypto.randomUUID(), type, data });
  send('owner', 'member.added', { memberId: 'helper', displayName: 'Helper', kind: 'agent', permissions: [], accountableHumanId: 'owner' });
  const key = f.store.issueAccessKey('commons', 'helper');
  for (const id of ['invite-one', 'invite-two']) {
    send('owner', 'work.proposed', { workItemId: id, title: id, definitionOfDone: 'Return useful work', mode: 'read', accountableMemberId: 'producer' });
    send('producer', 'work.accepted', { workItemId: id, expectedRevision: 0 });
    send('producer', 'work.help_updated', { workItemId: id, expectedRevision: 1, expectedHelpRevision: 0, status: 'open', scope: 'Suggest a useful improvement', expiresAt: new Date(now + 60000).toISOString() });
  }
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (stdio) await stdio.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const config = join(f.directory, 'helper-page');
  saveAgentConnection(config, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'helper', token: key });
  stdio = await openMcpTestClient(config);
  const first = (await stdio.call('room_list_work', { focus: 'help_wanted', limit: 1 })).result.structuredContent;
  assert.ok(first.page, JSON.stringify(first)); assert.equal(first.page.totalWork, 2); now += 1000;
  const second = (await stdio.call('room_list_work', first.page.nextRead.arguments)).result;
  assert.ok(!second.isError, JSON.stringify(second)); assert.notEqual(second.structuredContent.work[0].id, first.work[0].id);
  now += 60000;
  const expired = (await stdio.call('room_list_work', first.page.nextRead.arguments)).result;
  assert.equal(expired.isError, true); assert.equal(expired.structuredContent.code, 'stale_work_cursor');
});
