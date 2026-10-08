// Inbound channel webhooks (missing-features #7).
//
// Third parties cannot POST a message into a room from a URL today —
// Discord's lowest-friction integration. This module is the server side of
// per-room inbound webhooks: a room owner creates one, gets a URL and a
// signing secret (shown once), and the third party POSTs JSON to the URL
// with an HMAC-SHA256 signature of the raw request body.
//
// Security posture (fail closed):
// - Every delivery is authenticated by the signature. Missing, malformed,
//   or mismatching signatures are rejected; the comparison is timing-safe.
// - The server never fetches attacker-controlled URLs. Card media URLs are
//   validated as https (private/reserved hosts refused) and render
//   client-side only — there is no server-side fetch to SSRF.
// - Webhook records (signing secret + server-held posting token) live in
//   the inbound_webhooks table next to agent_webhook_subs.secret — the
//   database is the trust boundary. List views never carry secrets.
// - Delivery is rate-limited per webhook in the HTTP layer.
//
// Pure-ish module: lifecycle state is a caller-owned Map, optionally
// write-through to a better-sqlite3 db (CREATE TABLE IF NOT EXISTS +
// hydrate on construction). Tests use the Map flavor; production passes
// the store's db.
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { InboundWebhookError, validateMessageCard } from "../src/message-cards.js";

const fail = (code, message) => { throw new InboundWebhookError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_webhook", message); };

const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 80;
const SECRET_BYTES = 32;
const MAX_DELIVER_BYTES = 65536;
const TEXT_MAX = 4000;

export const inboundWebhooksSchema = `
  CREATE TABLE IF NOT EXISTS inbound_webhooks (
    webhook_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    name TEXT NOT NULL,
    secret TEXT NOT NULL,
    post_token TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS inbound_webhooks_room ON inbound_webhooks(room_id);
`;
// Back-compat alias for the earlier name.
export const INBOUND_WEBHOOKS_SCHEMA = inboundWebhooksSchema;

// Sign the raw request body. The signature covers bytes, not parsed JSON,
// so no canonicalization can be smuggled past verification.
export function signBody(secret, rawBody) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new InboundWebhookError("invalid_webhook", "secret is required");
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? "");
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// Verify the X-Signature-256 header against the raw body. Fail closed:
// anything missing or malformed is false, and the comparison is
// timing-safe. Returns a boolean, never throws.
export function verifySignatureHeader(secret, headerValue, rawBody) {
  try {
    if (typeof secret !== "string" || secret.length === 0) return false;
    if (typeof headerValue !== "string") return false;
    const match = /^sha256=([0-9a-fA-F]{64})$/.exec(headerValue.trim());
    if (!match) return false;
    const expected = Buffer.from(createHmac("sha256", secret)
      .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? "")).digest("hex"), "utf8");
    const actual = Buffer.from(match[1].toLowerCase(), "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// Validate and normalize a delivery payload. Returns { text, card? }.
// Throws InboundWebhookError on anything malformed — unknown top-level
// fields included.
export function parseDeliverPayload(rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? "");
  if (body.length === 0) fail("invalid_payload", "empty body");
  if (body.length > MAX_DELIVER_BYTES) fail("payload_too_large", `body must be at most ${MAX_DELIVER_BYTES} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    fail("invalid_payload", "body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("invalid_payload", "body must be a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "text" && key !== "card") fail("invalid_payload", `unexpected field: ${key}`);
  }
  const text = parsed.text;
  if (typeof text !== "string" || text.length === 0) fail("invalid_payload", "text is required");
  if (text.length > TEXT_MAX) fail("invalid_payload", `text must be at most ${TEXT_MAX} characters`);
  const out = { text };
  if (parsed.card !== undefined) out.card = validateMessageCard(parsed.card);
  return out;
}

export function createInboundWebhooks({ store = null, clock = Date.now,
    randomId = null, randomSecret = null } = {}) {
  check(store === null || store instanceof Map, "store must be a Map if given");
  const hooks = store ?? new Map();
  const now = clock;
  const newId = randomId ?? (() => `wh_${randomBytes(12).toString("hex")}`);
  const newSecret = randomSecret ?? (() => randomBytes(SECRET_BYTES).toString("hex"));
  // Durable write-through, attached after the store's schema pass (the DDL
  // lives in inboundWebhooksSchema and is applied by the RoomStore, like
  // agentPluginSchema — never here, so a fresh database still reads as
  // schema-less at the version check).
  let persist = null;

  // Attach a better-sqlite3 database: prepares the write-through statements
  // and hydrates the in-memory Map. Called once by the RoomStore after it
  // applies inboundWebhooksSchema.
  const load = db => {
    check(!persist, "database already attached");
    check(db && typeof db.prepare === "function", "db must be a better-sqlite3 database");
    persist = {
      insert: db.prepare("INSERT INTO inbound_webhooks(webhook_id,room_id,member_id,name,secret,post_token,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)"),
      updateEnabled: db.prepare("UPDATE inbound_webhooks SET enabled=? WHERE webhook_id=?"),
      updateToken: db.prepare("UPDATE inbound_webhooks SET post_token=? WHERE webhook_id=?"),
      remove: db.prepare("DELETE FROM inbound_webhooks WHERE webhook_id=?"),
    };
    for (const row of db.prepare("SELECT * FROM inbound_webhooks").all()) {
      hooks.set(row.webhook_id, {
        webhookId: row.webhook_id, roomId: row.room_id, memberId: row.member_id,
        name: row.name, secret: row.secret, postToken: row.post_token,
        enabled: row.enabled === 1, createdAt: row.created_at,
      });
    }
    return hooks.size;
  };

  const view = hook => Object.freeze({
    webhookId: hook.webhookId, roomId: hook.roomId, memberId: hook.memberId,
    name: hook.name, enabled: hook.enabled, createdAt: hook.createdAt,
  });

  // Create a webhook record. The member must already exist (the HTTP layer
  // adds the webhook's agent member first); postToken is the server-held
  // access token used to post deliveries. Returns the record including the
  // signing secret — shown once, never returned again.
  const create = ({ roomId, memberId, name, postToken }) => {
    check(typeof roomId === "string" && roomId.length > 0 && roomId.length <= 384, "roomId is required");
    check(typeof memberId === "string" && memberId.length > 0, "memberId is required");
    check(typeof name === "string" && name.trim().length > 0 && name.length <= NAME_MAX,
      `name must be 1-${NAME_MAX} characters`);
    check(typeof postToken === "string" && postToken.length > 0, "postToken is required");
    const webhookId = newId();
    check(WEBHOOK_ID_PATTERN.test(webhookId), "webhookId is invalid");
    check(!hooks.has(webhookId), `webhook "${webhookId}" already exists`);
    const secret = newSecret();
    check(typeof secret === "string" && secret.length >= SECRET_BYTES, "secret must carry enough entropy");
    const hook = { webhookId, roomId, memberId, name: name.trim(), secret, postToken,
      enabled: true, createdAt: now() };
    hooks.set(webhookId, hook);
    persist?.insert.run(webhookId, roomId, memberId, hook.name, secret, postToken, 1, hook.createdAt);
    return Object.freeze({ ...view(hook), secret });
  };

  // Server-only accessor for the deliver path: resolves the signing secret
  // and posting token. Unknown or disabled webhooks fail closed.
  const getForDelivery = webhookId => {
    check(typeof webhookId === "string" && WEBHOOK_ID_PATTERN.test(webhookId), "webhookId is invalid");
    const hook = hooks.get(webhookId);
    if (!hook || !hook.enabled) fail("unknown_webhook", "unknown or disabled webhook");
    return hook;
  };

  const listForRoom = roomId => {
    check(typeof roomId === "string" && roomId.length > 0, "roomId is required");
    return Object.freeze([...hooks.values()]
      .filter(hook => hook.roomId === roomId)
      .map(view));
  };

  const setEnabled = (webhookId, enabled) => {
    check(typeof enabled === "boolean", "enabled must be a boolean");
    const hook = hooks.get(webhookId);
    check(hook, `unknown webhook "${webhookId}"`);
    hook.enabled = enabled;
    persist?.updateEnabled.run(enabled ? 1 : 0, webhookId);
    return view(hook);
  };

  const updatePostToken = (webhookId, postToken) => {
    check(typeof postToken === "string" && postToken.length > 0, "postToken is required");
    const hook = hooks.get(webhookId);
    check(hook, `unknown webhook "${webhookId}"`);
    hook.postToken = postToken;
    persist?.updateToken.run(postToken, webhookId);
  };

  const revoke = webhookId => {
    check(typeof webhookId === "string" && WEBHOOK_ID_PATTERN.test(webhookId), "webhookId is invalid");
    check(hooks.delete(webhookId), `unknown webhook "${webhookId}"`);
    persist?.remove.run(webhookId);
    return Object.freeze({ webhookId, revoked: true });
  };

  return Object.freeze({ create, getForDelivery, listForRoom, setEnabled, updatePostToken, revoke, load,
    size: () => hooks.size });
}

export { InboundWebhookError, validateMessageCard };
