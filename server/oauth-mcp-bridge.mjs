// OAuth bearer -> Room account bridge for the ChatGPT app (/mcp/chatgpt).
//
// Room's own OAuth server mints oat_ access tokens for an account. The room
// MCP profile authenticates identities, so a valid token is mapped to one
// bridge identity per account whose room links point at that account's own
// human member in every room it belongs to. Tool calls then run with the
// account's normal member permissions, on the existing room path.
//
// A token is accepted only when it is live (not expired, not revoked, account
// active), was minted for this resource (RFC 8707 audience) and carries every
// scope the tool asks for. The bridge credential is derived per account from
// a server-held key and never leaves the server.

import { createHmac, randomBytes } from "node:crypto";

const base64url = buffer => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const normalize = value => typeof value === "string" ? value.replace(/\/$/, "") : null;

function bridgeKey(db) {
  db.exec("CREATE TABLE IF NOT EXISTS oauth_mcp_bridge_key (id INTEGER PRIMARY KEY CHECK(id = 1), key TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO oauth_mcp_bridge_key(id,key) VALUES(1,?)").run(base64url(randomBytes(32)));
  return db.prepare("SELECT key FROM oauth_mcp_bridge_key WHERE id=1").get().key;
}

export function createOAuthMcpBridge({ oauthProvider, store, audiences }) {
  let key = null;
  const allowed = () => new Set((typeof audiences === "function" ? audiences() : audiences ?? []).map(normalize));

  const verify = token => {
    if (typeof token !== "string" || !token.startsWith("oat_")) return null;
    let grant;
    try { grant = oauthProvider.verifyAccessToken(token); } catch { return null; }
    if (!grant) return null; // unknown, expired, revoked or inactive account
    if (!grant.resource || !allowed().has(normalize(grant.resource))) return null; // wrong audience
    return grant;
  };

  const ensureIdentity = accountId => {
    key ??= bridgeKey(store.db);
    const secret = `pri_${base64url(createHmac("sha256", key).update(`oauth-mcp:${accountId}`).digest())}`;
    const made = store.identities.create("Room account (OAuth)", { secret });
    const identityId = made.identityId;
    const now = store.now();
    // Link the bridge identity to the account's own human member in each
    // room, so it acts with exactly that member's permissions.
    const rows = store.db.prepare("SELECT room_id AS roomId, member_id AS memberId FROM member_accounts WHERE account_id=?").all(accountId);
    const link = store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?) ON CONFLICT(room_id,identity_id) DO UPDATE SET member_id=excluded.member_id");
    for (const row of rows) link.run(row.roomId, identityId, row.memberId, now);
    return secret;
  };

  // Returns an Authorization header for the room profile, or null.
  return function resolveOAuthBearer(token, { requiredScopes = [] } = {}) {
    if (!store?.db || !store.identities || typeof oauthProvider?.verifyAccessToken !== "function") return null;
    const grant = verify(token);
    if (!grant) return null;
    if (!requiredScopes.every(scope => grant.scopes.includes(scope))) return null;
    try { return `Bearer ${ensureIdentity(grant.userId)}`; } catch { return null; }
  };
}
