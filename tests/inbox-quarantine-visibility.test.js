// Quarantine visibility enforcement (task B, wave-10): held and dismissed
// journal rows must be honored by the four main inbox read paths — list,
// read, search, and threads — per docs/AUTO-QUARANTINE-POLICY.md §1 (held
// is held out of the main inbox) and §3 (dismissed stays out). Released
// rows return to the inbox. The review surface itself is the only view that
// shows held/dismissed rows.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { ServiceError } from "../server/store.mjs";

const throwsCode = (fn, status, code) => assert.throws(fn,
  error => error instanceof ServiceError && error.status === status && error.code === code);
const flag = (score = 75, key = "test_signal") => ({
  score, quarantine: score >= 60, signals: [{ key, weight: score, detail: `Test signal ${key} fired` }] });

// Two imported telegram messages on one connection, both journaled as held.
// Provider message ids are what the journal matches on.
function visibilityFixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const token = session.token, binding = session.sessionBinding;
  const conn = { accountId: account.id, id: "tg-visibility-conn", revision: 1, channel: "telegram", provider: "telegram-bot",
    externalId: "7000000004", identity: { kind: "bot", id: "7000000004", handle: "@visibility_bot", displayName: "Visibility Bot" },
    capabilities: { read: true, send: false, threads: true, edit: false } };
  const importMessage = (n, text) => {
    const envelope = normalizeTelegramUpdate(conn, { update_id: 900000 + n,
      message: { message_id: 200 + n, date: 1788948000 + n, chat: { id: 5000000300, type: "private", first_name: "Spammer" },
        from: { id: 5000000019, is_bot: false, first_name: "Spammer", last_name: "McSpam", username: "spammer" },
        text } });
    const sourceId = telegramSourceId(conn, `5000000300:${200 + n}`);
    f.store.transaction(() => f.store.inbox.importSource(token, { action: "source.import", requestId: randomUUID(),
      sourceId, expectedRevision: 0, data: { adapter: "telegram", envelope } }, binding));
    return { envelope, sourceId, providerId: envelope.message.id };
  };
  const first = importMessage(1, "You won a prize, claim now");
  const second = importMessage(2, "Urgent wire transfer needed");
  const hold1 = f.store.spamQuarantine.quarantine({ messageId: first.providerId, channel: "telegram",
    connectionId: conn.id, flag: flag(80, "prize_bait") });
  const hold2 = f.store.spamQuarantine.quarantine({ messageId: second.providerId, channel: "telegram",
    connectionId: conn.id, flag: flag(90, "wire_fraud") });
  return { f, account, token, binding, conn, first, second, hold1, hold2 };
}

const listIds = (f, token, binding) =>
  f.store.inbox.list(token, binding, { includeChannels: true }).sources.map(s => s.id);
const threadSourceIds = (f, token, binding) =>
  f.store.inbox.threads(token, binding, { includeChannels: true }).threads.flatMap(th => th.entries.map(e => e.source.id));
const searchIds = (f, token, binding, query) =>
  f.store.inbox.search(token, binding, { query, includeChannels: true });

test("held messages are hidden from the list view", t => {
  const { f, token, binding, first, second } = visibilityFixture(t);
  const ids = listIds(f, token, binding);
  assert.ok(!ids.includes(first.sourceId), "held message is out of the list");
  assert.ok(!ids.includes(second.sourceId), "second held message is out of the list");
});

test("held messages read as not-found", t => {
  const { f, token, binding, first, second } = visibilityFixture(t);
  throwsCode(() => f.store.inbox.read(token, first.sourceId, binding), 404, "inbox_source_not_found");
  throwsCode(() => f.store.inbox.read(token, second.sourceId, binding), 404, "inbox_source_not_found");
});

test("held messages are excluded from search results and totals", t => {
  const { f, token, binding } = visibilityFixture(t);
  const prize = searchIds(f, token, binding, "prize");
  assert.deepEqual(prize.results, [], "held message body is not searchable");
  assert.equal(prize.total, 0, "search total does not count held messages");
  const wire = searchIds(f, token, binding, "wire transfer");
  assert.deepEqual(wire.results, [], "second held message body is not searchable");
  assert.equal(wire.total, 0);
});

test("held messages are excluded from the thread view", t => {
  const { f, token, binding, first, second } = visibilityFixture(t);
  const ids = threadSourceIds(f, token, binding);
  assert.ok(!ids.includes(first.sourceId), "held message is out of every thread");
  assert.ok(!ids.includes(second.sourceId), "second held message is out of every thread");
});

test("dismissed messages stay hidden from all four read paths", t => {
  const { f, token, binding, first, second, hold1, hold2 } = visibilityFixture(t);
  f.store.inbox.quarantineDismiss(token, binding, { quarantineId: hold1.id });
  f.store.inbox.quarantineDismiss(token, binding, { quarantineId: hold2.id });
  assert.ok(!listIds(f, token, binding).includes(first.sourceId), "dismissed: out of list");
  throwsCode(() => f.store.inbox.read(token, first.sourceId, binding), 404, "inbox_source_not_found");
  const prize = searchIds(f, token, binding, "prize");
  assert.deepEqual(prize.results, [], "dismissed: out of search");
  assert.ok(!threadSourceIds(f, token, binding).includes(second.sourceId), "dismissed: out of threads");
});

test("releasing a hold returns the message to all four read paths", t => {
  const { f, token, binding, first, second, hold1 } = visibilityFixture(t);
  f.store.inbox.quarantineRelease(token, binding, { quarantineId: hold1.id });
  assert.ok(listIds(f, token, binding).includes(first.sourceId), "released: back in list");
  const read = f.store.inbox.read(token, first.sourceId, binding);
  assert.equal(read.source.id, first.sourceId, "released: readable again");
  const prize = searchIds(f, token, binding, "prize");
  assert.ok(prize.results.some(r => r.source.id === first.sourceId), "released: searchable again");
  assert.ok(prize.total >= 1, "released: counted in search total");
  assert.ok(threadSourceIds(f, token, binding).includes(first.sourceId), "released: back in threads");
  // The other hold is untouched: still hidden everywhere.
  assert.ok(!listIds(f, token, binding).includes(second.sourceId), "other held message still hidden");
  throwsCode(() => f.store.inbox.read(token, second.sourceId, binding), 404, "inbox_source_not_found");
});

test("a hold that does not resolve to this account's sources hides nothing", t => {
  const { f, token, binding, first, hold1 } = visibilityFixture(t);
  f.store.inbox.quarantineRelease(token, binding, { quarantineId: hold1.id });
  assert.ok(listIds(f, token, binding).includes(first.sourceId), "released message is visible");
  // Same provider message id and channel, but a connection this account's
  // source was never imported on: quarantineMatch must not resolve it.
  f.store.spamQuarantine.quarantine({ messageId: first.providerId, channel: "telegram",
    connectionId: "someone-elses-connection", flag: flag(80, "prize_bait") });
  // And a hold for a message id that was never imported at all.
  f.store.spamQuarantine.quarantine({ messageId: "ghost-message-9", channel: "telegram",
    connectionId: "ghost-connection", flag: flag(80, "prize_bait") });
  assert.ok(listIds(f, token, binding).includes(first.sourceId), "non-matching hold hides nothing");
  const review = f.store.inbox.quarantineReview(token, binding, {});
  assert.ok(!review.items.some(i => i.messageId === "ghost-message-9"), "unresolvable hold is not in this account's backlog");
});

test("a hold with explicit account/source ids is also enforced", t => {
  const { f, account, token, binding, first, hold1 } = visibilityFixture(t);
  f.store.inbox.quarantineRelease(token, binding, { quarantineId: hold1.id });
  assert.ok(listIds(f, token, binding).includes(first.sourceId), "released message is visible");
  // Gap #2 (PR #563): the hold records the importing account and the inbox
  // source id; enforcement must honor the explicit link too.
  const explicit = f.store.spamQuarantine.quarantine({ messageId: first.providerId, channel: "telegram",
    connectionId: "ignored-because-sourceId-wins", accountId: account.id, sourceId: first.sourceId,
    flag: flag(85, "explicit_link") });
  assert.ok(!listIds(f, token, binding).includes(first.sourceId), "explicit hold hides the source from the list");
  throwsCode(() => f.store.inbox.read(token, first.sourceId, binding), 404, "inbox_source_not_found");
  assert.ok(!threadSourceIds(f, token, binding).includes(first.sourceId), "explicit hold hides the source from threads");
  f.store.inbox.quarantineRelease(token, binding, { quarantineId: explicit.id });
  assert.ok(listIds(f, token, binding).includes(first.sourceId), "released explicit hold returns the source");
});

test("the review surface still shows held and dismissed rows", t => {
  const { f, token, binding, hold1, hold2 } = visibilityFixture(t);
  f.store.inbox.quarantineDismiss(token, binding, { quarantineId: hold2.id });
  const held = f.store.inbox.quarantineReview(token, binding, {});
  assert.ok(held.items.some(i => i.id === hold1.id), "held row still in the review backlog");
  const dismissed = f.store.inbox.quarantineReview(token, binding, { status: "dismissed" });
  assert.ok(dismissed.items.some(i => i.id === hold2.id), "dismissed row still in the audit history");
});
