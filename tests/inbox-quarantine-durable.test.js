// Quarantine durability switch: the spam quarantine path files tripped
// messages into the durable spam_quarantine journal (store.spamQuarantine),
// not the in-memory createQuarantineQueue (which loses its queue on restart).
// These tests prove the import funnel journals on a tripped flag, that held
// records survive a store reopen, and that the journal's review() still
// speaks the queue's release|confirm_spam vocabulary. Fixture people and
// addresses are invented; nothing here is a real person.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { RoomStore, ServiceError } from "../server/store.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { try { f.store.close(); } catch { /* already closed by a reopen test */ } rmSync(f.directory, { recursive: true, force: true }); });
  f.account = f.store.accountForMember("commons", "owner");
  f.key = f.store.issueAccountAccessKey(f.account.id); const slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, ...f.store.loginAccountSession(slot.token, f.key, 0) };
  f.binding = f.auth.sessionBinding;
  return f;
}
// Email-path fixture (the registered source.import writer that
// EmailImport.verify() expects, so a store reopen reconciles).
function emailFixture(t) {
  const f = fixture(t);
  f.raw = emailContractFixture(); f.raw.connection.accountId = f.account.id;
  f.apply = request => f.store.email.apply(f.auth.token, request, f.binding);
  f.configure = () => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: f.raw.connection.id,
    expectedRevision: 0, profile: structuredClone(f.raw.connection) });
  f.envelope = () => normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
  f.page = () => {
    const envelope = f.envelope();
    const head = f.store.db.prepare("SELECT revision FROM private_inbox_sources WHERE account_id=? AND id=?").get(f.account.id, envelope.sourceId);
    const state = f.store.email.state(f.auth.token, f.raw.connection.id, f.raw.message.parentFolderId, f.binding);
    return { action: "page.apply", requestId: randomUUID(), connectionId: f.raw.connection.id,
      connectionRevision: f.raw.connection.revision, folderId: f.raw.message.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
      reset: state.needsReset, complete: true,
      observations: [{ kind: "message", expectedSourceRevision: head?.revision ?? 0, envelope }] };
  };
  return f;
}
const spammyEmail = f => {
  f.raw.message.from = { emailAddress: { name: "Airdrop Official", address: "airdrop@evil.example" } };
  f.raw.message.subject = "URGENT!! FREE CRYPTO AIRDROP";
  f.raw.message.body.content = "Send us your crypto to double your money! Log in here to confirm your identity and claim your free airdrop: https://claim-free-airdrop.xyz/verify Act now!";
};
const tgConn = accountId => ({ accountId, id: "telegram-guard", revision: 1, channel: "telegram", provider: "telegram-bot",
  externalId: "7000000007", identity: { kind: "bot", id: "7000000007", handle: "@roombot", displayName: "Room Bot" },
  capabilities: { read: true, send: false, threads: true, edit: false } });
const tgEnvelope = (conn, { updateId = 700001, messageId = 11, chatId = 5000000101, from, text }) => normalizeTelegramUpdate(conn,
  { update_id: updateId, message: { message_id: messageId, date: 1788948000,
    chat: { id: chatId, type: "private", first_name: "Alice" }, from, text } });
const spamFrom = { id: 5000000002, is_bot: false, first_name: "Airdrop", last_name: "Official", username: "airdrop_official" };
const spamText = "URGENT!! Send us your crypto to double your money! Log in here to confirm your identity: https://claim-free-airdrop.xyz/verify Act now!";
const cleanFrom = { id: 5000000003, is_bot: false, first_name: "Avery", username: "avery" };
const cleanText = "Hey, are we still on for lunch tomorrow?";
const importTelegram = (f, envelope, requestId = randomUUID()) => {
  const sourceId = telegramSourceId(envelope.connection, envelope.message.id);
  let result;
  f.store.transaction(() => {
    result = f.store.inbox.importSource(f.auth.token, { action: "source.import", requestId,
      sourceId, expectedRevision: 0, data: { adapter: "telegram", envelope } }, f.binding);
  });
  return { result, envelope, sourceId };
};
const sqlRows = store => store.db.prepare("SELECT * FROM spam_quarantine").all();

test("a tripped spam guard journals a held record in the durable journal on import", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const envelope = tgEnvelope(conn, { from: spamFrom, text: spamText });
  const { result } = importTelegram(f, envelope);
  assert.equal(result.receipt.spam.quarantine, true, "the fixture text must trip the spam guard");
  assert.equal(result.receipt.spam.score >= 60, true);
  const held = f.store.spamQuarantine.held();
  assert.equal(held.length, 1, "the tripped message must be journaled, not lost");
  const record = held[0];
  assert.deepEqual({ messageId: record.messageId, channel: record.channel, connectionId: record.connectionId,
    status: record.status, score: record.score, reviewedBy: record.reviewedBy },
    { messageId: envelope.message.id, channel: "telegram", connectionId: "telegram-guard",
      status: "held", score: result.receipt.spam.score, reviewedBy: null });
  assert.deepEqual(record.reason, result.receipt.spam.signals.map(s => ({ key: s.key, weight: s.weight, detail: s.detail })),
    "the journaled reason is the flag's signal list");
  assert.equal(sqlRows(f.store).length, 1, "the record is in the spam_quarantine table, not an in-memory queue");
  assert.match(sqlRows(f.store)[0].id, /^qz-[1-9][0-9]*$/);
});

test("a clean import journals nothing", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const { result } = importTelegram(f, tgEnvelope(conn, { messageId: 12, updateId: 700002, from: cleanFrom, text: cleanText }));
  assert.equal(result.receipt.spam.quarantine, false);
  assert.deepEqual(f.store.spamQuarantine.held(), []);
  assert.equal(sqlRows(f.store).length, 0);
});

test("an unscannable envelope journals nothing", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  // Empty body: the scorer records unscannable (score 0) instead of failing.
  const envelope = tgEnvelope(conn, { messageId: 13, updateId: 700003, from: cleanFrom, text: "" });
  envelope.body.content = "";
  const { result } = importTelegram(f, envelope);
  assert.equal(result.receipt.spam.quarantine, false);
  assert.deepEqual(f.store.spamQuarantine.held(), []);
});

test("held records survive a store reopen and review() keeps the queue vocabulary", t => {
  const f = emailFixture(t);
  spammyEmail(f);
  f.configure(); f.apply(f.page());
  const receipt = JSON.parse(f.store.db.prepare(
    "SELECT receipt_json FROM private_inbox_commands WHERE account_id=? AND json_extract(request_json,'$.action')='source.import'")
    .get(f.account.id).receipt_json);
  assert.equal(receipt.spam.quarantine, true, "the spammy email fixture must trip the spam guard");
  const held = f.store.spamQuarantine.held();
  assert.equal(held.length, 1, "the tripped import must be journaled");
  assert.equal(held[0].channel, "email");
  assert.equal(held[0].messageId, f.envelope().message.id);
  const id = held[0].id;
  // The email path also survives the store's own integrity gates.
  f.store.inbox.verify(); f.store.email.verify();
  // Simulate a process restart: close and reopen the store on the same file.
  f.store.close();
  const reopened = new RoomStore(f.filename);
  f.store = reopened; // the t.after() hook closes whichever store is current
  const resumed = reopened.spamQuarantine.held();
  assert.equal(resumed.length, 1, "the held record must survive the restart");
  assert.equal(resumed[0].id, id, "quarantine ids are stable across the restart");
  assert.deepEqual(resumed[0].reason, receipt.spam.signals.map(s => ({ key: s.key, weight: s.weight, detail: s.detail })));
  assert.deepEqual(reopened.spamQuarantine.verify(), { held: 1, released: 0, dismissed: 0 });
  // The review() bridge still speaks the in-memory queue's vocabulary.
  const dismissed = reopened.spamQuarantine.review(id, { decision: "confirm_spam", reviewer: "owner" });
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.reviewedBy, "owner");
  assert.deepEqual(reopened.spamQuarantine.held(), [], "reviewed rows leave the held backlog");
  assert.throws(() => reopened.spamQuarantine.review(id, { decision: "release", reviewer: "owner" }),
    error => error instanceof ServiceError && error.status === 409 && error.code === "quarantine_already_reviewed",
    "reviews stay final");
  assert.throws(() => reopened.spamQuarantine.review("qz-404", { decision: "release", reviewer: "owner" }),
    error => error instanceof ServiceError && error.status === 404, "unknown ids stay unknown");
});

test("review() with release keeps working after a restart", t => {
  const f = emailFixture(t);
  spammyEmail(f);
  f.configure(); f.apply(f.page());
  const id = f.store.spamQuarantine.held()[0].id;
  f.store.close();
  const reopened = new RoomStore(f.filename);
  f.store = reopened;
  const released = reopened.spamQuarantine.review(id, { decision: "release", reviewer: "owner", note: "false positive" });
  assert.equal(released.status, "released");
  assert.equal(released.note, "false positive");
  assert.deepEqual(reopened.spamQuarantine.counts(), { held: 0, released: 1, dismissed: 0 });
});

test("a duplicate import requestId does not double-journal", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const envelope = tgEnvelope(conn, { from: spamFrom, text: spamText });
  const requestId = randomUUID();
  const first = importTelegram(f, envelope, requestId);
  assert.equal(first.result.duplicate, false);
  const second = importTelegram(f, envelope, requestId);
  assert.equal(second.result.duplicate, true, "the idempotency guard must short-circuit the retry");
  assert.equal(f.store.spamQuarantine.held().length, 1, "the retry must not file a second quarantine record");
});

test("the receipt itself is unchanged: no quarantine id leaks into the journaled receipt", t => {
  const f = fixture(t);
  const conn = tgConn(f.account.id);
  const { result } = importTelegram(f, tgEnvelope(conn, { from: spamFrom, text: spamText }));
  assert.equal(result.receipt.quarantineId, undefined, "the receipt keeps the pure flag; the journal row is the store of record");
  f.store.inbox.verify(); // the journal write must not disturb inbox journal replay
});
