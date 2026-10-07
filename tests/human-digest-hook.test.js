// #1601 (IS-UX-1): human digest hook. Policy first, delivery second.
// The hook is inert without mail infra: with no RESEND_API_KEY nothing is
// sent and the result says so. Quiet hours and opt-out are honored before
// any render happens.
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSendDigest, buildDigestEmail, deliverDigestEmail, digestRenderInput } from "../server/human-digest-hook.mjs";

const member = { id: "maya", notificationPreferences: {} };
const feed = { notifications: [{ kind: "mention", messageId: "m1", actorId: "alice", sequence: 11, at: 1, changes: 1 }] };
const emptyFeed = { notifications: [] };

test("empty feed never sends", () => {
  assert.deepEqual(shouldSendDigest({ member, feed: emptyFeed }), { send: false, reason: "empty_feed" });
  assert.deepEqual(shouldSendDigest({ member, feed: null }), { send: false, reason: "empty_feed" });
});

test("member email_digest opt-out is honored", () => {
  const optedOut = { id: "maya", notificationPreferences: { email_digest: false } };
  assert.deepEqual(shouldSendDigest({ member: optedOut, feed }), { send: false, reason: "opted_out" });
});

test("quiet hours hold the digest", () => {
  const quiet = { id: "maya", notificationPreferences: { quietHours: { start: "00:00", end: "23:59", tz: "UTC" } } };
  const at = Date.UTC(2026, 9, 7, 12, 0, 0);
  const decision = shouldSendDigest({ member: quiet, feed, now: at });
  assert.deepEqual(decision, { send: false, reason: "quiet_hours" });
});

test("a digestable feed outside quiet hours sends", () => {
  assert.deepEqual(shouldSendDigest({ member, feed }), { send: true, reason: "ok" });
});

test("built email renders through the notification email renderer", () => {
  const email = buildDigestEmail({ member, feed, roomName: "commons" });
  assert.equal(email.skipped, false);
  assert.ok(email.subject.includes("Room brief") || email.subject.length > 0, "has a subject");
  assert.ok(email.text.includes("alice"), "names the actor");
  assert.ok(email.text.includes("commons"), "names the room");
  assert.ok(email.html.includes("alice"), "html twin carries it too");
});

test("delivery without RESEND_API_KEY is inert and honest", async () => {
  const input = digestRenderInput({ feed, roomName: "commons" });
  const result = await deliverDigestEmail({ to: "maya@example.com", input, env: {} });
  assert.deepEqual(result, { delivered: false, reason: "transport_unavailable" });
});

test("delivery with a key calls the transport once, carrying the digest", async () => {
  const sent = [];
  const input = digestRenderInput({ feed, roomName: "commons" });
  const result = await deliverDigestEmail({
    to: "maya@example.com",
    input,
    env: { RESEND_API_KEY: "re_test_key" },
    fetchFn: async (url, init) => { sent.push({ url, init }); return { ok: true, json: async () => ({}) }; }
  });
  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.to, "maya@example.com");
  assert.ok(body.text.includes("alice"), "the digest content survives the mailer's own render");
  assert.ok(body.text.includes("commons"), "the room name survives the mailer's own render");
});

test("an empty digest reports a skip, never a phantom delivery", async () => {
  const input = digestRenderInput({ feed: emptyFeed, roomName: "commons" });
  const result = await deliverDigestEmail({
    to: "maya@example.com",
    input,
    env: { RESEND_API_KEY: "re_test_key" },
    fetchFn: async () => { throw new Error("must not send"); }
  });
  assert.deepEqual(result, { delivered: false, reason: "empty" });
});
