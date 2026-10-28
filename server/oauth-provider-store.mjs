// Durable OAuth provider state. Tokens are stored as SHA-256 hashes only.
// Tables are created on first use, not during Durable Object construction.
export const OAUTH_PROVIDER_TABLES = Object.freeze([
  "oauth_provider_clients",
  "oauth_provider_codes",
  "oauth_provider_access_tokens",
  "oauth_provider_refresh_tokens",
]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oauth_provider_clients (
    client_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS oauth_provider_clients_expires ON oauth_provider_clients(expires_at);

  CREATE TABLE IF NOT EXISTS oauth_provider_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL CHECK(used IN (0,1)),
    -- O1 (issue #941): the token family minted from this code, so a
    -- replayed code revokes its tokens (RFC 6749 §10.5).
    family_id TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_provider_codes_expires ON oauth_provider_codes(expires_at);

  CREATE TABLE IF NOT EXISTS oauth_provider_access_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    family_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_provider_access_tokens_expires ON oauth_provider_access_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS oauth_provider_access_tokens_family ON oauth_provider_access_tokens(family_id);
  CREATE INDEX IF NOT EXISTS oauth_provider_access_tokens_user ON oauth_provider_access_tokens(user_id);

  CREATE TABLE IF NOT EXISTS oauth_provider_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    family_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
    rotated_by TEXT,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_provider_refresh_tokens_expires ON oauth_provider_refresh_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS oauth_provider_refresh_tokens_family ON oauth_provider_refresh_tokens(family_id);
  CREATE INDEX IF NOT EXISTS oauth_provider_refresh_tokens_user ON oauth_provider_refresh_tokens(user_id);
`;

const ready = new WeakSet();

export function oauthProviderTablesPresent(db) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='oauth_provider_clients'"
  ).get());
}

export function ensureOAuthProviderSchema(db) {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  // O1 (issue #941): databases created before the family_id column existed
  // gain it idempotently. CREATE TABLE IF NOT EXISTS alone cannot evolve
  // the table, and the column is nullable so old rows stay valid.
  const columns = db.prepare("PRAGMA table_info(oauth_provider_codes)").all().map(column => column.name);
  if (!columns.includes("family_id")) db.exec("ALTER TABLE oauth_provider_codes ADD COLUMN family_id TEXT");
  ready.add(db);
}

const PRUNE = Object.freeze([
  ["oauth_provider_clients", "client_id"],
  ["oauth_provider_codes", "code_hash"],
  ["oauth_provider_access_tokens", "token_hash"],
  ["oauth_provider_refresh_tokens", "token_hash"],
]);

// Bounded delete of expired rows. Does not create the tables: a cron tick
// on a room that has never issued a token stays a no-op.
export function pruneOAuthProvider(db, { now, limit = 100 } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("pruneOAuthProvider requires a timestamp and a positive limit");
  }
  if (!oauthProviderTablesPresent(db)) return { pruned: 0 };
  let pruned = 0;
  for (const [table, key] of PRUNE) {
    const result = db.prepare(
      `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires_at <= ? LIMIT ?)`
    ).run(now, limit);
    pruned += result.changes ?? 0;
  }
  return { pruned };
}

const watch = (record, save) => new Proxy(record, {
  set(target, prop, value) {
    target[prop] = value;
    save(target);
    return true;
  }
});

const scopesOf = json => JSON.parse(json);
const flag = value => value ? 1 : 0;

export function createOAuthProviderSqlite(db) {
  const touch = () => ensureOAuthProviderSchema(db);
  const saveClient = row => db.prepare(
    `INSERT INTO oauth_provider_clients(client_id,name,redirect_uris_json,expires_at)
     VALUES(?,?,?,?)
     ON CONFLICT(client_id) DO UPDATE SET
       name=excluded.name, redirect_uris_json=excluded.redirect_uris_json, expires_at=excluded.expires_at`
  ).run(row.clientId, row.name, JSON.stringify(row.redirectUris), row.expiresAt);
  const saveCode = row => db.prepare(
    `INSERT INTO oauth_provider_codes(code_hash,client_id,user_id,redirect_uri,scopes_json,code_challenge,created_at,expires_at,used,family_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code_hash) DO UPDATE SET used=excluded.used, family_id=excluded.family_id`
  ).run(row.codeHash, row.clientId, row.userId, row.redirectUri, JSON.stringify(row.scopes),
    row.codeChallenge, row.createdAt, row.expiresAt, flag(row.used), row.familyId ?? null);
  const saveAccess = row => db.prepare(
    `INSERT INTO oauth_provider_access_tokens(token_hash,client_id,user_id,scopes_json,family_id,created_at,expires_at,revoked,ip,user_agent)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(token_hash) DO UPDATE SET revoked=excluded.revoked`
  ).run(row.tokenHash, row.clientId, row.userId, JSON.stringify(row.scopes), row.familyId,
    row.createdAt, row.expiresAt, flag(row.revoked), row.ip ?? null, row.userAgent ?? null);
  const saveRefresh = row => db.prepare(
    `INSERT INTO oauth_provider_refresh_tokens(token_hash,client_id,user_id,scopes_json,family_id,created_at,expires_at,revoked,rotated_by,ip,user_agent)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(token_hash) DO UPDATE SET revoked=excluded.revoked, rotated_by=excluded.rotated_by`
  ).run(row.tokenHash, row.clientId, row.userId, JSON.stringify(row.scopes), row.familyId,
    row.createdAt, row.expiresAt, flag(row.revoked), row.rotatedBy ?? null, row.ip ?? null, row.userAgent ?? null);

  const clients = {
    get(clientId) {
      touch();
      const row = db.prepare("SELECT * FROM oauth_provider_clients WHERE client_id=?").get(clientId);
      if (!row) return undefined;
      return watch({
        clientId: row.client_id, name: row.name, redirectUris: scopesOf(row.redirect_uris_json), expiresAt: row.expires_at
      }, saveClient);
    },
    set(_clientId, record) { touch(); saveClient(record); return this; },
    delete(clientId) { touch(); db.prepare("DELETE FROM oauth_provider_clients WHERE client_id=?").run(clientId); }
  };
  const codes = {
    get(codeHash) {
      touch();
      const row = db.prepare("SELECT * FROM oauth_provider_codes WHERE code_hash=?").get(codeHash);
      if (!row) return undefined;
      return watch({
        codeHash: row.code_hash, clientId: row.client_id, userId: row.user_id, redirectUri: row.redirect_uri,
        scopes: scopesOf(row.scopes_json), codeChallenge: row.code_challenge, createdAt: row.created_at,
        expiresAt: row.expires_at, used: row.used === 1, familyId: row.family_id ?? null
      }, saveCode);
    },
    set(_codeHash, record) { touch(); saveCode(record); return this; },
    delete(codeHash) { touch(); db.prepare("DELETE FROM oauth_provider_codes WHERE code_hash=?").run(codeHash); }
  };
  const accessTokens = {
    get(tokenHash) {
      touch();
      const row = db.prepare("SELECT * FROM oauth_provider_access_tokens WHERE token_hash=?").get(tokenHash);
      if (!row) return undefined;
      return watch({
        tokenHash: row.token_hash, clientId: row.client_id, userId: row.user_id, scopes: scopesOf(row.scopes_json),
        familyId: row.family_id, createdAt: row.created_at, expiresAt: row.expires_at, revoked: row.revoked === 1,
        ip: row.ip ?? null, userAgent: row.user_agent ?? null
      }, saveAccess);
    },
    set(_tokenHash, record) { touch(); saveAccess(record); return this; },
    delete(tokenHash) { touch(); db.prepare("DELETE FROM oauth_provider_access_tokens WHERE token_hash=?").run(tokenHash); },
    values() {
      touch();
      return db.prepare("SELECT token_hash FROM oauth_provider_access_tokens").all()
        .map(row => accessTokens.get(row.token_hash));
    }
  };
  const refreshTokens = {
    get(tokenHash) {
      touch();
      const row = db.prepare("SELECT * FROM oauth_provider_refresh_tokens WHERE token_hash=?").get(tokenHash);
      if (!row) return undefined;
      return watch({
        tokenHash: row.token_hash, clientId: row.client_id, userId: row.user_id, scopes: scopesOf(row.scopes_json),
        familyId: row.family_id, createdAt: row.created_at, expiresAt: row.expires_at, revoked: row.revoked === 1,
        rotatedBy: row.rotated_by ?? null, ip: row.ip ?? null, userAgent: row.user_agent ?? null
      }, saveRefresh);
    },
    set(_tokenHash, record) { touch(); saveRefresh(record); return this; },
    delete(tokenHash) { touch(); db.prepare("DELETE FROM oauth_provider_refresh_tokens WHERE token_hash=?").run(tokenHash); },
    values() {
      touch();
      return db.prepare("SELECT token_hash FROM oauth_provider_refresh_tokens").all()
        .map(row => refreshTokens.get(row.token_hash));
    }
  };
  return { clients, codes, accessTokens, refreshTokens, prune: (now, limit) => pruneOAuthProvider(db, { now, limit }) };
}
