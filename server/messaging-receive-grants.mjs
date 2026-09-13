const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const revision=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
const fail=()=>{throw new Error('receive_grant_unconfirmed');};
const providers=['telegram','sms','whatsapp'];
export const MAX_RECEIVE_GRANT_MS=30*86400000;

// Host-only authority, NOT a bearer token or an account session. Private metadata
// DB owned by the host, with no message bodies or provider credentials. No live
// runtime uses this yet. Provider registry locks must additionally pin the exact
// connection revision through receive/import; this class cannot verify providers.
export class MessagingReceiveGrants {
  #db; #store; #closed=false;
  constructor({db,store}) {
    this.#db=db;this.#store=store;
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS messaging_receive_grants_v1 (
        account_id TEXT NOT NULL, connection_id TEXT NOT NULL, revision INTEGER NOT NULL,
        auth_epoch INTEGER NOT NULL, provider TEXT NOT NULL, connection_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','revoked')), expires_at INTEGER NOT NULL,
        at INTEGER NOT NULL, actor_session_revision INTEGER NOT NULL,
        PRIMARY KEY(account_id,connection_id,revision));`);
  }
  close(){this.#closed=true;}
  #transaction(fn){
    if(this.#closed||this.#db.isTransaction||this.#store.db.isTransaction)fail();
    let began=false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');began=true;
      const result=this.#store.transaction(()=>{
        const value=fn();if(value&&typeof value.then==='function')fail();return value;
      });
      this.#db.exec('COMMIT');return result;
    }catch{if(began)this.#db.exec('ROLLBACK');fail();}
  }
  #auth(session){
    if(!exact(session,['token','binding'])||typeof session.binding!=='string'||!/^[a-f0-9]{64}$/.test(session.binding))fail();
    return this.#store.authenticateAccountSession(session.token,null,session.binding);
  }
  #row(accountId,connectionId){
    return this.#db.prepare('SELECT * FROM messaging_receive_grants_v1 WHERE account_id=? AND connection_id=? ORDER BY revision DESC LIMIT 1').get(accountId,connectionId);
  }
  #view(r){return Object.freeze({accountId:r.account_id,connectionId:r.connection_id,revision:r.revision,
    authEpoch:r.auth_epoch,provider:r.provider,connectionRevision:r.connection_revision,
    state:r.state,expiresAt:r.expires_at});}
  #append(r){this.#db.prepare('INSERT INTO messaging_receive_grants_v1 VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(r.account_id,r.connection_id,r.revision,r.auth_epoch,r.provider,r.connection_revision,r.state,r.expires_at,r.at,r.actor_session_revision);return this.#view(r);}
  issue(session,request){
    if(!exact(request,['connectionId','provider','connectionRevision','expectedRevision','expiresAt'])
      ||!id(request.connectionId)||!providers.includes(request.provider)||!revision(request.connectionRevision)||request.connectionRevision<1
      ||!revision(request.expectedRevision)||!Number.isSafeInteger(request.expiresAt))fail();
    return this.#transaction(()=>{
      const auth=this.#auth(session),now=this.#store.now(),old=this.#row(auth.account.id,request.connectionId);
      if(request.expiresAt<=now||request.expiresAt>now+MAX_RECEIVE_GRANT_MS||(old?.revision??0)!==request.expectedRevision
        ||old&&old.provider!==request.provider)fail();
      const count=this.#db.prepare('SELECT count(*) n FROM messaging_receive_grants_v1 WHERE account_id=?').get(auth.account.id).n;
      const connections=this.#db.prepare('SELECT count(DISTINCT connection_id) n FROM messaging_receive_grants_v1 WHERE account_id=?').get(auth.account.id).n;
      if(count>=5000||!old&&connections>=100)fail();
      return this.#append({account_id:auth.account.id,connection_id:request.connectionId,revision:request.expectedRevision+1,
        auth_epoch:auth.account.authEpoch,provider:request.provider,connection_revision:request.connectionRevision,
        state:'active',expires_at:request.expiresAt,at:now,actor_session_revision:auth.sessionRevision});
    });
  }
  revoke(session,request){
    if(!exact(request,['connectionId','expectedRevision']))fail();
    const {connectionId,expectedRevision}=request;
    if(!id(connectionId)||!revision(expectedRevision))fail();
    return this.#transaction(()=>{
      const auth=this.#auth(session),r=this.#row(auth.account.id,connectionId);
      if(!r||r.revision!==expectedRevision||r.state!=='active')fail();
      return this.#append({...r,revision:r.revision+1,state:'revoked',at:this.#store.now(),actor_session_revision:auth.sessionRevision});
    });
  }
  // Synchronous receive/import only. No room reads, sends, or login-shaped auth
  // object is returned. Lock order: provider registry -> this DB -> RoomStore.
  withGrant(binding,fn){
    if(!exact(binding,['accountId','connectionId','revision','provider','connectionRevision'])||!id(binding.accountId)
      ||!id(binding.connectionId)||!revision(binding.revision)||!providers.includes(binding.provider)
      ||!revision(binding.connectionRevision)||typeof fn!=='function')fail();
    return this.#transaction(()=>{
      const check=()=>{
        const r=this.#row(binding.accountId,binding.connectionId),account=this.#store.account(binding.accountId);
        if(!r||r.state!=='active'||r.revision!==binding.revision||r.provider!==binding.provider
          ||r.connection_revision!==binding.connectionRevision||r.expires_at<=this.#store.now()
          ||!account.active||r.auth_epoch!==account.authEpoch)fail();
        return r;
      };
      const result=fn(this.#view(check()));
      if(result&&typeof result.then==='function')fail();
      check();return result;
    });
  }
}
