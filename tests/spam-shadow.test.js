// Shadow-mode auto-quarantine instrumentation (AUTO-QUARANTINE-POLICY.md v1,
// §5): the room logs what WOULD have been held under the proposed hold
// threshold without changing flag-only enforcement. These tests cover the pure
// decision function (threshold boundary, every hard gate, determinism), the
// envelope gate derivation, and the import-path wiring (one decision per
// scored message on the source.import receipt, journal replay stays
// deterministic, enforcement behavior unchanged). Fixture people and addresses
// are invented; nothing here is a real person.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { quarantineThreshold } from "../server/inbox-spam.mjs";
import { shadowPolicyVersion, shadowHoldThreshold, shadowFlagOnlyChannels, shadowGateKeys,
  shadowGatesOfEnvelope, evaluateShadowHold, shadowDecisionForImport, ShadowError } from "../server/spam-shadow.mjs";

const flag = (score, signals = []) => ({ score, signals: signals.map(([key, weight]) => ({ key, weight, detail: `${key} detail` })), quarantine: score >= 60 });
// Recursive key-sorting canonicalizer for determinism comparisons.
const canonical = value => JSON.stringify(value, (key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
  ? Object.fromEntries(Object.keys(nested).sort().map(k => [k, nested[k]])) : nested);

// --- threshold: single shared number, one source of truth -------------------

test("the shadow hold threshold is 60 and tracks the scorer's quarantineThreshold", () => {
  assert.equal(shadowHoldThreshold, 60);
  assert.equal(shadowHoldThreshold, quarantineThreshold, "one threshold, one source of truth");
  assert.equal(shadowPolicyVersion, "v1");
});

// --- pure decision -----------------------------------------------------------

test("score 60 with no gates would hold; score 59 would not", () => {
  const hold = evaluateShadowHold({ flag: flag(60, [["telegram_impersonation", 35], ["telegram_giveaway_lure", 25]]),
    channel: "telegram", connectionId: "c1", messageId: "m1", gates: shadowGatesOfEnvelope({ channel: "telegram",
      message: { id: "m1", replyTo: null, from: { id: "u9" } }, connection: { id: "c1", identity: { id: "b1" } } }), at: 1000 });
  assert.equal(hold.wouldHold, true);
  assert.equal(hold.gateBlock, null);
  assert.equal(hold.threshold, 60);
  assert.equal(hold.score, 60);
  assert.equal(hold.policyVersion, "v1");
  assert.deepEqual(hold.features, [{ key: "telegram_impersonation", weight: 35, detail: "telegram_impersonation detail" },
    { key: "telegram_giveaway_lure", weight: 25, detail: "telegram_giveaway_lure detail" }]);
  const pass = evaluateShadowHold({ flag: flag(59), channel: "telegram", at: 1000 });
  assert.equal(pass.wouldHold, false);
  assert.equal(pass.gateBlock, null);
});

test("every hard gate blocks the hold and is named in gateBlock", () => {
  const gates = { allowlisted: true, existingThread: true, verifiedConnector: true, serviceNotification: true };
  for (const key of ["allowlisted", "existingThread", "verifiedConnector", "serviceNotification"]) {
    const single = { ...gates };
    for (const other of Object.keys(single)) if (other !== key) single[other] = false;
    const decision = evaluateShadowHold({ flag: flag(100), channel: "telegram", gates: single, at: 1000 });
    assert.equal(decision.wouldHold, false, `gate ${key} must block`);
    assert.equal(decision.gateBlock, key);
    assert.equal(decision.gates[key].blocked, true);
    assert.equal(decision.gates[key].evaluated, true);
  }
  const personal = evaluateShadowHold({ flag: flag(100), channel: "telegram-personal", at: 1000 });
  assert.equal(personal.wouldHold, false, "personal telegram chats stay flag-only");
  assert.equal(personal.gateBlock, "flagOnlyChannel");
  assert.ok(shadowFlagOnlyChannels.includes("telegram-personal"));
});

test("gateBlock names the first blocking gate in policy order", () => {
  const decision = evaluateShadowHold({ flag: flag(90), channel: "telegram",
    gates: { allowlisted: false, existingThread: true, verifiedConnector: true, serviceNotification: false }, at: 1 });
  assert.equal(decision.gateBlock, "existingThread");
  assert.equal(decision.gates.verifiedConnector.blocked, true);
});

test("null gates are not evaluated and never block", () => {
  const decision = evaluateShadowHold({ flag: flag(80), channel: "telegram",
    gates: { allowlisted: null, existingThread: false, verifiedConnector: null, serviceNotification: null }, at: 1 });
  assert.equal(decision.wouldHold, true);
  assert.equal(decision.gates.allowlisted.evaluated, false);
  assert.equal(decision.gates.allowlisted.blocked, false);
  assert.equal(decision.gates.serviceNotification.evaluated, false);
  assert.deepEqual(Object.keys(decision.gates).sort(), [...shadowGateKeys].sort());
});

test("the decision is frozen, JSON-stable, and deterministic", () => {
  const input = { flag: flag(75, [["link_text_mismatch", 30]]), channel: "email", connectionId: "c9",
    messageId: "m9", gates: { allowlisted: null, existingThread: false, verifiedConnector: false, serviceNotification: null }, at: 424242 };
  const a = evaluateShadowHold(input), b = evaluateShadowHold(input);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.gates) && Object.isFrozen(a.features) && a.features.every(Object.isFrozen));
  assert.equal(canonical(a), canonical(b), "same inputs must produce the same decision");
  const roundTripped = JSON.parse(JSON.stringify(a));
  assert.deepEqual(roundTripped, JSON.parse(JSON.stringify(b)), "JSON round-trip is stable across identical decisions");
  assert.equal(roundTripped.wouldHold, a.wouldHold);
  assert.equal(roundTripped.gateBlock, a.gateBlock);
  assert.equal(roundTripped.score, 75);
});

test("invalid inputs fail with coded errors", () => {
  assert.throws(() => evaluateShadowHold({ flag: null }), ShadowError);
  assert.throws(() => evaluateShadowHold({ flag: { score: -1, signals: [] } }), ShadowError);
  assert.throws(() => evaluateShadowHold({ flag: flag(10), gates: { bogus: true } }), /unknown gate/);
  assert.throws(() => evaluateShadowHold({ flag: flag(10), gates: { allowlisted: "yes" } }), ShadowError);
  assert.throws(() => shadowDecisionForImport({ flag: flag(10), envelope: null }), ShadowError);
  assert.throws(() => shadowGatesOfEnvelope(null), ShadowError);
});

// --- envelope gate derivation -------------------------------------------------

const tgConn = accountId => ({ accountId, id: "telegram-guard", revision: 1, channel: "telegram", provider: "telegram-bot",
  externalId: "7000000007", identity: { kind: "bot", id: "7000000007", handle: "@roombot", displayName: "Room Bot" },
  capabilities: { read: true, send: false, threads: true, edit: false } });
const tgEnvelope = (conn, { updateId = 700001, messageId = 11, chatId = 5000000101, from, text, replyToMessageId = null }) => normalizeTelegramUpdate(conn,
  { update_id: updateId, message: { message_id: messageId, date: 1788948000,
    chat: { id: chatId, type: "private", first_name: "Alice" }, from, text,
    ...(replyToMessageId === null ? {} : { reply_to_message: { message_id: replyToMessageId } }) } });
const impersonator = { id: 5000000001, is_bot: false, first_name: "Room", last_name: "Bot", username: "evilclone" };
const lureText = "Claim your free airdrop now https://evil.example/claim";
const cleanFrom = { id: 5000000003, is_bot: false, first_name: "Avery", username: "avery" };

test("telegram gates: reply marker blocks, own-bot sender blocks, plain message passes", () => {
  const conn = tgConn("acct-1");
  const plain = shadowGatesOfEnvelope(tgEnvelope(conn, { from: cleanFrom, text: "hello" }));
  assert.equal(plain.existingThread, false);
  assert.equal(plain.verifiedConnector, false);
  const reply = shadowGatesOfEnvelope(tgEnvelope(conn, { messageId: 12, updateId: 700002, from: cleanFrom, text: "hello", replyToMessageId: 11 }));
  assert.equal(reply.existingThread, true, "a reply_to_message marks an existing-thread reply");
  const own = shadowGatesOfEnvelope(tgEnvelope(conn, { messageId: 13, updateId: 700003,
    from: { id: 7000000007, is_bot: true, first_name: "Room Bot", username: "roombot" }, text: "hello" }));
  assert.equal(own.verifiedConnector, true, "the room's own bot identity is a verified connector");
  assert.equal(plain.allowlisted, null, "no allowlist store yet: gate open, recorded as unevaluated");
  assert.equal(plain.serviceNotification, null, "no machine-generated markers yet: gate open, recorded as unevaluated");
});

test("email gates: reply headers block, own alias sender blocks, unknown headers stay unevaluated", () => {
  const base = channel => ({ channel, message: { id: "m", from: { name: "Mallory", address: "mallory@evil.example" } },
    connection: { id: "c", identity: { name: "Owner", address: "owner@example.com" }, aliases: [{ name: "", address: "me@example.com" }] },
    replyHeaders: { state: "complete", inReplyTo: [], references: [] } });
  const first = shadowGatesOfEnvelope(base("email"));
  assert.equal(first.existingThread, false);
  assert.equal(first.verifiedConnector, false);
  const replyEnv = base("email");
  replyEnv.replyHeaders.inReplyTo = ["<abc@evil.example>"];
  assert.equal(shadowGatesOfEnvelope(replyEnv).existingThread, true);
  const ownEnv = base("email");
  ownEnv.message.from = { name: "Me", address: "me@example.com" };
  assert.equal(shadowGatesOfEnvelope(ownEnv).verifiedConnector, true, "own alias is a verified connector");
  const unknownEnv = base("email");
  unknownEnv.replyHeaders = { state: "not_loaded", inReplyTo: [], references: [] };
  assert.equal(shadowGatesOfEnvelope(unknownEnv).existingThread, null, "unloaded headers cannot prove a reply");
  assert.equal(shadowGatesOfEnvelope({ channel: "whatsapp", message: {}, connection: {} }).existingThread, null);
});

test("shadowDecisionForImport picks up channel, connection, and message ids", () => {
  const conn = tgConn("acct-1");
  const envelope = tgEnvelope(conn, { from: impersonator, text: lureText });
  const decision = shadowDecisionForImport({ flag: flag(60), envelope, at: 777 });
  assert.equal(decision.channel, "telegram");
  assert.equal(decision.connectionId, "telegram-guard");
  assert.equal(decision.messageId, envelope.message.id);
  assert.equal(decision.at, 777);
  assert.equal(decision.wouldHold, true, "impersonation 35 + giveaway lure 25 clears 60 with no gates");
});

// --- import-path wiring: instrumentation fires, enforcement unchanged --------

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.account = f.store.accountForMember("commons", "owner");
  f.key = f.store.issueAccountAccessKey(f.account.id); const slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, ...f.store.loginAccountSession(slot.token, f.key, 0) };
  f.binding = f.auth.sessionBinding;
  return f;
}
const importTelegram = (f, envelope, requestId = randomUUID()) => {
  const sourceId = telegramSourceId(envelope.connection, envelope.message.id);
  let receipt;
  f.store.transaction(() => {
    receipt = f.store.inbox.importSource(f.auth.token, { action: "source.import", requestId,
      sourceId, expectedRevision: 0, data: { adapter: "telegram", envelope } }, f.binding).receipt;
  });
  return { receipt, envelope, sourceId };
};

test("a would-be hold is logged on the receipt; the message still lands in the inbox (flag-only)", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const envelope = tgEnvelope(conn, { from: impersonator, text: lureText });
  const { receipt } = importTelegram(f, envelope);
  assert.equal(receipt.spam.quarantine, true, "the fixture must trip the spam guard");
  const shadow = receipt.shadowQuarantine;
  assert.ok(shadow, "every scored import carries a shadow decision");
  assert.equal(shadow.wouldHold, true);
  assert.equal(shadow.score, receipt.spam.score);
  assert.equal(shadow.threshold, 60);
  assert.equal(shadow.policyVersion, "v1");
  assert.equal(shadow.gateBlock, null);
  assert.equal(shadow.messageId, envelope.message.id, "messageId is the join key to later review outcomes");
  assert.deepEqual(shadow.features, receipt.spam.signals.map(s => ({ key: s.key, weight: s.weight, detail: s.detail })));
  // Enforcement unchanged: the message still lands in the inbox (flag-only),
  // and the durable quarantine journal still files the tripped flag as before.
  assert.equal(f.store.inbox.verify().sources, 1, "the import landed in the inbox");
  assert.equal(f.store.spamQuarantine.held().length, 1, "existing journal behavior unchanged");
  assert.equal(f.store.spamQuarantine.held()[0].messageId, envelope.message.id);
});

test("a clean import logs wouldHold false and journals nothing new", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const { receipt } = importTelegram(f, tgEnvelope(conn, { messageId: 21, updateId: 700021, from: cleanFrom,
    text: "Running ten minutes late, see you at the cafe." }));
  assert.equal(receipt.spam.quarantine, false);
  assert.equal(receipt.shadowQuarantine.wouldHold, false);
  assert.equal(receipt.shadowQuarantine.score, 0);
  assert.deepEqual(receipt.shadowQuarantine.features, []);
  assert.deepEqual(f.store.spamQuarantine.held(), []);
  assert.doesNotThrow(() => f.store.inbox.verify(), "journal replay recomputes the shadow decision deterministically");
});

test("a high-scoring reply is shadow-blocked by the existing-thread gate but enforcement is untouched", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const envelope = tgEnvelope(conn, { messageId: 31, updateId: 700031, from: impersonator, text: lureText, replyToMessageId: 30 });
  const { receipt } = importTelegram(f, envelope);
  assert.equal(receipt.spam.quarantine, true, "the spam flag still trips");
  assert.equal(receipt.shadowQuarantine.wouldHold, false, "a threaded reply would never be auto-held");
  assert.equal(receipt.shadowQuarantine.gateBlock, "existingThread");
  assert.equal(f.store.spamQuarantine.held().length, 1, "the journal still files on the flag alone — shadow gates change nothing");
  assert.doesNotThrow(() => f.store.inbox.verify());
});

test("the shadow decision survives a journal round-trip with identical bytes", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const { receipt, sourceId } = importTelegram(f, tgEnvelope(conn, { from: impersonator, text: lureText }));
  const stored = JSON.parse(f.store.db.prepare(
    "SELECT receipt_json FROM private_inbox_commands WHERE account_id=? AND json_extract(receipt_json,'$.sourceId')=?")
    .get(f.account.id, sourceId).receipt_json);
  assert.deepEqual(stored.shadowQuarantine, JSON.parse(JSON.stringify(receipt.shadowQuarantine)),
    "the journaled decision round-trips byte-identically for the shadow report query");
  assert.doesNotThrow(() => f.store.inbox.verify(), "verify() replays the shadow decision from journaled inputs");
});
