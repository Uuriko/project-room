import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createGmailRuntime } from '../server/gmail-runtime.mjs';
const origin = 'http://127.0.0.1:4173';
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gmail-runtime-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_GMAIL_CLIENT_FILE: join(directory, 'client.json'), ROOM_GMAIL_KEY_FILE: join(directory, 'key'), ROOM_GMAIL_VAULT_FILE: join(directory, 'vault.sqlite') };
  writeFileSync(env.ROOM_GMAIL_CLIENT_FILE, JSON.stringify({ web: { client_id: 'fixture-client', client_secret: 'fixture-secret', redirect_uris: [origin + '/api/inbox/connections/gmail/callback'] } }), { mode: 0o600 });
  writeFileSync(env.ROOM_GMAIL_KEY_FILE, randomBytes(32), { mode: 0o600 });
  return { directory, env, open: extra => createGmailRuntime({ env, origin, store: { now: Date.now }, ...extra }) };
}
test('disabled configuration does not require or create secrets', () => {
  assert.equal(createGmailRuntime({ env: {} }), null);
});
test('valid private configuration opens and reopens a private vault', t => {
  const f = fixture(t); let runtime = f.open();
  assert.ok(runtime.connections); runtime.close(); runtime.close();
  assert.equal(statSync(f.env.ROOM_GMAIL_VAULT_FILE).mode & 0o077, 0);
  runtime = f.open(); runtime.close();
});
test('partial configuration, wrong redirect and readable key fail closed', t => {
  const f = fixture(t);
  assert.throws(() => f.open({ env: { ROOM_GMAIL_KEY_FILE: f.env.ROOM_GMAIL_KEY_FILE } }), { code: 'gmail_private_configuration_invalid' });
  assert.throws(() => f.open({ origin: 'https://other.example' }), { code: 'gmail_private_configuration_invalid' });
  chmodSync(f.env.ROOM_GMAIL_KEY_FILE, 0o644);
  assert.throws(() => f.open(), { code: 'gmail_private_configuration_invalid' });
});
test('keys inside source root or through symlinks are rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.open({ sourceRoot: f.directory }), { code: 'gmail_private_configuration_invalid' });
  const link = join(f.directory, 'key-link'); symlinkSync(f.env.ROOM_GMAIL_KEY_FILE, link);
  assert.throws(() => f.open({ env: { ...f.env, ROOM_GMAIL_KEY_FILE: link } }), { code: 'gmail_private_configuration_invalid' });
});
test('existing room database cannot be reused as credential vault', t => {
  const f = fixture(t); const db = new DatabaseSync(f.env.ROOM_GMAIL_VAULT_FILE);
  db.exec('CREATE TABLE rooms(id TEXT)'); db.close(); chmodSync(f.env.ROOM_GMAIL_VAULT_FILE, 0o600);
  assert.throws(() => f.open(), { code: 'gmail_private_configuration_invalid' });
  const verify = new DatabaseSync(f.env.ROOM_GMAIL_VAULT_FILE);
  assert.equal(verify.prepare("SELECT count(*) n FROM sqlite_master WHERE name='mail_credentials_v1'").get().n, 0); verify.close();
});
