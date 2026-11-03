// OAuth-configured server: anonymous initialize keeps the 401 challenge but
// its body carries the public starter task and a discovery URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeRoomMcpNode } from '../server/mcp-http.mjs';

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res; };
  res.end = body => { res.body = body ?? ''; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
const metadata = 'https://room.example/.well-known/oauth-protected-resource/mcp';
async function run(roomMcp, headers = {}) {
  const res = fakeRes(); const calls = [];
  const spy = roomMcp && (async (message, opts) => { calls.push(message); return roomMcp(message, opts); });
  await writeRoomMcpNode({ method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res, new URL('https://room.example/mcp'), { bodyText: init, roomMcp: spy, oauthMetadataUrl: metadata });
  return { res, body: JSON.parse(res.body), calls };
}
const task = { taskId: 't1', title: 'Public task', namespaceId: 'private-room', claim: { holder: 'x' }, files: ['a.js'] };

test('anonymous initialize keeps 401 + WWW-Authenticate and adds a public starter task', async () => {
  const { res, body, calls } = await run(async () => ({ jsonrpc: '2.0', id: 'starter-task', result: { structuredContent: { recommendations: [{ task }] } } }));
  assert.equal(res.status, 401);
  assert.match(String(res.headers['WWW-Authenticate'] ?? res.headers['www-authenticate']), /resource_metadata=/);
  assert.equal(body.error.code, -32001);
  assert.equal(body.error.data.starterTask.state, 'available');
  assert.equal(body.error.data.starterTask.claimed, false);
  assert.deepEqual(body.error.data.starterTask.task, { taskId: 't1', title: 'Public task', files: ['a.js'] });
  assert.equal(JSON.stringify(body).includes('private-room'), false);
  assert.match(body.error.data.discoveryUrl, /\/mcp\?auth=discovery$/);
  // Read-only: the only store call is a recommend without autoClaim.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, 'public_work_recommend');
  assert.equal(calls[0].params.arguments.autoClaim, undefined);
});

test('empty board or failing recommend still returns the 401 challenge with the empty starter case', async () => {
  for (const roomMcp of [async () => ({ result: { structuredContent: { recommendations: [] } } }), async () => { throw new Error('down'); }, null]) {
    const { res, body } = await run(roomMcp);
    assert.equal(res.status, 401);
    assert.equal(body.error.data.starterTask.state, 'none');
    assert.equal(body.error.data.starterTask.suggestedFirstAction.tool, 'room_join_prompt');
  }
});
