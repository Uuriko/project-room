// Slack two-way bridge (Linear parity: Slack two-way). OFF unless
// ROOM_SLACK_BRIDGE=1. The owner sets these later (never stored in the DB):
//   SLACK_SIGNING_SECRET  verifies inbound Events API requests
//   SLACK_BOT_TOKEN       posts room messages to Slack (chat.postMessage)
// The room owner links one Slack channel to the room and picks the room
// member that Slack posts appear as (the bridge member).
// Inbound: human channel messages become room messages; bot messages and
// subtypes (edits, joins, our own posts) are ignored so nothing echoes.
// Outbound: room messages from anyone but the bridge member are relayed in
// sequence order from a per-link cursor; a failed send stops and retries.
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendRoomEvent, stableEventId } from "./receipt-cards.mjs";

export const SLACK_TABLES = Object.freeze(["room_slack_links"]);
export const slackBridgeEnabled = (env = process.env) => env?.ROOM_SLACK_BRIDGE === "1";
export const slackSecretsMissing = (env = process.env) =>
  ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"].filter(name => typeof env?.[name] !== "string" || !env[name]);
export const SLACK_ID = /^[A-Z0-9]{2,32}$/;
const MAX_TEXT = 4000;
const OUT_BATCH = 20;

const ensure = db => db.exec(`CREATE TABLE IF NOT EXISTS room_slack_links (room_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, bridge_member TEXT NOT NULL, out_seq INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (team_id, channel_id))`);

const linkOut = r => r ? ({ roomId: r.room_id, teamId: r.team_id, channelId: r.channel_id, bridgeMember: r.bridge_member, createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString() }) : null;
export function getLink(db, roomId) { ensure(db); return linkOut(db.prepare("SELECT * FROM room_slack_links WHERE room_id = ?").get(roomId)); }
export function linkByChannel(db, teamId, channelId) {
  ensure(db); return db.prepare("SELECT * FROM room_slack_links WHERE team_id = ? AND channel_id = ?").get(teamId, channelId) ?? null;
}
// Returns { link } or { taken: true } when the channel is linked elsewhere.
// Outbound starts at the room's current head, so history is not replayed.
export function setLink(store, { roomId, teamId, channelId, bridgeMember, createdBy, now = Date.now() }) {
  const db = store.db; ensure(db);
  const other = linkByChannel(db, teamId, channelId);
  if (other && other.room_id !== roomId) return { taken: true };
  db.prepare(`INSERT INTO room_slack_links (room_id, team_id, channel_id, bridge_member, out_seq, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (room_id) DO UPDATE SET team_id = excluded.team_id, channel_id = excluded.channel_id, bridge_member = excluded.bridge_member,
    out_seq = excluded.out_seq, created_by = excluded.created_by, created_at = excluded.created_at`)
    .run(roomId, teamId, channelId, bridgeMember, store.headSequence(roomId), createdBy, now);
  return { link: getLink(db, roomId) };
}
export function removeLink(db, roomId) { ensure(db); return db.prepare("DELETE FROM room_slack_links WHERE room_id = ?").run(roomId).changes > 0; }

// Slack request signing v0: HMAC-SHA256 of `v0:{ts}:{body}`, 5-minute window.
export function verifySlack({ secret, headers, body, nowS }) {
  const ts = headers?.["x-slack-request-timestamp"];
  const sig = headers?.["x-slack-signature"];
  if (typeof ts !== "string" || !/^\d{1,12}$/.test(ts) || typeof sig !== "string") return "missing signature headers";
  if (Math.abs(nowS - Number(ts)) > 300) return "stale timestamp";
  const want = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`);
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? null : "bad signature";
}

// Handle one verified Events API payload. Returns the HTTP response value.
export function handleSlackEvent(store, payload, now = Date.now()) {
  if (payload?.type === "url_verification") return { challenge: String(payload.challenge ?? "").slice(0, 200) };
  if (payload?.type !== "event_callback") return { ok: true, ignored: "type" };
  const ev = payload.event ?? {};
  if (ev.type !== "message" || ev.subtype || ev.bot_id || typeof ev.text !== "string" || !ev.text.trim()) return { ok: true, ignored: "not_a_human_message" };
  const teamId = String(payload.team_id ?? ""), eventId = String(payload.event_id ?? "");
  if (!SLACK_ID.test(teamId) || !SLACK_ID.test(String(ev.channel ?? "")) || !/^[A-Za-z0-9]{1,64}$/.test(eventId)) return { ok: true, ignored: "invalid" };
  const link = linkByChannel(store.db, teamId, ev.channel);
  if (!link) return { ok: true, ignored: "unlinked" };
  const messageId = stableEventId("sl", `${link.room_id}\0${teamId}\0${eventId}`);
  const who = /^[A-Z0-9]{2,32}$/.test(String(ev.user ?? "")) ? `<@${ev.user}>` : "someone";
  const body = `[Slack] ${who}: ${ev.text}`.slice(0, MAX_TEXT);
  const posted = appendRoomEvent(store, link.room_id, { id: messageId, type: "message.posted", actorId: link.bridge_member, data: { messageId, body }, atMs: now });
  return { ok: true, posted: Boolean(posted), duplicate: !posted };
}

// Outbound relay: one pass over every link. fetchImpl is injected for tests.
export async function relayToSlack(store, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!slackBridgeEnabled(env) || !env.SLACK_BOT_TOKEN) return { links: 0, sent: 0 };
  const db = store.db; ensure(db);
  let sent = 0;
  const links = db.prepare("SELECT * FROM room_slack_links").all();
  for (const link of links) {
    const rows = db.prepare("SELECT sequence, body FROM events WHERE room_id = ? AND sequence > ? ORDER BY sequence LIMIT ?").all(link.room_id, link.out_seq, OUT_BATCH);
    for (const row of rows) {
      let ev; try { ev = JSON.parse(row.body); } catch { ev = null; }
      if (ev?.type === "message.posted" && ev.actorId !== link.bridge_member && typeof ev.data?.body === "string") {
        const res = await fetchImpl("https://slack.com/api/chat.postMessage", { method: "POST",
          headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
          body: JSON.stringify({ channel: link.channel_id, text: `${ev.actorId}: ${ev.data.body}`.slice(0, MAX_TEXT), unfurl_links: false }) }).catch(() => null);
        const out = res?.ok ? await res.json().catch(() => null) : null;
        if (!out?.ok) break; // retry from this event next pass
        sent++;
      }
      db.prepare("UPDATE room_slack_links SET out_seq = ? WHERE room_id = ?").run(row.sequence, link.room_id);
    }
  }
  return { links: links.length, sent };
}

export function slackOutboundDue(store, env = process.env) {
  if (!slackBridgeEnabled(env) || !env?.SLACK_BOT_TOKEN || !store?.db) return false;
  ensure(store.db);
  return Boolean(store.db.prepare("SELECT 1 FROM room_slack_links l JOIN rooms r ON r.id = l.room_id WHERE r.sequence > l.out_seq LIMIT 1").get());
}
