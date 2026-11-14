// F-3: pwr_ (public work receipt) rows get write-time parity with the
// recorded public-receipts setting, like wcr_/wir_ rows already have.
//
// Before the cure a pwr_ row survived a room's recorded opt-out: it was
// removed only by the separate directory toggle, so turning recorded
// public receipts off left the room's public-work receipts in
// public_receipts. The cure has two legs, both pinned here:
//   (a) replaceOptedInReceipts, reached through syncRoomPublication on
//       the recorded on -> off transition, also deletes the room's pwr_
//       rows — by origin attribution, and by task-join attribution for
//       rows whose origin is a claim namespace rather than the room.
//   (b) projectPublicWorkReceipt, for a room whose RECORDED setting is
//       exactly off (json_extract of rooms.projection yields 0), skips
//       the insert and deletes any existing row, so a re-projection
//       (review stamp, backfill) cannot resurrect an opted-out row.
// A room whose setting was never recorded keeps the old behaviour
// exactly: its pwr_ rows project and stay. No read predicate changes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { projectPublicWorkReceipt } from "../server/public-read-model.mjs";

const SHA = "cd".repeat(32);

function setup(t, roomIds) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-pwr-parity-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const keys = {};
  for (const roomId of roomIds) {
    store.initialize(initialRoom(roomId));
    keys[roomId] = store.issueAccessKey(roomId, "owner");
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys };
}

function setReceipts(store, key, roomId, id, enabled) {
  return store.command(key, roomId, { id, type: "room.public_receipts_set", data: { enabled } });
}

function addTask(store, offerId, namespace, roomId) {
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(offerId, namespace, roomId, 1, "https://github.com/Uuriko/project-room", "main", JSON.stringify(["README.md"]), 1, Date.now());
}

function bodyFor(receiptId, namespaceId, taskId = null) {
  return { schema: "public-work-receipt/1", receiptId, namespaceId, ...(taskId ? { taskId } : {}),
    identityId: "ai_public", title: "Public task", createdAt: "2026-10-01T00:00:00.000Z",
    artifact: { sha256: SHA } };
}

function addReceiptRecord(store, body, offerId) {
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    body.receiptId, offerId, body.namespaceId, 1, "ai_public", "note", SHA, 4, JSON.stringify(body), Date.now());
}

const rowCount = (store, receiptId) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM public_receipts WHERE id=?").get(receiptId).n;

test("leg (a), origin attribution: a recorded opt-out deletes the room's pwr_ row in that write", t => {
  const { store, keys } = setup(t, ["alpha"]);
  const PWR = `pwr_${"aa".repeat(32)}`;
  const body = bodyFor(PWR, "alpha");
  addReceiptRecord(store, body, "offer-alpha");
  setReceipts(store, keys.alpha, "alpha", "alpha-on", true);
  projectPublicWorkReceipt(store, body, SHA);
  assert.equal(rowCount(store, PWR), 1, "projected while recorded on");
  setReceipts(store, keys.alpha, "alpha", "alpha-off", false);
  assert.equal(rowCount(store, PWR), 0, "the opt-out write deletes the pwr_ row, like the wcr_/wir_ rows");
  // Toggling back on does not resurrect a deleted row by itself — the
  // row returns only when its source is re-projected (the backfill's
  // receipts phase does exactly that) — and a second opt-out deletes
  // the re-projected row again.
  setReceipts(store, keys.alpha, "alpha", "alpha-on-again", true);
  assert.equal(rowCount(store, PWR), 0, "recorded on alone does not resurrect a deleted row");
  projectPublicWorkReceipt(store, body, SHA);
  assert.equal(rowCount(store, PWR), 1, "re-projection while recorded on restores the row");
  setReceipts(store, keys.alpha, "alpha", "alpha-off-again", false);
  assert.equal(rowCount(store, PWR), 0, "off -> on -> off ends with no pwr_ row");
});

test("leg (a), task-join attribution: an opt-out deletes a pwr_ row whose origin is a namespace", t => {
  const { store, keys } = setup(t, ["beta"]);
  const PWR = `pwr_${"bb".repeat(32)}`;
  // No taskId on the body and no task row at projection time: the row's
  // origin falls back to the claim namespace, not the room. Only the
  // task-join attribution (public_work_receipts -> public_work_tasks)
  // ties this row to beta.
  const body = bodyFor(PWR, "ns_beta");
  addReceiptRecord(store, body, "offer-beta");
  projectPublicWorkReceipt(store, body, SHA);
  assert.equal(rowCount(store, PWR), 1);
  assert.equal(store.db.prepare("SELECT origin_room_id AS origin FROM public_receipts WHERE id=?").get(PWR).origin, "ns_beta");
  addTask(store, "offer-beta", "ns_beta", "beta");
  setReceipts(store, keys.beta, "beta", "beta-on", true);
  setReceipts(store, keys.beta, "beta", "beta-off", false);
  assert.equal(rowCount(store, PWR), 0, "the task-join attribution deletes the namespace-origin row");
});

test("leg (a) is probe-guarded: the origin leg still deletes when the public-work tables are unreadable", t => {
  const { store, keys } = setup(t, ["gamma"]);
  const PWR = `pwr_${"cc".repeat(32)}`;
  const body = bodyFor(PWR, "gamma");
  addReceiptRecord(store, body, "offer-gamma");
  setReceipts(store, keys.gamma, "gamma", "gamma-on", true);
  projectPublicWorkReceipt(store, body, SHA);
  assert.equal(rowCount(store, PWR), 1);
  // A store predating the public-work tables: the task-join leg cannot
  // be read, so it is skipped — the opt-out must not throw, and the
  // origin-attributed row is still deleted.
  store.db.exec("DROP TABLE public_work_receipts");
  store.db.exec("DROP TABLE public_work_tasks");
  setReceipts(store, keys.gamma, "gamma", "gamma-off", false);
  assert.equal(rowCount(store, PWR), 0);
});

test("leg (b): a room recorded exactly off gains no pwr_ row, and re-projection deletes an existing one", t => {
  const { store, keys } = setup(t, ["delta"]);
  const PWR = `pwr_${"dd".repeat(32)}`;
  const body = bodyFor(PWR, "ns_delta", "offer-delta");
  addTask(store, "offer-delta", "ns_delta", "delta");
  addReceiptRecord(store, body, "offer-delta");
  // Never recorded: today's behaviour — the row projects and stays.
  projectPublicWorkReceipt(store, body, SHA);
  assert.equal(rowCount(store, PWR), 1, "never-recorded room projects its pwr_ row");
  // Record off as the room's first recorded setting. That write reaches
  // neither leg (a)'s replace (nothing was ever on), so the row is still
  // there until the next projection — which is leg (b)'s moment.
  setReceipts(store, keys.delta, "delta", "delta-off", false);
  projectPublicWorkReceipt(store, body, SHA);
  assert.equal(rowCount(store, PWR), 0, "re-projection under a recorded-off setting deletes the existing row");
  projectPublicWorkReceipt(store, body, SHA);
  assert.equal(rowCount(store, PWR), 0, "projection under a recorded-off setting inserts nothing");
});

test("regression: a never-recorded room behaves exactly as today, and a recorded-on room projects", t => {
  const { store, keys } = setup(t, ["epsilon", "zeta"]);
  const PWR_NEVER = `pwr_${"ee".repeat(32)}`;
  const neverBody = bodyFor(PWR_NEVER, "ns_epsilon", "offer-epsilon");
  addTask(store, "offer-epsilon", "ns_epsilon", "epsilon");
  addReceiptRecord(store, neverBody, "offer-epsilon");
  projectPublicWorkReceipt(store, neverBody, SHA);
  projectPublicWorkReceipt(store, neverBody, SHA);
  assert.equal(rowCount(store, PWR_NEVER), 1, "never-recorded: repeated projection keeps exactly one row");
  const PWR_ON = `pwr_${"ff".repeat(32)}`;
  const onBody = bodyFor(PWR_ON, "ns_zeta", "offer-zeta");
  addTask(store, "offer-zeta", "ns_zeta", "zeta");
  addReceiptRecord(store, onBody, "offer-zeta");
  setReceipts(store, keys.zeta, "zeta", "zeta-on", true);
  projectPublicWorkReceipt(store, onBody, SHA);
  assert.equal(rowCount(store, PWR_ON), 1, "recorded on: the row projects");
});
