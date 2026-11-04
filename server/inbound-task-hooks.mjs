// Signed per-room inbound webhooks that open a Board task and wake its
// assignee (Linear-parity: integrations such as Sentry or Asks open issues;
// Linear Loops start work from external events).
//
// Wire format matches MCP Events (server/mcp-events-wire.mjs): body
// {eventId, name, timestamp, data, cursor?} signed with Standard Webhooks
// headers webhook-id / webhook-timestamp / webhook-signature (v1, HMAC-SHA256
// over `${id}.${timestamp}.${body}` with a whsec_ key). A sender that already
// emits MCP Events can point at Room unchanged.
//
// OFF unless ROOM_INBOUND_HOOKS=1: both routes answer 404. Payload text is
// stored as task title/note only — it is data, never instructions, and is
// never echoed back. The signing secret is returned once at creation and is
// stored only as AES-256-GCM ciphertext under a key derived (HKDF-SHA256)
// from the Worker secret ROOM_INBOUND_HOOK_KEY, bound to the hook id. With the
// flag on and no key, create and delivery fail closed (503).
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { eventSigningKey } from "./mcp-events-wire.mjs";
import { createWork, claimWork } from "./work-claims.mjs";
import { emitWorkClaimEvent, enqueueClaimWake } from "./work-claim-events.mjs";
import { ownMember } from "../src/events.js";

export const INBOUND_HOOK_TABLES = Object.freeze(["room_inbound_hooks", "room_inbound_deliveries"]);
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS room_inbound_hooks (hook_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, secret TEXT NOT NULL,
    target_member TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
  CREATE TABLE IF NOT EXISTS room_inbound_deliveries (hook_id TEXT NOT NULL, delivery_id TEXT NOT NULL, at INTEGER NOT NULL,
    claim_id TEXT NOT NULL, PRIMARY KEY (hook_id, delivery_id));`;
export const INBOUND_TOLERANCE_S = 300;
export const INBOUND_BODY_LIMIT = 65536;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const inboundHooksEnabled = (env = process.env) => env?.ROOM_INBOUND_HOOKS === "1";
const ensure = db => db.exec(SCHEMA);

export class InboundKeyMissing extends Error {}
function hookKey(env) {
  const raw = env?.ROOM_INBOUND_HOOK_KEY;
  if (typeof raw !== "string" || raw.length < 32) throw new InboundKeyMissing("inbound hook key unavailable");
  return Buffer.from(hkdfSync("sha256", raw, "room-inbound-hooks", "room-inbound-hook-secret-v1", 32));
}
export function sealSecret(secret, hookId, env = process.env) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", hookKey(env), iv).setAAD(Buffer.from(hookId));
  const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url")}`;
}
export function openSecret(sealed, hookId, env = process.env) {
  if (typeof sealed !== "string" || !sealed.startsWith("v1:")) return null;
  const buf = Buffer.from(sealed.slice(3), "base64url");
  if (buf.length < 29) return null;
  const d = createDecipheriv("aes-256-gcm", hookKey(env), buf.subarray(0, 12)).setAAD(Buffer.from(hookId));
  d.setAuthTag(buf.subarray(buf.length - 16));
  try { return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString("utf8"); } catch { return null; }
}

export function createInboundHook(db, { roomId, targetMember, createdBy, now = Date.now(), env = process.env }) {
  ensure(db);
  const hookId = `ih_${randomBytes(12).toString("base64url")}`;
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  db.prepare("INSERT INTO room_inbound_hooks (hook_id, room_id, secret, target_member, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(hookId, roomId, sealSecret(secret, hookId, env), targetMember, createdBy, now);
  return { hookId, secret, path: `/api/inbound/${hookId}` };
}
export function revokeInboundHook(db, { roomId, hookId, now = Date.now() }) {
  ensure(db);
  return db.prepare("UPDATE room_inbound_hooks SET revoked_at = ? WHERE hook_id = ? AND room_id = ? AND revoked_at IS NULL").run(now, hookId, roomId).changes > 0;
}
// Owner listing: never includes the secret or its ciphertext.
export function listInboundHooks(db, { roomId }) {
  ensure(db);
  return db.prepare(`SELECT h.hook_id, h.target_member, h.created_by, h.created_at, h.revoked_at,
      (SELECT COUNT(*) FROM room_inbound_deliveries d WHERE d.hook_id = h.hook_id) AS deliveries,
      (SELECT MAX(at) FROM room_inbound_deliveries d WHERE d.hook_id = h.hook_id) AS last_delivery_at
    FROM room_inbound_hooks h WHERE h.room_id = ? ORDER BY h.created_at DESC LIMIT 100`).all(roomId)
    .map(r => ({ hookId: r.hook_id, path: `/api/inbound/${r.hook_id}`, target: r.target_member, createdBy: r.created_by,
      createdAt: r.created_at, revokedAt: r.revoked_at ?? null, deliveries: r.deliveries, lastDeliveryAt: r.last_delivery_at ?? null }));
}
function hookOf(db, hookId) {
  ensure(db);
  return db.prepare("SELECT * FROM room_inbound_hooks WHERE hook_id = ? AND revoked_at IS NULL").get(hookId) ?? null;
}

// Standard Webhooks verification. Returns null when valid, else a reason code.
export function verifyInbound({ secret, headers, body, nowS }) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (typeof id !== "string" || !ID.test(id) || typeof ts !== "string" || !/^\d{1,12}$/.test(ts) || typeof sig !== "string") return "missing_signature";
  if (Math.abs(nowS - Number(ts)) > INBOUND_TOLERANCE_S) return "stale_timestamp";
  const expected = createHmac("sha256", eventSigningKey(secret)).update(`${id}.${ts}.${body}`).digest();
  const ok = sig.split(" ").some(part => {
    if (!part.startsWith("v1,")) return false;
    const got = Buffer.from(part.slice(3), "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return ok ? null : "bad_signature";
}

const clip = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, max) : "");

// Parse an MCP Events payload into a task. Throws {reason} on bad shape.
export function taskFromEvent(text) {
  let event;
  try { event = JSON.parse(text); } catch { return { error: "invalid_json" }; }
  if (!event || typeof event !== "object" || typeof event.eventId !== "string" || !ID.test(event.eventId) || typeof event.name !== "string") return { error: "invalid_event" };
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const name = clip(event.name, 80);
  const title = clip(data.title, 200) || name;
  if (!title) return { error: "invalid_event" };
  const parts = [clip(data.body ?? data.summary, 2000), clip(data.url, 500)].filter(Boolean);
  return { eventId: event.eventId, name, title: `[${name}] ${title}`.slice(0, 240), note: parts.join("\n") || null };
}

// Open (or idempotently re-find) the task for a verified delivery and wake
// the hook's target. Returns { claimId, duplicate }.
export function openInboundTask(store, hook, task, deliveryId, now = Date.now()) {
  const db = store.db;
  ensure(db);
  const seen = db.prepare("SELECT claim_id FROM room_inbound_deliveries WHERE hook_id = ? AND delivery_id = ?").get(hook.hook_id, deliveryId);
  if (seen) return { claimId: seen.claim_id, duplicate: true };
  const claimId = `in-${createHash("sha256").update(`${hook.hook_id}:${task.eventId}`).digest("hex").slice(0, 20)}`;
  const roomId = hook.room_id;
  if (store.workClaims.get(roomId, claimId)) {
    db.prepare("INSERT OR IGNORE INTO room_inbound_deliveries (hook_id, delivery_id, at, claim_id) VALUES (?, ?, ?, ?)").run(hook.hook_id, deliveryId, now, claimId);
    return { claimId, duplicate: true };
  }
  const members = store.roomAuthority(roomId).members ?? {};
  const target = ownMember(members, hook.target_member);
  const actor = hook.created_by;
  let item = createWork({ id: claimId, title: task.title, note: task.note ?? undefined, tags: ["inbound", task.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40) || "event"] }, { now, agentId: actor });
  const assigned = target && target.active !== false;
  if (assigned) item = claimWork(item, target.id, { note: `opened by inbound hook ${hook.hook_id}`, room: { workClaims: store.workClaims.rawConfig(roomId) }, now });
  store.workClaims.set(roomId, item);
  emitWorkClaimEvent(store, roomId, { actorId: actor, item, action: assigned ? "claimed" : "created", previousOwnerId: null, previousState: null, atMs: now,
    ...(assigned ? { attention: "assigned", attentionMemberId: target.id } : {}) });
  if (assigned) enqueueClaimWake(store, roomId, target.id, `work-claim:${claimId}:assigned:${now}`, { reason: "assigned", actorId: actor });
  db.prepare("INSERT INTO room_inbound_deliveries (hook_id, delivery_id, at, claim_id) VALUES (?, ?, ?, ?)").run(hook.hook_id, deliveryId, now, claimId);
  return { claimId, duplicate: false, assigned };
}

// POST /api/inbound/{hookId}
export async function postInboundHook(ctx, { env = process.env, now = Date.now() } = {}) {
  if (!inboundHooksEnabled(env)) ctx.reject(404, "not_found", "Not found");
  ctx.rate?.(`inbound-hook:${ctx.remoteAddress ?? "unknown"}`, 120);
  const hookId = ctx.params.hookId;
  const hook = typeof hookId === "string" && ID.test(hookId) ? hookOf(ctx.store.db, hookId) : null;
  if (!hook) ctx.reject(404, "not_found", "Not found");
  const text = await ctx.readText(ctx.req, INBOUND_BODY_LIMIT, () => ctx.reject(413, "too_large", "Request is too large"));
  let secret;
  try { secret = openSecret(hook.secret, hook.hook_id, env); } catch (e) { if (e instanceof InboundKeyMissing) ctx.reject(503, "inbound_hooks_unavailable", "Inbound hooks are not configured"); throw e; }
  if (!secret) ctx.reject(401, "webhook_signature", "unverifiable");
  const bad = verifyInbound({ secret, headers: ctx.req.headers, body: text, nowS: Math.floor(now / 1000) });
  if (bad) ctx.reject(401, "webhook_signature", bad);
  const task = taskFromEvent(text);
  if (task.error) ctx.reject(422, task.error, "Expected an MCP Events payload {eventId, name, timestamp, data:{title, body?, url?}}");
  const run = () => openInboundTask(ctx.store, hook, task, ctx.req.headers["webhook-id"], now);
  const out = typeof ctx.store.transaction === "function" ? ctx.store.transaction(run) : run();
  return ctx.json(ctx.res, out.duplicate ? 200 : 201, { ok: true, claimId: out.claimId, duplicate: out.duplicate });
}
