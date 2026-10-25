// Projection shape upgrade v1 (server/legacy-message-shape.mjs). Built on
// research r57's repro: prod muse-room's stored projection carries message
// shapes today's reducer no longer builds (reactions from before #3831; no
// derived receiptId on receipt cards from before d7578160f), so messages
// parity fails on the first of them once the backfill catches up.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { PURGE_TABLES } from "../server/purge-registry.mjs";
import { lazyAdditiveTables } from "../server/writer-fence.mjs";
import { upgradeLegacyMessages } from "../server/legacy-message-shape.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";

const LONG = "long body kept at rest ".repeat(20);

function seeded(t, { bodiesAtRest = false, cardData = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "r58-legacy-shape-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { bodiesAtRest });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const at = n => new Date(Date.UTC(2026, 9, 3) + n * 1000).toISOString();
  store.initialize([
    ...initialRoom("commons"),
    event({ type: T.MESSAGE_POSTED, actorId: "owner", roomId: "commons", id: "ev-card", idempotencyKey: "k-card", at: at(1),
      data: { messageId: "card", body: "Closed", kind: "receipt_card", claimId: "CLAIM-1", title: "Done", closedBy: "Owner", deliveryMode: "merged", evidence: "Merged PR 1 abc. Source completion only.", ...cardData } }),
    event({ type: T.MESSAGE_POSTED, actorId: "owner", roomId: "commons", id: "ev-plain", idempotencyKey: "k-plain", at: at(2),
      data: { messageId: "plain", body: "hello" } }),
    event({ type: T.MESSAGE_POSTED, actorId: "owner", roomId: "commons", id: "ev-long", idempotencyKey: "k-long", at: at(3),
      data: { messageId: "long", body: LONG } })
  ]);
  return store;
}
const stored = store => JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
function rewriteProjection(store, edit) {
  const projection = stored(store);
  edit(projection.messages);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(projection));
  store._projectionCache?.clear?.();
}
const legacy = messages => {
  delete messages.find(m => m.id === "card").receiptId;
  messages.find(m => m.id === "plain").reactions = { "👀": ["owner"] };
};
function catchUp(store) {
  let result, guard = 0;
  do { result = store.backfillMessages({ limit: 400 }); } while (!result.done && ++guard < 50);
  assert.equal(result.done, true);
  assert.deepEqual(result.blocked, []);
}
const parityFailures = store => store.integrityFailures().filter(row => row.step === "messages_parity");
const audits = store => store.db.prepare("SELECT room_id, version, target, reactions_removed, receipt_ids_added, runs FROM projection_shape_upgrades ORDER BY target").all().map(row => ({ ...row }));

test("legacy shapes no longer fail the parity step: it upgrades them first and certifies", t => {
  const store = seeded(t);
  rewriteProjection(store, legacy);
  catchUp(store);
  store.runIntegrityParityStep();
  assert.deepEqual(parityFailures(store), []);
  const cursor = store.db.prepare("SELECT applied_seq, parity_at_seq FROM messages_backfill_cursor WHERE room_id='commons'").get();
  assert.equal(cursor.parity_at_seq, cursor.applied_seq, "the room is certified at its head");
  const messages = stored(store).messages;
  const card = messages.find(m => m.id === "card");
  assert.equal(card.receiptId, "rc_CLAIM-1");
  assert.deepEqual(Object.keys(card).slice(Object.keys(card).indexOf("claimId"), Object.keys(card).indexOf("claimId") + 2), ["claimId", "receiptId"], "the reducer's key order");
  assert.equal(Object.hasOwn(messages.find(m => m.id === "plain"), "reactions"), false);
  assert.deepEqual(audits(store), [{ room_id: "commons", version: 1, target: "projection", reactions_removed: 1, receipt_ids_added: 1, runs: 1 }]);
  assert.doesNotThrow(() => auditRecovery(store));
});

test("a card whose posting event carried receiptId gets that id, not the derived one", t => {
  const store = seeded(t, { cardData: { receiptId: "rc_custom-7" } });
  rewriteProjection(store, messages => { delete messages.find(m => m.id === "card").receiptId; });
  assert.equal(store.upgradeLegacyMessageShapes().receiptIdsAdded, 1);
  assert.equal(stored(store).messages.find(m => m.id === "card").receiptId, "rc_custom-7");
  catchUp(store);
  assert.equal(store.checkMessagesParity().ok, true);
});

test("the upgrade is idempotent and leaves a current projection byte-identical", t => {
  const store = seeded(t);
  const before = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  assert.deepEqual(store.upgradeLegacyMessageShapes(), { rooms: 0, reactionsRemoved: 0, receiptIdsAdded: 0 });
  assert.equal(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection, before);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='projection_shape_upgrades'").get(), undefined, "no audit table without a change");
  rewriteProjection(store, legacy);
  assert.equal(store.upgradeLegacyMessageShapes().rooms, 1);
  assert.equal(store.upgradeLegacyMessageShapes().rooms, 0);
  assert.equal(audits(store)[0].runs, 1);
});

test("a legacy checkpoint is upgraded too, so a replay from it builds current shapes", t => {
  const store = seeded(t);
  const state = store.room("commons").state;
  const checkpoint = structuredClone(state);
  legacy(checkpoint.messages);
  store.db.prepare("INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)").run("commons", store.room("commons").sequence, JSON.stringify(checkpoint));
  assert.equal(Object.hasOwn(store.rebuildProjection("commons").state.messages.find(m => m.id === "plain"), "reactions"), true, "replay starts from the legacy checkpoint");
  const result = store.upgradeLegacyMessageShapes();
  assert.equal(result.rooms, 1);
  const rebuilt = store.rebuildProjection("commons").state.messages;
  assert.equal(Object.hasOwn(rebuilt.find(m => m.id === "plain"), "reactions"), false);
  assert.equal(rebuilt.find(m => m.id === "card").receiptId, "rc_CLAIM-1");
  assert.deepEqual(audits(store).map(row => row.target), ["checkpoint"]);
  assert.doesNotThrow(() => auditRecovery(store));
});

test("with bodies at rest, a long body stays readable after the upgrade rewrites the row", t => {
  const store = seeded(t, { bodiesAtRest: true });
  assert.equal(typeof stored(store).messages.find(m => m.id === "long").bodyRef, "string", "the fixture body is at rest");
  rewriteProjection(store, messages => { messages.find(m => m.id === "long").reactions = { "+1": ["owner"] }; });
  assert.equal(store.upgradeLegacyMessageShapes().reactionsRemoved, 1);
  const message = store.room("commons").state.messages.find(m => m.id === "long");
  assert.equal(message.body, LONG);
  assert.equal(Object.hasOwn(message, "reactions"), false);
  catchUp(store);
  assert.equal(store.checkMessagesParity().ok, true);
});

test("an upgraded room's parity certification is cleared so the sweep re-certifies it", t => {
  const store = seeded(t);
  catchUp(store);
  assert.equal(store.checkMessagesParity().ok, true);
  rewriteProjection(store, legacy);
  store.upgradeLegacyMessageShapes();
  assert.equal(store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='commons'").get().parity_at_seq, null);
});

test("the audit table is registered: room purge deletes it and the recovery audit allows it", () => {
  const entry = PURGE_TABLES.find(row => row.table === "projection_shape_upgrades");
  assert.ok(entry, "purge registry entry");
  assert.equal(entry.action, "delete");
  assert.deepEqual([...entry.match.room], ["room_id"]);
  assert.ok(lazyAdditiveTables.includes("projection_shape_upgrades"));
});

test("upgradeLegacyMessages: only the two legacy fields change", () => {
  const state = { messages: [
    { id: "a", body: "x", reactions: {} },
    { id: "b", kind: "receipt_card", claimId: "C", title: "t" },
    { id: "c", kind: "receipt_card", claimId: "D", receiptId: "rc_keep" },
    { id: "d", kind: "receipt_card", title: "no claim" },
    null
  ] };
  assert.deepEqual(upgradeLegacyMessages(state, new Map()), { reactionsRemoved: 1, receiptIdsAdded: 1 });
  assert.deepEqual(state.messages[0], { id: "a", body: "x" });
  assert.deepEqual(Object.keys(state.messages[1]), ["id", "kind", "claimId", "receiptId", "title"]);
  assert.equal(state.messages[2].receiptId, "rc_keep");
  assert.equal(Object.hasOwn(state.messages[3], "receiptId"), false);
});
