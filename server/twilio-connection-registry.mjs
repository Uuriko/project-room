import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const revision = v => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER - 1;
const fail = () => { throw new Error('twilio_connection_unconfirmed'); };

// Host-only private database. No credentials in status, no provider calls.
// Each connection owns exactly one receiving address; a tombstone retains that
// ownership. Host must authenticate account and verify provider ownership first.
export class TwilioConnectionRegistry {
  #db; #key; #closed = false;
  constructor({db,key}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) fail();
    this.#db=db; this.#key=Buffer.from(key);
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS twilio_connections_v1 (
        account_id TEXT NOT NULL, connection_id TEXT NOT NULL, auth_epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL, account_sid TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('active','disconnected')),
        nonce BLOB, ciphertext BLOB, tag BLOB, PRIMARY KEY(account_id,connection_id));`);
  }
  close() { this.#closed=true; this.#key.fill(0); }
  #binding(b) { if(this.#closed || !b || !id(b.accountId) || !id(b.connectionId) || !revision(b.authEpoch)) fail(); }
  #row(b) { return this.#db.prepare('SELECT * FROM twilio_connections_v1 WHERE account_id=? AND connection_id=?').get(b.accountId,b.connectionId); }
  #aad(r) { return Buffer.from(JSON.stringify(['twilio-connection-v1',r.account_id,r.connection_id,r.auth_epoch,r.revision,r.account_sid,r.address])); }
  #transaction(fn) {
    if(this.#closed || this.#db.isTransaction) fail();
    this.#db.exec('BEGIN IMMEDIATE');
    try { const r=fn(); if(r && typeof r.then==='function') fail(); this.#db.exec('COMMIT'); return r; }
    catch { this.#db.exec('ROLLBACK'); fail(); }
  }
  status(b) {
    this.#binding(b);const r=this.#row(b);
    return r ? {state:r.auth_epoch===b.authEpoch?r.state:'reauthorize',revision:r.revision} : {state:'missing',revision:0};
  }
  configure(b) {
    this.#binding(b);
    if(!revision(b.expectedRevision) || !/^AC[a-f0-9]{32}$/.test(b.accountSid)
      || typeof b.address!=='string' || !/^(?:whatsapp:)?\+[1-9][0-9]{6,14}$/.test(b.address)
      || typeof b.authToken!=='string' || !b.authToken || b.authToken.length>256
      || typeof b.webhookUrl!=='string' || b.webhookUrl.length>2048) fail();
    try {const url=new URL(b.webhookUrl);if(url.protocol!=='https:'||url.username||url.password||url.hash)fail();} catch {fail();}
    return this.#transaction(()=>{
      const old=this.#row(b);
      if((old?.revision??0)!==b.expectedRevision || old && (old.account_sid!==b.accountSid || old.address!==b.address || old.auth_epoch>b.authEpoch)) fail();
      const r={account_id:b.accountId,connection_id:b.connectionId,auth_epoch:b.authEpoch,
        revision:b.expectedRevision+1,account_sid:b.accountSid,address:b.address};
      const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.#key,nonce);cipher.setAAD(this.#aad(r));
      const ciphertext=Buffer.concat([cipher.update(JSON.stringify({authToken:b.authToken,webhookUrl:b.webhookUrl})),cipher.final()]);
      this.#db.prepare(`INSERT INTO twilio_connections_v1 VALUES(?,?,?,?,?,?,'active',?,?,?)
        ON CONFLICT(account_id,connection_id) DO UPDATE SET auth_epoch=excluded.auth_epoch,revision=excluded.revision,
        state='active',nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag`)
        .run(r.account_id,r.connection_id,r.auth_epoch,r.revision,r.account_sid,r.address,nonce,ciphertext,cipher.getAuthTag());
      return {state:'active',revision:r.revision};
    });
  }
  withGrant(b,fn) {
    this.#binding(b);if(!revision(b.expectedRevision) || typeof fn!=='function')fail();
    return this.#transaction(()=>{
      const r=this.#row(b);
      if(!r || r.state!=='active' || r.auth_epoch!==b.authEpoch || r.revision!==b.expectedRevision)fail();
      const decipher=createDecipheriv('aes-256-gcm',this.#key,r.nonce);decipher.setAAD(this.#aad(r));decipher.setAuthTag(r.tag);
      const secret=JSON.parse(Buffer.concat([decipher.update(r.ciphertext),decipher.final()]).toString('utf8'));
      return fn({active:true,accountId:b.accountId,connectionId:b.connectionId,authEpoch:b.authEpoch,revision:r.revision,
        accountSid:r.account_sid,addresses:[r.address],authToken:secret.authToken,webhookUrl:secret.webhookUrl});
    });
  }
  disconnect(b) {
    this.#binding(b);if(!revision(b.expectedRevision))fail();
    return this.#transaction(()=>{
      const r=this.#row(b);if(!r || r.auth_epoch!==b.authEpoch || r.revision!==b.expectedRevision)fail();
      this.#db.prepare("UPDATE twilio_connections_v1 SET revision=revision+1,state='disconnected',nonce=NULL,ciphertext=NULL,tag=NULL WHERE account_id=? AND connection_id=?")
        .run(b.accountId,b.connectionId);
      return {state:'disconnected',revision:b.expectedRevision+1};
    });
  }
}
