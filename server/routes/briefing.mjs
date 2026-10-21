// GET /api/account/briefing  the caller's morning briefing across rooms; { enabled: false } until turned on
// PUT /api/account/briefing  { enabled, hour? } opt in or out (hour 0-23, local to the client, default 8)
// Off by default. Reading it records lastReadAt, so "changed since last" is
// what arrived since the previous briefing. Account session only.
import { listAccountUpdates } from "../updates.mjs";
import { composeBriefing } from "../../src/briefing.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS account_briefings (
  account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, hour INTEGER NOT NULL, last_read_at INTEGER, updated_at INTEGER NOT NULL)`;
const ready = new WeakSet();
export function ensureBriefings(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

function session(ctx) {
  const slotToken = ctx.cookie(ctx.req, ctx.accountCookieName);
  if (!slotToken) ctx.reject(401, "account_session_required", "Sign in to read your briefing");
  const binding = ctx.accountBinding(ctx.req);
  try { return { auth: ctx.store.authenticateAccountSession(slotToken, null, binding), slotToken, binding }; }
  catch (error) {
    if (error?.code === "session_binding_changed") throw error;
    ctx.reject(401, "account_session_required", "Sign in to read your briefing");
  }
}
const prefsOf = (db, accountId) => ensureBriefings(db).prepare("SELECT * FROM account_briefings WHERE account_id=?").get(accountId);

export function readBriefing(ctx) {
  ctx.rate(`briefing:${ctx.remoteAddress}`, 60);
  const { auth, slotToken, binding } = session(ctx);
  const prefs = prefsOf(ctx.store.db, auth.account.id);
  if (!prefs?.enabled) return ctx.json(ctx.res, 200, { enabled: false, hour: prefs?.hour ?? 8, briefing: null });
  const updates = listAccountUpdates(ctx.store, slotToken, binding, { state: "actionable", limit: 100 });
  const since = prefs.last_read_at ? new Date(prefs.last_read_at).toISOString() : null;
  const briefing = composeBriefing(updates.items, { since });
  ctx.store.db.prepare("UPDATE account_briefings SET last_read_at=? WHERE account_id=?").run(ctx.store.now(), auth.account.id);
  return ctx.json(ctx.res, 200, { enabled: true, hour: prefs.hour, since, incomplete: Object.values(updates.incompleteSources ?? {}).some(Boolean), briefing });
}

export async function writeBriefing(ctx) {
  ctx.rate(`briefing:${ctx.remoteAddress}`, 60);
  const { auth } = session(ctx);
  ctx.protectWrite(ctx.req, auth, false);
  const data = await ctx.body(ctx.req);
  const hour = data?.hour ?? 8;
  if (typeof data?.enabled !== "boolean" || !Number.isInteger(hour) || hour < 0 || hour > 23) ctx.reject(422, "invalid_briefing", "Supply enabled (true or false) and an optional hour 0-23");
  ensureBriefings(ctx.store.db).prepare(`INSERT INTO account_briefings(account_id,enabled,hour,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled, hour=excluded.hour, updated_at=excluded.updated_at`)
    .run(auth.account.id, data.enabled ? 1 : 0, hour, ctx.store.now());
  return ctx.json(ctx.res, 200, { enabled: data.enabled, hour });
}

const parity = "exempt:human account preference and digest; agents read Updates directly";
export const BRIEFING_ROUTES = Object.freeze([
  Object.freeze({ id: "account.briefing.read", method: "GET", path: "/api/account/briefing", auth: "account", capability: null, scope: "worker", events: [],
    rate: { key: "briefing", max: 60 }, parity, authenticate: ctx => session(ctx).auth, handler: readBriefing, schema: { response: { type: "object" } } }),
  Object.freeze({ id: "account.briefing.write", method: "PUT", path: "/api/account/briefing", auth: "account", capability: null, scope: "worker", events: [],
    rate: { key: "briefing", max: 60 }, parity, authenticate: ctx => session(ctx).auth, handler: writeBriefing, schema: { response: { type: "object" } } }),
]);
