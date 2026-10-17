// F8: the public receipts gallery must list room-published receipts next to
// public-work receipts. The projection chain (settings toggle ->
// public_receipts -> receipts-live feed) was exercised in production only
// in the opt-in-after-settle order: suites seeded claims first and opted
// the room in afterwards, which re-projects from scratch. The live order
// is the reverse — a room opts in, THEN its work settles — and that order
// had no coverage while the production gallery sat frozen on public-work
// receipts alone. These tests pin the live order for both room sources
// (work claims and work items), through the real HTTP feed, and pin the
// negative: identical settled work in a room that never opted in stays
// out of the feed entirely. Opt-in is the only gate; ordering (newest
// first) and the feed shape are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { projectPublicWorkReceipt } from "../server/public-read-model.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const MERGED_AT = "2026-10-05T00:00:00.000Z";

function mergedClaim(id, title) {
  return {
    id, title, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: MERGED_AT }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/42", outcome: "merged", syncedAt: MERGED_AT },
    blobs: [], updatedAt: MERGED_AT,
  };
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-receipt-feed-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("gallery-room"));
  store.initialize(initialRoom("quiet-room"));
  const galleryKey = store.issueAccessKey("gallery-room", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const feed = async () => (await (await fetch(`${origin}/api/public/receipts`)).json()).receipts;
  return { store, galleryKey, origin, feed };
}

test("a work-claim receipt that settles AFTER opt-in joins the feed; the same work un-opted-in does not", async t => {
  const { store, galleryKey, origin, feed } = await serve(t);
  // Production order: opt in first, settle second — in both rooms the
  // claim settles identically; only the toggle differs.
  store.command(galleryKey, "gallery-room", { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  store.workClaims.set("gallery-room", mergedClaim("settled-claim", "Settled after opt-in"));
  store.workClaims.set("quiet-room", mergedClaim("settled-claim", "Settled after opt-in"));

  const receipts = await feed();
  const roomReceipt = receipts.find(receipt => receipt.title === "Settled after opt-in");
  assert.ok(roomReceipt, "the opted-in room's receipt is in the feed");
  assert.equal(roomReceipt.source, "work-claim");
  assert.ok(roomReceipt.id.startsWith("wcr_"), `room receipts carry the wcr_ id, got ${roomReceipt.id}`);
  // Room attribution in the feed follows the room's separate listing
  // choice (public page / directory); the receipts toggle alone publishes
  // the receipt without naming the room.
  assert.equal(receipts.filter(receipt => receipt.title === "Settled after opt-in").length, 1,
    "the quiet room's identical receipt is not in the feed");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM public_receipts WHERE origin_room_id='quiet-room'").get().n, 0,
    "no projection row exists for the room that never opted in");

  const gallery = await (await fetch(`${origin}/receipts`)).text();
  assert.match(gallery, /Settled after opt-in/, "the gallery page lists the room receipt");
  const detail = await (await fetch(`${origin}/receipts/${roomReceipt.id}`)).text();
  assert.match(detail, /Settled after opt-in/, "the room receipt has a detail page");
});

test("room receipts list alongside public-work receipts, newest first, feed shape unchanged", async t => {
  const { store, galleryKey, feed } = await serve(t);
  store.command(galleryKey, "gallery-room", { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  store.workClaims.set("gallery-room", mergedClaim("settled-claim", "Room receipt, newer"));
  projectPublicWorkReceipt(store, {
    receiptId: "pwr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Public work receipt, older",
    namespaceId: "public-gallery",
    agentName: "gallery-agent",
    createdAt: "2026-10-01T00:00:00.000Z",
  }, "ab".repeat(32));

  const receipts = await feed();
  assert.deepEqual(receipts.map(receipt => receipt.title), ["Room receipt, newer", "Public work receipt, older"],
    "one feed, both sources, newest first");
  assert.deepEqual(receipts.map(receipt => receipt.source), ["work-claim", "public-work"]);
  for (const receipt of receipts) {
    assert.equal(receipt.schema, "project-room-public-receipt/1");
    assert.ok(Array.isArray(receipt.agents) && Array.isArray(receipt.hashes));
  }
});

test("a completed work item in an opted-in room publishes a work-item receipt to the feed", async t => {
  const { store, galleryKey, feed } = await serve(t);
  const command = (key, id, type, data) => store.command(key, "gallery-room", { id, type, data });
  command(galleryKey, "add-producer", T.MEMBER_ADDED, {
    memberId: "producer", displayName: "Producer", kind: "agent",
    permissions: ["accept_work", "complete_work"], accountableHumanId: "owner",
  });
  const producerKey = store.issueAccessKey("gallery-room", "producer");
  const signEvidence = makeTestSigner(store);
  // Opt in before the work exists — the strictest production order.
  command(galleryKey, "opt-in", "room.public_receipts_set", { enabled: true });
  command(galleryKey, "propose", T.WORK_PROPOSED, {
    workItemId: "wi-feed", title: "Feed work item", definitionOfDone: "A result text.",
    accountableMemberId: "producer", mode: "read",
  });
  const revision = () => store.room("gallery-room").state.workItems["wi-feed"].revision;
  command(producerKey, "accept", T.WORK_ACCEPTED, { workItemId: "wi-feed", expectedRevision: revision() });
  command(producerKey, "start", T.WORK_STARTED, { workItemId: "wi-feed", expectedRevision: revision() });
  const text = "The feed result text.";
  command(producerKey, "complete", T.WORK_COMPLETED, {
    workItemId: "wi-feed", expectedRevision: revision(),
    summary: text, evidenceVersion: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    producerId: "producer", evidenceUrl: "https://example.invalid/feed-result",
    nextAction: "Review", signedEvidence: signEvidence(),
  });

  const receipts = await feed();
  const item = receipts.find(receipt => receipt.title === "Feed work item");
  assert.ok(item, "the work-item receipt is in the feed");
  assert.equal(item.source, "work-item");
  assert.ok(item.id.startsWith("wir_"), `work-item receipts carry the wir_ id, got ${item.id}`);
});
