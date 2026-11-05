// MGMT-PANEL Slice 2 — guarded room delete (Path A only) and the G-1
// money/proof clearance guard in the purge core.
//
// Covered, per PANEL-SPEC v2 §2.4 / §9 and CRITIQUE MF-1/MF-2/MF-3/MF-5:
//   MF-2  the guard set covers every registry table that can carry
//         money/proof rows for a room (registry-parsing coverage test);
//   MF-1  a money-bearing room is refused through BOTH the panel wrapper
//         and a direct generic purge plan — the guard lives in
//         operator-purge.mjs roomGuards(), not in the panel;
//   MF-3  a money row arriving after the plan is refused at execute,
//         inside the execute transaction, as money_bearing_room;
//   MF-5  the panel execute verifies the typed title + id server-side;
//   G-2   execute needs a room_export audit row no older than 24 hours;
//   G-3   the panel plans only lifecycle-archived rooms (MF-5a: the
//         verified archived_at is what discharges allowActiveMembers);
//   G-4   the panel accepts exactly one target: the room in the path;
//   Path A happy path: message-archive, lifecycle-archive, export on
//   record, plan, execute — the room is gone and the audit rows remain.
// Path B (outright delete of a live room) is not built (MF-4): the panel
// refuses a non-archived room while the generic flow is unchanged.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { PURGE_TABLES } from "../server/purge-registry.mjs";
import { createOperatorPurge, MONEY_PROOF_TABLES } from "../server/operator-purge.mjs";
import { createOperatorRoomPurge } from "../server/operator-room-purge.mjs";
import { appendOperatorAction } from "../server/operator-actions.mjs";
import { operatorArchive } from "../server/operator-archive.mjs";
import { event, EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

const TOKEN = "operator-room-purge-token-0123456789ab";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function createdRoom(roomId, title, humans = 1) {
  const events = [
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId, data: { roomId, ownerId: "owner", title, purpose: "operator room purge fixture" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, data: { memberId: "owner", displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } })
  ];
  if (humans > 1) {
    events.push(event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, data: { memberId: "second", displayName: "Second human", kind: "human", permissions: ["steer"] } }));
  }
  return events;
}

function archiveLifecycle(store, roomId) {
  const owner = store.issueAccessKey(roomId, "owner");
  store.command(owner, roomId, { id: randomUUID(), type: T.ROOM_ARCHIVED, data: {} });
  const row = store.db.prepare("SELECT archived_at AS archivedAt FROM rooms WHERE id=?").get(roomId);
  assert.ok(row?.archivedAt, `${roomId} is lifecycle-archived`);
  return owner;
}

function seedJournalRow(store, roomId, entryId = `entry-${roomId}`) {
  store.db.prepare("INSERT INTO bounty_journal (room_id, entry_id, account_id, at, kind, amount, lot_state, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(roomId, entryId, "acct-fixture", new Date().toISOString(), "genesis", 100, "payable", "0".repeat(64), "1".repeat(64));
}

function recordExport(store, roomId) {
  appendOperatorAction(store, {
    action: "room_export", targetKind: "room", targetId: roomId,
    reason: null, counts: { format: "jsonl", events: 3, bytes: 128, scrubbed: true }, result: "ok", requestId: randomUUID()
  });
}

// The room flood guard refills on the store clock; message-posting
// fixtures step the clock per post (the operator-archive suite's pattern).
function steppingClock() {
  let clock = Date.now();
  return { now: () => clock, step: (ms = 10_000) => { clock += ms; } };
}

function postMessages(store, clock, roomId, owner, n) {
  for (let i = 0; i < n; i++) {
    clock.step();
    store.command(owner, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: `fixture message ${i}` } });
  }
}

async function serve(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-op-room-purge-"));
  const clock = steppingClock();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: clock.now, ...options });
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
  const call = async (path, { method = "GET", data, token = TOKEN } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(token ? { Authorization: `Operator ${token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {})
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  };
  return { store, call, clock };
}

function unitStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-op-room-purge-unit-"));
  const clock = steppingClock();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: clock.now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, clock };
}

describe("MF-2 registry coverage for the G-1 guard set", () => {
  // The families named in PANEL-SPEC v2 §2.4 / CRITIQUE MF-2. A table is in
  // scope when the registry can delete it for a room (room match or via),
  // with two named exceptions read straight from the spec: stitch_receipts
  // is in the guard set although its registry entry is account-scoped (its
  // room count is always 0, so including it costs nothing), and
  // public_work_receipts is OUT although its family matches, because its
  // registry entry is identity-scoped and it survives a room purge.
  const inFamily = table =>
    table.startsWith("bounty_") ||
    table.startsWith("public_work_") ||
    table === "public_receipts" ||
    table.startsWith("spend_") ||
    table.startsWith("work_claim") ||
    table === "stitch_receipts" ||
    table === "room_vetting_receipts" ||
    table === "external_receipts" ||
    table.startsWith("demigod_contract");

  test("every registry table that can carry money/proof rows for a room is in the guard set", () => {
    const guard = new Set(MONEY_PROOF_TABLES);
    const scoped = PURGE_TABLES.filter(entry =>
      entry.action === "delete" && inFamily(entry.table) &&
      (entry.match?.room || entry.via?.room || entry.table === "stitch_receipts"));
    assert.ok(scoped.length >= 30, `expected at least 30 scoped registry tables, got ${scoped.length}`);
    for (const entry of scoped) {
      if (entry.table === "public_work_receipts") continue; // identity-only; see header
      assert.ok(guard.has(entry.table), `${entry.table} is a room-deleted money/proof table missing from MONEY_PROOF_TABLES`);
    }
  });

  test("public_work_receipts is not in the guard set and has no room match in the registry", () => {
    assert.equal(MONEY_PROOF_TABLES.includes("public_work_receipts"), false);
    const entry = PURGE_TABLES.find(row => row.table === "public_work_receipts");
    assert.ok(entry, "registry still names public_work_receipts");
    assert.equal(entry.match?.room, undefined);
  });

  test("every guard-set table exists in the purge registry", () => {
    const registry = new Set(PURGE_TABLES.map(entry => entry.table));
    for (const table of MONEY_PROOF_TABLES) assert.ok(registry.has(table), `${table} is in the guard set but not in the purge registry`);
    assert.equal(MONEY_PROOF_TABLES.length, 31);
  });
});

describe("MF-1 G-1 binds every caller", { concurrency: false }, () => {
  before(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  test("a room with a single genesis journal row refuses through the generic purge route and through the panel wrapper", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("money-room", "Money Room"));
    archiveLifecycle(store, "money-room");
    seedJournalRow(store, "money-room");

    const generic = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "money-room" }], reason: "Remove money room", allowActiveMembers: true } });
    assert.equal(generic.status, 422, JSON.stringify(generic.body));
    assert.equal(generic.body.error.code, "money_bearing_room");

    const panel = await call("/api/operator/rooms/money-room/purge/plan", { method: "POST", data: { reason: "Remove money room" } });
    assert.equal(panel.status, 422, JSON.stringify(panel.body));
    assert.equal(panel.body.error.code, "money_bearing_room");

    assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id='money-room'").get(), "room survives both refusals");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM bounty_journal WHERE room_id='money-room'").get().n, 1);
  });

  test("MF-3: a money row arriving after the plan refuses execute in-transaction as money_bearing_room", t => {
    const { store } = unitStore(t);
    store.initialize(createdRoom("race-room", "Race Room"));
    const purge = createOperatorPurge(store);
    const plan = purge.plan({ targets: [{ kind: "room", id: "race-room" }], reason: "Race fixture" }, randomUUID());
    seedJournalRow(store, "race-room");
    assert.throws(
      () => purge.execute({ planId: plan.planId, confirmToken: plan.confirmToken }, randomUUID()),
      error => error.code === "money_bearing_room"
    );
    assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id='race-room'").get(), "room survives the refused execute");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE result='executed'").get().n, 0);
  });
});

describe("panel Path A wrapper", { concurrency: false }, () => {
  before(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  test("a non-archived room refuses at the panel while the generic flow is unchanged; batch targets refuse", async t => {
    const { store, call } = await serve(t);
    store.initialize(createdRoom("live-room", "Live Room"));
    store.initialize(createdRoom("other-room", "Other Room"));

    const panel = await call("/api/operator/rooms/live-room/purge/plan", { method: "POST", data: { reason: "Delete live room" } });
    assert.equal(panel.status, 422, JSON.stringify(panel.body));
    assert.equal(panel.body.error.code, "room_not_archived");

    const batch = await call("/api/operator/rooms/live-room/purge/plan", { method: "POST", data: { reason: "Batch", targets: [{ kind: "room", id: "live-room" }, { kind: "room", id: "other-room" }] } });
    assert.equal(batch.status, 422);
    assert.equal(batch.body.error.code, "invalid_purge");

    // Path B is not built, but the pre-existing generic flow is the status
    // quo and is unchanged by the panel: a live money-free room still plans.
    const generic = await call("/api/operator/purge/plan", { method: "POST", data: { targets: [{ kind: "room", id: "live-room" }], reason: "Status quo check" } });
    assert.equal(generic.status, 200, JSON.stringify(generic.body));
  });

  test("archive then purge: a money-free archived room purges end to end through the panel routes", async t => {
    const { store, call, clock } = await serve(t);
    const roomId = "archived-room";
    store.initialize(createdRoom(roomId, "Archived Room", 2));
    const owner = store.issueAccessKey(roomId, "owner");
    postMessages(store, clock, roomId, owner, 110);
    // (a) Message archive through the existing operator door: dry run, then
    // a real run on the dry run's expect. The room stays open throughout.
    const dry = await call("/api/operator/archive", { method: "POST", data: { roomId, keepNewest: 100, reason: "Panel archive fixture" } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.ok(dry.body.archived > 0);
    const ran = await call("/api/operator/archive", { method: "POST", data: { roomId, keepNewest: 100, reason: "Panel archive fixture", dryRun: false, expect: dry.body.expect } });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(store.db.prepare("SELECT archived_at FROM rooms WHERE id=?").get(roomId).archived_at, null, "message archive does not lifecycle-archive");

    // Lifecycle archive (the owner's act) is Path A's precondition. The
    // room keeps 2 active human members in its projection; the verified
    // archived_at is what lets the panel plan it at all (MF-5a).
    archiveLifecycle(store, roomId);

    const plan = await call(`/api/operator/rooms/${roomId}/purge/plan`, { method: "POST", data: { reason: "Remove archived fixture" } });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.moneyProof, "clear");
    assert.equal(plan.body.exportOnRecordAt, null);

    const executeBody = {
      planId: plan.body.planId, confirmToken: plan.body.confirmToken,
      confirmTitle: "Archived Room", confirmId: roomId, exportHeld: true
    };
    const noExport = await call(`/api/operator/rooms/${roomId}/purge/execute`, { method: "POST", data: executeBody });
    assert.equal(noExport.status, 409, JSON.stringify(noExport.body));
    assert.equal(noExport.body.error.code, "export_required");

    recordExport(store, roomId);
    const wrongTitle = await call(`/api/operator/rooms/${roomId}/purge/execute`, { method: "POST", data: { ...executeBody, confirmTitle: "Wrong Title" } });
    assert.equal(wrongTitle.status, 422, JSON.stringify(wrongTitle.body));
    assert.equal(wrongTitle.body.error.code, "confirmation_mismatch");
    assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId), "room survives a mismatched confirmation");

    const done = await call(`/api/operator/rooms/${roomId}/purge/execute`, { method: "POST", data: executeBody });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.result, "executed");
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId), undefined, "room is purged");

    const actions = store.db.prepare("SELECT action, result FROM operator_actions").all();
    assert.ok(actions.some(row => row.action === "messages_archive" && row.result === "ok"), "message-archive audit row");
    assert.ok(actions.some(row => row.action === "room_export" && row.result === "ok"), "export audit row");
    assert.ok(actions.some(row => row.action === "plan" && row.result === "ok"), "plan audit row");
    assert.ok(actions.some(row => row.action === "execute" && row.result === "executed"), "execute audit row");
  });

  test("G-2: an export older than 24 hours refuses execute; a fresh one allows it", t => {
    const { store } = unitStore(t);
    const roomId = "stale-export-room";
    store.initialize(createdRoom(roomId, "Stale Export Room"));
    archiveLifecycle(store, roomId);
    const roomPurge = createOperatorRoomPurge(store);
    const plan = roomPurge.plan(roomId, { reason: "Stale export fixture" }, randomUUID());
    store.db.prepare(`INSERT INTO operator_actions (id, at, action, target_kind, target_id, reason, plan_hash, counts_json, result, request_id)
      VALUES ('oa_stale_export_fixture', ?, 'room_export', 'room', ?, NULL, NULL, '{"format":"jsonl","events":1,"bytes":10,"scrubbed":true}', 'ok', 'req-stale')`)
      .run(store.now() - 25 * 60 * 60 * 1000, roomId);
    const body = { planId: plan.planId, confirmToken: plan.confirmToken, confirmTitle: "Stale Export Room", confirmId: roomId, exportHeld: true };
    assert.throws(() => roomPurge.execute(roomId, body, randomUUID()), error => error.code === "export_required");
    recordExport(store, roomId);
    const done = roomPurge.execute(roomId, body, randomUUID());
    assert.equal(done.result, "executed");
    assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId), undefined);
  });

  test("the archive door still works directly for a room the panel will later purge", t => {
    const { store, clock } = unitStore(t);
    const roomId = "door-room";
    store.initialize(createdRoom(roomId, "Door Room"));
    const owner = store.issueAccessKey(roomId, "owner");
    postMessages(store, clock, roomId, owner, 105);
    const dry = operatorArchive(store, { roomId, keepNewest: 100, reason: "Door fixture" }, randomUUID());
    assert.ok(dry.archived > 0);
    const done = operatorArchive(store, { roomId, keepNewest: 100, reason: "Door fixture", dryRun: false, expect: dry.expect }, randomUUID());
    assert.equal(done.ok, true);
    assert.ok(done.projectionBytes.after < done.projectionBytes.before);
  });
});
