// Spam guard: sender reputation, bulk-pattern detection, Telegram-specific
// signals, and the owner-review quarantine queue. Pure tests, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  flagMessage, scannableMessage, createSenderReputation, createQuarantineQueue,
  quarantineThreshold, SpamFlagError, QuarantineError,
} from "../server/inbox-spam.mjs";

const throwsSpam = (fn, code) => assert.throws(fn, err => err instanceof SpamFlagError && err.code === code);
const throwsQz = (fn, code) => assert.throws(fn, err => err instanceof QuarantineError && err.code === code);
const keys = flag => flag.signals.map(s => s.key);

// --- backward compatibility: context omitted keeps body-only behavior ------
test("flagMessage without context behaves as before", () => {
  const flag = flagMessage({ body: "hey, are we still on for the call?" });
  assert.equal(flag.score, 0);
  assert.equal(flag.quarantine, false);
});
test("unknown context fields are rejected", () => {
  throwsSpam(() => flagMessage({ body: "hi" }, { context: { bogus: true } }) , "invalid_scannable_message");
});
test("out-of-range reputationScore is rejected", () => {
  throwsSpam(() => flagMessage({ body: "hi" }, { context: { reputationScore: 101 } }), "invalid_scannable_message");
});

// --- sender reputation ----------------------------------------------------
test("fresh sender has unknown label and zero score", () => {
  const rep = createSenderReputation();
  const snap = rep.get("new-sender@example.com");
  assert.equal(snap.score, 0);
  assert.equal(snap.label, "unknown");
  assert.equal(snap.total, 0);
});
test("long clean history earns the trusted label", () => {
  const rep = createSenderReputation();
  for (let i = 0; i < 10; i += 1) rep.record("friend@example.com", "clean");
  const snap = rep.get("friend@example.com");
  assert.equal(snap.label, "trusted");
  assert.equal(snap.score, 0);
});
test("prior quarantines push a sender to bad and trip the reputation signal", () => {
  const rep = createSenderReputation();
  rep.record("shady@example.com", "quarantined");
  rep.record("shady@example.com", "quarantined");
  rep.record("shady@example.com", "quarantined");
  const snap = rep.get("shady@example.com");
  assert.equal(snap.label, "bad");
  assert.ok(snap.score >= 60);
  const flag = flagMessage({ from: "shady@example.com", body: "hello there" },
    { context: { reputationScore: snap.score } });
  assert.ok(keys(flag).includes("bad_reputation"));
});
test("a single confirmed-spam outcome marks the sender bad", () => {
  const rep = createSenderReputation();
  const snap = rep.record("spam@example.com", "spam_confirmed");
  assert.equal(snap.label, "bad");
});
test("flagged-but-not-quarantined senders sit at watch, not bad", () => {
  const rep = createSenderReputation();
  rep.record("iffy@example.com", "flagged");
  rep.record("iffy@example.com", "flagged");
  rep.record("iffy@example.com", "flagged");
  rep.record("iffy@example.com", "flagged");
  const snap = rep.get("iffy@example.com");
  assert.equal(snap.label, "watch");
  assert.ok(snap.score < 60);
});
test("worst() ranks senders by descending score", () => {
  const rep = createSenderReputation();
  rep.record("a@example.com", "flagged");
  rep.record("b@example.com", "spam_confirmed");
  rep.record("c@example.com", "quarantined");
  const order = rep.worst().map(s => s.senderKey);
  assert.deepEqual(order.slice(0, 2), ["b@example.com", "c@example.com"]);
});
test("reputation outcome validation is coded", () => {
  const rep = createSenderReputation();
  throwsSpam(() => rep.record("x@example.com", "blocked"), "invalid_scannable_message");
  throwsSpam(() => rep.record("", "clean"), "invalid_scannable_message");
});

// --- bulk-pattern detection -------------------------------------------------
test("large recipient set trips bulk_recipients", () => {
  const flag = flagMessage({ from: "promo@example.com", body: "Big sale today." },
    { context: { recipients: 120 } });
  assert.ok(keys(flag).includes("bulk_recipients"));
});
test("sender burst trips burst_sender", () => {
  const flag = flagMessage({ body: "msg", }, { context: { burstCount: 45 } });
  assert.ok(keys(flag).includes("burst_sender"));
});
test("small recipient sets and quiet senders stay clean", () => {
  const flag = flagMessage({ from: "a@example.com", body: "hello" },
    { context: { recipients: 3, burstCount: 2 } });
  assert.equal(flag.score, 0);
});
test("bulk + burst + bad reputation combines toward quarantine", () => {
  const flag = flagMessage({ from: "blaster@example.com", body: "Limited time offer! Click the link." },
    { context: { recipients: 200, burstCount: 60, reputationScore: 65 } });
  const ks = keys(flag);
  assert.ok(ks.includes("bulk_recipients"));
  assert.ok(ks.includes("burst_sender"));
  assert.ok(ks.includes("bot_spam_pattern"));
  assert.ok(ks.includes("bad_reputation"));
  assert.ok(flag.score >= quarantineThreshold);
});

// --- Telegram-specific signals ----------------------------------------------
const tgCtx = () => ({ botName: "Room Helper", botHandle: "@roomhelper_bot", senderHandle: "@nota_bot" });
test("impersonating the room bot from another handle is caught", () => {
  const flag = flagMessage({ from: "Room Helper", body: "Please forward your code." }, { context: tgCtx() });
  assert.ok(keys(flag).includes("telegram_impersonation"));
  assert.ok(flag.score >= 35);
});
test("the real bot handle is not flagged for impersonation", () => {
  const flag = flagMessage({ from: "Room Helper", body: "Please forward your code." },
    { context: { botName: "Room Helper", botHandle: "@roomhelper_bot", senderHandle: "@roomhelper_bot" } });
  assert.ok(!keys(flag).includes("telegram_impersonation"));
});
test("giveaway lure with a link is flagged", () => {
  const flag = flagMessage({ body: "AIRDROP! Send 1 TON and we double your crypto instantly." },
    { context: { ...tgCtx(), recipients: 0, burstCount: 0 }, });
  const withUrl = flagMessage({ body: "AIRDROP! Send 1 TON and we double your crypto instantly.", urls: ["https://example.com/claim"] }, { context: tgCtx() });
  assert.ok(!keys(flag).includes("telegram_giveaway_lure"));
  assert.ok(keys(withUrl).includes("telegram_giveaway_lure"));
});
test("t.me invite plus lure words is flagged", () => {
  const flag = flagMessage({ body: "Free VIP trading signals, join fast, limited spots: t.me/+AbCdEf123456" },
    { context: tgCtx() });
  assert.ok(keys(flag).includes("telegram_join_lure"));
});
test("plain t.me link without lure words stays clean", () => {
  const flag = flagMessage({ body: "Our channel: t.me/roomupdates" }, { context: tgCtx() });
  assert.equal(flag.score, 0);
});
test("full Telegram spam profile quarantines", () => {
  const flag = flagMessage(
    { from: "Room Helper", body: "AIRDROP! Double your TON! Click the link now: t.me/+claim" , urls: ["https://evil.top/claim"] },
    { context: { ...tgCtx(), burstCount: 50, reputationScore: 70 } });
  const ks = keys(flag);
  for (const k of ["telegram_impersonation", "telegram_giveaway_lure", "bot_spam_pattern", "burst_sender", "bad_reputation"]) {
    assert.ok(ks.includes(k), `expected signal ${k}`);
  }
  assert.ok(flag.quarantine);
});

// --- quarantine review queue (no silent drops) -------------------------------
const sampleFlag = () => flagMessage({ from: "evil <x@evil.top>", subject: "URGENT: verify now!",
  body: "Your account will be suspended. Log in here to verify your password now.",
  urls: [{ text: "https://mybank.com/login", target: "https://evil.top/login" }], attachments: [] });
test("quarantined mail lands in the pending queue, not dropped", () => {
  const q = createQuarantineQueue();
  const flag = sampleFlag();
  assert.ok(flag.quarantine);
  const rec = q.quarantine({ messageId: "msg-1", flag, channel: "email", connectionId: "conn-1" });
  assert.equal(rec.status, "pending");
  assert.equal(rec.messageId, "msg-1");
  assert.equal(rec.score, flag.score);
  assert.deepEqual(q.pending().map(r => r.id), [rec.id]);
  assert.deepEqual(q.counts(), { pending: 1, released: 0, confirmedSpam: 0 });
});
test("owner can release a false positive back to the inbox", () => {
  const q = createQuarantineQueue();
  const rec = q.quarantine({ messageId: "msg-2", flag: sampleFlag(), channel: "telegram", at: 1234 });
  const reviewed = q.review(rec.id, { decision: "release", reviewer: "owner-1", note: "newsletter" });
  assert.equal(reviewed.status, "released");
  assert.equal(reviewed.reviewedBy, "owner-1");
  assert.equal(reviewed.decision, "release");
  assert.equal(q.pending().length, 0);
  assert.deepEqual(q.counts(), { pending: 0, released: 1, confirmedSpam: 0 });
  // the record persists after review: nothing vanishes silently
  assert.equal(q.get(rec.id).status, "released");
});
test("owner can confirm spam; the record persists", () => {
  const q = createQuarantineQueue();
  const rec = q.quarantine({ messageId: "msg-3", flag: sampleFlag(), channel: "email" });
  q.review(rec.id, { decision: "confirm_spam", reviewer: "owner-1" });
  assert.equal(q.get(rec.id).status, "confirmed_spam");
  assert.deepEqual(q.counts(), { pending: 0, released: 0, confirmedSpam: 1 });
});
test("non-quarantine flags cannot enter the queue", () => {
  const q = createQuarantineQueue();
  const clean = flagMessage({ body: "hello" });
  throwsQz(() => q.quarantine({ messageId: "m", flag: clean, channel: "email" }), "invalid_quarantine");
});
test("reviews are final and unknown ids fail loudly", () => {
  const q = createQuarantineQueue();
  const rec = q.quarantine({ messageId: "m", flag: sampleFlag(), channel: "email" });
  q.review(rec.id, { decision: "release", reviewer: "owner-1" });
  throwsQz(() => q.review(rec.id, { decision: "release", reviewer: "owner-1" }), "invalid_quarantine");
  throwsQz(() => q.review("qz-999", { decision: "release", reviewer: "owner-1" }), "invalid_quarantine");
  throwsQz(() => q.review(rec.id, { decision: "maybe", reviewer: "owner-1" }), "invalid_quarantine");
});
test("scannableMessage shape still validates normally", () => {
  const m = scannableMessage({ body: "hi" });
  assert.equal(m.body, "hi");
  assert.throws(() => scannableMessage({}), () => true);
});
