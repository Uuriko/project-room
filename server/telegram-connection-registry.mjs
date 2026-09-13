import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const rev = v => Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const fail = () => { throw new Error('telegram_connection_unconfirmed'); };

// Separate private SQLite DB. Host authenticates the account before every call,
// verifies bot identity with Telegram before configure, and owns DB/key security.
export class TelegramConnectionRegistry {
  #db; #key;
  constructor({db,key}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) fail();
    this.#db=db;this.#key=Buffer.from(key);
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS telegram_connections_v1 (
        account_id TEXT NOT NULL, connection_id TEXT NOT NULL, auth_epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL, bot_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('active','disconnected')),
        nonce BLOB, ciphertext BLOB, tag BLOB, PRIMARY KEY(account_id,connection_id));`);
  }
  #binding(accountId,connectionId,authEpoch) { if(!id(accountId)||!id(connectionId)||!rev(authEpoch))fail(); }
  #row(accountId,connectionId) { return this.#db.prepare('SELECT * FROM telegram_connections_v1 WHERE account_id=? AND connection_id=?').get(accountId,connectionId); }
  #aad(row) {return Buffer.from(JSON.stringify(['telegram-connection-v1',row.account_id,row.connection_id,row.auth_epoch,row.revision,row.bot_id]));}
  #transaction(fn) {
    if(this.#db.isTransaction)fail();this.#db.exec('BEGIN IMMEDIATE');
    try{const result=fn();this.#db.exec('COMMIT');return result;}catch{this.#db.exec('ROLLBACK');fail();}
  }
  status({accountId,connectionId,authEpoch}) {
    this.#binding(accountId,connectionId,authEpoch);const row=this.#row(accountId,connectionId);
    return !row?{state:'missing',revision:0}: {state:row.auth_epoch===authEpoch?row.state:'reauthorize',revision:row.revision};
  }
  configure({accountId,connectionId,authEpoch,expectedRevision,botId,token,chatIds}) {
    this.#binding(accountId,connectionId,authEpoch);
    if(!rev(expectedRevision)||typeof botId!=='string'||!/^[1-9][0-9]{0,15}$/.test(botId)
      ||!Number.isSafeInteger(Number(botId))||typeof token!=='string'||token.length>128
      ||!/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token)||token.split(':')[0]!==botId
      ||!Array.isArray(chatIds)||!chatIds.length||chatIds.length>100
      ||!chatIds.every(n=>Number.isSafeInteger(n)&&n!==0)||new Set(chatIds).size!==chatIds.length)fail();
    return this.#transaction(()=>{
      const old=this.#row(accountId,connectionId);
      if((old?.revision??0)!==expectedRevision||old&&(old.bot_id!==botId||authEpoch<old.auth_epoch))fail();
      const row={account_id:accountId,connection_id:connectionId,auth_epoch:authEpoch,revision:expectedRevision+1,bot_id:botId};
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,nonce);cipher.setAAD(this.#aad(row));
      const plaintext=JSON.stringify({token,chatIds:[...chatIds].sort((a,b)=>a-b)});
      const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
      this.#db.prepare(`INSERT INTO telegram_connections_v1 VALUES(?,?,?,?,?,'active',?,?,?)
        ON CONFLICT(account_id,connection_id) DO UPDATE SET auth_epoch=excluded.auth_epoch,revision=excluded.revision,
        state='active',nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag`)
        .run(accountId,connectionId,authEpoch,row.revision,botId,nonce,ciphertext,cipher.getAuthTag());
      return {state:'active',revision:row.revision};
    });
  }
  grant({accountId,connectionId,authEpoch}) {
    this.#binding(accountId,connectionId,authEpoch);const row=this.#row(accountId,connectionId);
    if(!row||row.state!=='active'||row.auth_epoch!==authEpoch)fail();
    try{const decipher=createDecipheriv('aes-256-gcm',this.#key,row.nonce);decipher.setAAD(this.#aad(row));decipher.setAuthTag(row.tag);
      const value=JSON.parse(Buffer.concat([decipher.update(row.ciphertext),decipher.final()]).toString('utf8'));
      return {active:true,accountId,connectionId,authEpoch,revision:row.revision,token:value.token,chatIds:value.chatIds};
    }catch{fail();}
  }
  disconnect({accountId,connectionId,authEpoch,expectedRevision}) {
    this.#binding(accountId,connectionId,authEpoch);if(!rev(expectedRevision))fail();
    return this.#transaction(()=>{
      const row=this.#row(accountId,connectionId);
      if(!row||row.revision!==expectedRevision||row.auth_epoch!==authEpoch)fail();
      this.#db.prepare("UPDATE telegram_connections_v1 SET revision=revision+1,state='disconnected',nonce=NULL,ciphertext=NULL,tag=NULL WHERE account_id=? AND connection_id=?")
        .run(accountId,connectionId);
      return {state:'disconnected',revision:expectedRevision+1};
    });
  }
  // Holds the registry write lock through a synchronous Inbox import, preventing
  // another registry handle from revoking/changing grants midway through commit.
  withGrant(binding,fn) {
    return this.#transaction(()=>{const grant=this.grant(binding),result=fn(grant);if(result&&typeof result.then==='function')fail();return result;});
  }
}
