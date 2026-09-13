import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { loginWithProvider, STARTER_ROOM_ID } from '../server/provider-onboarding.mjs';
import { createRoomServer } from '../server/http.mjs';

function accountId(issuer, sub) {
  return `idp-${createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex')}`;
}

// Loopback two-human drill. Never points at live Durable Object storage.
export async function runHostedDrill() {
  if (process.env.ROOM_DRILL_ALLOW_LIVE === '1') throw new Error('Live drill is not enabled in this script');
  const directory = mkdtempSync(join(tmpdir(), 'hosted-drill-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const issuer = 'https://test.clerk.accounts.dev';
  const aliceId = accountId(issuer, 'user_alice');
  const login = async (sub, sid, operatorAccountId) => {
    const slot = store.createAccountSessionSlot();
    const claims = { iss: issuer, sub, sid, exp: Math.floor(store.now() / 1000) + 120 };
    return loginWithProvider(store, {
      issuer, token: 'signed-test-assertion', verify: async () => claims,
      slotToken: slot.token, expectedRevision: 0, operatorAccountId
    });
  };
  const alice = await login('user_alice', 'sess_alice', aliceId);
  const bob = await login('user_bob', 'sess_bob', aliceId);
  const welcome = store.room(STARTER_ROOM_ID);
  const aliceMember = Object.entries(welcome.state.members).find(([, m]) => m.permissions?.includes('manage_members') && m.id !== 'welcome-host');
  const bobMember = Object.entries(welcome.state.members).find(([, m]) => m.id.startsWith('member-') && m.id !== aliceMember?.[0] && m.id !== 'welcome-host');
  if (!aliceMember || aliceMember[1].permissions.join() !== 'manage_members') throw new Error('Alice is not Welcome operator');
  if (!bobMember || bobMember[1].permissions.length) throw new Error('Bob must stay permissions []');
  const server = createRoomServer({ store, operatorAccountId: aliceId });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const aliceKey = store.issueAccessKey(STARTER_ROOM_ID, aliceMember[0]);
  const bobKey = store.issueAccessKey(STARTER_ROOM_ID, bobMember[0]);
  const post = await fetch(origin + `/api/rooms/${STARTER_ROOM_ID}/commands`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bobKey, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'drill-hello', type: 'message.posted', data: { messageId: 'drill-hello', body: 'Hello from Bob' } })
  });
  if (post.status !== 201) throw new Error('Bob chat failed ' + post.status);
  const aliceExpiry = alice.session.expiresAt;
  store.changeAccountAccess(store.accountForMember(STARTER_ROOM_ID, bobMember[0]).id, { expectedRevision: 0, active: false, reason: 'Drill revoke' });
  const denied = await fetch(origin + `/api/rooms/${STARTER_ROOM_ID}/commands`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bobKey, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'drill-bye', type: 'message.posted', data: { messageId: 'drill-bye', body: 'should fail' } })
  });
  server.closeStreams(); server.closeAllConnections();
  await new Promise(r => server.close(r));
  store.close();
  rmSync(directory, { recursive: true, force: true });
  if (denied.status < 400) throw new Error('Revoked Bob still posted');
  if (aliceExpiry <= 0) throw new Error('Alice session missing');
  return { ok: true, aliceOperator: true, bobRevoked: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHostedDrill().then(r => { console.log(JSON.stringify(r)); }).catch(err => { console.error(err.message); process.exit(1); });
}
