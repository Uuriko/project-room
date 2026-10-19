// PROOF-WALL-FLIP: the public proof surfaces stop exhibiting the
// platform's own rooms and stop serving records with no verification
// fact. Three rules, exercised end to end over HTTP:
//   1. A room its owner records internal (room.internal_set) keeps its
//      receipts in-room — the wall, the detail page, and lot visibility
//      all close — while a stranger room's verified receipt in another
//      room keeps projecting (the kill criterion: no false exclusion).
//   2. A work-claim receipt with no verification fact recorded does not
//      project (covered at the tier contract in
//      public-result-receipts.test.js; the wall here agrees).
//   3. A public-work receipt that is merely submitted (hash-only,
//      unreviewed) does not serve; once a review decision is recorded
//      — the fact arriving after projection — it serves.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  publicWorkClaimReceiptId, projectPublicWorkReceipt, syncRoomPublication, queryPublicReceipts,
} from "../server/public-read-model.mjs";
import { lotReceiptVisible } from "../server/public-visibility.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;
const LOT_ID = `lot_${"1a".repeat(8)}`;

function addAda(store, roomId, ownerKey) {
  store.command(ownerKey, roomId, { id: `add-ada-${roomId}`, type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
}

function verifiedClaim(id, title, at) {
  return {
    id, title, state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "distinct_member", reviewedBy: "owner",
    history: [{ action: "state:done", agentId: "ada", at, note: "Delivered" }],
    pullRequest: null, blobs: [HASH], updatedAt: at,
  };
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-proof-wall-flip-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("drill-room"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const drillOwnerKey = store.issueAccessKey("drill-room", "owner");
  addAda(store, "commons", ownerKey);
  addAda(store, "drill-room", drillOwnerKey);
  const adaKey = store.issueAccessKey("commons", "ada");
  // A stranger-shaped verified receipt: non-fleet room, recorded fact.
  store.workClaims.set("commons", verifiedClaim("verified-result", "Verified result work", "2026-10-02T10:00:00.000Z"));
  // A done claim with no verification fact recorded anywhere.
  store.workClaims.set("commons", {
    id: "bare-result", title: "Unrecorded finish work", state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "self_attested",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T11:00:00.000Z" }],
    pullRequest: null, blobs: [], updatedAt: "2026-10-02T11:00:00.000Z",
  });
  // The drill room's receipt is just as verified — only its room's
  // internal marking may hide it, never its shape.
  store.workClaims.set("drill-room", verifiedClaim("drill-verified", "Drill verified work", "2026-10-02T12:00:00.000Z"));
  // A public-work receipt in commons, merely submitted: hash-only,
  // unreviewed, no fact recorded yet.
  const artifactText = "the submitted teardown";
  const sha = createHash("sha256").update(artifactText, "utf8").digest("hex");
  const pwrId = `pwr_${"cd".repeat(32)}`;
  const body = { schema: "public-work-receipt/1", receiptId: pwrId, namespaceId: `public_${"ef".repeat(16)}`,
    identityId: "ai_public", title: "Submitted public work", createdAt: "2026-10-02T09:00:00.000Z",
    state: "submitted", verification: "hash_only", artifact: { sha256: sha } };
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-pwf", body.namespaceId, "commons", 1,
      "https://example.invalid/repo", "main", "[]", 1, 0);
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(pwrId, "offer-pwf", body.namespaceId, 1, "ai_public", artifactText, sha,
      Buffer.byteLength(artifactText), JSON.stringify(body), 0);
  projectPublicWorkReceipt(store, body, sha);
  store.command(ownerKey, "commons", { id: "publish-commons", type: "room.public_receipts_set", data: { enabled: true } });
  store.command(drillOwnerKey, "drill-room", { id: "publish-drill", type: "room.public_receipts_set", data: { enabled: true } });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, ownerKey, drillOwnerKey, adaKey, pwrId };
}

async function raw(origin, path) {
  const res = await fetch(`${origin}${path}`);
  return { status: res.status, text: await res.text() };
}

async function feedTitles(origin) {
  const feed = await raw(origin, "/api/public/receipts?limit=50");
  assert.equal(feed.status, 200);
  return JSON.parse(feed.text).receipts.map(receipt => receipt.title);
}

test("an internal marking closes the drill room's public surfaces; the stranger receipt keeps projecting", async t => {
  const { origin, store, drillOwnerKey, adaKey } = await serve(t);
  const drillTwin = publicWorkClaimReceiptId("drill-room", "drill-verified");

  // Before any marking, the drill receipt projects like any other
  // verified receipt — it is the marking, not the room, that hides it.
  let titles = await feedTitles(origin);
  assert.ok(titles.includes("Drill verified work"), "unmarked drill receipt projects");
  assert.ok(titles.includes("Verified result work"), "stranger verified receipt projects");
  assert.equal((await raw(origin, `/receipts/${drillTwin}`)).status, 200);
  // The no-fact claim never projects, marked room or not.
  assert.ok(!titles.includes("Unrecorded finish work"), "no-fact claim is absent from the wall");
  assert.equal((await raw(origin, `/receipts/${publicWorkClaimReceiptId("commons", "bare-result")}`)).status, 404);

  // Only the room's owner may record the marking.
  assert.throws(() => store.command(adaKey, "commons", { id: "mark-by-ada", type: "room.internal_set", data: { enabled: true } }),
    /Only the Room owner may mark the room internal/);

  store.command(drillOwnerKey, "drill-room", { id: "mark-drill-internal", type: "room.internal_set", data: { enabled: true } });

  titles = await feedTitles(origin);
  assert.ok(!titles.includes("Drill verified work"), "internal room's receipt leaves the wall");
  assert.ok(titles.includes("Verified result work"), "the stranger room's verified receipt still projects — no false exclusion");
  assert.equal((await raw(origin, `/receipts/${drillTwin}`)).status, 404, "detail page closes");
  assert.equal((await raw(origin, `/receipts/${drillTwin}.json`)).status, 404, "JSON twin closes");
  // The lot rule reads the same marking (the drill room's recorded
  // receipts setting is on, so only the internal leg can close it).
  assert.equal(lotReceiptVisible(store.db, { id: LOT_ID, roomId: "drill-room" }), false, "lots of an internal room stay private");
  assert.equal(lotReceiptVisible(store.db, { id: LOT_ID, roomId: "commons" }), true, "the stranger room's lot rule is untouched");

  // Unmarking restores projection exactly: the marking is a recorded
  // state, not a deletion.
  store.command(drillOwnerKey, "drill-room", { id: "unmark-drill", type: "room.internal_set", data: { enabled: false } });
  titles = await feedTitles(origin);
  assert.ok(titles.includes("Drill verified work"), "unmarked, the drill receipt projects again");
  assert.equal(lotReceiptVisible(store.db, { id: LOT_ID, roomId: "drill-room" }), true);
});

test("a public-work receipt serves only once a review fact is recorded", async t => {
  const { origin, store, pwrId } = await serve(t);
  assert.ok(!(await feedTitles(origin)).includes("Submitted public work"), "submitted, hash-only, unreviewed: absent from the wall");
  assert.equal((await raw(origin, `/receipts/${pwrId}`)).status, 404);
  assert.equal((await raw(origin, `/receipts/${pwrId}.json`)).status, 404);

  // The designated reviewer records a decision — the fact arrives
  // after projection, through the review record the read composes.
  store.db.prepare("INSERT INTO public_work_reviews (receipt_id, room_id, revision, state_json) VALUES (?,?,?,?)")
    .run(pwrId, "commons", 1, JSON.stringify({
      state: "rejected", verification: null,
      decision: { decision: "rejected", at: "2026-10-03T00:00:00.000Z" },
    }));
  assert.ok((await feedTitles(origin)).includes("Submitted public work"),
    "a recorded reviewer decision is a fact: the receipt serves (as rejected, not dressed as accepted)");
  const detail = await raw(origin, `/receipts/${pwrId}.json`);
  assert.equal(detail.status, 200);
  assert.equal(JSON.parse(detail.text).state, "rejected");
});

test("work-item receipts project only with a recorded reporter, and an internal state hides the room's rows at read", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-proof-wall-flip-projector-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  const state = {
    room: { id: "commons", ownerId: "owner", title: "Commons",
      publicReceipts: { enabled: true, revision: 1, setById: "owner", setAt: "2026-10-02T00:00:00.000Z" } },
    members: {
      owner: { id: "owner", displayName: "Owner", kind: "human", active: true },
      ada: { id: "ada", displayName: "Ada", kind: "agent", active: true },
    },
    workItems: {
      "reported-item": { id: "reported-item", state: "completed", title: "Reported completion", accountableMemberId: "ada",
        receipt: { reportedById: "ada", producerId: "ada", evidenceVersion: HASH }, updatedAt: "2026-10-02T10:00:00.000Z" },
      "unreported-item": { id: "unreported-item", state: "completed", title: "Unreported completion", accountableMemberId: "ada",
        receipt: { reportedById: null, producerId: "ada", evidenceVersion: HASH }, updatedAt: "2026-10-02T11:00:00.000Z" },
    },
  };
  syncRoomPublication(store, { roomId: "commons", state, previous: null });
  let titles = queryPublicReceipts(store, { limit: 50 }).receipts.map(receipt => receipt.title);
  assert.ok(titles.includes("Reported completion"), "a completion with a recorded reporter projects");
  assert.ok(!titles.includes("Unreported completion"), "a completion with no recorded reporter does not project");

  const internalState = { ...state, room: { ...state.room, internal: { enabled: true, revision: 1, setById: "owner", setAt: "2026-10-02T12:00:00.000Z" } } };
  syncRoomPublication(store, { roomId: "commons", state: internalState, previous: state });
  titles = queryPublicReceipts(store, { limit: 50 }).receipts.map(receipt => receipt.title);
  assert.deepEqual(titles, [], "once the room is recorded internal, its rows serve on no public read");
});
