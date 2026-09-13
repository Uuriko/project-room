import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { loginWithProvider, STARTER_ROOM_ID } from '../server/provider-onboarding.mjs';

function fixture(t, sub = 'user_alice') {
  const directory = mkdtempSync(join(tmpdir(), 'operator-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issuer = 'https://test.clerk.accounts.dev';
  const slot = store.createAccountSessionSlot();
  const claims = { iss: issuer, sub, sid: 'sess_a', exp: Math.floor(store.now() / 1000) + 120 };
  const accountId = `idp-${createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex')}`;
  return {
    store, accountId, options: {
      issuer, token: 'signed-test-assertion', verify: async () => claims, slotToken: slot.token, expectedRevision: 0
    }
  };
}

test('named operator gets manage_members on Welcome; others stay empty', async t => {
  const op = fixture(t, 'user_alice');
  const first = await loginWithProvider(op.store, { ...op.options, operatorAccountId: op.accountId });
  assert.equal(first.roomId, STARTER_ROOM_ID);
  const memberId = Object.keys(op.store.room(STARTER_ROOM_ID).state.members).find(id => id.startsWith('member-'));
  assert.deepEqual(op.store.room(STARTER_ROOM_ID).state.members[memberId].permissions, ['manage_members']);
  assert.equal(op.store.room(STARTER_ROOM_ID).state.room.ownerId, 'welcome-host');
  const other = fixture(t, 'user_bob');
  await loginWithProvider(other.store, { ...other.options, operatorAccountId: op.accountId });
  const bob = Object.keys(other.store.room(STARTER_ROOM_ID).state.members).find(id => id.startsWith('member-'));
  assert.deepEqual(other.store.room(STARTER_ROOM_ID).state.members[bob].permissions, []);
});
