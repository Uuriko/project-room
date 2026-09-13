import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { providerAccountId } from '../server/operator-account-id.mjs';
import { loginWithProvider } from '../server/provider-onboarding.mjs';
import { RoomStore } from '../server/store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));

test('providerAccountId is issuer+sub sha256 and matches loginWithProvider', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-id-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issuer = 'https://clerk.trydemigod.com';
  const sub = 'user_alice';
  const expected = providerAccountId(issuer, sub);
  assert.match(expected, /^idp-[a-f0-9]{64}$/);
  assert.throws(() => providerAccountId(issuer, 'potter@trydemigod.com'));
  assert.throws(() => providerAccountId('http://clerk.trydemigod.com', sub));
  const slot = store.createAccountSessionSlot();
  const claims = { iss: issuer, sub, sid: 'sess_a', exp: Math.floor(store.now() / 1000) + 120 };
  await loginWithProvider(store, {
    issuer, token: 'signed-test-assertion', verify: async () => claims, slotToken: slot.token, expectedRevision: 0
  });
  const row = store.db.prepare('SELECT id FROM accounts').get();
  assert.equal(row.id, expected);
  const cli = spawnSync(process.execPath, [join(root, '../scripts/operator-account-id.mjs'), issuer, sub], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).accountId, expected);
});
