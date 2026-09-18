// Review-coverage dashboard route: GET /api/inbox/quarantine/coverage.
// Covers the service projection (per-signal reviewCoverage with precision
// inputs, account scoping, empty queue) and the HTTP route (happy path over
// HTTP, verdicts reflected in the numbers, unauthenticated requests refused).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { normalizeTelegramUpdate, telegramSourceId } from "../server/channel-adapters/telegram.mjs";

const flag = (score = 75, key = "test_signal") => ({
  score, quarantine: score >= 60, signals: [{ key, weight: score, detail: `Test signal ${key} fired` }] });

// Same quarantine fixture as the review-surface tests: two telegram
// messages imported on one connection, both held — one prize_bait (80),
// one wire_fraud (90).
function coverageFixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const token = session.token, binding = session.sessionBinding;
  const conn = { accountId: account.id, id: "tg-coverage-conn", revision: 1, channel: "telegram", provider: "telegram-bot",
    externalId: "7000000099", identity: { kind: "bot", id: "7000000099", handle: "@coverage_bot", displayName: "Coverage Bot" },
    capabilities: { read: true, send: false, threads: true, edit: false } };
  const importMessage = (n, text) => {
    const envelope = normalizeTelegramUpdate(conn, { update_id: 900000 + n,
      message: { message_id: 200 + n, date: 1788948000 + n, chat: { id: 5000000201, type: "private", first_name: "Spammer" },
        from: { id: 5000000019, is_bot: false, first_name: "Spammer", last_name: "McSpam", username: "spammer" },
        text } });
    const sourceId = telegramSourceId(conn, `5000000201:${200 + n}`);
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
  return { f, account, token, binding, hold1, hold2 };
}

test("coverage reports per-signal review coverage over the account's backlog", t => {
  const { f, token, binding } = coverageFixture(t);
  const report = f.store.inbox.quarantineCoverage(token, binding);
  assert.equal(report.contractVersion, 1);
  assert.equal(report.viewer.accountId, f.store.accountForMember("commons", "owner").id);
  assert.ok(typeof report.generatedAt === "number");
  assert.deepEqual(report.totals,
    { held: 2, confirmed: 0, dismissed: 0, split: 0, reviewed: 0, total: 2, reviewCoverage: 0 });
  assert.deepEqual([...report.zeroCoverageSignals].sort(), ["prize_bait", "wire_fraud"]);
  const bait = report.perSignal.find(s => s.key === "prize_bait");
  const fraud = report.perSignal.find(s => s.key === "wire_fraud");
  assert.equal(bait.held, 1);
  assert.equal(bait.reviewed, 0);
  assert.equal(bait.reviewCoverage, 0);
  assert.equal(bait.avgScore, 80);
  assert.equal(fraud.held, 1);
  assert.equal(fraud.reviewCoverage, 0);
});

test("Confirm/Dismiss/Split verdicts land in the per-signal breakdown", t => {
  const { f, token, binding, hold1, hold2 } = coverageFixture(t);
  f.store.inbox.quarantineSplit(token, binding, { quarantineId: hold1.id });
  f.store.inbox.quarantineRelease(token, binding, { quarantineId: hold1.id });
  f.store.inbox.quarantineDismiss(token, binding, { quarantineId: hold2.id });
  const report = f.store.inbox.quarantineCoverage(token, binding);
  assert.deepEqual(report.totals,
    { held: 0, confirmed: 1, dismissed: 1, split: 1, reviewed: 2, total: 2, reviewCoverage: 1 });
  assert.deepEqual(report.zeroCoverageSignals, []);
  const bait = report.perSignal.find(s => s.key === "prize_bait");
  const fraud = report.perSignal.find(s => s.key === "wire_fraud");
  // Precision inputs: confirmed vs dismissed per signal.
  assert.deepEqual([bait.confirmed, bait.dismissed, bait.split, bait.reviewed, bait.reviewCoverage], [1, 0, 1, 1, 1]);
  assert.deepEqual([fraud.confirmed, fraud.dismissed, fraud.split, fraud.reviewed, fraud.reviewCoverage], [0, 1, 0, 1, 1]);
});

test("empty queue is honest absence: null coverage, no signals, no gap", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const report = f.store.inbox.quarantineCoverage(session.token, session.sessionBinding);
  assert.deepEqual(report.totals,
    { held: 0, confirmed: 0, dismissed: 0, split: 0, reviewed: 0, total: 0, reviewCoverage: null });
  assert.deepEqual(report.perSignal, []);
  assert.deepEqual(report.zeroCoverageSignals, []);
});

test("coverage is account-scoped: another account sees an empty dashboard", t => {
  const { f, token: _token, binding: _binding } = coverageFixture(t);
  const other = f.store.createAccount("coverage-stranger", "stranger");
  const otherKey = f.store.issueAccountAccessKey(other.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, otherKey, 0) };
  const report = f.store.inbox.quarantineCoverage(session.token, session.sessionBinding);
  assert.deepEqual(report.perSignal, []);
  assert.equal(report.totals.total, 0);
  assert.equal(report.totals.reviewCoverage, null);
});

// --- HTTP -------------------------------------------------------------------

async function httpFixture(t) {
  const { f, token, binding, hold1, hold2 } = coverageFixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const creds = { cookie: `account_session=${token}`, binding };
  return { f, origin, creds, hold1, hold2 };
}
const get = (origin, path, creds, query = "") => fetch(origin + path + query, {
  headers: { Cookie: creds.cookie, "X-Session-Binding": creds.binding } });

test("GET /api/inbox/quarantine/coverage serves the dashboard over HTTP", async t => {
  const { origin, creds } = await httpFixture(t);
  const res = await get(origin, "/api/inbox/quarantine/coverage", creds);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.contractVersion, 1);
  assert.ok(typeof body.viewer.accountId === "string");
  assert.equal(body.totals.total, 2);
  assert.equal(body.totals.reviewCoverage, 0);
  assert.ok(Array.isArray(body.perSignal) && body.perSignal.length === 2);
  for (const signal of body.perSignal) {
    assert.ok(typeof signal.key === "string");
    assert.equal(signal.held, 1);
    assert.equal(signal.reviewed, 0);
    assert.equal(signal.reviewCoverage, 0);
    assert.ok(typeof signal.shareOfHolds === "number");
    assert.ok(typeof signal.avgScore === "number");
    assert.ok(typeof signal.avgWeight === "number");
  }
});

test("GET /api/inbox/quarantine/coverage reflects owner verdicts", async t => {
  const { f, origin, creds, hold1, hold2 } = await httpFixture(t);
  const before = await (await get(origin, "/api/inbox/quarantine/coverage", creds)).json();
  assert.equal(before.zeroCoverageSignals.length, 2);
  creds.csrf = f.store.accountSessionSlot(creds.cookie.split("=")[1]).csrf;
  const post = (path, data) => fetch(origin + path, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie,
      "X-Session-Binding": creds.binding, "X-CSRF-Token": creds.csrf }, body: JSON.stringify(data) });
  assert.equal((await post("/api/inbox/quarantine/release", { quarantineId: hold1.id })).status, 200);
  assert.equal((await post("/api/inbox/quarantine/dismiss", { quarantineId: hold2.id })).status, 200);
  const after = await (await get(origin, "/api/inbox/quarantine/coverage", creds)).json();
  assert.deepEqual(after.totals, { held: 0, confirmed: 1, dismissed: 1, split: 0, reviewed: 2, total: 2, reviewCoverage: 1 });
  assert.deepEqual(after.zeroCoverageSignals, []);
  const bait = after.perSignal.find(s => s.key === "prize_bait");
  assert.deepEqual([bait.confirmed, bait.reviewed, bait.reviewCoverage], [1, 1, 1]);
});

test("GET /api/inbox/quarantine/coverage rejects unauthenticated requests", async t => {
  const { origin } = await httpFixture(t);
  const noBinding = await fetch(origin + "/api/inbox/quarantine/coverage",
    { headers: { Cookie: "account_session=" } });
  assert.equal(noBinding.status, 422);
  const bogus = await fetch(origin + "/api/inbox/quarantine/coverage",
    { headers: { Cookie: "account_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "X-Session-Binding": "a".repeat(64) } });
  assert.equal(bogus.status, 401);
});

test("GET /api/inbox/quarantine/coverage on an empty queue returns null coverage", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const res = await get(origin, "/api/inbox/quarantine/coverage",
    { cookie: `account_session=${session.token}`, binding: session.sessionBinding });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.perSignal, []);
  assert.equal(body.totals.reviewCoverage, null);
  assert.deepEqual(body.zeroCoverageSignals, []);
});
