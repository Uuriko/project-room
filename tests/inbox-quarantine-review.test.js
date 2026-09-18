// Quarantine review UI (worker C): the held-message review surface. Covers
// the status-aware journal listing, the account-scoped review projection and
// the Confirm / Dismiss / Split actions at the service layer and over HTTP,
// the durable thread-split journal (offline integrity, read-only opens,
// reopen survival), and the client validators.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { RoomStore, ServiceError } from "../server/store.mjs";
import { InboxClient } from "../src/inbox-client.js";

const throwsCode = (fn, status, code) => assert.throws(fn,
  error => error instanceof ServiceError && error.status === status && error.code === code);
const flag = (score = 75, key = "test_signal") => ({
  score, quarantine: score >= 60, signals: [{ key, weight: score, detail: `Test signal ${key} fired` }] });

// Import two telegram messages on one connection; quarantine both. The
// provider message ids are what the journal matches on.
function quarantineFixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const token = session.token, binding = session.sessionBinding;
  const conn = { accountId: account.id, id: "tg-quarantine-conn", revision: 1, channel: "telegram", provider: "telegram-bot",
    externalId: "7000000003", identity: { kind: "bot", id: "7000000003", handle: "@quarantine_bot", displayName: "Quarantine Bot" },
    capabilities: { read: true, send: false, threads: true, edit: false } };
  const importMessage = (n, text) => {
    const envelope = normalizeTelegramUpdate(conn, { update_id: 800000 + n,
      message: { message_id: 100 + n, date: 1788948000 + n, chat: { id: 5000000200, type: "private", first_name: "Spammer" },
        from: { id: 5000000009, is_bot: false, first_name: "Spammer", last_name: "McSpam", username: "spammer" },
        text } });
    const sourceId = telegramSourceId(conn, `5000000200:${100 + n}`);
    f.store.transaction(() => f.store.inbox.importSource(token, { action: "source.import", requestId: randomUUID(),
      sourceId, expectedRevision: 0, data: { adapter: "telegram", envelope } }, binding));
    return { envelope, sourceId, providerId: envelope.message.id };
  };
  const first = importMessage(1, "You won a prize, claim now");
  const second = importMessage(2, "Urgent wire transfer needed");
  const hold1 = f.store.spamQuarantine.quarantine({ messageId: first.providerId, channel: "telegram",
    connectionId: conn.id, flag: flag(80, "prize_bait"), at: Date.now() - 2000 });
  const hold2 = f.store.spamQuarantine.quarantine({ messageId: second.providerId, channel: "telegram",
    connectionId: conn.id, flag: flag(90, "wire_fraud"), at: Date.now() - 1000 });
  return { f, account, token, binding, conn, first, second, hold1, hold2 };
}

test("review lists held items with scores, reasons, sender, channel and age", t => {
  const { f, token, binding, hold1 } = quarantineFixture(t);
  const review = f.store.inbox.quarantineReview(token, binding, {});
  assert.equal(review.contractVersion, 1);
  assert.equal(review.status, "held");
  assert.equal(review.items.length, 2);
  const item = review.items.find(i => i.id === hold1.id);
  assert.equal(item.score, 80);
  assert.ok(item.reason.length > 0 && item.reason.every(s => typeof s.key === "string" && typeof s.weight === "number" && typeof s.detail === "string"));
  assert.equal(item.channel, "telegram");
  assert.ok(Number.isSafeInteger(item.quarantinedAt));
  assert.ok(item.source && typeof item.source.id === "string", "held row resolves to the imported source");
  assert.ok(typeof item.source.sender === "string" && item.source.sender.length > 0, "sender is shown");
});

test("review is account-scoped: another account never sees or touches these holds", t => {
  const { f, token, binding, hold1 } = quarantineFixture(t);
  const other = f.store.createAccount("quarantine-stranger", "stranger");
  const otherKey = f.store.issueAccountAccessKey(other.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, otherKey, 0) };
  const review = f.store.inbox.quarantineReview(session.token, session.sessionBinding, {});
  assert.deepEqual(review.items, []);
  assert.deepEqual(review.counts, { held: 0, released: 0, dismissed: 0 });
  throwsCode(() => f.store.inbox.quarantineRelease(session.token, session.sessionBinding, { quarantineId: hold1.id }), 404, "quarantine_not_found");
});

test("the held row resolves to the source on the same connection", t => {
  const { f, token, binding, hold1, first, conn } = quarantineFixture(t);
  const review = f.store.inbox.quarantineReview(token, binding, {});
  const item = review.items.find(i => i.id === hold1.id);
  assert.equal(item.source.id, first.sourceId);
  assert.equal(item.connectionId, conn.id);
});

test("held items list oldest first", t => {
  const { f, token, binding, hold1, hold2 } = quarantineFixture(t);
  const review = f.store.inbox.quarantineReview(token, binding, { status: "held" });
  assert.deepEqual(review.items.map(i => i.id), [hold1.id, hold2.id]);
});

test("confirm accepts the held message: the verdict is recorded with the reviewer", t => {
  const { f, account, token, binding, hold1 } = quarantineFixture(t);
  const result = f.store.inbox.quarantineRelease(token, binding, { quarantineId: hold1.id, note: "looks fine" });
  assert.equal(result.decision, "release");
  assert.equal(result.item.status, "released");
  assert.equal(result.item.reviewedBy, account.id);
  assert.equal(result.item.note, "looks fine");
  assert.ok(Number.isSafeInteger(result.item.reviewedAt));
  const review = f.store.inbox.quarantineReview(token, binding, {});
  assert.equal(review.items.find(i => i.id === hold1.id), undefined, "confirmed item leaves the held backlog");
  const released = f.store.inbox.quarantineReview(token, binding, { status: "released" });
  assert.ok(released.items.some(i => i.id === hold1.id), "confirmed item shows in released history");
});

test("dismiss drops the held message as spam and keeps the audit record", t => {
  const { f, account, token, binding, hold2 } = quarantineFixture(t);
  const result = f.store.inbox.quarantineDismiss(token, binding, { quarantineId: hold2.id });
  assert.equal(result.decision, "dismiss");
  assert.equal(result.item.status, "dismissed");
  assert.equal(result.item.reviewedBy, account.id);
  const review = f.store.inbox.quarantineReview(token, binding, {});
  assert.equal(review.items.find(i => i.id === hold2.id), undefined, "dismissed item leaves the held backlog");
  const dismissed = f.store.inbox.quarantineReview(token, binding, { status: "dismissed" });
  assert.ok(dismissed.items.some(i => i.id === hold2.id), "dismissed item stays for audit");
  throwsCode(() => f.store.inbox.quarantineRelease(token, binding, { quarantineId: hold2.id }), 409, "quarantine_already_reviewed");
});

test("review rejects unknown ids and invalid filters", t => {
  const { f, token, binding } = quarantineFixture(t);
  throwsCode(() => f.store.inbox.quarantineReview(token, binding, { status: "archived" }), 422, "invalid_quarantine");
  throwsCode(() => f.store.inbox.quarantineReview(token, binding, { limit: "many" }), 422, "invalid_quarantine");
  throwsCode(() => f.store.inbox.quarantineRelease(token, binding, { quarantineId: "qz-999" }), 404, "quarantine_not_found");
  throwsCode(() => f.store.inbox.quarantineDismiss(token, binding, { quarantineId: 42 }), 422, "invalid_quarantine");
});

test("split separates the held message off its thread and the row stays held", t => {
  const { f, token, binding, hold1, first } = quarantineFixture(t);
  const result = f.store.inbox.quarantineSplit(token, binding, { quarantineId: hold1.id, note: "own thread" });
  assert.equal(result.split.quarantineId, hold1.id);
  assert.equal(result.split.sourceId, first.sourceId);
  assert.equal(result.split.reason, "own thread");
  assert.equal(result.item.status, "held", "split is a thread action, not a verdict");
  throwsCode(() => f.store.inbox.quarantineSplit(token, binding, { quarantineId: hold1.id }), 409, "quarantine_already_split");
  const threads = f.store.inbox.threads(token, binding, { includeChannels: true });
  const splitThread = threads.threads.find(th => th.entries.some(e => e.source.id === first.sourceId));
  assert.ok(splitThread, "split source still appears in threads");
  assert.equal(splitThread.entries.length, 1, "split source is a singleton thread");
});

test("split records survive a store reopen", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-quarantine-reopen-"));
  const path = join(directory, "room.sqlite");
  const first = new RoomStore(path);
  const accountId = "quarantine-reopen-acct";
  first.createAccount(accountId, "reopen");
  const split = first.quarantineSplits.split({ quarantineId: "qz-1", accountId, sourceId: "src-1",
    priorThread: "thread-9", reviewer: accountId, reason: "reopen me" });
  assert.equal(split.quarantineId, "qz-1");
  first.close();
  const second = new RoomStore(path);
  try {
    assert.deepEqual(second.quarantineSplits.list(accountId).map(s => s.quarantineId), ["qz-1"]);
    assert.ok(second.quarantineSplits.splitSourceIds(accountId).has("src-1"));
  } finally { second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the thread-split journal validates its inputs and its offline integrity", t => {
  const { f, account } = quarantineFixture(t);
  const journal = f.store.quarantineSplits;
  throwsCode(() => journal.split({ quarantineId: "", accountId: account.id, sourceId: "s", priorThread: "t", reviewer: account.id }), 422, "invalid_quarantine_split");
  throwsCode(() => journal.split({ quarantineId: "qz-2", accountId: account.id, sourceId: "s", priorThread: "t", reviewer: account.id, reason: "x".repeat(257) }), 422, "invalid_quarantine_split");
  const ok = journal.split({ quarantineId: "qz-9", accountId: account.id, sourceId: "src-9", priorThread: "thread-9", reviewer: account.id });
  assert.ok(ok.splitAt > 0);
  assert.equal(ok.priorThread, "thread-9");
  const verified = journal.verify();
  assert.ok(Number.isSafeInteger(verified.splits) && verified.splits >= 1, "verify counts the split records");
  assert.ok(Number.isSafeInteger(verified.checkedAt));
  // Offline integrity: a tampered row (empty reviewer) fails verification.
  f.store.db.exec("UPDATE quarantine_thread_splits SET reviewer='' WHERE quarantine_id='qz-9'");
  assert.throws(() => journal.verify(), /requires operator reconciliation/);
});

test("the thread-split schema verifies on read-only opens without migrating", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-quarantine-ro-"));
  const path = join(directory, "room.sqlite");
  const writable = new RoomStore(path);
  writable.quarantineSplits.split({ quarantineId: "qz-7", accountId: "acct-ro", sourceId: "src-ro", priorThread: "thread-ro", reviewer: "acct-ro" });
  writable.close();
  const readOnly = new RoomStore(path, { readOnly: true });
  try {
    readOnly.quarantineSplits.verifySchema({ allowAbsent: true });
    assert.deepEqual(readOnly.quarantineSplits.list("acct-ro").map(s => s.quarantineId), ["qz-7"]);
  } finally { readOnly.close(); rmSync(directory, { recursive: true, force: true }); }
});

// --- HTTP -------------------------------------------------------------------

async function httpFixture(t) {
  const { f, account, token, binding, hold1, hold2 } = quarantineFixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const creds = { cookie: `account_session=${token}`, binding };
  return { f, account, origin, creds, hold1, hold2 };
}
const get = (origin, path, creds, query = "") => fetch(origin + path + query, {
  headers: { Cookie: creds.cookie, "X-Session-Binding": creds.binding } });
const post = (origin, path, creds, data) => fetch(origin + path, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie,
    "X-Session-Binding": creds.binding, "X-CSRF-Token": creds.csrf ?? "" }, body: JSON.stringify(data) });

test("GET /api/inbox/quarantine lists the held backlog over HTTP", async t => {
  const { origin, creds, hold1, hold2 } = await httpFixture(t);
  const res = await get(origin, "/api/inbox/quarantine", creds);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.contractVersion, 1);
  assert.deepEqual(body.items.map(i => i.id), [hold1.id, hold2.id]);
  assert.ok(body.items.every(i => i.reason.length > 0 && typeof i.score === "number"));
  const filtered = await get(origin, "/api/inbox/quarantine", creds, "?status=released");
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).items, []);
  const bad = await get(origin, "/api/inbox/quarantine", creds, "?status=bogus");
  assert.equal(bad.status, 422);
});

test("POST /api/inbox/quarantine/release records the owner's verdict", async t => {
  const { f, origin, creds, hold1 } = await httpFixture(t);
  creds.csrf = f.store.accountSessionSlot(creds.cookie.split("=")[1]).csrf;
  const res = await post(origin, "/api/inbox/quarantine/release", creds, { quarantineId: hold1.id, note: "http confirm" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.decision, "release");
  assert.equal(body.item.status, "released");
  assert.equal(body.item.note, "http confirm");
  const missing = await post(origin, "/api/inbox/quarantine/release", creds, { quarantineId: "qz-404" });
  assert.equal(missing.status, 404);
});

test("POST /api/inbox/quarantine/release accepts an explicit null note", async t => {
  const { f, origin, creds, hold1 } = await httpFixture(t);
  creds.csrf = f.store.accountSessionSlot(creds.cookie.split("=")[1]).csrf;
  // The client sends note: null by default; the route must accept it.
  const res = await post(origin, "/api/inbox/quarantine/release", creds, { quarantineId: hold1.id, note: null });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.item.status, "released");
  assert.equal(body.item.note, null);
});

test("POST /api/inbox/quarantine/dismiss confirms spam over HTTP", async t => {
  const { f, origin, creds, hold2 } = await httpFixture(t);
  creds.csrf = f.store.accountSessionSlot(creds.cookie.split("=")[1]).csrf;
  const res = await post(origin, "/api/inbox/quarantine/dismiss", creds, { quarantineId: hold2.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.decision, "dismiss");
  assert.equal(body.item.status, "dismissed");
  const again = await post(origin, "/api/inbox/quarantine/dismiss", creds, { quarantineId: hold2.id });
  assert.equal(again.status, 409);
});

test("POST /api/inbox/quarantine/split separates the thread over HTTP", async t => {
  const { f, origin, creds, hold1 } = await httpFixture(t);
  creds.csrf = f.store.accountSessionSlot(creds.cookie.split("=")[1]).csrf;
  const res = await post(origin, "/api/inbox/quarantine/split", creds, { quarantineId: hold1.id, note: "http split" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.split.quarantineId, hold1.id);
  assert.equal(body.item.status, "held");
  const dup = await post(origin, "/api/inbox/quarantine/split", creds, { quarantineId: hold1.id });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error.code, "quarantine_already_split");
});

// --- client -----------------------------------------------------------------

function clientHarness() {
  const calls = [];
  const account = { generation: 1, currentSession: () => ({ account: { id: "owner", authEpoch: 2 }, sessionRevision: 4, sessionBinding: "b".repeat(64) }),
    owns: () => true, request: async (path, { data } = {}) => { calls.push({ path, data }); return harnessResponse(path); } };
  return { account, calls };
}
const item = id => ({ id, messageId: "m-" + id, channel: "telegram", connectionId: "c1",
  reason: [{ key: "k", weight: 80, detail: "why" }], score: 80, quarantinedAt: 1, status: "held",
  reviewedBy: null, reviewedAt: null, note: null, updatedAt: 1, sender: "Spammer", subject: null, excerpt: "test",
  source: { id: "src-" + id } });
function harnessResponse(path) {
  const session = { account: { id: "owner", authEpoch: 2 }, sessionRevision: 4, sessionBinding: "b".repeat(64) };
  const viewer = { accountId: "owner", authEpoch: 2, sessionBinding: "b".repeat(64), sessionRevision: 4 };
  if (path.startsWith("/api/inbox/quarantine?")) return { contractVersion: 1, viewer, status: "held",
    counts: { held: 2, released: 0, dismissed: 0 }, items: [item("qz-1"), item("qz-2")] };
  if (path === "/api/inbox/quarantine/release") return { contractVersion: 1, viewer, decision: "release", item: { ...item("qz-1"), status: "released" } };
  if (path === "/api/inbox/quarantine/dismiss") return { contractVersion: 1, viewer, decision: "dismiss", item: { ...item("qz-2"), status: "dismissed" } };
  if (path === "/api/inbox/quarantine/split") return { contractVersion: 1, viewer,
    split: { quarantineId: "qz-1", accountId: "owner", sourceId: "src-qz-1", channel: "telegram", priorThread: null, reviewer: "owner", reason: null, splitAt: 1 },
    item: item("qz-1") };
  throw new Error("unexpected path " + path);
}

test("quarantine client validates the backlog and the review actions", async () => {
  const { account, calls } = clientHarness();
  const client = new InboxClient(account);
  const backlog = await client.quarantine({ status: "held" });
  assert.equal(backlog.items.length, 2);
  assert.ok(calls[0].path.includes("status=held"));
  const released = await client.quarantineRelease("qz-1", "fine");
  assert.equal(released.decision, "release");
  assert.deepEqual(calls[1], { path: "/api/inbox/quarantine/release", data: { quarantineId: "qz-1", note: "fine" } });
});

test("quarantine client validates release, dismiss and split responses", async () => {
  const { account } = clientHarness();
  const client = new InboxClient(account);
  const dismissed = await client.quarantineDismiss("qz-2", null);
  assert.equal(dismissed.item.status, "dismissed");
  const split = await client.quarantineSplit("qz-1", "own thread");
  assert.equal(split.split.sourceId, "src-qz-1");
  assert.equal(split.item.status, "held");
  // A malformed item is rejected, not rendered.
  const bad = clientHarness();
  bad.account.request = async () => ({ contractVersion: 1,
    viewer: { accountId: "owner", authEpoch: 2, sessionBinding: "b".repeat(64), sessionRevision: 4 },
    status: "held", counts: { held: 1, released: 0, dismissed: 0 }, items: [{ id: "qz-x" }] });
  await assert.rejects(new InboxClient(bad.account).quarantine({}),
    error => error.code === "invalid_inbox_response");
});
