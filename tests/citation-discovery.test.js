// Citation discovery (UT-SHARE F-3 / F-5): the member who owns a live
// public receipt must be able to find its URL from inside the room, and
// the public list's room filter must find a room's own receipts.
//
// F-3: a completed board work item projects its completion ONLY as a
// wir_ (work-item) row — the mirrored claim is deliberately skipped in
// the projection — but the member receipt read computed only the wcr_
// twin id, so the owner read publicId/publicUrl null while
// /receipts/wir_… answered 200. The member read now resolves whichever
// twin row the anonymous read resolves, gated on the room's recorded
// opt-in (the authoritative setting, never a stale projection row).
//
// F-5: public rows carry room_id only when the room is publicly listed,
// so an opted-in but unlisted room's receipts showed room:null and
// ?room=<id> returned [] for the room's own published receipts. The
// filter now matches a room's receipts by their source room for the
// room sources (the split roomProofRows already applies); the row's
// public room field is unchanged — an unlisted room's face stays
// withheld, the filter confirms nothing the receipt page doesn't.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { publicWorkClaimReceiptId } from "../server/public-read-model.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;
const RECEIPT_COLUMNS = "id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, verification_state, hashes_json, at, start_href, agent_ids_json";

async function serve(t, roomId) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-citation-discovery-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  const ownerKey = store.issueAccessKey(roomId, "owner");
  store.command(ownerKey, roomId, {
    id: `add-ada-${roomId}`, type: T.MEMBER_ADDED,
    data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" },
  });
  const adaKey = store.issueAccessKey(roomId, "ada");
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
  const get = async (path, key) => {
    const res = await fetch(`${origin}${path}`, key ? { headers: { authorization: `Bearer ${key}` } } : {});
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  return { store, origin, ownerKey, adaKey, get };
}

// A board work item driven through the real command path to completion,
// in a room that opted in first (the production order UT-SHARE walked).
function completeBoardItem(store, roomId, ownerKey, adaKey, itemId, title) {
  const command = (key, id, type, data) => store.command(key, roomId, { id, type, data });
  const revision = () => store.room(roomId).state.workItems[itemId].revision;
  command(ownerKey, `propose-${itemId}`, T.WORK_PROPOSED, {
    workItemId: itemId, title, definitionOfDone: "A result text.",
    accountableMemberId: "ada", mode: "read",
  });
  command(adaKey, `accept-${itemId}`, T.WORK_ACCEPTED, { workItemId: itemId, expectedRevision: revision() });
  command(adaKey, `start-${itemId}`, T.WORK_STARTED, { workItemId: itemId, expectedRevision: revision() });
  const text = "The cited result text.";
  command(adaKey, `complete-${itemId}`, T.WORK_COMPLETED, {
    workItemId: itemId, expectedRevision: revision(),
    summary: text, evidenceVersion: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    producerId: "ada", evidenceUrl: "https://example.invalid/cited-result",
    nextAction: "Review", signedEvidence: makeTestSigner(store)(),
  });
}

function resultClaim(id, title) {
  return {
    id, title, state: "done", owner: "ada",
    deliveryMode: "result", reviewPolicy: "distinct_member", reviewedBy: "owner",
    history: [{ action: "state:done", agentId: "ada", at: "2026-10-02T10:00:00.000Z", note: "Delivered" }],
    pullRequest: null, blobs: [HASH], updatedAt: "2026-10-02T10:00:00.000Z",
  };
}

test("F-3: the member receipt names the work-item twin the public read resolves", async t => {
  const roomId = "share-room";
  const { store, origin, ownerKey, adaKey, get } = await serve(t, roomId);
  store.command(ownerKey, roomId, { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  completeBoardItem(store, roomId, ownerKey, adaKey, "board-task", "Board task");
  store.workClaims.set(roomId, resultClaim("result-claim", "Result claim"));

  // The live public surface, as a stranger sees it.
  const feed = (await get("/api/public/receipts?limit=50")).body.receipts;
  const wir = feed.find(receipt => receipt.source === "work-item");
  assert.ok(wir, "the completed board item's receipt is live in the public feed");
  assert.ok(wir.id.startsWith("wir_"), `work-item twin id shape, got ${wir.id}`);
  const wcr = feed.find(receipt => receipt.source === "work-claim");
  assert.ok(wcr, "the result claim's receipt is live in the public feed");

  const member = await get(`/api/rooms/${roomId}/receipts`, adaKey);
  assert.equal(member.status, 200);
  const byId = new Map(member.body.receipts.map(receipt => [receipt.workItemId, receipt]));

  // The board completion's member receipt advertises the wir_ twin, and
  // the advertised URL's path resolves 200 in the same run (closure).
  const board = byId.get("board-task");
  assert.ok(board, "the member receipts list carries the board completion");
  assert.equal(board.publicId, wir.id);
  assert.equal(board.publicUrl, `https://room.trydemigod.com/receipts/${wir.id}`);
  const resolved = await fetch(`${origin}/receipts/${board.publicId}`);
  assert.equal(resolved.status, 200, "the advertised twin URL resolves");

  // The claim-shaped control is unchanged: its wcr_ twin.
  const claim = byId.get("result-claim");
  assert.equal(claim.publicId, publicWorkClaimReceiptId(roomId, "result-claim"));
  assert.equal(claim.publicId, wcr.id);
});

test("F-3 gate: an opted-out room's member read stays null even with a stale projection row", async t => {
  const roomId = "opted-room";
  const { store, ownerKey, adaKey, get } = await serve(t, roomId);
  store.command(ownerKey, roomId, { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  store.workClaims.set(roomId, resultClaim("drift-claim", "Drift claim"));
  const wcrId = publicWorkClaimReceiptId(roomId, "drift-claim");
  const live = await get(`/api/rooms/${roomId}/receipts`, adaKey);
  assert.equal(live.body.receipts.find(receipt => receipt.workItemId === "drift-claim").publicId, wcrId,
    "control: while opted in, the twin advertises");

  // Opt back out (the recorded setting flips; sync deletes the rows),
  // then simulate mirror drift: the stale row reappears without the
  // room's recorded consent. The member read follows the recorded
  // opt-in, never the row, so it must still answer null.
  const stale = store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts WHERE id=?`).get(wcrId);
  assert.ok(stale, "the projection row existed while opted in");
  store.command(ownerKey, roomId, { id: "opt-out", type: "room.public_receipts_set", data: { enabled: false } });
  store.db.prepare(`INSERT INTO public_receipts (${RECEIPT_COLUMNS}) VALUES (${RECEIPT_COLUMNS.split(", ").map(() => "?").join(",")})`)
    .run(...RECEIPT_COLUMNS.split(", ").map(column => stale[column]));

  const member = await get(`/api/rooms/${roomId}/receipts`, adaKey);
  const drift = member.body.receipts.find(receipt => receipt.workItemId === "drift-claim");
  assert.equal(drift.publicId, null);
  assert.equal(drift.publicUrl, null);
});

test("F-5: the public list room filter finds an unlisted room's own receipts", async t => {
  const roomId = "share-room";
  const { store, ownerKey, adaKey, get } = await serve(t, roomId);
  store.command(ownerKey, roomId, { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  completeBoardItem(store, roomId, ownerKey, adaKey, "board-task", "Board task");
  store.workClaims.set(roomId, resultClaim("result-claim", "Result claim"));

  const unfiltered = (await get("/api/public/receipts?limit=50")).body.receipts;
  assert.equal(unfiltered.length, 2, "both receipts are publicly listed unfiltered");
  // The room never took a public face, so its rows withhold the room…
  for (const receipt of unfiltered) assert.equal(receipt.room, null);

  // …but the room filter still finds the room's own receipts.
  const filtered = (await get(`/api/public/receipts?room=${roomId}&limit=50`)).body;
  assert.deepEqual(filtered.receipts.map(receipt => receipt.id).sort(), unfiltered.map(receipt => receipt.id).sort(),
    "?room=<the room> returns exactly the room's published receipts");

  // Pagination through the filter stays anchored: page 1's cursor
  // legitimately serves page 2 of the same filtered list.
  const page1 = (await get(`/api/public/receipts?room=${roomId}&limit=1`)).body;
  assert.equal(page1.receipts.length, 1);
  assert.ok(page1.nextCursor, "the filtered list paginates");
  const page2 = (await get(`/api/public/receipts?room=${roomId}&limit=1&cursor=${page1.nextCursor}`)).body;
  assert.equal(page2.receipts.length, 1);
  assert.notEqual(page2.receipts[0].id, page1.receipts[0].id);

  // A different room's filter excludes them.
  const other = (await get("/api/public/receipts?room=some-other-room&limit=50")).body;
  assert.equal(other.receipts.length, 0);
});
