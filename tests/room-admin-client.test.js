// Pins the wire format of the RoomAgentClient admin verbs (invite codes,
// access requests) and the optional-field behavior of request bodies:
// undefined fields are omitted, every other value (null, "", 0, false)
// is sent exactly as given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient, RoomClientError } from '../client/room-agent.mjs';

const ORIGIN = 'http://127.0.0.1:9';
const TOKEN = 'pri_' + 'a'.repeat(43);

function fixture(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => queue.shift() };
  };
  const client = new RoomAgentClient({ origin: ORIGIN, roomId: 'commons', token: TOKEN, fetchImpl });
  return { client, calls };
}

test('agentInvites reads the invite list over GET', async () => {
  const { client, calls } = fixture([{ roomId: 'commons', invites: [] }]);
  const value = await client.agentInvites();
  assert.deepEqual(value, { roomId: 'commons', invites: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${ORIGIN}/api/rooms/commons/agent-invites`);
  assert.equal(calls[0].body, undefined);
});

test('createAgentInvite omits undefined option fields from the body', async () => {
  const { client, calls } = fixture([{ roomId: 'commons', code: 'code-1', inviteId: 'inv-1' }]);
  await client.createAgentInvite({ expiresInMinutes: 60 });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${ORIGIN}/api/rooms/commons/agent-invites`);
  assert.deepEqual(calls[0].body, { expiresInMinutes: 60 });
});

test('accessRequests encodes the status filter', async () => {
  const { client, calls } = fixture([{ roomId: 'commons', requests: [] }]);
  await client.accessRequests({ status: 'pending' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${ORIGIN}/api/rooms/commons/access-requests?status=pending`);
});

test('decideAccessRequest keeps defined fields and drops undefined ones', async () => {
  const { client, calls } = fixture([{ roomId: 'commons', decided: true }]);
  await client.decideAccessRequest('req1', { decision: 'approve', note: 'ok' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${ORIGIN}/api/rooms/commons/access-requests/req1/decide`);
  assert.deepEqual(calls[0].body, { decision: 'approve', note: 'ok' });
});

test('optional body fields keep null, empty string and zero; only undefined is dropped', async () => {
  const { client, calls } = fixture([{ roomId: 'commons', closed: true }]);
  await client.closeWorkClaim('claim-1', { reason: null });
  assert.deepEqual(calls[0].body, { reason: null });
});

test('admin verbs reject a response for the wrong room', async () => {
  const { client } = fixture([{ roomId: 'elsewhere', invites: [] }]);
  await assert.rejects(client.agentInvites(), error => {
    assert.ok(error instanceof RoomClientError);
    assert.equal(error.status, 200);
    assert.equal(error.code, 'invalid_response');
    return true;
  });
});
