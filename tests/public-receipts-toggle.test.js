// Owner-only public-receipts toggle (QA wave-2 gap).
//
// A room setting `publicReceipts` (default: public, i.e. current behavior)
// controls whether the room's work receipts are publicly visible.
// The owner flips it; non-owners get 403 on mutation. When a room turns
// receipts private, non-members get 403 on the receipt read/artifact
// endpoints and the receipts vanish from the public feed, detail page,
// and sitemap; members keep reading them. Served by the real HTTP
// server and RoomStore.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { projectPublicWorkReceipt } from "../server/receipts-live.mjs";

const PWR = `pwr_${"cd".repeat(32)}`;
const NAMESPACE = `public_${"ef".repeat(16)}`;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-receipts-toggle-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  const adaKey = store.issueAccessKey("commons", "ada");
  const now = Date.now();
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("offer-1", NAMESPACE, "commons", 1, "https://github.com/Uuriko/project-room", "main", JSON.stringify(["README.md"]), 1, now);
  const body = { schema: "public-work-receipt/1", receiptId: PWR, namespaceId: NAMESPACE, identityId: "ai_public",
    title: "Public task", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: "cd".repeat(32) } };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    PWR, "offer-1", NAMESPACE, 1, "ai_public", "note", "cd".repeat(32), 4, JSON.stringify(body), now);
  projectPublicWorkReceipt(store, body, "cd".repeat(32));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, ownerKey, adaKey };
}

async function raw(origin, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers }, body });
  const text = await res.text();
  return { status: res.status, text };
}

const setVisibility = (origin, key, publicReceipts) => raw(origin, "/api/rooms/commons/directory", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ discoverable: false, publicReceipts }),
});

test("default: receipts stay public for everyone (backward compatible)", async t => {
  const { origin } = await serve(t);
  const read = await raw(origin, `/api/public-work/receipts/${PWR}`);
  assert.equal(read.status, 200);
  assert.equal(JSON.parse(read.text).receiptId, PWR);
  const artifact = await raw(origin, `/api/public-work/receipts/${PWR}/artifact`);
  assert.equal(artifact.status, 200);
  assert.equal(artifact.text, "note");
  const feed = await raw(origin, "/api/public/receipts");
  assert.equal(feed.status, 200);
  assert.ok(JSON.parse(feed.text).receipts.some(receipt => receipt.id === PWR));
  assert.equal((await raw(origin, `/receipts/${PWR}`)).status, 200);
  assert.equal((await raw(origin, `/receipts/${PWR}.json`)).status, 200);
  assert.ok((await raw(origin, "/sitemap.xml")).text.includes(`/receipts/${PWR}`));
});

test("owner flips receipts private; non-owner mutation is refused", async t => {
  const { origin, ownerKey, adaKey } = await serve(t);
  const denied = await raw(origin, "/api/rooms/commons/directory", {
    method: "POST",
    headers: { authorization: `Bearer ${adaKey}`, "content-type": "application/json" },
    body: JSON.stringify({ discoverable: false, publicReceipts: false }),
  });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.text).error.code, "owner_only");
  const badShape = await raw(origin, "/api/rooms/commons/directory", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ discoverable: false, publicReceipts: "no" }),
  });
  assert.equal(badShape.status, 422);
  const off = await setVisibility(origin, ownerKey, false);
  assert.equal(off.status, 200);
  const status = JSON.parse(off.text);
  assert.equal(status.publicReceipts, false);
  assert.equal(status.discoverable, false);
  const ownerStatus = await raw(origin, "/api/rooms/commons/directory", {
    headers: { authorization: `Bearer ${ownerKey}` },
  });
  assert.equal(JSON.parse(ownerStatus.text).publicReceipts, false);
  const adaStatus = await raw(origin, "/api/rooms/commons/directory", {
    headers: { authorization: `Bearer ${adaKey}` },
  });
  assert.equal(adaStatus.status, 403);
});

test("private receipts: anonymous 403/404, members still read; flipping back restores", async t => {
  const { origin, ownerKey, adaKey } = await serve(t);
  assert.equal((await raw(origin, `/api/public-work/receipts/${PWR}`)).status, 200);
  assert.equal((await setVisibility(origin, ownerKey, false)).status, 200);
  const anonRead = await raw(origin, `/api/public-work/receipts/${PWR}`);
  assert.equal(anonRead.status, 403);
  assert.equal(JSON.parse(anonRead.text).error.code, "receipts_private");
  assert.equal((await raw(origin, `/api/public-work/receipts/${PWR}/artifact`)).status, 403);
  const memberRead = await raw(origin, `/api/public-work/receipts/${PWR}`, {
    headers: { authorization: `Bearer ${adaKey}` },
  });
  assert.equal(memberRead.status, 200);
  assert.equal(JSON.parse(memberRead.text).receiptId, PWR);
  assert.equal((await raw(origin, `/api/public-work/receipts/${PWR}/artifact`, {
    headers: { authorization: `Bearer ${adaKey}` },
  })).status, 200);
  assert.equal((await raw(origin, `/api/public-work/receipts/${PWR}`, {
    headers: { authorization: `Bearer ${ownerKey}` },
  })).status, 200);
  const feed = await raw(origin, "/api/public/receipts");
  assert.equal(JSON.parse(feed.text).receipts.some(receipt => receipt.id === PWR), false);
  assert.equal((await raw(origin, `/receipts/${PWR}`)).status, 404);
  assert.equal((await raw(origin, `/receipts/${PWR}.json`)).status, 404);
  assert.equal((await raw(origin, "/sitemap.xml")).text.includes(`/receipts/${PWR}`), false);
  assert.equal((await setVisibility(origin, ownerKey, true)).status, 200);
  assert.equal((await raw(origin, `/api/public-work/receipts/${PWR}`)).status, 200);
  assert.ok(JSON.parse((await raw(origin, "/api/public/receipts")).text).receipts.some(receipt => receipt.id === PWR));
  assert.equal((await raw(origin, `/receipts/${PWR}`)).status, 200);
});
