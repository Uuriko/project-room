// ROOM_INVITE_SHARE: a connected agent mints a teammate invite and gets one
// paste line; the teammate's agent joins with it. Credentials are minted only
// in this disposable fixture and never printed in diagnostics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { inviteShareEnabled, inviteShareMessage, withInviteShare } from '../server/invite-share.mjs';

test('flag off by default; pure line shape', () => {
  assert.equal(inviteShareEnabled({}), false);
  assert.equal(inviteShareEnabled({ ROOM_INVITE_SHARE: '1' }), true);
  const r = { code: 'TESTCODE', roomId: 'r1', expiresAt: Date.UTC(2026, 10, 5) };
  assert.equal(withInviteShare(r, {}), r);
  const line = inviteShareMessage(r);
  assert.equal(line, 'Connect to Project Room at https://room.trydemigod.com/mcp (approve the sign-in it asks for), call room_join with inviteCode TESTCODE to join room r1, then take and finish one small task there. The code works once and expires 2026-11-05T00:00:00.000Z.');
  assert.equal(inviteShareMessage({ roomId: 'r1' }), null);
  assert.equal(withInviteShare(r, { ROOM_INVITE_SHARE: '1' }).shareMessage, line);
});

async function serve(t) {
  const dir = mkdtempSync(join(tmpdir(), 'invite-share-'));
  const store = new RoomStore(join(dir, 'room.sqlite')); store.initialize(initialRoom('commons'));
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.ROOM_INVITE_SHARE; });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const http = async (path, { method = 'GET', token, body } = {}) => {
    const res = await fetch(origin + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const tool = async (token, name, args) => {
    const r = await http('/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name, arguments: args } } });
    assert.equal(r.status, 200, `${name}: HTTP`); assert.ok(r.json.result && !r.json.result.isError, `${name}: tool success`);
    return r.json.result;
  };
  const identity = async displayName => (await http('/api/agent-identities', { method: 'POST', body: { displayName } })).json.secret;
  return { tool, identity };
}

test('flag on: invite result carries a share line, text block withholds the code, teammate joins with it', async t => {
  const { tool, identity } = await serve(t);
  process.env.ROOM_INVITE_SHARE = '1';
  const founder = await identity('Share founder');
  const room = (await tool(founder, 'room_create', { title: 'Share test', purpose: 'Teammate invites' })).structuredContent;
  const minted = await tool(founder, 'room_create_agent_invite', { roomId: room.roomId, profile: 'chat' });
  const { code, shareMessage } = minted.structuredContent;
  assert.ok(typeof shareMessage === 'string' && shareMessage.includes(code), 'share line carries the code in structuredContent');
  assert.ok(shareMessage.includes(`join room ${room.roomId}`));
  assert.equal(JSON.stringify(minted.content).includes(code), false, 'code withheld from text, including the share line');
  const fromLine = /inviteCode (\S+) /.exec(shareMessage)[1];
  const teammate = await identity('Teammate agent');
  const joined = await tool(teammate, 'room_join', { inviteCode: fromLine });
  assert.equal(joined.structuredContent.roomId, room.roomId);
});

test('flag off: invite result unchanged (no share line)', async t => {
  const { tool, identity } = await serve(t);
  const founder = await identity('Plain founder');
  const room = (await tool(founder, 'room_create', { title: 'Plain', purpose: 'No flag' })).structuredContent;
  const minted = await tool(founder, 'room_create_agent_invite', { roomId: room.roomId, profile: 'chat' });
  assert.equal(minted.structuredContent.shareMessage, undefined);
});
