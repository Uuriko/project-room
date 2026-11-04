import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { verifySlack, relayToSlack, slackOutboundDue, slackSecretsMissing, getLink } from "../server/slack-bridge.mjs";
import { postSlackLink, postSlackEvents, SLACK_BRIDGE_ROUTES } from "../server/routes/slack-bridge.mjs";
import { ROUTES } from "../server/routes/table.mjs";

const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
const SECRET = "test-signing-secret";
const ENV = { ROOM_SLACK_BRIDGE: "1", SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: "test-bot-token" };
const NOW = 1_800_000_000_000;
const signed = (body, ts = String(NOW / 1000)) => ({ "x-slack-request-timestamp": ts,
  "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}` });

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-lead", type: "member.added", data: { memberId: "lead", displayName: "lead", kind: "agent", permissions: [] } });
  store.command(ownerKey, "commons", { id: "add-bridge", type: "member.added", data: { memberId: "slack", displayName: "Slack", kind: "agent", permissions: [] } });
  t.after(() => { store.close(); delete process.env.ROOM_SLACK_BRIDGE; });
  const owner = store.roomAuthority("commons").ownerId;
  const admin = async (memberId, body) => {
    const ctx = { params: { roomId: "commons" }, req: {}, res: {}, url: new URL("https://room.example/"), store,
      roomCredentials: () => ({ mode: "room", bearer: false }), expectedBinding: () => null, accountBinding: () => null,
      roomAuth: () => ({ member: { id: memberId }, credentialScope: "room", credentialHash: memberId }),
      protectWrite: () => {}, rate: () => {}, body: async () => body, json: (_r, status, value) => ({ status, value }), reject };
    try { return await postSlackLink(ctx); } catch (e) { if (!Number.isInteger(e.status)) throw e; return { status: e.status, code: e.code }; }
  };
  const deliver = async (payload, { headers, env = ENV } = {}) => {
    const text = JSON.stringify(payload);
    const ctx = { req: { headers: headers ?? signed(text) }, res: {}, store, rate: () => {}, readText: async () => text,
      json: (_r, status, value) => ({ status, value }), reject };
    try { return await postSlackEvents(ctx, { env, now: NOW }); } catch (e) { if (!Number.isInteger(e.status)) throw e; return { status: e.status, code: e.code }; }
  };
  const messages = () => store.db.prepare("SELECT body FROM events WHERE room_id = 'commons' ORDER BY sequence").all()
    .map(r => JSON.parse(r.body)).filter(e => e.type === "message.posted");
  return { store, owner, admin, deliver, messages };
}

const msg = (eventId, extra = {}) => ({ type: "event_callback", team_id: "T123", event_id: eventId,
  event: { type: "message", channel: "C456", user: "U789", text: "hello from slack", ...extra } });

test("pure: Slack v0 signature check and secret names", () => {
  const body = "{}";
  assert.equal(verifySlack({ secret: SECRET, headers: signed(body), body, nowS: NOW / 1000 }), null);
  assert.equal(verifySlack({ secret: SECRET, headers: signed(body), body: "{ }", nowS: NOW / 1000 }), "bad signature");
  assert.equal(verifySlack({ secret: SECRET, headers: signed(body), body, nowS: NOW / 1000 + 301 }), "stale timestamp");
  assert.equal(verifySlack({ secret: SECRET, headers: {}, body, nowS: 0 }), "missing signature headers");
  assert.deepEqual(slackSecretsMissing({}), ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"]);
});

test("routes are in the table and 404 with the flag off", async t => {
  for (const r of SLACK_BRIDGE_ROUTES) assert.ok(ROUTES.includes(r));
  const f = fixture(t);
  assert.equal((await f.admin(f.owner, { get: true })).status, 404);
  assert.equal((await f.deliver(msg("Ev1"), { env: {} })).status, 404);
  assert.equal((await f.deliver(msg("Ev1"), { env: { ROOM_SLACK_BRIDGE: "1" } })).code, "slack_not_configured");
});

test("flag on: owner links; signed Slack messages land once; bots, edits and bad signatures do not", async t => {
  process.env.ROOM_SLACK_BRIDGE = "1";
  const f = fixture(t);
  assert.deepEqual(await f.admin("lead", { get: true }), { status: 403, code: "access_denied" });
  assert.equal((await f.admin(f.owner, { link: { teamId: "T123", channelId: "C456", memberId: "ghost" } })).code, "invalid_body");
  const linked = await f.admin(f.owner, { link: { teamId: "T123", channelId: "C456", memberId: "slack" } });
  assert.equal(linked.status, 201);
  assert.equal(linked.value.link.bridgeMember, "slack");
  assert.equal((await f.deliver({ type: "url_verification", challenge: "abc" })).value.challenge, "abc");
  const before = f.messages().length;
  assert.equal((await f.deliver(msg("Ev1"))).value.posted, true);
  assert.equal((await f.deliver(msg("Ev1"))).value.duplicate, true);
  await f.deliver(msg("Ev2", { bot_id: "B1" }));
  await f.deliver(msg("Ev3", { subtype: "message_changed" }));
  await f.deliver({ ...msg("Ev4"), event: { ...msg("Ev4").event, channel: "C999" } });
  assert.equal((await f.deliver(msg("Ev5"), { headers: { "x-slack-request-timestamp": String(NOW / 1000), "x-slack-signature": "v0=bad" } })).code, "webhook_signature");
  const after = f.messages();
  assert.equal(after.length, before + 1);
  assert.deepEqual([after.at(-1).actorId, after.at(-1).data.body], ["slack", "[Slack] <@U789>: hello from slack"]);
  assert.equal((await f.admin(f.owner, { unlink: true })).value.removed, true);
  assert.equal(getLink(f.store.db, "commons"), null);
});

test("outbound: relays room messages except the bridge member's, retries on failure, never replays history", async t => {
  process.env.ROOM_SLACK_BRIDGE = "1";
  const f = fixture(t);
  const leadKey = f.store.issueAccessKey("commons", "lead");
  f.store.command(leadKey, "commons", { id: "old", type: "message.posted", data: { messageId: "old", body: "before link" } });
  await f.admin(f.owner, { link: { teamId: "T123", channelId: "C456", memberId: "slack" } });
  assert.equal(slackOutboundDue(f.store, ENV), false);
  f.store.command(leadKey, "commons", { id: "m1", type: "message.posted", data: { messageId: "m1", body: "ship it" } });
  await f.deliver(msg("Ev9"));
  assert.equal(slackOutboundDue(f.store, ENV), true);
  assert.equal(slackOutboundDue(f.store, {}), false);
  let fail = true; const sent = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://slack.com/api/chat.postMessage");
    if (fail) return { ok: true, json: async () => ({ ok: false, error: "ratelimited" }) };
    sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true }) };
  };
  assert.equal((await relayToSlack(f.store, { env: ENV, fetchImpl })).sent, 0);
  fail = false;
  assert.equal((await relayToSlack(f.store, { env: ENV, fetchImpl })).sent, 1);
  assert.deepEqual(sent, [{ channel: "C456", text: "lead: ship it", unfurl_links: false }]);
  assert.equal(slackOutboundDue(f.store, ENV), false);
  assert.equal((await relayToSlack(f.store, { env: { ROOM_SLACK_BRIDGE: "1" }, fetchImpl })).sent, 0);
});
