import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { GMAIL_READ_SCOPE } from './gmail-oauth.mjs';

const fail = code => { throw new MailCredentialError(code); };
export class MailCredentialError extends Error {
  constructor(code) { super(code); this.name = 'MailCredentialError'; this.code = code; }
}
const positive = n => Number.isSafeInteger(n) && n > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function validateBinding(value) {
  if (!value || !id(value.accountId) || !id(value.connectionId) || !Number.isSafeInteger(value.authEpoch) || value.authEpoch < 0
    || !positive(value.connectionRevision) || value.provider !== 'gmail'
    || typeof value.mailbox !== 'string' || value.mailbox.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.mailbox) || value.mailbox !== value.mailbox.toLowerCase())
    fail('mail_credential_binding_invalid');
  return JSON.stringify([value.accountId, value.connectionId, value.authEpoch,
    value.connectionRevision, value.provider, value.mailbox]);
}
function serializeCredentials(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'accessToken,expiresAt,refreshToken,scope'
    || value.scope !== GMAIL_READ_SCOPE || !positive(value.expiresAt)
    || !['accessToken', 'refreshToken'].every(key => typeof value[key] === 'string'
      && value[key].length > 0 && value[key].length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value[key])))
    fail('mail_credentials_invalid');
  return JSON.stringify(value);
}

// A separate private SQLite database, never the room event journal or a public export.
// Caller owns DB lifecycle/permissions and supplies a key held OUTSIDE the DB/repo.
// This is not authorization: the host must derive bindings from fresh authenticated
// state, and serialize/check account changes across vault writes and provider calls.
export class MailCredentialVault {
  #db; #key;
  constructor({ db, key }) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail('mail_vault_key_invalid');
    this.#key = Buffer.from(key);
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS mail_credentials_v1 (
      account_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0), binding TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','disconnected')),
      nonce BLOB, ciphertext BLOB, tag BLOB,
      PRIMARY KEY(account_id,connection_id),
      CHECK((state='active' AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND tag IS NOT NULL)
        OR (state='disconnected' AND nonce IS NULL AND ciphertext IS NULL AND tag IS NULL))
    )`);
  }
  #row(binding) {
    if (!this.#key) fail('mail_vault_closed');
    validateBinding(binding);
    return this.#db.prepare('SELECT * FROM mail_credentials_v1 WHERE account_id=? AND connection_id=?')
      .get(binding.accountId, binding.connectionId);
  }
  #aad(binding, version) { return Buffer.from(JSON.stringify(['project-room-mail-v1', binding, version])); }
  // Metadata only, including tombstones. Host must authorize the account first.
  status(binding) {
    const row = this.#row(binding);
    return row ? { version: row.version, state: row.state } : { version: 0, state: 'missing' };
  }
  #version(value) { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail('mail_credential_version_invalid'); }

  put({ binding, credentials, expectedVersion }) {
    const serializedBinding = validateBinding(binding);
    const plaintext = Buffer.from(serializeCredentials(credentials));
    this.#version(expectedVersion);
    try {
      const current = this.#row(binding);
      if ((current?.version ?? 0) !== expectedVersion) fail('mail_credential_changed');
      // Reconnect/epoch upgrades require a newer connection revision. Refreshing
      // credentials can retain the exact binding but cannot silently change identity.
      if (current) {
        const old = JSON.parse(current.binding);
        if (old[4] !== binding.provider || old[5] !== binding.mailbox
          || binding.authEpoch < old[2] || binding.connectionRevision < old[3]
          || (current.state === 'disconnected' || binding.authEpoch !== old[2]) && binding.connectionRevision <= old[3])
          fail('mail_credential_binding_changed');
      }
      const version = expectedVersion + 1;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
      cipher.setAAD(this.#aad(serializedBinding, version));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const values = [version, serializedBinding, nonce, ciphertext, tag, binding.accountId, binding.connectionId];
      if (current) {
        const result = this.#db.prepare(`UPDATE mail_credentials_v1 SET version=?,binding=?,nonce=?,ciphertext=?,tag=?,state='active'
          WHERE account_id=? AND connection_id=? AND version=?`).run(...values, expectedVersion);
        if (result.changes !== 1) fail('mail_credential_changed');
      } else {
        const result = this.#db.prepare(`INSERT OR IGNORE INTO mail_credentials_v1
          (version,binding,nonce,ciphertext,tag,account_id,connection_id,state) VALUES (?,?,?,?,?,?,?,'active')`).run(...values);
        if (result.changes !== 1) fail('mail_credential_changed');
      }
      return { version, state: 'active' };
    } finally { plaintext.fill(0); }
  }

  read(binding) {
    const row = this.#row(binding);
    if (!row) fail('mail_credential_missing');
    if (row.state !== 'active') fail('mail_credential_disconnected');
    if (row.binding !== validateBinding(binding)) fail('mail_credential_binding_changed');
    let plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, row.nonce);
      decipher.setAAD(this.#aad(row.binding, row.version));
      decipher.setAuthTag(row.tag);
      plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      const credentials = JSON.parse(plaintext.toString('utf8'));
      serializeCredentials(credentials);
      return { version: row.version, credentials };
    } catch { fail('mail_credential_unreadable'); }
    finally { plaintext?.fill(0); }
  }

  disconnect({ binding, expectedVersion }) {
    this.#version(expectedVersion);
    const row = this.#row(binding);
    if (!row || row.version !== expectedVersion) fail('mail_credential_changed');
    if (row.binding !== validateBinding(binding)) fail('mail_credential_binding_changed');
    const version = expectedVersion + 1;
    const result = this.#db.prepare(`UPDATE mail_credentials_v1
      SET version=?,state='disconnected',nonce=NULL,ciphertext=NULL,tag=NULL
      WHERE account_id=? AND connection_id=? AND version=?`).run(version, binding.accountId, binding.connectionId, expectedVersion);
    if (result.changes !== 1) fail('mail_credential_changed');
    // Tombstone is retained so a late refresh cannot recreate the deleted credential.
    // This is local removal only, not Google token revocation or backup erasure.
    return { version, state: 'disconnected' };
  }

  close() { this.#key?.fill(0); this.#key = null; }
}
