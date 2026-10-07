// Inbound channel webhooks + rich message cards (missing-features #7).
//
// Security is the point: unsigned or SSRF-able inbound webhooks are worse
// than none. These tests pin the fail-closed contract at the real
// boundaries: HMAC verification of the raw request body, strict card
// schema validation before a card is stored on a message, and escaped
// card HTML at render time.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  createInboundWebhooks,
  signBody,
  verifySignatureHeader,
  parseDeliverPayload,
  InboundWebhookError,
} from "../server/inbound-webhooks.mjs";
import { validateMessageCard, MESSAGE_CARD_LIMITS } from "../src/message-cards.js";
import { applyEvent, emptyRoomState, EVENT_TYPES } from "../src/events.js";
import { messageCardHtml } from "../src/conversation.js";

const SECRET = randomBytes(32).toString("hex");
const sign = (secret, raw) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

// --- signature verification: fail closed -----------------------------------

test("verifySignatureHeader accepts the exact HMAC of the raw body", () => {
  const raw = Buffer.from(JSON.stringify({ text: "deploy done" }));
  assert.equal(verifySignatureHeader(SECRET, signBody(SECRET, raw), raw), true);
  assert.equal(verifySignatureHeader(SECRET, sign(SECRET, raw), raw), true);
});

test("verifySignatureHeader rejects missing, malformed, and wrong signatures", () => {
  const raw = Buffer.from(JSON.stringify({ text: "deploy done" }));
  assert.equal(verifySignatureHeader(SECRET, null, raw), false);
  assert.equal(verifySignatureHeader(SECRET, "", raw), false);
  assert.equal(verifySignatureHeader(SECRET, "not-a-signature", raw), false);
  assert.equal(verifySignatureHeader(SECRET, "sha256=zzz", raw), false);
  assert.equal(verifySignatureHeader(SECRET, "sha256=" + "0".repeat(63), raw), false);
  assert.equal(verifySignatureHeader(SECRET, "sha256=" + "0".repeat(65), raw), false);
  // Wrong secret: must not verify.
  assert.equal(verifySignatureHeader(SECRET, sign("0".repeat(64), raw), raw), false);
  // Tampered body: must not verify.
  const tampered = Buffer.from(JSON.stringify({ text: "deploy done!" }));
  assert.equal(verifySignatureHeader(SECRET, sign(SECRET, raw), tampered), false);
  // Empty secret fails closed.
  assert.equal(verifySignatureHeader("", sign(SECRET, raw), raw), false);
});

test("signBody is deterministic and covers the raw bytes, not the parse", () => {
  const a = Buffer.from('{"text":"x"}');
  const b = Buffer.from('{"text": "x"}'); // same JSON, different bytes
  assert.notEqual(signBody(SECRET, a), signBody(SECRET, b));
  assert.equal(signBody(SECRET, a), signBody(SECRET, Buffer.from('{"text":"x"}')));
});

// --- deliver payload validation --------------------------------------------

test("parseDeliverPayload accepts text with an optional valid card", () => {
  const card = { title: "Deploy", description: "shipped **v2**", color: "#00ff00",
    fields: [{ name: "env", value: "prod", inline: true }] };
  const parsed = parseDeliverPayload(Buffer.from(JSON.stringify({ text: "hi", card })));
  assert.equal(parsed.text, "hi");
  assert.deepEqual(parsed.card, card);
  const plain = parseDeliverPayload(Buffer.from(JSON.stringify({ text: "hi" })));
  assert.equal(plain.text, "hi");
  assert.ok(!("card" in plain));
});

test("parseDeliverPayload rejects malformed or hostile payloads", () => {
  assert.throws(() => parseDeliverPayload(Buffer.from("not json")), InboundWebhookError);
  assert.throws(() => parseDeliverPayload(Buffer.from(JSON.stringify({}))), InboundWebhookError);
  assert.throws(() => parseDeliverPayload(Buffer.from(JSON.stringify({ text: "" }))), InboundWebhookError);
  assert.throws(() => parseDeliverPayload(Buffer.from(JSON.stringify({ text: "x".repeat(4001) }))), InboundWebhookError);
  assert.throws(() => parseDeliverPayload(Buffer.from(JSON.stringify({ text: "x", card: { title: "" } }))), InboundWebhookError);
  // Surprise top-level fields are refused (strict shape, no silent drops).
  assert.throws(() => parseDeliverPayload(Buffer.from(JSON.stringify({ text: "x", admin: true }))), InboundWebhookError);
  // Oversized bodies are refused before JSON parsing can blow up.
  assert.throws(() => parseDeliverPayload(Buffer.alloc(65537).fill(120)), InboundWebhookError);
});

// --- card schema ------------------------------------------------------------

test("validateMessageCard accepts a full card and freezes it", () => {
  const card = validateMessageCard({
    title: "Nightly build",
    description: "all green",
    url: "https://ci.example/runs/1",
    color: "#123abc",
    image: "https://ci.example/badge.png",
    fields: [{ name: "duration", value: "3m", inline: true }],
    footer: "ci-bot",
    timestamp: "2026-10-06T22:00:00.000Z",
  });
  assert.equal(card.title, "Nightly build");
  assert.ok(Object.isFrozen(card));
  assert.ok(Object.isFrozen(card.fields));
});

test("validateMessageCard rejects hostile and malformed cards", () => {
  assert.throws(() => validateMessageCard(null), InboundWebhookError);
  assert.throws(() => validateMessageCard("nope"), InboundWebhookError);
  assert.throws(() => validateMessageCard({}), /title/);
  assert.throws(() => validateMessageCard({ title: "x".repeat(MESSAGE_CARD_LIMITS.title + 1) }), /title/);
  assert.throws(() => validateMessageCard({ title: "ok", bogus: 1 }), /unexpected field/);
  assert.throws(() => validateMessageCard({ title: "ok", color: "red" }), /color/);
  assert.throws(() => validateMessageCard({ title: "ok", color: "#12345" }), /color/);
  // Non-https and javascript: URLs are refused. The server never fetches
  // card URLs; the client renders them as plain links, so the scheme gate
  // is the whole SSRF/XSS story for card media.
  assert.throws(() => validateMessageCard({ title: "ok", image: "http://x.example/a.png" }), /https/);
  assert.throws(() => validateMessageCard({ title: "ok", url: "javascript:alert(1)" }), /https/);
  assert.throws(() => validateMessageCard({ title: "ok", image: "https://169.254.169.254/latest" }), /https|private|reserved/);
  const many = Array.from({ length: MESSAGE_CARD_LIMITS.fields + 1 }, (_, i) => ({ name: `f${i}`, value: "v" }));
  assert.throws(() => validateMessageCard({ title: "ok", fields: many }), /fields/);
  assert.throws(() => validateMessageCard({ title: "ok", fields: [{ name: "n" }] }), /value/);
  assert.throws(() => validateMessageCard({ title: "ok", timestamp: "yesterday" }), /timestamp/);
});

test("validateMessageCard refuses private/reserved IP literals in card URLs", () => {
  for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "[::1]"]) {
    assert.throws(() => validateMessageCard({ title: "ok", image: `https://${host}/x.png` }),
      /private|reserved/, `host ${host} must be refused`);
  }
});

// --- reducer: cards are additive, plain messages unchanged ------------------

const bootRoom = () => {
  let state = emptyRoomState();
  state = applyEvent(state, { id: "evt-room", type: EVENT_TYPES.ROOM_CREATED, roomId: "r1",
    actorId: "owner1", at: "2026-10-06T22:00:00.000Z", idempotencyKey: "k-room",
    data: { roomId: "r1", ownerId: "owner1", title: "R", purpose: "P" } });
  state = applyEvent(state, { id: "evt-owner", type: EVENT_TYPES.MEMBER_ADDED, roomId: "r1",
    actorId: "owner1", at: "2026-10-06T22:00:00.000Z", idempotencyKey: "k-owner",
    data: { memberId: "owner1", displayName: "owner", kind: "human", permissions: ["manage_members"] } });
  state = applyEvent(state, { id: "evt-member-wh1", type: EVENT_TYPES.MEMBER_ADDED, roomId: "r1",
    actorId: "owner1", at: "2026-10-06T22:00:00.000Z", idempotencyKey: "k-wh1",
    data: { memberId: "wh1", displayName: "deploy bot", kind: "agent", permissions: [] } });
  return state;
};
const posted = (id, data) => ({
  id, type: EVENT_TYPES.MESSAGE_POSTED, roomId: "r1", actorId: "wh1",
  at: "2026-10-06T22:00:00.000Z", idempotencyKey: `k-${id}`, data,
});

test("reducer stores a validated card on the message", () => {
  let state = bootRoom();
  const card = { title: "Deploy", description: "done" };
  state = applyEvent(state, posted("m1", { messageId: "m1", body: "shipped", card }));
  const message = state.messages.find(m => m.id === "m1");
  assert.equal(message.body, "shipped");
  assert.deepEqual(message.card, card);
});

test("reducer rejects an invalid card and leaves plain messages untouched", () => {
  let state = bootRoom();
  assert.throws(() => applyEvent(state, posted("m2", { messageId: "m2", body: "x", card: { title: "" } })));
  assert.throws(() => applyEvent(state, posted("m3", { messageId: "m3", body: "x", card: "nope" })));
  // Plain message: no card key at all, renders exactly as before.
  state = applyEvent(state, posted("m4", { messageId: "m4", body: "plain" }));
  const message = state.messages.find(m => m.id === "m4");
  assert.equal(message.body, "plain");
  assert.ok(!("card" in message));
});

// --- render: third-party card content is escaped ----------------------------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

test("messageCardHtml renders nothing without a card and escapes hostile content", () => {
  assert.equal(messageCardHtml(null, esc), "");
  assert.equal(messageCardHtml(undefined, esc), "");
  const html = messageCardHtml({
    title: "<script>alert(1)</script>",
    description: "**bold** and <img src=x onerror=alert(2)>",
    url: "https://example.com/?a=1&b=2",
    color: "#ff0000",
    fields: [{ name: "<b>n</b>", value: "v", inline: true }],
    footer: "f",
  }, esc);
  assert.ok(!html.includes("<script>"), "raw script tag must not appear");
  assert.ok(html.includes("&lt;script&gt;"), "title is escaped");
  assert.ok(html.includes("<strong>bold</strong>"), "description keeps markdown");
  assert.ok(!html.includes("<img src=x"), "no raw html from description");
  assert.ok(html.includes('href="https://example.com/?a=1&amp;b=2"'), "url escaped in href");
  assert.ok(html.includes("#ff0000"), "color accent rendered");
});

test("messageCardHtml refuses to render an invalid card", () => {
  assert.equal(messageCardHtml({ title: "" }, esc), "");
  assert.equal(messageCardHtml({ title: "ok", image: "http://x.example/a.png" }, esc), "");
});

// --- webhook record lifecycle (in-memory Map flavor) ------------------------

test("createInboundWebhooks mints secrets shown once and verifies deliveries", () => {
  const hooks = createInboundWebhooks({ clock: () => 1_700_000_000_000 });
  const created = hooks.create({ roomId: "r1", memberId: "wh1", name: "deploy bot", postToken: "tok_abc" });
  assert.ok(created.webhookId);
  assert.ok(created.secret.length >= 32, "secret has real entropy");
  assert.equal(created.roomId, "r1");
  // The list view never carries secrets or the posting token.
  const listed = hooks.listForRoom("r1");
  assert.equal(listed.length, 1);
  assert.ok(!("secret" in listed[0]) && !("postToken" in listed[0]));
  assert.equal(listed[0].enabled, true);
  // Delivery verification uses the stored secret.
  const raw = Buffer.from(JSON.stringify({ text: "hi" }));
  const stored = hooks.getForDelivery(created.webhookId);
  assert.equal(verifySignatureHeader(stored.secret, signBody(stored.secret, raw), raw), true);
  assert.equal(hooks.listForRoom("other").length, 0);
  // Revoke disables delivery.
  hooks.revoke(created.webhookId);
  assert.throws(() => hooks.getForDelivery(created.webhookId), InboundWebhookError);
  assert.equal(hooks.listForRoom("r1").length, 0);
});

test("createInboundWebhooks validates names and rejects duplicates", () => {
  const hooks = createInboundWebhooks({ clock: () => 1_700_000_000_000 });
  assert.throws(() => hooks.create({ roomId: "r1", memberId: "w", name: "", postToken: "t" }), InboundWebhookError);
  assert.throws(() => hooks.create({ roomId: "r1", memberId: "w", name: "x".repeat(81), postToken: "t" }), InboundWebhookError);
  assert.throws(() => hooks.create({ roomId: "", memberId: "w", name: "ok", postToken: "t" }), InboundWebhookError);
  const first = hooks.create({ roomId: "r1", memberId: "w1", name: "bot", postToken: "t" });
  const second = hooks.create({ roomId: "r1", memberId: "w2", name: "bot", postToken: "t" });
  assert.notEqual(first.webhookId, second.webhookId, "webhook ids are unique");
  assert.notEqual(first.secret, second.secret, "signing secrets are unique");
});
