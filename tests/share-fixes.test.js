// Share-journey repairs (UT-SHARE-JOURNEY F-2..F-6): the public receipt
// proves the work, not only the title — the producer-reported summary and
// claimed checks ride the projection (F-2); the member receipt names the
// twin that is actually live, including a board work item's wir_ twin
// (F-3); one tier vocabulary names the level on every surface (F-4); the
// public list's room filter finds an unlisted room's own receipts (F-5);
// and the /join onward link is labelled for what /join does (F-6).
// The invariant under every repair is the #3594 boundary: fields widen
// only inside projections the owner already opted in to, and a receipt
// from a room that never opted in refuses anonymous reads exactly as at
// main — asserted here in the QA-STRANGER-2 leg-6 shape.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  ensurePublicReceiptShareColumns, publicWorkItemReceiptId, publicWorkClaimReceiptId,
} from "../server/public-read-model.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const SUMMARY = "Silent autumn room / agents pass the work along / receipts tell the tale";
const CHECKS = ["haiku syllables counted", "receipt boundary probed"];

function completeWorkItem(store, roomId, ownerKey, signEvidence) {
  const cmd = (key, id, type, data) => store.command(key, roomId, { id, type, data });
  cmd(ownerKey, `add-producer-${roomId}`, T.MEMBER_ADDED, {
    memberId: "producer", displayName: "Producer", kind: "agent",
    permissions: ["accept_work", "complete_work"], accountableHumanId: "owner",
  });
  const producerKey = store.issueAccessKey(roomId, "producer");
  cmd(ownerKey, `propose-${roomId}`, T.WORK_PROPOSED, {
    workItemId: "wi-share", title: "Share journey haiku", definitionOfDone: "A haiku.",
    accountableMemberId: "producer", mode: "read",
  });
  const revision = () => store.room(roomId).state.workItems["wi-share"].revision;
  cmd(producerKey, `accept-${roomId}`, T.WORK_ACCEPTED, { workItemId: "wi-share", expectedRevision: revision() });
  cmd(producerKey, `start-${roomId}`, T.WORK_STARTED, { workItemId: "wi-share", expectedRevision: revision() });
  cmd(producerKey, `complete-${roomId}`, T.WORK_COMPLETED, {
    workItemId: "wi-share", expectedRevision: revision(),
    summary: SUMMARY, evidenceVersion: `sha256:${createHash("sha256").update(SUMMARY).digest("hex")}`,
    producerId: "producer", evidenceUrl: "https://example.invalid/haiku",
    checksClaimed: CHECKS,
    nextAction: "Review", signedEvidence: signEvidence(),
  });
  return producerKey;
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-share-fixes-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("share-room"));
  store.initialize(initialRoom("quiet-room"));
  const shareKey = store.issueAccessKey("share-room", "owner");
  const quietKey = store.issueAccessKey("quiet-room", "owner");
  const signEvidence = makeTestSigner(store);
  // Receipts opt-in ONLY — no public page, no directory listing — so the
  // room's receipts carry room_id NULL (the F-5 shape from production).
  store.command(shareKey, "share-room", { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  const producerKey = completeWorkItem(store, "share-room", shareKey, signEvidence);
  // A result-mode claim carrying a delivery bundle (the wcr_ shape).
  store.workClaims.set("share-room", {
    id: "result-claim", title: "Result claim work", state: "done", owner: "producer",
    deliveryMode: "result", reviewPolicy: "self_attested",
    history: [{ action: "state:done", agentId: "producer", at: "2026-10-02T11:00:00.000Z", note: "Finished the survey" }],
    delivery: { checks: [{ name: "survey rows counted", result: "pass" }, { name: "totals reconciled", result: "pass" }] },
    pullRequest: null, blobs: [], updatedAt: "2026-10-02T11:00:00.000Z",
  });
  // The identical completion in a room that never opted in (boundary).
  completeWorkItem(store, "quiet-room", quietKey, signEvidence);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, producerKey };
}

const get = async (origin, path, headers = {}) => {
  const res = await fetch(`${origin}${path}`, { headers });
  return { status: res.status, text: await res.text() };
};

test("F-2: the public projection carries the producer-reported summary and claimed checks", async t => {
  const { origin } = await serve(t);
  const feed = JSON.parse((await get(origin, "/api/public/receipts?limit=50")).text).receipts;
  const wir = feed.find(receipt => receipt.source === "work-item");
  assert.ok(wir, "the work-item receipt is in the feed");
  assert.equal(wir.summary, SUMMARY);
  assert.deepEqual(wir.checksClaimed, CHECKS);
  const wcr = feed.find(receipt => receipt.source === "work-claim");
  assert.ok(wcr, "the result-mode claim receipt is in the feed");
  assert.equal(wcr.summary, "Finished the survey");
  assert.deepEqual(wcr.checksClaimed, ["survey rows counted", "totals reconciled"]);

  // Page and JSON twin show the deliverable, labelled producer-reported.
  const page = await get(origin, `/receipts/${wir.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /What was delivered/);
  assert.ok(page.text.includes(SUMMARY), "the page shows the summary text");
  for (const check of CHECKS) assert.ok(page.text.includes(check), `the page lists the claimed check: ${check}`);
  assert.match(page.text, /not independently verified/);
  const json = JSON.parse((await get(origin, `/receipts/${wir.id}.json`)).text);
  assert.equal(json.summary, SUMMARY);
  assert.deepEqual(json.checksClaimed, CHECKS);
});

test("F-3: the member receipt names the work-item twin that is actually live", async t => {
  const { origin, producerKey } = await serve(t);
  const member = JSON.parse((await get(origin, "/api/rooms/share-room/receipts", { authorization: `Bearer ${producerKey}` })).text);
  const byId = new Map(member.receipts.map(receipt => [receipt.workItemId, receipt]));
  const item = byId.get("wi-share");
  const wirId = publicWorkItemReceiptId("share-room", "wi-share");
  assert.equal(item.publicId, wirId);
  assert.equal(item.publicUrl, `https://room.trydemigod.com/receipts/${wirId}`);
  // The advertised link resolves anonymously — it is the live twin.
  assert.equal((await get(origin, `/receipts/${item.publicId}`)).status, 200);
  const claim = byId.get("result-claim");
  assert.equal(claim.publicId, publicWorkClaimReceiptId("share-room", "result-claim"));
});

test("F-4 + F-6: one tier vocabulary, and the join link says what /join does", async t => {
  const { origin } = await serve(t);
  const feed = JSON.parse((await get(origin, "/api/public/receipts?limit=50")).text).receipts;
  const wir = feed.find(receipt => receipt.source === "work-item");
  const page = await get(origin, `/receipts/${wir.id}`);
  assert.match(page.text, /Verification tier: Room-recorded completion\./);
  assert.doesNotMatch(page.text, /bundle unaltered/);
  assert.doesNotMatch(page.text, /Post a bounty/);
  assert.match(page.text, /<a href="\/join">Join Project Room<\/a>/);
  const wcr = feed.find(receipt => receipt.source === "work-claim");
  const claimPage = await get(origin, `/receipts/${wcr.id}`);
  assert.match(claimPage.text, /Verification tier: Self-attested completion\./);
  assert.doesNotMatch(claimPage.text, /bundle unaltered/);
});

test("F-5: the room filter finds an unlisted room's own published receipts", async t => {
  const { origin } = await serve(t);
  const all = JSON.parse((await get(origin, "/api/public/receipts?limit=50")).text).receipts;
  assert.ok(all.every(receipt => receipt.room === null), "the fixture room is unlisted: its rows name no room");
  const byRoom = JSON.parse((await get(origin, "/api/public/receipts?room=share-room")).text).receipts;
  assert.deepEqual(byRoom.map(receipt => receipt.id).sort(), all.map(receipt => receipt.id).sort());
  // Paginating through the filter keeps working: the cursor names a
  // receipt this filtered list may anchor on.
  const first = JSON.parse((await get(origin, "/api/public/receipts?room=share-room&limit=1")).text);
  assert.equal(first.receipts.length, 1);
  assert.ok(first.nextCursor, "a one-item page over two receipts has a cursor");
  const second = JSON.parse((await get(origin, `/api/public/receipts?room=share-room&limit=1&cursor=${first.nextCursor}`)).text);
  assert.equal(second.receipts.length, 1);
  assert.notEqual(second.receipts[0].id, first.receipts[0].id);
});

test("boundary: a room that never opted in refuses anonymous reads exactly as at main", async t => {
  const { origin, store } = await serve(t);
  const quietWir = publicWorkItemReceiptId("quiet-room", "wi-share");
  // The read model itself resolves nothing for the non-public twin.
  assert.equal(publicReceiptById(store, quietWir), null);
  // Page and JSON twin refuse like any private receipt (404, the same
  // shape a never-existent id gets).
  assert.equal((await get(origin, `/receipts/${quietWir}`)).status, 404);
  assert.equal((await get(origin, `/receipts/${quietWir}.json`)).status, 404);
  const missing = await get(origin, `/receipts/wir_${"0".repeat(32)}`);
  assert.equal(missing.status, 404);
  // The room filter leaks nothing for the quiet room.
  const byQuiet = JSON.parse((await get(origin, "/api/public/receipts?room=quiet-room")).text).receipts;
  assert.deepEqual(byQuiet, []);
  // And no summary or checks for the quiet completion appear anywhere
  // in the public feed.
  const feed = JSON.parse((await get(origin, "/api/public/receipts?limit=50")).text).receipts;
  assert.equal(feed.filter(receipt => receipt.summary === SUMMARY).length, 1,
    "only the opted-in room's receipt carries the summary");
});

test("a legacy public_receipts table gains the share columns additively", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-share-migration-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  const columns = () => store.db.prepare("PRAGMA table_info(public_receipts)").all().map(column => column.name);
  assert.ok(columns().includes("summary") && columns().includes("checks_json"), "fresh tables carry both columns");
  store.db.exec("ALTER TABLE public_receipts DROP COLUMN summary");
  store.db.exec("ALTER TABLE public_receipts DROP COLUMN checks_json");
  assert.equal(columns().includes("summary"), false);
  ensurePublicReceiptShareColumns(store.db);
  assert.ok(columns().includes("summary") && columns().includes("checks_json"), "the ensure restores both on a legacy table");
  ensurePublicReceiptShareColumns(store.db);
  assert.ok(columns().includes("summary"), "and is idempotent");
});
