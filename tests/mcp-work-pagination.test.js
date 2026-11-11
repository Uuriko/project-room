import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { legacyAgentRoom } from './helpers/legacy-agent-room.mjs';
import { createRoomServer } from '../server/http.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { openMcpTestClient } from '../scripts/mcp-test-client.mjs';

test('hosted and stdio work tools traverse more than 25 query matches and reject changed selections', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-page-')), store = new RoomStore(join(directory, 'room.sqlite'));
  const identity = store.identities.create('Owen');
  legacyAgentRoom(store, identity, { roomId: 'test-room', title: 'Test', purpose: 'Paging', kind: 'personal', displayName: 'Owner' });
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


test('hosted and stdio native work tools traverse 63 sources including empty result pages without exact totals', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-work-page-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const identity = store.identities.create('Native owner');
  new AgentRooms(store).create(identity.secret, { roomId: 'native-page', title: 'Native', purpose: 'Paging', kind: 'personal', displayName: 'Owner', starter: false });
  const send = (type, data) => store.command(identity.secret, 'native-page', { id: crypto.randomUUID(), type, data });
  for (let i = 0; i < 63; i++) send('work.proposed', { workItemId: `task-${i}`, title: `Native task ${i}`, definitionOfDone: 'Return a useful answer', mode: 'read', accountableMemberId: identity.identityId });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, config = join(directory, 'agent');
  let stdio = null;
  t.after(async () => { if (stdio) await stdio.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  saveAgentConnection(config, { version: 1, origin, roomId: 'native-page', memberId: identity.identityId, token: identity.secret });
  stdio = await openMcpTestClient(config);
  store.room = () => { throw Error('native paging must not hydrate room'); };
  store.workClaims.list = () => { throw Error('native paging must not read legacy Board'); };
  const unwrap = response => response.result ?? { isError: true, protocolError: response.error };
  const hosted = async args => unwrap(await (await fetch(`${origin}/room/mcp?profile=full`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.secret}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'native-page', method: 'tools/call', params: { name: 'room_list_work', arguments: { roomId: 'native-page', ...args } } }) })).json());
  const bound = async args => unwrap(await stdio.call('room_list_work', args));
  for (const transport of [hosted, bound]) {
    const call = async args => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await transport(args);
        if (result.structuredContent?.code !== 'rate_limited') return result;
        // Follow the real server's retry contract; paging does not bypass abuse limits.
        await new Promise(resolve => setTimeout(resolve, result.structuredContent.retryAfterMs ?? 1000));
      }
      assert.fail('paging remained rate limited after the announced retry intervals');
    };
    for (const focus of ['all', 'results']) {
      const ids = [], cursors = new Set();
      let args = { focus, limit: 4 }, first, pages = 0, examined = 0;
      while (true) {
        const result = await call(args);
        assert.ok(!result.isError, JSON.stringify(result));
        const data = result.structuredContent;
        first ??= data;
        pages++;
        assert.ok(pages <= Math.ceil(63 / 4), 'one advancing source window per page');
        assert.equal(data.workScope, 'bounded_source_window');
        assert.equal(data.page.totalWork, null);
        assert.equal(data.page.totalReplyRequests, null);
        assert.equal(data.selection.matches, null);
        assert.ok(data.selection.examinedWork <= 4);
        assert.ok(data.work.length <= 4);
        examined += data.selection.examinedWork;
        ids.push(...data.work.map(item => item.id));
        if (!data.page.hasMore) { assert.equal(data.page.nextRead, null); break; }
        assert.ok(data.page.nextRead?.arguments.cursor, 'even an empty filtered page must continue');
        assert.equal(cursors.has(data.page.nextRead.arguments.cursor), false);
        cursors.add(data.page.nextRead.arguments.cursor);
        args = data.page.nextRead.arguments;
      }
      assert.equal(pages, Math.ceil(63 / 4));
      assert.equal(examined, 63);
      if (focus === 'all') {
        assert.equal(ids.length, 63);
        assert.equal(new Set(ids).size, 63);
        assert.deepEqual([...ids].sort(), Array.from({ length: 63 }, (_, i) => `task-${i}`).sort());
      } else assert.deepEqual(ids, [], 'proposals have no saved result; emptiness is proven only after all source pages');
      for (const changed of [{ focus: focus === 'all' ? 'results' : 'all' }, { limit: 3 }]) {
        const mismatch = await call({ ...first.page.nextRead.arguments, ...changed });
        assert.equal(mismatch.isError, true);
        assert.match(JSON.stringify(mismatch), /stale_work_cursor/);
      }
    }
    for (const selection of [{ query: 'Native' }, { sort: 'curiosity' }]) {
      const unavailable = await call(selection);
      assert.equal(unavailable.isError, true);
      if (transport === hosted) assert.match(JSON.stringify(unavailable), /current_work_selection_unavailable/);
      assert.equal(unavailable.structuredContent?.work, undefined, 'unsupported selection never becomes a successful empty page');
    }
    const first = (await call({ focus: 'all' })).structuredContent;
    send('message.posted', { messageId: crypto.randomUUID(), body: 'Advance native revision' });
    const stale = await call(first.page.nextRead.arguments);
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /stale_work_cursor/);
    t.diagnostic(JSON.stringify({ transport: transport === hosted ? 'hosted' : 'stdio', sources: 63, pagesPerSelection: 16, resultPagesEmpty: 16, totals: 'unknown' }));
  }
});
