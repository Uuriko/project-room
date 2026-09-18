// Spam-guard + quiet-hours wiring (tasks 32/34): the pure flagMessage and
// decideNotification modules must actually run on inbound messages. These
// tests cover the envelope mapping, the import-path wiring (spam flags and
// notify decisions journaled on source.import receipts), and the journal
// replay staying deterministic when the owner edits prefs after import.
// Fixture people and addresses are invented; nothing here is a real person.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { scannableOfEnvelope, scoreImportedEnvelope, decideImportedNotification,
  runImportGuards, replayImportedNotification } from "../server/inbox-import-guards.mjs";
import { createNotifyPrefs } from "../server/notify-prefs.mjs";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.account = f.store.accountForMember("commons", "owner");
  f.key = f.store.issueAccountAccessKey(f.account.id); const slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, ...f.store.loginAccountSession(slot.token, f.key, 0) };
  f.binding = f.auth.sessionBinding;
  return f;
}
const tgConn = accountId => ({ accountId, id: "telegram-guard", revision: 1, channel: "telegram", provider: "telegram-bot",
  externalId: "7000000007", identity: { kind: "bot", id: "7000000007", handle: "@roombot", displayName: "Room Bot" },
  capabilities: { read: true, send: false, threads: true, edit: false } });
const tgEnvelope = (conn, { updateId = 700001, messageId = 11, chatId = 5000000101, from, text }) => normalizeTelegramUpdate(conn,
  { update_id: updateId, message: { message_id: messageId, date: 1788948000,
    chat: { id: chatId, type: "private", first_name: "Alice" }, from, text } });
const importTelegram = (f, envelope) => {
  const sourceId = telegramSourceId(envelope.connection, envelope.message.id);
  let receipt;
  f.store.transaction(() => {
    receipt = f.store.inbox.importSource(f.auth.token, { action: "source.import", requestId: randomUUID(),
      sourceId, expectedRevision: 0, data: { adapter: "telegram", envelope } }, f.binding).receipt;
  });
  return receipt;
};
const inboxReceiptFor = (f, sourceId) => JSON.parse(f.store.db.prepare(
  "SELECT receipt_json FROM private_inbox_commands WHERE account_id=? AND json_extract(receipt_json,'$.action')='source.import' AND json_extract(receipt_json,'$.sourceId')=?")
  .get(f.account.id, sourceId).receipt_json);

// --- pure mapping -----------------------------------------------------------

test("scannableOfEnvelope maps a telegram envelope with impersonation context", () => {
  const conn = tgConn("acct-1");
  const envelope = tgEnvelope(conn, { from: { id: 5000000001, is_bot: false, first_name: "Room", last_name: "Bot", username: "evilclone" },
    text: "Claim your free airdrop now https://evil.example/claim" });
  const { value, context } = scannableOfEnvelope(envelope);
  assert.equal(value.from, "Room Bot @evilclone");
  assert.equal(value.body, "Claim your free airdrop now https://evil.example/claim");
  assert.deepEqual(value.urls, ["https://evil.example/claim"]);
  assert.equal(context.senderHandle, "@evilclone");
  assert.equal(context.botName, "Room Bot");
  assert.equal(context.botHandle, "@roombot");
});

test("scoreImportedEnvelope quarantines a bot-impersonating giveaway lure", () => {
  const conn = tgConn("acct-1");
  const envelope = tgEnvelope(conn, { from: { id: 5000000001, is_bot: false, first_name: "Room", last_name: "Bot", username: "evilclone" },
    text: "Claim your free airdrop now https://evil.example/claim" });
  const flag = scoreImportedEnvelope(envelope);
  assert.equal(flag.quarantine, true, `expected quarantine, got ${flag.score}`);
  const keys = flag.signals.map(s => s.key);
  assert.ok(keys.includes("telegram_impersonation"), `missing impersonation signal: ${keys}`);
  assert.ok(keys.includes("telegram_giveaway_lure"), `missing giveaway signal: ${keys}`);
});

test("scoreImportedEnvelope leaves a clean telegram message unflagged", () => {
  const conn = tgConn("acct-1");
  const envelope = tgEnvelope(conn, { from: { id: 5000000001, is_bot: false, first_name: "Alice", last_name: "Wonderland", username: "alice" },
    text: "Running ten minutes late, see you at the cafe." });
  const flag = scoreImportedEnvelope(envelope);
  assert.equal(flag.score, 0); assert.equal(flag.quarantine, false); assert.deepEqual(flag.signals, []);
});

test("scoreImportedEnvelope marks an unscannable envelope instead of throwing", () => {
  const flag = scoreImportedEnvelope({ channel: "telegram", message: {} });
  assert.equal(flag.unscannable, true); assert.equal(flag.score, 0); assert.equal(flag.quarantine, false);
});

test("scannableOfEnvelope maps an email envelope with reply-to and recipients", () => {
  const envelope = { channel: "email",
    message: { from: { name: "Mallory", address: "mallory@evil.example" }, subject: "Hi",
      replyTo: [{ name: "", address: "bounce@other.example" }],
      to: Array.from({ length: 30 }, (_, i) => ({ name: "", address: `victim${i}@example.com` })), cc: [], bcc: [] },
    body: { format: "text", content: "hello" } };
  const { value, context } = scannableOfEnvelope(envelope);
  assert.equal(value.from, "Mallory <mallory@evil.example>");
  assert.equal(value.replyTo, "bounce@other.example");
  assert.equal(context.recipients, 30);
  const flag = scoreImportedEnvelope(envelope);
  assert.ok(flag.signals.some(s => s.key === "bulk_recipients"));
});

// --- import-path wiring -----------------------------------------------------

test("importSource journals the spam flag on the receipt (spammy telegram DM)", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const envelope = tgEnvelope(conn, { from: { id: 5000000001, is_bot: false, first_name: "Room", last_name: "Bot", username: "evilclone" },
    text: "Claim your free airdrop now https://evil.example/claim" });
  const receipt = importTelegram(f, envelope);
  assert.equal(receipt.action, "source.import");
  assert.equal(receipt.spam.quarantine, true, `expected quarantine, got ${receipt.spam.score}`);
  assert.ok(receipt.spam.signals.some(s => s.key === "telegram_impersonation"));
  // Flag-only (task 33): the message still imports; nothing is held or moved.
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.notify.decision, "deliver", "default prefs deliver outside quiet hours");
  assert.equal(receipt.notify.connectionId, "telegram-guard");
});

test("importSource journals a clean spam score and respects quiet hours", t => {
  const f = fixture(t);
  const now = Date.now(), pad = n => String(n).padStart(2, "0");
  const hm = at => pad(new Date(at).getUTCHours()) + ":" + pad(new Date(at).getUTCMinutes());
  // A window covering "now" (wraps overnight when near midnight).
  f.store.inbox.notifyPrefs.setQuietHours(f.account.id, { start: hm(now - 3600000), end: hm(now + 3600000), tz: "UTC" });
  const conn = tgConn(f.account.id);
  const envelope = tgEnvelope(conn, { updateId: 700002, messageId: 12,
    from: { id: 5000000001, is_bot: false, first_name: "Alice", last_name: "Wonderland", username: "alice" },
    text: "Running ten minutes late, see you at the cafe." });
  const receipt = importTelegram(f, envelope);
  assert.equal(receipt.spam.quarantine, false);
  assert.equal(receipt.notify.decision, "hold", `expected hold in quiet hours, got ${receipt.notify.decision}`);
  assert.match(receipt.notify.reason, /quiet hours/);
  // Outside the window the same prefs release it.
  f.store.inbox.notifyPrefs.clearQuietHours(f.account.id);
  const again = importTelegram(f, tgEnvelope(conn, { updateId: 700003, messageId: 13,
    from: { id: 5000000001, is_bot: false, first_name: "Alice", last_name: "Wonderland", username: "alice" },
    text: "On my way." }));
  assert.equal(again.notify.decision, "deliver");
});

test("muted level and digest batching surface on the import receipt", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const envelope = options => tgEnvelope(conn, { updateId: options.updateId, messageId: options.messageId,
    from: { id: 5000000001, is_bot: false, first_name: "Alice", username: "alice" }, text: "ping" });
  f.store.inbox.notifyPrefs.setGlobal(f.account.id, { level: "muted" });
  const muted = importTelegram(f, envelope({ updateId: 700010, messageId: 20 }));
  assert.equal(muted.notify.decision, "muted");
  f.store.inbox.notifyPrefs.setGlobal(f.account.id, { level: "all" });
  f.store.inbox.notifyPrefs.setConnection(f.account.id, { connectionId: "telegram-guard", channel: "telegram", batching: "digest" });
  const digested = importTelegram(f, envelope({ updateId: 700011, messageId: 21 }));
  assert.equal(digested.notify.decision, "hold");
  assert.match(digested.notify.reason, /digest batching/);
});

test("email import through the channel importer also runs the guards", t => {
  const f = fixture(t);
  f.raw = emailContractFixture(); f.raw.connection.accountId = f.account.id;
  f.raw.message.subject = "URGENT! ACCOUNT SUSPENDED!";
  f.raw.message.body.content = "Your account will be suspended! Log in below to verify your account: https://evil-verify.xyz/login";
  const apply = request => f.store.email.apply(f.auth.token, request, f.binding);
  apply({ action: "connection.configure", requestId: randomUUID(), connectionId: f.raw.connection.id,
    expectedRevision: 0, profile: structuredClone(f.raw.connection) });
  const state = f.store.email.state(f.auth.token, f.raw.connection.id, f.raw.message.parentFolderId, f.binding);
  const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
  apply({ action: "page.apply", requestId: randomUUID(), connectionId: f.raw.connection.id,
    connectionRevision: f.raw.connection.revision, folderId: f.raw.message.parentFolderId,
    expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
    reset: state.needsReset, complete: true,
    observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] });
  const receipt = inboxReceiptFor(f, envelope.sourceId);
  assert.equal(receipt.spam.quarantine, true, `expected quarantine, got ${receipt.spam.score}`);
  const keys = receipt.spam.signals.map(s => s.key);
  assert.ok(keys.includes("credential_harvest") && keys.includes("suspicious_tld"), `unexpected signals: ${keys}`);
  assert.equal(receipt.notify.decision, "deliver");
});

// --- journal replay ---------------------------------------------------------

test("inbox verify replays guard decisions after the owner edits prefs", t => {
  const f = fixture(t);
  const now = Date.now(), pad = n => String(n).padStart(2, "0");
  const hm = at => pad(new Date(at).getUTCHours()) + ":" + pad(new Date(at).getUTCMinutes());
  f.store.inbox.notifyPrefs.setQuietHours(f.account.id, { start: hm(now - 3600000), end: hm(now + 3600000), tz: "UTC" });
  const conn = tgConn(f.account.id);
  const first = importTelegram(f, tgEnvelope(conn, { updateId: 700020, messageId: 30,
    from: { id: 5000000001, is_bot: false, first_name: "Alice", username: "alice" }, text: "ping" }));
  assert.equal(first.notify.decision, "hold");
  // The owner changes everything after the import: the replay must recompute
  // from the journaled snapshot, not the live prefs.
  f.store.inbox.notifyPrefs.clearQuietHours(f.account.id);
  f.store.inbox.notifyPrefs.setGlobal(f.account.id, { level: "muted" });
  const verified = f.store.inbox.verify();
  assert.equal(verified.sources, 1, `expected 1 source, got ${JSON.stringify(verified)}`);
  const reread = inboxReceiptFor(f, telegramSourceId(conn, "5000000101:30"));
  assert.equal(reread.notify.decision, "hold", "journaled decision survives prefs edits");
});

test("decideImportedNotification/replayImportedNotification round-trip", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("user-1", { start: "22:00", end: "07:00", tz: "UTC" });
  prefs.setConnection("user-1", { connectionId: "conn-1", channel: "telegram", batching: "immediate" });
  const envelope = { connection: { id: "conn-1" } };
  const at = Date.parse("2026-09-18T02:00:00Z");
  const decided = decideImportedNotification({ prefs, accountId: "user-1", envelope, at });
  assert.equal(decided.decision, "hold");
  const replayed = replayImportedNotification({ snapshot: decided.prefs, accountId: "user-1",
    connectionId: decided.connectionId, urgent: decided.urgent, at: decided.at });
  assert.deepEqual(replayed.decision, decided.decision);
  assert.deepEqual(replayed.prefs, decided.prefs);
});

test("runImportGuards returns both guards as frozen records", () => {
  const envelope = { channel: "telegram", connection: { id: "c", identity: { displayName: "Room Bot", handle: "@roombot" } },
    message: { from: { kind: "user", id: "1", handle: "@alice", displayName: "Alice" } },
    body: { format: "text", content: "hello" }, attachments: [] };
  const guards = runImportGuards({ prefs: createNotifyPrefs(), accountId: "u", envelope });
  assert.equal(guards.spam.score, 0); assert.equal(guards.notify.decision, "deliver");
  assert.ok(Object.isFrozen(guards) && Object.isFrozen(guards.spam) && Object.isFrozen(guards.notify));
});
