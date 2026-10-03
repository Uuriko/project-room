// Operator auth, purge, audit, and status over a real store and HTTP server.
// Exercises server/operator-auth.mjs, server/operator-routes.mjs,
// server/operator-purge.mjs, server/operator-actions.mjs,
// server/purge-registry.mjs, and server/operator-status.mjs.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { PURGE_TABLES } from "../server/purge-registry.mjs";
import { countPurge, createOperatorPurge } from "../server/operator-purge.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { collectLargestTables } from "../server/operator-status.mjs";
import { event, EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

const TOKEN = "operator-test-token-0123456789abcdef";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const MESSAGE = "synthetic-purge-message-body-xyz";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function surface(body) {
  const copy = { ...body };
  delete copy.operationId;
  return copy;
}

function tableCounts(db) {
  const counts = {};
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (!IDENT.test(row.name)) continue;
    counts[row.name] = db.prepare(`SELECT count(*) AS n FROM ${row.name}`).get().n;
  }
  return counts;
}

function matchingRows(db, entry, kind, id) {
  const parts = [];
  const params = [];
  for (const column of entry.match?.[kind] ?? []) {
    parts.push(`${column}=?`);
    params.push(id);
  }
  const via = entry.via?.[kind];
  if (via) {
    parts.push(`${via.childKey} IN (SELECT ${via.parentKey} FROM ${via.parent} WHERE ${via.scope}=?)`);
    params.push(id);
  }
  if (!parts.length) return 0;
  if (RETIRED_TABLES.includes(entry.table) && !db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(entry.table)) return 0;
  return db.prepare(`SELECT count(*) AS n FROM ${entry.table} WHERE ${parts.join(" OR ")}`).get(...params).n;
}

function createdRoom(roomId, title) {
  return [
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId, data: { roomId, ownerId: "owner", title, purpose: "operator purge fixture" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, data: { memberId: "owner", displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } })
  ];
}

async function serve(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-operator-"));
  const store = new RoomStore(join(directory, "room.sqlite"), options);
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
  const call = async (path, { method = "GET", data, token = TOKEN, cookie, authorization } = {}) => {
    const auth = authorization !== undefined ? authorization : (token ? `Operator ${token}` : null);
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(auth ? { Authorization: auth } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
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

async function planAndExecute(call, targets, extra = {}) {
  const plan = await call("/api/operator/purge/plan", { method: "POST", data: { targets, reason: "Remove QA leftover", ...extra } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const executed = await call("/api/operator/purge/execute", { method: "POST", data: { planId: plan.body.planId, confirmToken: plan.body.confirmToken } });
  return { plan, executed };
}

describe("operator purge and status", { concurrency: false }, () => {
  before(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => {
    delete process.env.ROOM_OPERATOR_TOKEN_SHA256;
    delete process.env.ROOM_OPERATOR_PROTECTED_ROOMS;
  });

  test("an unset secret answers the same 404 as an unknown path", async t => {
    delete process.env.ROOM_OPERATOR_TOKEN_SHA256;
    try {
      const { store, call } = await serve(t);
      store.initialize(createdRoom("commons", "Commons"));
      const unknown = await call("/api/no-such-operator-path", { token: null });
      assert.equal(unknown.status, 404);
      for (const path of ["/api/operator/status", "/api/operator/purge/plan", "/api/operator/actions", "/api/operator/drift"]) {
        const hidden = await call(path, {
          method: path.includes("purge") ? "POST" : "GET",
          token: TOKEN,
          data: path.includes("purge") ? { targets: [{ kind: "room", id: "commons" }], reason: "hidden" } : undefined
        });
        assert.equal(hidden.status, 404);
        assert.deepEqual(surface(hidden.body), surface(unknown.body));
      }
      for (let n = 0; n < 11; n++) {
        const again = await call("/api/operator/status", { token: TOKEN });
        assert.equal(again.status, 404);
        assert.equal(again.body.error.code, "not_found");
      }
    } finally {
      process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH;
    }
  });

  test("a wrong token or a cookie without the operator token is a 404, and the eleventh call is rate limited", async t => {
    const { call } = await serve(t);
    const unknown = await call("/api/no-such-operator-path", { token: "not-the-operator-token-0123456789abcd" });
    assert.equal(unknown.status, 404);
    const wrong = await call("/api/operator/status", { token: "not-the-operator-token-0123456789abcd" });
    assert.equal(wrong.status, 404);
    assert.deepEqual(surface(wrong.body), surface(unknown.body));
    for (const cookie of ["room_session=abc", "__Host-room_session=abc", "pilot_account_session=abc"]) {
      const cooked = await call("/api/operator/status", { token: null, cookie });
      assert.equal(cooked.status, 404, cookie);
      assert.equal(cooked.body.error.code, "not_found");
    }
    const withCookie = await call("/api/operator/status", { cookie: "room_session=abc" });
    assert.equal(withCookie.status, 200);
    let limited = null;
    for (let n = 0; n < 11; n++) limited = await call("/api/operator/status", { token: "not-the-operator-token-0123456789abcd" });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "rate_limited");
  });

  test("every keyed table has one purge row and every retain row has a reason", async t => {
    const { store } = await serve(t);
    const keyed = [];
    for (const row of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (!IDENT.test(row.name)) continue;
      const columns = new Set(store.db.prepare(`PRAGMA table_info(${row.name})`).all().map(column => column.name));
      if (columns.has("room_id") || columns.has("identity_id") || columns.has("account_id")) keyed.push(row.name);
    }
    const seen = new Set();
    for (const entry of PURGE_TABLES) {
      assert.equal(seen.has(entry.table), false, entry.table);
      seen.add(entry.table);
      assert.ok(entry.action === "delete" || entry.action === "retain");
      if (entry.action === "retain") {
        assert.equal(typeof entry.reason, "string");
        assert.ok(entry.reason.length > 0);
      }
    }
    assert.deepEqual(keyed.filter(name => !seen.has(name)), []);
  });

  test("find lists QA leftovers and does not delete them", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("qa2-authz-fixture", "qa2 authz"));
    store.initialize(createdRoom("personal-FixtureRoom1", "My first room"));
    store.initialize(createdRoom("room-b-keep", "Keep me"));
    const identity = store.identities.create("qa2-fixture-agent");
    const countsBefore = tableCounts(store.db);
    const rooms = await call("/api/operator/purge/find", { method: "POST", data: { roomIdPrefix: "qa2-authz-" } });
    assert.equal(rooms.status, 200);
    assert.deepEqual(rooms.body.rooms.map(room => room.id), ["qa2-authz-fixture"]);
    const personal = await call("/api/operator/purge/find", { method: "POST", data: { roomIdPrefix: "personal-", roomTitlePrefix: "My first room" } });
    assert.equal(personal.status, 200);
    assert.deepEqual(personal.body.rooms.map(room => room.id), ["personal-FixtureRoom1"]);
    const names = await call("/api/operator/purge/find", { method: "POST", data: { identityNamePrefix: "qa2-" } });
    assert.equal(names.status, 200);
    assert.deepEqual(names.body.identities.map(row => row.id), [identity.identityId]);
    const countsAfter = tableCounts(store.db);
    assert.equal(countsAfter.operator_actions, countsBefore.operator_actions + 3);
    delete countsBefore.operator_actions;
    delete countsAfter.operator_actions;
    assert.deepEqual(countsAfter, countsBefore);
  });

  test("purging one room removes its rows, leaves the other room, and keeps integrity matched", async t => {
    const { store, call } = await serve(t);
    assert.deepEqual(retiredTableNames(store.db), []);
    const roomA = "qa2-authz-fixture";
    const roomB = "room-b-keep";
    store.initialize(createdRoom(roomA, "qa2 authz"));
    store.initialize(createdRoom(roomB, "Keep me"));
    const ownerA = store.issueAccessKey(roomA, "owner");
    const ownerB = store.issueAccessKey(roomB, "owner");
    const posted = store.command(ownerA, roomA, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: MESSAGE } });
    store.command(ownerB, roomB, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "keep this room" } });
    const workId = "work-a";
    store.command(ownerA, roomA, { id: randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: workId, title: "Fixture work", definitionOfDone: "Done", accountableMemberId: "owner" } });
    store.workClaims.set(roomA, { id: "claim-a", title: "Fixture claim", state: "open", owner: "owner", updatedAt: new Date().toISOString() });
    const identity = store.identities.create("qa2-room-agent");
    store.identities.link(ownerA, roomA, { identityId: identity.identityId, memberId: "reporter", displayName: "Reporter", permissions: [] });
    store.agentPlugin.subscribeWebhook({ identityId: identity.identityId, url: "https://hooks.example.test/operator-purge", events: ["message.posted"] });
    store.command(ownerA, roomA, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "wake the subscription" } });
    assert.ok(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_deliveries WHERE room_id=?").get(roomA).n > 0);
    store.wakeQueue.enqueue(ownerA, roomA, { requestId: randomUUID(), queueKey: "qa-wake", intent: { kind: "fixture" }, dueAt: Date.now() + 60_000, maxAttempts: 3 });
    store.roomAttachments.stage(ownerA, roomA, { id: "file-a", filename: "notes.txt", mediaType: "text/plain", data: Buffer.from("hello").toString("base64") });
    store.moderation.report(identity.secret, roomA, { messageId: posted.event.data.messageId, reason: "fixture report" });
    store.reminders.mutate(ownerA, roomA, { requestId: randomUUID(), workItemId: workId, expectedRevision: 0, action: "schedule", dueAt: Date.now() + 3600_000 });
    const link = store.shareLinks.create(ownerA, roomA, {
      requestId: randomUUID(),
      linkToken: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 86400_000,
      maxJoins: 1,
      expectedMemberRevision: store.room(roomA).state.members.owner.revision
    });
    store.db.prepare("INSERT INTO share_link_codes(code_hash, link_id, created_at) VALUES(?,?,?)").run("ab".repeat(32), link.link.id, Date.now());
    const projectionB = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomB).projection;
    const eventsB = store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=?").get(roomB).n;
    assert.equal((await call(`/api/rooms/${roomA}`, { authorization: `Bearer ${ownerA}` })).status, 200);
    const { plan, executed } = await planAndExecute(call, [{ kind: "room", id: roomA }]);
    assert.ok(plan.body.totalRows > 0);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.result, "executed");
    assert.deepEqual(retiredTableNames(store.db), []);
    for (const entry of PURGE_TABLES) {
      if (entry.action !== "delete") continue;
      assert.equal(matchingRows(store.db, entry, "room", roomA), 0, entry.table);
    }
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomA), undefined);
    assert.equal(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomB).projection, projectionB);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=?").get(roomB).n, eventsB);
    const integrity = await store.verifyRoomIntegrity();
    assert.equal(integrity.matched, 1);
    assert.equal(integrity.verified, 0);
    const gone = await call(`/api/rooms/${roomA}`, { authorization: `Bearer ${ownerA}` });
    assert.ok(gone.status === 401 || gone.status === 404);
    assert.equal((await call(`/api/rooms/${roomB}`, { authorization: `Bearer ${ownerB}` })).status, 200);
    const actions = store.db.prepare("SELECT action, result, counts_json, reason FROM operator_actions").all();
    assert.equal(actions.filter(row => row.action === "plan" && row.result === "ok").length, 1);
    assert.equal(actions.filter(row => row.action === "execute" && row.result === "executed").length, 1);
    assert.equal(actions.some(row => JSON.stringify(row).includes(MESSAGE)), false);
    const columns = store.db.prepare("PRAGMA table_info(operator_actions)").all().map(column => column.name);
    assert.deepEqual(columns, ["id", "at", "action", "target_kind", "target_id", "reason", "plan_hash", "counts_json", "result", "request_id"]);
    assert.throws(() => store.db.prepare("UPDATE operator_actions SET result='rewritten'").run(), /append-only/);
    assert.throws(() => store.db.prepare("DELETE FROM operator_actions").run(), /append-only/);
  });

  test("a new event between plan and execute refuses and deletes nothing", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("qa2-authz-changed", "qa2 changed"));
    const owner = store.issueAccessKey("qa2-authz-changed", "owner");
    const plan = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "qa2-authz-changed" }], reason: "Remove QA leftover" } });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    store.command(owner, "qa2-authz-changed", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "arrived after the plan" } });
    const countsBefore = tableCounts(store.db);
    const executed = await call("/api/operator/purge/execute", { method: "POST", data: { planId: plan.body.planId, confirmToken: plan.body.confirmToken } });
    assert.equal(executed.status, 409);
    assert.equal(executed.body.error.code, "plan_changed");
    const countsAfter = tableCounts(store.db);
    assert.equal(countsAfter.operator_actions, countsBefore.operator_actions + 1);
    delete countsBefore.operator_actions;
    delete countsAfter.operator_actions;
    assert.deepEqual(countsAfter, countsBefore);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=?").get("qa2-authz-changed").n > 0, true);
  });

  test("a confirm token is single use, expires at 10 minutes, and is bound to its plan", async t => {
    let now = Date.parse("2026-10-02T12:00:00Z");
    const { store, call } = await serve(t, { now: () => now });
    store.initialize(createdRoom("room-one", "One"));
    store.initialize(createdRoom("room-two", "Two"));
    const first = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "room-one" }], reason: "Remove QA leftover" } });
    const second = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "room-two" }], reason: "Remove QA leftover" } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const swapped = await call("/api/operator/purge/execute", { method: "POST", data: { planId: first.body.planId, confirmToken: second.body.confirmToken } });
    assert.equal(swapped.status, 401);
    assert.equal(swapped.body.error.code, "invalid_confirmation");
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id='room-one'").get() !== undefined, true);
    now += 10 * 60 * 1000;
    const expired = await call("/api/operator/purge/execute", { method: "POST", data: { planId: second.body.planId, confirmToken: second.body.confirmToken } });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, "invalid_confirmation");
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id='room-two'").get() !== undefined, true);
    now = Date.parse("2026-10-02T12:00:00Z");
    const fresh = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "room-one" }], reason: "Remove QA leftover" } });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const once = await call("/api/operator/purge/execute", { method: "POST", data: { planId: fresh.body.planId, confirmToken: fresh.body.confirmToken } });
    assert.equal(once.status, 200, JSON.stringify(once.body));
    const twice = await call("/api/operator/purge/execute", { method: "POST", data: { planId: fresh.body.planId, confirmToken: fresh.body.confirmToken } });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, "confirm_used");
  });

  test("purging an identity revokes its bearer and removes links, subscriptions, and deliveries", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("commons", "Commons"));
    const owner = store.issueAccessKey("commons", "owner");
    const identity = store.identities.create("qa2-fixture-agent");
    store.identities.link(owner, "commons", { identityId: identity.identityId, memberId: "linked", displayName: "Linked", permissions: [] });
    const subscribed = store.agentPlugin.subscribeWebhook({ identityId: identity.identityId, url: "https://hooks.example.test/operator-purge", events: ["message.posted"] });
    store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "for the delivery" } });
    assert.ok(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_deliveries WHERE agent_id=?").get(identity.identityId).n > 0);
    assert.equal((await call("/api/rooms/commons", { authorization: `Bearer ${identity.secret}` })).status, 200);
    const { executed } = await planAndExecute(call, [{ kind: "identity", id: identity.identityId }]);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal((await call("/api/rooms/commons", { authorization: `Bearer ${identity.secret}` })).status, 401);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM identity_links WHERE identity_id=?").get(identity.identityId).n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_subs WHERE agent_id=?").get(identity.identityId).n, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_deliveries WHERE agent_id=?").get(identity.identityId).n, 0);
    assert.equal(store.agentPlugin.listWebhooks(identity.identityId).length, 0);
    const row = store.db.prepare("SELECT revoked_at FROM agent_identities WHERE identity_id=?").get(identity.identityId);
    assert.equal(typeof row.revoked_at, "number");
    assert.equal(subscribed.subscription.subscriptionId.length > 0, true);
  });

  test("active humans and protected rooms are refused", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("busy-room", "Busy"));
    store.initialize(createdRoom("invite-only-pilot", "Pilot"));
    store.initialize(createdRoom("kept-room", "Kept"));
    const owner = store.issueAccessKey("busy-room", "owner");
    store.command(owner, "busy-room", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "second", displayName: "Second human", kind: "human", permissions: ["steer"] } });
    const refused = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "busy-room" }], reason: "Remove QA leftover" } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "active_members");
    assert.match(refused.body.error.message, /2 active human/);
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id='busy-room'").get() !== undefined, true);
    const allowed = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "busy-room" }], reason: "Remove QA leftover", allowActiveMembers: true } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.warnings[0].count, 2);
    const pilot = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "invite-only-pilot" }], reason: "Remove QA leftover" } });
    assert.equal(pilot.status, 403);
    assert.equal(pilot.body.error.code, "protected_room");
    process.env.ROOM_OPERATOR_PROTECTED_ROOMS = "kept-room";
    try {
      const marked = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "kept-room" }], reason: "Remove QA leftover" } });
      assert.equal(marked.status, 403);
      assert.equal(marked.body.error.code, "protected_room");
    } finally {
      delete process.env.ROOM_OPERATOR_PROTECTED_ROOMS;
    }
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 3);
  });

  test("purging an account runs account deletion and retires the account key", async t => {
    const { store, call } = await serve(t);
    store.createAccount("acct-fixture");
    const key = store.issueAccountAccessKey("acct-fixture");
    assert.equal(store.authenticateAccountAccessKey(key).account.id, "acct-fixture");
    const { executed } = await planAndExecute(call, [{ kind: "account", id: "acct-fixture" }]);
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.throws(() => store.authenticateAccountAccessKey(key), /401|unauthenticated|expired|revoked/);
    assert.equal(store.db.prepare("SELECT active FROM accounts WHERE id=?").get("acct-fixture").active, 0);
  });

  test("status answers in under two seconds and drift compares the caller SHA", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("commons", "Commons"));
    const started = performance.now();
    const status = await call("/api/operator/status");
    assert.ok(performance.now() - started < 2000);
    assert.equal(status.status, 200);
    assert.equal(status.body.ready, true);
    assert.equal(status.body.jobs, "see /api/health/jobs");
    assert.equal(status.body.lastColdStart, null);
    assert.equal(status.body.retention, null);
    assert.equal(status.body.partial, false);
    assert.ok(status.body.tables.length <= 25);
    assert.ok(Array.isArray(status.body.operatorActions));
    assert.equal(status.body.version.sourceRevision, "unstamped");
    const hidden = await call("/api/operator/status", { token: null });
    assert.equal(hidden.status, 404);
    const match = await call("/api/operator/drift?main=unstamped");
    assert.equal(match.status, 200);
    assert.equal(match.body.match, true);
    assert.equal(match.body.deployed, "unstamped");
    const differ = await call("/api/operator/drift?main=abcdef1");
    assert.equal(differ.status, 200);
    assert.equal(differ.body.match, false);
    assert.equal(differ.body.main, "abcdef1");
    const invalid = await call("/api/operator/drift?main=not-a-sha");
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, "invalid_revision");
    const cut = collectLargestTables(store.db, { deadlineMs: 0 });
    assert.equal(cut.partial, true);
  });
});

// Frozen on-disk format from 00e800eb, before the feature was removed. It
// intentionally exists only in this upgrade fixture, never in fresh stores.
const RETIRED_SCHEMA = `
CREATE TABLE IF NOT EXISTS external_identities (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('agent','human')),
    display_name TEXT NOT NULL,
    venues_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'stranger' CHECK(status IN ('stranger','known','working','vouched','member')),
    referrer_external_id TEXT,
    reputation INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, external_id)
  );
  CREATE INDEX IF NOT EXISTS external_identities_by_status ON external_identities(room_id, status);
  CREATE INDEX IF NOT EXISTS external_identities_by_referrer ON external_identities(room_id, referrer_external_id);
CREATE TABLE IF NOT EXISTS external_receipts (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    receipt_id TEXT NOT NULL,
    external_id TEXT,
    offer_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('work','jury','oracle','tier_cut','reputation_import')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, receipt_id)
  );
  CREATE INDEX IF NOT EXISTS external_receipts_by_external ON external_receipts(room_id, external_id);
  CREATE INDEX IF NOT EXISTS external_receipts_by_offer ON external_receipts(room_id, offer_id);
CREATE TABLE IF NOT EXISTS emissary_drops (
  drop_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  issuer_member_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  title TEXT NOT NULL,
  terms TEXT NOT NULL,
  deadline_at INTEGER NULL,
  artifact_text TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'default-unverified',
  idempotency_key TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emissary_drops_room_venue_day ON emissary_drops(room_id, venue, created_at);
CREATE INDEX IF NOT EXISTS emissary_drops_idem ON emissary_drops(room_id, idempotency_key);
CREATE TABLE IF NOT EXISTS emissary_invite_attribution (
  attribution_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  issuer_member_id TEXT NOT NULL,
  invite_token_hash TEXT NOT NULL,
  note TEXT NULL,
  minted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emissary_invite_attribution_issuer_day ON emissary_invite_attribution(room_id, issuer_member_id, minted_at);
CREATE TABLE IF NOT EXISTS emissary_idempotency (
  room_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS emissary_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_member_id TEXT NOT NULL,
  subject_id TEXT NULL,
  details_json TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emissary_journal_room_kind ON emissary_journal(room_id, kind, seq);`;
const RETIRED_TABLES = [
  "external_identities", "external_receipts", "emissary_drops",
  "emissary_invite_attribution", "emissary_idempotency", "emissary_journal"
];

function retiredTableNames(db) {
  return db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name").all()
    .map(row => row.name).filter(name => RETIRED_TABLES.includes(name));
}

function retiredRows(db, roomId) {
  return Object.fromEntries(RETIRED_TABLES.map(table => [table,
    db.prepare(`SELECT * FROM main.${table} WHERE room_id=? ORDER BY rowid`).all(roomId)
  ]));
}

function seedRetiredRows(db, roomId) {
  db.prepare("INSERT INTO external_identities(room_id, external_id, kind, display_name, created_at, last_seen_at) VALUES(?,?,'agent','Synthetic fixture',1,1)").run(roomId, `external-${roomId}`);
  db.prepare("INSERT INTO external_receipts(room_id, receipt_id, external_id, kind, payload_json, created_at) VALUES(?,?,?,'work','{\"synthetic\":true}',1)").run(roomId, `receipt-${roomId}`, `external-${roomId}`);
  db.prepare("INSERT INTO emissary_drops(drop_id, room_id, issuer_member_id, venue, title, terms, artifact_text, artifact_sha256, created_at) VALUES(?,?,'owner','generic','Synthetic','Synthetic','Synthetic',?,1)").run(`drop-${roomId}`, roomId, "0".repeat(64));
  db.prepare("INSERT INTO emissary_invite_attribution(attribution_id, room_id, issuer_member_id, invite_token_hash, minted_at, expires_at) VALUES(?,?,'owner',?,1,2)").run(`attribution-${roomId}`, roomId, "0".repeat(64));
  db.prepare("INSERT INTO emissary_idempotency(room_id, idempotency_key, tool, result_json, created_at) VALUES(?,'synthetic-key','synthetic','{}',1)").run(roomId);
  db.prepare("INSERT INTO emissary_journal(event_id, room_id, kind, actor_member_id, created_at) VALUES(?,?,'synthetic','owner',1)").run(`journal-${roomId}`, roomId);
}

function retainedStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-retained-purge-"));
  const path = join(directory, "room.sqlite");
  let store = new RoomStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(retiredTableNames(store.db), []);
  store.initialize(createdRoom("retained-room", "Remove this fixture"));
  store.initialize(createdRoom("keep-room", "Keep this fixture"));
  store.db.exec(RETIRED_SCHEMA);
  seedRetiredRows(store.db, "retained-room");
  seedRetiredRows(store.db, "keep-room");
  const retainedBefore = retiredRows(store.db, "retained-room");
  const kept = retiredRows(store.db, "keep-room");
  store.close();
  store = new RoomStore(path);
  assert.deepEqual(retiredRows(store.db, "retained-room"), retainedBefore);
  assert.deepEqual(retiredRows(store.db, "keep-room"), kept);
  assert.doesNotThrow(() => auditRecovery(store));
  return { store, retainedBefore, kept };
}

function planRetainedRoom(purge) {
  return purge.plan({ targets: [{ kind: "room", id: "retained-room" }], reason: "Synthetic retained-data cleanup" }, randomUUID());
}

function executePlan(purge, plan) {
  return purge.execute({ planId: plan.planId, confirmToken: plan.confirmToken }, randomUUID());
}

function nonAuditRows(db) {
  return Object.entries(tableCounts(db)).reduce((sum, [table, count]) =>
    sum + (["operator_actions", "integrity_snapshot"].includes(table) ? 0 : count), 0);
}

describe("retained room cleanup compatibility", () => {
  test("reopened retained rows are counted and removed only for the selected room", t => {
    const { store, kept } = retainedStore(t);
    const purge = createOperatorPurge(store);
    const keptRoom = store.db.prepare("SELECT * FROM rooms WHERE id='keep-room'").get();
    const keptEvents = store.db.prepare("SELECT * FROM events WHERE room_id='keep-room' ORDER BY sequence").all();
    const schema = store.db.prepare("SELECT name, sql FROM main.sqlite_master WHERE type='table' ORDER BY name").all();
    const totalBefore = nonAuditRows(store.db);
    const plan = planRetainedRoom(purge);
    const result = executePlan(purge, plan);
    assert.equal(result.result, "executed");
    for (const table of RETIRED_TABLES) {
      assert.equal(plan.counts.find(row => row.table === table)?.rows, 1, table);
      assert.equal(store.db.prepare(`SELECT count(*) AS n FROM main.${table} WHERE room_id='retained-room'`).get().n, 0, table);
    }
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id='retained-room'").get(), undefined);
    assert.deepEqual(retiredRows(store.db, "keep-room"), kept);
    assert.deepEqual(store.db.prepare("SELECT * FROM rooms WHERE id='keep-room'").get(), keptRoom);
    assert.deepEqual(store.db.prepare("SELECT * FROM events WHERE room_id='keep-room' ORDER BY sequence").all(), keptEvents);
    assert.deepEqual(store.db.prepare("SELECT name, sql FROM main.sqlite_master WHERE type='table' ORDER BY name").all(), schema);
    assert.equal(result.totalRows, totalBefore - nonAuditRows(store.db) - 1, "count includes every deleted child row, excluding the room itself");
    assert.equal(plan.totalRows, result.totalRows);
    const audit = store.db.prepare("SELECT counts_json FROM operator_actions WHERE action='execute' AND result='executed'").all();
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].counts_json).totalRows, result.totalRows);
    assert.doesNotThrow(() => auditRecovery(store));
  });

  test("a retained row added after planning invalidates confirmation without deleting data", t => {
    const { store, kept } = retainedStore(t);
    const purge = createOperatorPurge(store);
    const plan = planRetainedRoom(purge);
    store.db.prepare("INSERT INTO emissary_idempotency(room_id, idempotency_key, tool, result_json, created_at) VALUES('retained-room','later','synthetic','{}',2)").run();
    const retainedBefore = retiredRows(store.db, "retained-room");
    assert.throws(() => executePlan(purge, plan), error => error.code === "plan_changed");
    assert.deepEqual(retiredRows(store.db, "retained-room"), retainedBefore);
    assert.deepEqual(retiredRows(store.db, "keep-room"), kept);
    assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id='retained-room'").get());
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE result='executed'").get().n, 0);
  });

  test("a retained cleanup failure rolls back earlier deletions and leaves its confirmation retryable", t => {
    const { store, retainedBefore, kept } = retainedStore(t);
    const purge = createOperatorPurge(store);
    const plan = planRetainedRoom(purge);
    const snapshot = store.db.prepare("SELECT * FROM integrity_snapshot").all();
    const rowsBefore = nonAuditRows(store.db);
    store.db.exec(`CREATE TRIGGER retained_cleanup_failure BEFORE DELETE ON external_receipts
      WHEN OLD.room_id='retained-room' BEGIN SELECT RAISE(ABORT, 'synthetic retained cleanup failure'); END`);
    assert.throws(() => executePlan(purge, plan), /synthetic retained cleanup failure/);
    assert.equal(nonAuditRows(store.db), rowsBefore);
    assert.deepEqual(retiredRows(store.db, "retained-room"), retainedBefore);
    assert.deepEqual(retiredRows(store.db, "keep-room"), kept);
    assert.deepEqual(store.db.prepare("SELECT * FROM integrity_snapshot").all(), snapshot);
    assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id='retained-room'").get());
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE result='executed'").get().n, 0);
    store.db.exec("DROP TRIGGER retained_cleanup_failure");
    assert.equal(executePlan(purge, plan).result, "executed");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE result='executed'").get().n, 1);
    assert.doesNotThrow(() => auditRecovery(store));
  });

  test("absent main tables ignore temp names while malformed retained tables fail loudly", async t => {
    const { store } = await serve(t);
    store.initialize(createdRoom("retained-room", "Synthetic main schema check"));
    store.db.exec("CREATE TEMP TABLE external_receipts(room_id TEXT); INSERT INTO temp.external_receipts VALUES('retained-room')");
    const purge = createOperatorPurge(store);
    const plan = planRetainedRoom(purge);
    assert.equal(plan.counts.find(row => row.table === "external_receipts")?.rows, 0);
    assert.equal(executePlan(purge, plan).result, "executed");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM temp.external_receipts").get().n, 1);
    assert.deepEqual(retiredTableNames(store.db), []);
    store.initialize(createdRoom("retained-room", "Synthetic malformed schema check"));
    store.db.exec("CREATE TABLE main.external_receipts(unexpected TEXT)");
    assert.throws(() => countPurge(store, [{ kind: "room", id: "retained-room" }]), /room_id/);
    assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id='retained-room'").get());
  });
});
