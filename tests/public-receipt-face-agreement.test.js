// Face agreement for public-work receipts (A6, CURE-SPEC-5128): a pwr_
// receipt lives in two stores — public_work_receipts, served by the API
// face, and the public_receipts mirror, served by the HTML faces. The
// faces must agree about whether the receipt is available: it is public
// only when BOTH records exist. Mirror-only and source-only states are
// seeded by direct DB writes, the same skew classes a restore, an
// un-run backfill, or manual repair can produce. Other receipt sources
// (work-claim, work-item) have no source row by design and must serve
// exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { collectPublicReceipts, projectPublicWorkReceipt, queryPublicReceipts } from "../server/receipts-live.mjs";
import { backfillPublicReadModel } from "../server/public-read-model.mjs";
import { unpublishPublic } from "../server/legal-store.mjs";

const SHA = "cd".repeat(32);
const MIRROR_ONLY = `pwr_${"44".repeat(32)}`;
const SOURCE_ONLY = `pwr_${"55".repeat(32)}`;
const BOTH = `pwr_${"aa".repeat(32)}`;
const UNPUBLISHED = `pwr_${"66".repeat(32)}`;
const WIR = `wir_${"77".repeat(16)}`;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-face-agreement-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store };
}

function seedPublicWork(store, id, offer, title, { project = true } = {}) {
  const receipt = {
    schema: "public-work-receipt/1", receiptId: id, namespaceId: "commons",
    identityId: "ai_public", title, createdAt: "2026-10-01T00:00:00.000Z",
    artifact: { sha256: SHA },
  };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, offer, "commons", 1, "ai_public", "note", SHA, 4, JSON.stringify(receipt), Date.now());
  if (project) projectPublicWorkReceipt(store, receipt, SHA);
  return receipt;
}

async function get(origin, path) {
  const res = await fetch(`${origin}${path}`);
  return { status: res.status, text: await res.text() };
}

async function faces(origin, id) {
  return {
    page: await get(origin, `/receipts/${id}`),
    json: await get(origin, `/receipts/${id}.json`),
    og: await get(origin, `/receipts/${id}/og.png`),
    badge: await get(origin, `/receipts/${id}/badge.svg`),
    api: await get(origin, `/api/public-work/receipts/${id}`),
  };
}

function assertNoFaceServes(f, marker) {
  for (const face of ["page", "json", "og", "badge", "api"]) {
    assert.equal(f[face].status, 404, `${face} must 404`);
  }
  assert.equal(f.page.text.includes(marker), false);
  assert.equal(f.json.text.includes(marker), false);
  assert.equal(f.badge.text.includes(marker), false);
}

test("mirror-only receipt resolves on no face", async t => {
  const { origin, store } = await serve(t);
  seedPublicWork(store, MIRROR_ONLY, "offer-mirror-only", "PROBE-MIRROR-ONLY");
  const before = await faces(origin, MIRROR_ONLY);
  assert.equal(before.page.status, 200);
  assert.equal(before.api.status, 200);
  store.db.prepare("DELETE FROM public_work_receipts WHERE receipt_id=?").run(MIRROR_ONLY);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_receipts WHERE id=?").get(MIRROR_ONLY).n, 1);

  const f = await faces(origin, MIRROR_ONLY);
  assertNoFaceServes(f, "PROBE-MIRROR-ONLY");
  assert.equal(JSON.parse(f.api.text).error.code, "public_receipt_not_found");
  const list = await get(origin, "/receipts");
  assert.equal(list.text.includes("PROBE-MIRROR-ONLY"), false);
  const apiList = await get(origin, "/api/public/receipts");
  assert.equal(apiList.text.includes(MIRROR_ONLY), false);
  const sitemap = await get(origin, "/sitemap.xml");
  assert.equal(sitemap.text.includes(`/receipts/${MIRROR_ONLY}`), false);
});

test("source-only receipt resolves on no face until backfill projects it", async t => {
  const { origin, store } = await serve(t);
  seedPublicWork(store, SOURCE_ONLY, "offer-source-only", "PROBE-SOURCE-ONLY", { project: false });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_receipts WHERE id=?").get(SOURCE_ONLY).n, 0);

  const f = await faces(origin, SOURCE_ONLY);
  assertNoFaceServes(f, "PROBE-SOURCE-ONLY");
  assert.equal(JSON.parse(f.api.text).error.code, "public_receipt_not_found");

  for (let i = 0; i < 20 && !backfillPublicReadModel(store, { limit: 100 }).done; i++) { /* drain phases */ }
  const healed = await faces(origin, SOURCE_ONLY);
  for (const face of ["page", "json", "og", "badge", "api"]) {
    assert.equal(healed[face].status, 200, `${face} must serve after backfill`);
  }
  assert.equal(healed.page.text.includes("PROBE-SOURCE-ONLY"), true);
});

test("projected receipt serves on every face (control)", async t => {
  const { origin, store } = await serve(t);
  seedPublicWork(store, BOTH, "offer-both", "PROBE-BOTH-PRESENT");
  const f = await faces(origin, BOTH);
  for (const face of ["page", "json", "og", "badge", "api"]) {
    assert.equal(f[face].status, 200, `${face} must serve`);
  }
  assert.equal(f.page.text.includes("PROBE-BOTH-PRESENT"), true);
  const list = await get(origin, "/receipts");
  assert.equal(list.text.includes("PROBE-BOTH-PRESENT"), true);
});

test("unpublished receipt resolves on no face (A6(iii) control)", async t => {
  const { origin, store } = await serve(t);
  seedPublicWork(store, UNPUBLISHED, "offer-unpublished", "PROBE-UNPUBLISHED");
  unpublishPublic(store.db, { kind: "receipt", id: UNPUBLISHED, byAccount: "operator", now: Date.now() });
  const f = await faces(origin, UNPUBLISHED);
  assertNoFaceServes(f, "PROBE-UNPUBLISHED");
  const list = await get(origin, "/receipts");
  assert.equal(list.text.includes("PROBE-UNPUBLISHED"), false);
  const sitemap = await get(origin, "/sitemap.xml");
  assert.equal(sitemap.text.includes(`/receipts/${UNPUBLISHED}`), false);
});

test("mirror-only receipt cannot anchor a list cursor", async t => {
  const { store } = await serve(t);
  seedPublicWork(store, MIRROR_ONLY, "offer-cursor", "PROBE-CURSOR");
  store.db.prepare("DELETE FROM public_work_receipts WHERE receipt_id=?").run(MIRROR_ONLY);
  const result = queryPublicReceipts(store, { cursor: MIRROR_ONLY });
  assert.equal(result.error?.status, 422);
  assert.equal(result.error?.code, "invalid_receipt_query");
  const list = queryPublicReceipts(store, {});
  assert.equal(list.receipts.some(receipt => receipt.id === MIRROR_ONLY), false);
});

test("work-claim and work-item receipts need no public-work row", async t => {
  const { origin, store } = await serve(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.workClaims.set("commons", {
    id: "claim-1", title: "Claim without a public-work row", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T12:00:00.000Z",
  });
  store.command(ownerKey, "commons", { id: "publish", type: "room.public_receipts_set", data: { enabled: true } });
  const claim = collectPublicReceipts(store).find(item => item.title === "Claim without a public-work row");
  assert.match(claim.id, /^wcr_[a-f0-9]{32}$/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_work_receipts WHERE receipt_id=?").get(claim.id).n, 0);
  assert.equal((await get(origin, `/receipts/${claim.id}`)).status, 200);
  assert.equal((await get(origin, `/receipts/${claim.id}.json`)).status, 200);

  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(WIR, "Item without a public-work row", "work-item", "commons", "commons", "Commons",
      "[]", "[]", null, null, null, "[]", "2026-10-01T00:00:00.000Z", "");
  assert.equal((await get(origin, `/receipts/${WIR}`)).status, 200);
  assert.equal((await get(origin, `/receipts/${WIR}.json`)).status, 200);
});
