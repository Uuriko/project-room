import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const offset = n => Number.isSafeInteger(n) && n >= 0;
const fail = () => { throw new Error('telegram_queue_unconfirmed'); };

// Private staging database, NOT the RoomStore database. Host owns secure file
// creation, one bot/account binding, lifecycle fencing, and the encryption key.
// Advance the provider offset only after stage() commits. Replay pending pages
// into the idempotent Inbox importer before markDelivered(). No network calls.
export class TelegramReceiveQueue {
  constructor({ db, key, accountId, connectionId, authEpoch, maxPages = 256 }) {
    if (!Buffer.isBuffer(key) || key.length !== 32 || !accountId || !connectionId || !offset(authEpoch)
      || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 256) fail();
    this.db = db; this.key = Buffer.from(key); this.accountId = accountId; this.connectionId = connectionId; this.authEpoch = authEpoch; this.maxPages = maxPages;
    this.scope = hash(JSON.stringify([accountId, connectionId, authEpoch, hash(key)]));
    db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_queue_meta (id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, next_offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_queue_pages (start_offset INTEGER PRIMARY KEY, next_offset INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL, delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)));`);
    this.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO telegram_queue_meta VALUES(1,?,0)').run(this.scope);
      if (db.prepare('SELECT scope FROM telegram_queue_meta WHERE id=1').get().scope !== this.scope) fail();
    });
  }
  transaction(fn) {
    if (this.db.isTransaction) fail();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  nextOffset() {
    const row = this.db.prepare('SELECT * FROM telegram_queue_meta WHERE id=1').get();
    if (row?.scope !== this.scope || !offset(row.next_offset)) fail();
    return row.next_offset;
  }
  aad(start, next) { return Buffer.from(JSON.stringify([this.scope,start,next])); }
  stage(expectedOffset, page) {
    if (!offset(expectedOffset) || !page || !offset(page.nextOffset) || page.nextOffset < expectedOffset
      || !Array.isArray(page.observations) || !Array.isArray(page.skipped)
      || page.observations.length + page.skipped.length > 25) fail();
    const ids = [];
    for (const item of page.observations) {
      if (item.accountId !== this.accountId || item.connectionId !== this.connectionId || item.provider !== 'telegram'
        || typeof item.providerRevision !== 'string' || !/^\d+$/.test(item.providerRevision)) fail();
      ids.push(Number(item.providerRevision));
    }
    for (const item of page.skipped) {
      if (!['outside_selected_chats','unsupported_content'].includes(item.reason)) fail();
      ids.push(item.updateId);
    }
    if (ids.some(id => !offset(id) || id < expectedOffset || id >= page.nextOffset)
      || new Set(ids).size !== ids.length || (ids.length ? Math.max(...ids) + 1 !== page.nextOffset : page.nextOffset !== expectedOffset)) fail();
    const plaintext = JSON.stringify(page);
    if (Buffer.byteLength(plaintext) > 262144) fail();
    const fingerprint = hash(plaintext);
    return this.transaction(() => {
      const current = this.nextOffset();
      if (!ids.length) { if (current !== expectedOffset) fail(); return {nextOffset:current,duplicate:false}; }
      const prior = this.db.prepare('SELECT * FROM telegram_queue_pages WHERE start_offset=?').get(expectedOffset);
      if (prior) { if (prior.fingerprint !== fingerprint) fail(); return {nextOffset:current,duplicate:true}; }
      if (current !== expectedOffset || this.db.prepare('SELECT count(*) n FROM telegram_queue_pages').get().n >= this.maxPages) fail();
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,nonce);
      cipher.setAAD(this.aad(expectedOffset,page.nextOffset));
      const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
      this.db.prepare('INSERT INTO telegram_queue_pages(start_offset,next_offset,fingerprint,nonce,ciphertext,tag) VALUES(?,?,?,?,?,?)')
        .run(expectedOffset,page.nextOffset,fingerprint,nonce,ciphertext,cipher.getAuthTag());
      this.db.prepare('UPDATE telegram_queue_meta SET next_offset=? WHERE id=1').run(page.nextOffset);
      return {nextOffset:page.nextOffset,duplicate:false};
    });
  }
  pending() {
    this.nextOffset();
    return this.db.prepare('SELECT * FROM telegram_queue_pages WHERE delivered=0 ORDER BY start_offset').all().map(row => {
      try {
        const decipher = createDecipheriv('aes-256-gcm',this.key,row.nonce);
        decipher.setAAD(this.aad(row.start_offset,row.next_offset)); decipher.setAuthTag(row.tag);
        const plaintext = Buffer.concat([decipher.update(row.ciphertext),decipher.final()]).toString('utf8');
        if (hash(plaintext) !== row.fingerprint) fail();
        return {startOffset:row.start_offset,fingerprint:row.fingerprint,page:JSON.parse(plaintext)};
      } catch { fail(); }
    });
  }
  // Host must call only after its separate durable Inbox transaction succeeds.
  // A crash between Inbox commit and this marker replays safely, not loses data.
  markDelivered(startOffset, fingerprint) {
    return this.transaction(() => {
      this.nextOffset();
      const row = this.db.prepare('SELECT * FROM telegram_queue_pages WHERE start_offset=?').get(startOffset);
      if (!row || row.fingerprint !== fingerprint) fail();
      this.db.prepare('UPDATE telegram_queue_pages SET delivered=1 WHERE start_offset=?').run(startOffset);
    });
  }
}
