// Durable MCP Events receipts. A webhook receipt is not proof an agent ran.
import { createHash, randomUUID } from "node:crypto";
import { eventSigningKey, verifyMcpEventCallback, deliverMcpEvent } from "./mcp-events-wire.mjs";

export const mcpEventSubscriptionsSchema = `
CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
 id TEXT PRIMARY KEY, principal TEXT NOT NULL, document TEXT NOT NULL,
 generation TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_event_outbox (
 subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, document TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER,
 PRIMARY KEY(subscription_id,event_id)
);
CREATE INDEX IF NOT EXISTS mcp_event_outbox_ready ON mcp_event_outbox(state,next_at);
`;
const HOUR = 3600000;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw Object.assign(new Error(message), { code: -32602 }); };
function principalKey(principal) {
  const fields = ["principalType", "familyId", "resource", "roomId", "identityId", "memberId"];
  if (!principal || !["account-agent", "invited-agent"].includes(principal.principalType)) fail("Invalid event principal");
  const result = {};
  for (const key of fields) {
    if (typeof principal[key] !== "string" || !principal[key] || principal[key].length > 2048) fail("Invalid event principal");
    result[key] = principal[key];
  }
  if (!Array.isArray(principal.scopes) || principal.scopes.length > 32 || principal.scopes.some(scope => typeof scope !== "string" || !/^[a-z:_-]{1,64}$/.test(scope))) fail("Invalid event grant scopes");
  result.scopes = [...new Set(principal.scopes)].sort();
  return JSON.stringify(result);
}
function thinId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("Invalid event identifier");
  return value;
}

function subscriptionIdentity(principal, name, args, delivery) {
  const key = principalKey(principal);
  if (name !== "room.requested" || !args || Object.keys(args).sort().join(",") !== "memberId,roomId" || args.roomId !== principal.roomId || args.memberId !== principal.memberId) fail("Event scope must match the authenticated agent");
  if (delivery?.mode !== "webhook") fail("Only webhook delivery is supported");
  let url;
  try { url = new URL(delivery.url); } catch { fail("Invalid callback URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("Invalid callback URL");
  const canonicalArgs = { roomId: args.roomId, memberId: args.memberId };
  return { id: `sub_${hash(JSON.stringify([key, url.href, name, canonicalArgs]))}`, url, canonicalArgs };
}

export function createMcpEventSubscriptions({ store, authorize, transport, dnsResolvers, now = () => store.now(), ttlMs = HOUR }) {
  if (typeof authorize !== "function" || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * HOUR) throw new TypeError("Invalid event configuration");
  const db = store.db;
  db.exec(mcpEventSubscriptionsSchema);
  const sweep = () => {
    db.prepare("DELETE FROM mcp_event_subscriptions WHERE id IN (SELECT id FROM mcp_event_subscriptions WHERE expires_at<=? LIMIT 100)").run(now());
    db.prepare("DELETE FROM mcp_event_outbox WHERE rowid IN (SELECT rowid FROM mcp_event_outbox WHERE subscription_id NOT IN (SELECT id FROM mcp_event_subscriptions) OR (state IN ('delivered','dead') AND next_at<?) LIMIT 200)").run(now() - 24 * HOUR);
  };
  const get = id => db.prepare("SELECT * FROM mcp_event_subscriptions WHERE id=?").get(id);
  const live = async row => {
    if (!row || row.state !== "active" || row.expires_at <= now()) return false;
    return Boolean(await authorize(JSON.parse(row.principal)));
  };
  async function subscribe({ principal, name, arguments: args, delivery, cursor = null, ttlMs: requestedTtl }) {
    sweep();
    const key = principalKey(principal);
    if (cursor !== null) fail("Event replay is not supported");
    const { id, url, canonicalArgs } = subscriptionIdentity(principal, name, args, delivery);
    eventSigningKey(delivery.secret);
    if (!await authorize(JSON.parse(key))) throw Object.assign(new Error("Event grant denied"), { code: -32001 });
    if (!get(id) && db.prepare("SELECT count(*) AS n FROM mcp_event_subscriptions WHERE principal=?").get(key).n >= 20) fail("Event subscription limit exceeded");
    const old = get(id), previous = old && JSON.parse(old.document);
    const generation = randomUUID();
    if (requestedTtl !== undefined && requestedTtl !== null && (!Number.isSafeInteger(requestedTtl) || requestedTtl < 0)) fail("Invalid subscription ttlMs");
    const expiresAt = now() + (requestedTtl == null ? ttlMs : Math.max(1000, Math.min(ttlMs, requestedTtl)));
    const document = { id, name, arguments: canonicalArgs, url: url.href, secret: delivery.secret, expiresAt };
    if (old?.state === "active" && old.expires_at > now() && previous.secret !== delivery.secret) {
      document.previousSecret = previous.secret;
      document.previousSecretExpiresAt = Math.min(now() + 60000, old.expires_at);
    } else if (previous?.secret === delivery.secret && previous.previousSecretExpiresAt > now()) {
      document.previousSecret = previous.previousSecret;
      document.previousSecretExpiresAt = previous.previousSecretExpiresAt;
    }
    db.prepare(`INSERT INTO mcp_event_subscriptions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,generation=excluded.generation,state=excluded.state,expires_at=excluded.expires_at`).run(id, key, JSON.stringify(document), generation, "verifying", expiresAt);
    try {
      // A short persisted cache avoids repeated challenges on refresh. A new
      // signing key always proves callback ownership again before activation.
      const cached = old?.state === "active" && old.expires_at > now()
        && previous.secret === delivery.secret && Number.isSafeInteger(previous.verifiedAt)
        && previous.verifiedAt <= now() && now() - previous.verifiedAt < 60000;
      if (!cached) await verifyMcpEventCallback({ subscriptionId: id, secret: delivery.secret, url: url.href, transport, dnsResolvers, now: now() });
      document.verifiedAt = cached ? previous.verifiedAt : now();
      if (!await authorize(JSON.parse(key)) || now() >= expiresAt) throw new Error("Event grant expired during verification");
      const result = db.prepare("UPDATE mcp_event_subscriptions SET state='active',document=? WHERE id=? AND generation=? AND state='verifying'").run(JSON.stringify(document), id, generation);
      if (!result.changes) throw new Error("Event subscription superseded");
    } catch (error) {
      db.prepare("UPDATE mcp_event_subscriptions SET state='inactive',document='{}' WHERE id=? AND generation=?").run(id, generation);
      throw error;
    }
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }
  function unsubscribe({ principal, id, name, arguments: args, delivery }) {
    const key = principalKey(principal);
    if (id === undefined) id = subscriptionIdentity(principal, name, args, delivery).id;
    if (typeof id !== "string" || id.length > 128) fail("Invalid subscription id");
    // Tombstones fence challenge completion and in-flight delivery acknowledgements.
    db.prepare("UPDATE mcp_event_subscriptions SET state='inactive',document='{}',generation=? WHERE id=? AND principal=?").run(randomUUID(), id, key);
    db.prepare("UPDATE mcp_event_outbox SET state='dead',lease=NULL WHERE subscription_id=? AND EXISTS (SELECT 1 FROM mcp_event_subscriptions WHERE id=? AND principal=? AND state='inactive')").run(id, id, key);
    return {};
  }
  // Call inside the same transaction that commits the durable Room wake signal.
  function enqueueRequested({ roomId, memberId, requestId, messageId, eventId, timestamp = new Date(now()).toISOString() }) {
    const data = { roomId: thinId(roomId), memberId: thinId(memberId) };
    if (requestId !== undefined) data.requestId = thinId(requestId);
    if (messageId !== undefined) data.messageId = thinId(messageId);
    const event = { eventId: thinId(eventId), name: "room.requested", timestamp, data, cursor: null };
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) fail("Invalid event time");
    let queued = 0;
    for (const row of db.prepare("SELECT * FROM mcp_event_subscriptions WHERE state='active' AND expires_at>?").all(now())) {
      const sub = JSON.parse(row.document);
      if (sub.arguments.roomId !== roomId || sub.arguments.memberId !== memberId) continue;
      if (db.prepare("SELECT 1 FROM mcp_event_outbox WHERE subscription_id=? AND event_id=?").get(row.id, eventId)) continue;
      if (db.prepare("SELECT count(*) AS n FROM mcp_event_outbox WHERE subscription_id=? AND state IN ('pending','leased')").get(row.id).n >= 1000) throw new Error("Event outbox capacity exceeded");
      queued += Number(db.prepare("INSERT OR IGNORE INTO mcp_event_outbox(subscription_id,event_id,document,next_at) VALUES(?,?,?,?)").run(row.id, eventId, JSON.stringify(event), now()).changes);
    }
    return queued;
  }
  async function drain({ limit = 10 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("Invalid event delivery limit");
    sweep();
    const results = [];
    for (let index = 0; index < limit; index++) {
      const job = store.transaction(() => {
        const row = db.prepare("SELECT * FROM mcp_event_outbox WHERE (state='pending' AND next_at<=?) OR (state='leased' AND lease_until<=?) ORDER BY next_at LIMIT 1").get(now(), now());
        if (!row) return null;
        row.lease = randomUUID();
        db.prepare("UPDATE mcp_event_outbox SET state='leased',lease=?,lease_until=?,attempts=attempts+1 WHERE subscription_id=? AND event_id=?").run(row.lease, now() + 30000, row.subscription_id, row.event_id);
        row.attempts++;
        return row;
      });
      if (!job) break;
      const row = get(job.subscription_id);
      let result;
      try {
        result = !await live(row) ? { classification: "revoked" } : await deliverMcpEvent({
          subscription: JSON.parse(row.document), event: JSON.parse(job.document), transport, dnsResolvers, now: now(),
          authorize: async () => {
            const current = get(row.id);
            if (current?.generation !== row.generation || !await live(current)) return false;
            // A paused worker must not send after another worker reclaimed its lease.
            const lease = db.prepare("SELECT lease,lease_until,state FROM mcp_event_outbox WHERE subscription_id=? AND event_id=?").get(job.subscription_id, job.event_id);
            return lease?.state === "leased" && lease.lease === job.lease && lease.lease_until > now();
          },
        });
      } catch { result = { classification: "retry" }; }
      const retry = result.classification === "retry" && job.attempts < 8 && row?.expires_at > now();
      const state = result.classification === "delivered" ? "delivered" : retry ? "pending" : "dead";
      db.prepare("UPDATE mcp_event_outbox SET state=?,next_at=?,lease=NULL,lease_until=NULL WHERE subscription_id=? AND event_id=? AND lease=?").run(state, now() + Math.min(60000, 1000 * 2 ** job.attempts), job.subscription_id, job.event_id, job.lease);
      results.push({ eventId: job.event_id, subscriptionId: job.subscription_id, classification: result.classification });
    }
    return results;
  }
  return { subscribe, unsubscribe, enqueueRequested, drain };
}
