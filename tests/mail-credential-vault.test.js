import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { MailCredentialVault } from '../server/mail-credential-vault.mjs';
import { GMAIL_READ_SCOPE } from '../server/gmail-oauth.mjs';

const binding = { accountId: 'account-a', connectionId: 'gmail-a', authEpoch: 1, connectionRevision: 1, provider: 'gmail', mailbox: 'pilot@example.com' };
const credentials = { accessToken: 'access-secret-fixture', refreshToken: 'refresh-secret-fixture', scope: GMAIL_READ_SCOPE, expiresAt: 999999999 };
function fixture(t) {
  const db = new DatabaseSync(':memory:'); const key = randomBytes(32);
  const vault = new MailCredentialVault({ db, key });
  t.after(() => { vault.close(); db.close(); key.fill(0); });
  const put = (expectedVersion = 0, nextBinding = binding) => vault.put({ binding: nextBinding, credentials, expectedVersion });
  return { db, key, vault, put };
}

test('roundtrip with a fresh vault instance; database contains ciphertext, not tokens', t => {
  const f = fixture(t);
  assert.deepEqual(f.put(), { version: 1, state: 'active' });
  const row = f.db.prepare('SELECT * FROM mail_credentials_v1').get();
  assert.ok(!JSON.stringify(row).includes(credentials.accessToken));
  assert.ok(!Buffer.from(row.ciphertext).toString().includes(credentials.refreshToken));
  const reopened = new MailCredentialVault({ db: f.db, key: f.key });
  assert.deepEqual(reopened.read(binding), { version: 1, credentials }); reopened.close();
});

test('wrong key cannot decrypt; errors contain no credentials', t => {
  const f = fixture(t); f.put();
  const wrong = new MailCredentialVault({ db: f.db, key: randomBytes(32) });
  assert.throws(() => wrong.read(binding), { code: 'mail_credential_unreadable' }); wrong.close();
});

test('changed account, connection, epoch, revision, provider and mailbox cannot read', t => {
  const f = fixture(t); f.put();
  for (const [field, value] of [['accountId', 'other'], ['connectionId', 'other'], ['authEpoch', 2], ['connectionRevision', 2], ['provider', 'other'], ['mailbox', 'other@example.com']])
    assert.throws(() => f.vault.read({ ...binding, [field]: value }));
});

test('ciphertext is authenticated against account and version, not transferable', t => {
  const f = fixture(t); f.put();
  f.db.prepare('UPDATE mail_credentials_v1 SET version=2').run();
  assert.throws(() => f.vault.read(binding), { code: 'mail_credential_unreadable' });
});

test('tampered authentication tag fails closed', t => {
  const f = fixture(t); f.put();
  f.db.prepare('UPDATE mail_credentials_v1 SET tag=?').run(randomBytes(16));
  assert.throws(() => f.vault.read(binding), { code: 'mail_credential_unreadable' });
});

test('refresh compare-and-swap prevents a stale update', t => {
  const f = fixture(t); f.put(); f.put(1);
  assert.throws(() => f.put(1), { code: 'mail_credential_changed' });
  assert.equal(f.vault.read(binding).version, 2);
});

test('disconnect clears credential columns and fences stale refresh or resurrection', t => {
  const f = fixture(t); f.put();
  assert.deepEqual(f.vault.disconnect({ binding, expectedVersion: 1 }), { version: 2, state: 'disconnected' });
  const row = f.db.prepare('SELECT * FROM mail_credentials_v1').get();
  for (const field of ['nonce', 'ciphertext', 'tag']) assert.equal(row[field], null);
  assert.throws(() => f.vault.read(binding), { code: 'mail_credential_disconnected' });
  assert.throws(() => f.put(1), { code: 'mail_credential_changed' });
  assert.throws(() => f.put(2), { code: 'mail_credential_binding_changed' });
  const reconnect = { ...binding, connectionRevision: 2 };
  f.put(2, reconnect);
  assert.throws(() => f.vault.read(binding), { code: 'mail_credential_binding_changed' });
  assert.equal(f.vault.read(reconnect).version, 3);
});

test('cannot change mailbox or roll account epoch backward on refresh', t => {
  const f = fixture(t); f.put();
  assert.throws(() => f.put(1, { ...binding, mailbox: 'other@example.com' }), { code: 'mail_credential_binding_changed' });
  assert.throws(() => f.put(1, { ...binding, authEpoch: 2 }), { code: 'mail_credential_binding_changed' });
  f.put(1, { ...binding, authEpoch: 2, connectionRevision: 2 });
  assert.throws(() => f.put(2, { ...binding, connectionRevision: 3 }), { code: 'mail_credential_binding_changed' });
});

test('new encryption nonce on every write', t => {
  const f = fixture(t); f.put();
  const before = f.db.prepare('SELECT nonce FROM mail_credentials_v1').get().nonce;
  f.put(1);
  assert.notDeepEqual(f.db.prepare('SELECT nonce FROM mail_credentials_v1').get().nonce, before);
});

test('rejects oversized tokens, extra credential fields, broad scopes and weak keys', t => {
  const f = fixture(t);
  for (const value of [{ ...credentials, accessToken: 'x'.repeat(8193) }, { ...credentials, extra: 'secret' }, { ...credentials, scope: 'https://mail.google.com/' }])
    assert.throws(() => f.vault.put({ binding, credentials: value, expectedVersion: 0 }), { code: 'mail_credentials_invalid' });
  assert.throws(() => new MailCredentialVault({ db: f.db, key: randomBytes(16) }), { code: 'mail_vault_key_invalid' });
});

test('closing vault prevents credential reads and does not alter caller key', t => {
  const f = fixture(t); f.put(); const copy = Buffer.from(f.key);
  f.vault.close(); assert.deepEqual(f.key, copy);
  assert.throws(() => f.vault.read(binding), { code: 'mail_vault_closed' });
});
