import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { workCommand } from '../cli/commands/work.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initialRoom } from '../server/bootstrap.mjs';
const execFileAsync = promisify(execFile);

test('work CLI default needs_me follows legacy signed cursors beyond 25 without an explicit limit', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', {id: 'reader', type: 'member.added', data: {memberId: 'reader', displayName: 'Reader', kind: 'agent', permissions: ['accept_work']}});
  const secret = store.issueAccessKey('commons', 'reader');
  for (let i = 0; i < 31; i++) store.command(owner, 'commons', {id: crypto.randomUUID(), type: 'work.proposed',
    data: {workItemId: `legacy-${i}`, title: `Task ${i}`, definitionOfDone: 'Produce a result', mode: 'read', accountableMemberId: 'reader'}});
  const server = createRoomServer({store}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();});
  const conn = {origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'reader', secret};
  let result; const methods = [], io = {connection: async () => conn, out: text => {
    assert.equal(text.includes(secret), false); result = JSON.parse(text);
  }, fetchImpl: (url, options) => {methods.push(options?.method ?? 'GET'); return fetch(url, options);}};
  await workCommand([], io);
  assert.equal(result.work.length, 25); assert.equal(result.page.nextRead.arguments.focus, 'needs_me');
  assert.match(result.page.nextRead.arguments.cursor, /^[^.]+\.[^.]+$/);
  assert.equal(result.page.nextRead.arguments.limit, 25);
  const ids = new Set(result.work.map(item => item.id));
  await workCommand(result.cli.nextArgv.slice(2), io);
  assert.equal(result.work.length, 6); assert.equal(result.cli.complete, true); assert.equal(result.cli.nextArgv, null);
  for (const item of result.work) {assert.equal(ids.has(item.id), false); ids.add(item.id);}
  assert.equal(ids.size, 31); assert.ok(methods.every(method => method === 'GET'));
});

test('work CLI traverses bounded native pages without writes and rejects stale cursors', async t => {
  const store = new RoomStore(':memory:'), identity = store.identities.create('Fixture agent');
  new AgentRooms(store).create(identity.secret, { roomId: 'cli-work', title: 'Fixture', purpose: 'Test', kind: 'personal', displayName: 'Agent', starter: false });
  const send = (type, data) => store.command(identity.secret, 'cli-work', { id: crypto.randomUUID(), type, data });
  for (let i = 0; i < 5; i++) send('work.proposed', { workItemId: `work-${i}`, title: `Task ${i}`, definitionOfDone: 'Produce a result', mode: 'read', accountableMemberId: identity.identityId });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const conn = { origin: `http://127.0.0.1:${server.address().port}`, roomId: 'cli-work', memberId: identity.identityId, secret: identity.secret };
  const command = await execFileAsync(process.execPath, ['bin/room.mjs', 'work', '--focus', 'all', '--limit', '1'], {
    env: { ...process.env, ROOM_ORIGIN: conn.origin, ROOM_ID: conn.roomId, ROOM_AGENT_MEMBER: conn.memberId, PROJECT_ROOM_SECRET: conn.secret }
  });
  const executed = JSON.parse(command.stdout);
  assert.equal(executed.page.hasMore, true); assert.equal(executed.cli.complete, false);
  assert.equal(command.stdout.includes(identity.secret), false);
  const calls = [], outputs = [], io = { connection: async () => conn, out: s => outputs.push(s), fetchImpl: (url, options) => { calls.push(options?.method ?? 'GET'); return fetch(url, options); } };
  await workCommand(['--focus', 'all', '--limit', '1'], io);
  const first = JSON.parse(outputs.pop());
  assert.equal(first.page.limit, 1); assert.equal(first.page.hasMore, true); assert.equal(first.work.length, 1);
  assert.equal(first.cli.complete, false);
  assert.equal(first.scope.externalExecution, false);
  assert.equal(JSON.stringify(first).includes(identity.secret), false);
  const cursor = first.page.nextRead.arguments.cursor;
  assert.deepEqual(first.cli.nextArgv, ['room', 'work', '--focus', 'all', '--limit', '1', '--cursor', cursor]);
  await workCommand(first.cli.nextArgv.slice(2), io);
  const second = JSON.parse(outputs.pop());
  assert.notEqual(second.work[0].id, first.work[0].id);
  await workCommand(['--focus', 'results', '--limit', '4'], io);
  const empty = JSON.parse(outputs.pop());
  assert.deepEqual(empty.work, []); assert.equal(empty.cli.complete, false, 'empty filtered page can still have more sources');
  await workCommand(empty.cli.nextArgv.slice(2), io);
  const last = JSON.parse(outputs.pop());
  assert.deepEqual(last.work, []); assert.equal(last.cli.complete, true); assert.equal(last.cli.nextArgv, null);
  assert.ok(calls.every(method => method === 'GET'));
  send('message.posted', { messageId: 'later-message', body: 'Change the room' });
  await assert.rejects(() => workCommand(['--focus', 'all', '--limit', '1', '--cursor', cursor], io), /restart|changed|stale/i);
  assert.deepEqual(outputs, [], 'a failed continuation does not emit partial results');
});

test('work CLI rejects invalid options before loading credentials', async () => {
  let calls = 0;
  const io = { connection: () => { calls++; throw Error('unexpected connection'); } };
  for (const args of [['--limit', '0'], ['--focus', 'ready'], ['--cursor', '../escape'], ['--limit', '1', '--limit', '2']])
    await assert.rejects(() => workCommand(args, io));
  assert.equal(calls, 0);
  await assert.rejects(() => workCommand([], { connection: async () => ({}) }), /member ID is required/);
});
