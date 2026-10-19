// Purge reach for the three tables PR #4160's source-DDL census left
// UNRESOLVED (PURGE-GAPS-CLOSURE, stacked on #4160):
//
//   - patrol_cursor / patrol_findings carry room_id but patrol's own room
//     cleanup never deletes them (it self-cleans blocks/claims/messages
//     only), so the purge registry now carries room-scoped rows for both.
//     The patrol tables are lazy-additive — absent from a fresh store — so
//     the rows are optional and a purge on such a store must still run.
//   - public_abuse_reports carries personal data (reporter email, ip_hash)
//     that no purge key reached. Its registry row reaches it on both keys
//     the data carries: room purge matches kind='room' reports by target
//     (the guard keeps receipt/agent reports that share the target string),
//     and account purge matches the reporter's email through
//     account_login_methods, the account's normalized email store.
//
// Deletion is proven through the operator purge door (plan + execute over
// HTTP), never by calling the executor's internals.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ensurePatrolSchema } from "../server/patrol.mjs";
import { submitPublicReport } from "../server/legal-store.mjs";
import { event, EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

const TOKEN = "operator-test-token-0123456789abcdef";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const IP_HASH = "ip-hash-fixture";

function createdRoom(roomId, title) {
  return [
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId, data: { roomId, ownerId: "owner", title, purpose: "purge gaps fixture" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, data: { memberId: "owner", displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } })
  ];
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-purge-gaps-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path, { method = "GET", data } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        Authorization: `Operator ${TOKEN}`,
        ...(data !== undefined ? { "Content-Type": "application/json" } : {})
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  };
  return { store, call };
}

async function planAndExecute(call, targets) {
  const plan = await call("/api/operator/purge/plan", { method: "POST", data: { targets, reason: "Remove QA leftover" } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const executed = await call("/api/operator/purge/execute", { method: "POST", data: { planId: plan.body.planId, confirmToken: plan.body.confirmToken } });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.body.result, "executed");
  return { plan, executed };
}

function planCount(plan, table) {
  return plan.body.counts.find(row => row.table === table)?.rows;
}

function report(store, fields) {
  const stored = submitPublicReport(store.db, { body: "fixture report body", ipHash: IP_HASH, now: store.now(), ...fields });
  assert.equal(stored.ok, true, JSON.stringify(stored));
  return stored.id;
}

function reportRow(store, id) {
  return store.db.prepare("SELECT id, kind, target, email FROM public_abuse_reports WHERE id=?").get(id);
}

describe("purge reach for patrol rows and public abuse reports", { concurrency: false }, () => {
  before(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  test("room purge removes the room's patrol cursor and findings, and spares the other room's", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("gaps-room-a", "Gaps A"));
    store.initialize(createdRoom("gaps-room-b", "Gaps B"));
    ensurePatrolSchema(store);
    store.db.prepare("INSERT INTO patrol_cursor (room_id, sequence, event_id) VALUES (?, ?, ?)").run("gaps-room-a", 7, "evt-a");
    store.db.prepare("INSERT INTO patrol_cursor (room_id, sequence, event_id) VALUES (?, ?, ?)").run("gaps-room-b", 3, "evt-b");
    const finding = "INSERT INTO patrol_findings (room_id, sequence, event_id, invariant, kind, subject_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    store.db.prepare(finding).run("gaps-room-a", 7, "evt-a", "sequence", "gap", "member-a", "fixture", "2026-10-18T00:00:00.000Z");
    store.db.prepare(finding).run("gaps-room-b", 3, "evt-b", "sequence", "gap", "member-b", "fixture", "2026-10-18T00:00:00.000Z");

    const { plan } = await planAndExecute(call, [{ kind: "room", id: "gaps-room-a" }]);
    assert.equal(planCount(plan, "patrol_cursor"), 1);
    assert.equal(planCount(plan, "patrol_findings"), 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM patrol_cursor WHERE room_id=?").get("gaps-room-a").n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM patrol_findings WHERE room_id=?").get("gaps-room-a").n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM patrol_cursor WHERE room_id=?").get("gaps-room-b").n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM patrol_findings WHERE room_id=?").get("gaps-room-b").n, 1);
  });

  test("room purge still executes on a store where the patrol tables were never created", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("gaps-room-c", "Gaps C"));
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'patrol%'").all();
    assert.deepEqual(tables, []);
    const { plan } = await planAndExecute(call, [{ kind: "room", id: "gaps-room-c" }]);
    assert.equal(planCount(plan, "patrol_cursor"), 0);
    assert.equal(planCount(plan, "patrol_findings"), 0);
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get("gaps-room-c"), undefined);
  });

  test("room purge deletes the room's room-kind abuse reports and no other kind sharing the target string", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("gaps-room-a", "Gaps A"));
    store.initialize(createdRoom("gaps-room-b", "Gaps B"));
    const roomReport = report(store, { kind: "room", target: "gaps-room-a", email: "Reporter@Example.com" });
    const otherRoomReport = report(store, { kind: "room", target: "gaps-room-b", email: null });
    // The target column is one string space across kinds: a receipt report
    // and an agent report may carry the same string as the room's id. Only
    // the kind='room' row is the room's report; the guard must spare these.
    const receiptReport = report(store, { kind: "receipt", target: "gaps-room-a", email: null });
    const agentReport = report(store, { kind: "agent", target: "gaps-room-a", email: null });
    // The filed email is stored normalized, matching account_login_methods.
    assert.equal(reportRow(store, roomReport).email, "reporter@example.com");

    const { plan } = await planAndExecute(call, [{ kind: "room", id: "gaps-room-a" }]);
    assert.equal(planCount(plan, "public_abuse_reports"), 1);
    assert.equal(reportRow(store, roomReport), undefined);
    assert.ok(reportRow(store, otherRoomReport));
    assert.ok(reportRow(store, receiptReport));
    assert.ok(reportRow(store, agentReport));
  });

  test("account purge deletes every abuse report filed under the account's email, and no one else's", async t => {
    const { store, call } = await serve(t);
    store.createAccount("acct-reporter");
    store.accountLogins.linkMagicMethod("acct-reporter", { email: "reporter@example.com" });
    store.createAccount("acct-bystander");
    store.accountLogins.linkMagicMethod("acct-bystander", { email: "other@example.com" });
    // Filed with mixed case at the public door; stored normalized, so the
    // account purge's email match reaches it exactly.
    const roomReport = report(store, { kind: "room", target: "some-room", email: "Reporter@Example.com" });
    const receiptReport = report(store, { kind: "receipt", target: "rc_fixture", email: "reporter@example.com" });
    const bystanderReport = report(store, { kind: "room", target: "some-room", email: "other@example.com" });
    const anonymousReport = report(store, { kind: "room", target: "some-room", email: null });

    const { plan } = await planAndExecute(call, [{ kind: "account", id: "acct-reporter" }]);
    assert.equal(planCount(plan, "public_abuse_reports"), 2);
    assert.equal(reportRow(store, roomReport), undefined);
    assert.equal(reportRow(store, receiptReport), undefined);
    assert.ok(reportRow(store, bystanderReport));
    assert.ok(reportRow(store, anonymousReport));
  });
});
