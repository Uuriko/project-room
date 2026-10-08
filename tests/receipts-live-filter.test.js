// Regression sweep for the receipts-visibility wrapper rewrite
// (b4bb20e74: fast path, batched json_each queries, dropped rooms-table check).
//
// Locks in the wrapper's contracts in server/receipts-live.mjs:
//  - fast path: while no room disabled public receipts, nothing hides;
//  - a receipt hides when ANY room it belongs to disabled receipts;
//  - pwr_ receipts resolve their room through the public-work task record,
//    never through the namespace sitting in origin_room_id;
//  - a room with no directory settings row stays public (matches the old
//    `?.` read);
//  - the wrapper never reads rooms/rooms.projection on the public path;
//  - flipping the toggle back on restores visibility immediately.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  queryPublicReceipts,
  publicReceiptById,
  listPublicReceiptSitemap,
  collectPublicReceipts,
  projectPublicWorkReceipt,
} from "../server/receipts-live.mjs";

const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "qa200-reg03-"));

function addPublicWorkReceipt(store, { receiptId, namespaceId, offerId, roomId, sha, now }) {
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(offerId, namespaceId, roomId, 1, "https://github.com/Uuriko/project-room", "main", JSON.stringify(["README.md"]), 1, now);
  const body = {
    schema: "public-work-receipt/1", receiptId, namespaceId, identityId: "ai_public",
    title: `Public task ${roomId}`, createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: sha },
  };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(receiptId, offerId, namespaceId, 1, "ai_public", "note", sha, 4, JSON.stringify(body), now);
  projectPublicWorkReceipt(store, body, sha);
}

function serve(t) {
  const directory = scratch();
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = ["alpha", "beta", "gamma"];
  const keys = {};
  for (const roomId of rooms) {
    store.initialize(initialRoom(roomId));
    keys[roomId] = store.issueAccessKey(roomId, "owner");
  }
  const command = (key, roomId, id, type, data) => store.command(key, roomId, { id, type, data });
  // wcr_ rows: room receipts projected from work-claim history when the room
  // publishes receipts; origin_room_id carries the room id directly.
  for (const roomId of rooms) {
    store.workClaims.set(roomId, {
      id: `${roomId}-claim`, title: `Done work in ${roomId}`, state: "done", owner: "owner",
      history: [{ action: "pr_merged", agentId: "owner", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
      pullRequest: { url: `https://github.com/Uuriko/project-room/pull/${roomId}`, outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
      blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
    });
    command(keys[roomId], roomId, `publish-${roomId}`, "room.public_receipts_set", { enabled: true });
  }
  const now = Date.now();
  // pwr_ rows: origin_room_id carries the namespace; the owning room comes
  // from the public_work_tasks record.
  addPublicWorkReceipt(store, {
    receiptId: `pwr_${"aa".repeat(32)}`, namespaceId: `public_${"bb".repeat(16)}`,
    offerId: "offer-alpha", roomId: "alpha", sha: "aa".repeat(32), now,
  });
  addPublicWorkReceipt(store, {
    receiptId: `pwr_${"cc".repeat(32)}`, namespaceId: `public_${"dd".repeat(16)}`,
    offerId: "offer-beta", roomId: "beta", sha: "cc".repeat(32), now,
  });
  // gamma never touches the directory: no settings row at all.
  store.db.prepare("DELETE FROM room_directory_settings WHERE room_id='gamma'").run();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const wcrOf = roomId => store.db.prepare(
    "SELECT id FROM public_receipts WHERE origin_room_id=? AND source!='public-work'").all(roomId).map(row => row.id);
  return { store, keys, wcrOf };
}

const ids = page => new Set(page.receipts.map(receipt => receipt.id));
const sitemapIds = entries => new Set(entries.map(entry => String(entry.path).split("/").pop()));

test("fast path: while no room is private, nothing hides", async t => {
  const { store, wcrOf } = serve(t);
  const expected = new Set([
    ...wcrOf("alpha"), ...wcrOf("beta"), ...wcrOf("gamma"),
    `pwr_${"aa".repeat(32)}`, `pwr_${"cc".repeat(32)}`,
  ]);
  assert.ok(expected.size >= 5, "fixture projected receipts for every room");
  const page = queryPublicReceipts(store, {});
  assert.deepEqual(ids(page), expected);
  for (const id of expected) {
    assert.ok(publicReceiptById(store, id), `detail read returns ${id}`);
  }
  assert.deepEqual(sitemapIds(listPublicReceiptSitemap(store, 100)), expected);
  assert.deepEqual(new Set(collectPublicReceipts(store).map(receipt => receipt.id)), expected);
});

test("a private room's own receipts drop out of the feed, detail, sitemap, and collect", async t => {
  const { store, keys, wcrOf } = serve(t);
  store.roomDirectory.setReceiptsVisibility("beta", "owner", false);
  const betaWcr = new Set(wcrOf("beta"));
  assert.ok(betaWcr.size > 0, "beta has room receipts in the fixture");
  const page = queryPublicReceipts(store, {});
  for (const id of betaWcr) assert.ok(!ids(page).has(id), `beta receipt ${id} hidden from the feed`);
  for (const id of betaWcr) assert.equal(publicReceiptById(store, id), null, `beta receipt ${id} hidden from detail`);
  const sitemap = sitemapIds(listPublicReceiptSitemap(store, 100));
  for (const id of betaWcr) assert.ok(!sitemap.has(id), `beta receipt ${id} hidden from the sitemap`);
  const collected = new Set(collectPublicReceipts(store).map(receipt => receipt.id));
  for (const id of betaWcr) assert.ok(!collected.has(id), `beta receipt ${id} hidden from collect`);
  // alpha's receipts are untouched.
  for (const id of wcrOf("alpha")) assert.ok(ids(page).has(id), `alpha receipt ${id} stays visible`);
  assert.ok(publicReceiptById(store, wcrOf("alpha")[0]));
});

test("pwr_ receipts hide by their task's room, never by the namespace origin", async t => {
  const { store, keys } = serve(t);
  const alphaPwr = `pwr_${"aa".repeat(32)}`;
  const betaPwr = `pwr_${"cc".repeat(32)}`;
  // Sanity: the pwr_ origin really is a namespace, not a room id.
  const origin = store.db.prepare("SELECT origin_room_id FROM public_receipts WHERE id=?").get(betaPwr).origin_room_id;
  assert.match(origin, /^public_[0-9a-f]{32}$/, "pwr_ origin_room_id is the namespace");
  store.roomDirectory.setReceiptsVisibility("beta", "owner", false);
  // The receipt whose TASK sits in the private room hides...
  assert.equal(publicReceiptById(store, betaPwr), null, "pwr receipt of a private room's task is hidden");
  assert.ok(!ids(queryPublicReceipts(store, {})).has(betaPwr));
  // ...while the other namespace's receipt, whose task is in a public room, stays.
  assert.ok(publicReceiptById(store, alphaPwr), "pwr receipt of a public room's task stays visible");
  assert.ok(ids(queryPublicReceipts(store, {})).has(alphaPwr));
});

test("a room with no directory settings row stays public", async t => {
  const { store, keys, wcrOf } = serve(t);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM room_directory_settings WHERE room_id='gamma'").get().n,
    0, "gamma has no settings row in this fixture");
  store.roomDirectory.setReceiptsVisibility("beta", "owner", false);
  const gammaWcr = wcrOf("gamma");
  assert.ok(gammaWcr.length > 0, "gamma has room receipts in the fixture");
  const page = queryPublicReceipts(store, {});
  for (const id of gammaWcr) assert.ok(ids(page).has(id), `gamma receipt ${id} stays visible without a settings row`);
  assert.ok(publicReceiptById(store, gammaWcr[0]));
});

test("flipping the toggle back on restores visibility immediately", async t => {
  const { store, keys, wcrOf } = serve(t);
  const betaPwr = `pwr_${"cc".repeat(32)}`;
  store.roomDirectory.setReceiptsVisibility("beta", "owner", false);
  assert.equal(publicReceiptById(store, betaPwr), null);
  store.roomDirectory.setReceiptsVisibility("beta", "owner", true);
  assert.ok(publicReceiptById(store, betaPwr), "pwr receipt visible again");
  const pageIds = ids(queryPublicReceipts(store, {}));
  assert.ok(pageIds.has(betaPwr));
  for (const id of wcrOf("beta")) assert.ok(pageIds.has(id), `beta room receipt ${id} visible again`);
});

test("the wrapper never reads rooms or rooms.projection on the public path", async t => {
  const { store, keys } = serve(t);
  store.roomDirectory.setReceiptsVisibility("beta", "owner", false);
  const seen = [];
  const original = store.db.prepare.bind(store.db);
  store.db.prepare = (sql, ...rest) => { seen.push(String(sql)); return original(sql, ...rest); };
  try {
    queryPublicReceipts(store, {});
    publicReceiptById(store, `pwr_${"aa".repeat(32)}`);
    listPublicReceiptSitemap(store, 100);
    collectPublicReceipts(store);
  } finally {
    store.db.prepare = original;
  }
  const roomReads = seen.filter(sql => /\bfrom\s+rooms\b/i.test(sql) || /rooms\.projection/i.test(sql));
  assert.deepEqual(roomReads, [], "no rooms/rooms.projection reads issued by the wrapper");
});
