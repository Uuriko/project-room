// Per-room public proof page: /r/<slug>/proof (+ .json twin).
//
// The page must present only the room's own published receipts, label each
// with the level of proof its record actually carries, link every entry to
// its receipt, and fail closed on privacy: unknown room, receipts-off
// room, owner toggle flip, and operator unpublish.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { roomProofView, PROOF_LEVELS, PROOF_HONESTY } from "../server/proof-page.mjs";
import { proofLevelOf } from "../server/public-read-model.mjs";

const WCR = `wcr_${"ab".repeat(16)}`;
const WIR = `wir_${"cd".repeat(16)}`;
const PWR = `pwr_${"ef".repeat(16)}`;
const OTHER = `wcr_${"99".repeat(16)}`;

function insertReceipt(store, row) {
  store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.title, row.source, row.origin ?? "commons", row.room ?? "commons", "Commons",
    JSON.stringify(row.agents ?? ["ada"]), JSON.stringify(row.humans ?? []),
    row.pullRequest ?? null, row.mergedAt ?? null, JSON.stringify(row.hashes ?? []), row.at,
    "https://room.trydemigod.com/?start=room");
}

function publishRoom(store, slug, receiptsEnabled) {
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    slug, "Commons", "A room that publishes its work.", 0, 1, JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
    receiptsEnabled, "request", null, "owner", now, now);
}

async function serve(t, { receiptsEnabled = 1 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "proof-page-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  publishRoom(store, "commons", receiptsEnabled);
  insertReceipt(store, {
    id: WCR, title: "Merged fix for the parser", source: "work-claim",
    pullRequest: "https://github.com/Uuriko/project-room/pull/123", mergedAt: "2026-10-10T00:00:00.000Z",
    hashes: [`sha256:${"a".repeat(64)}`], at: "2026-10-10T00:00:00.000Z",
  });
  insertReceipt(store, {
    id: WIR, title: "Weekly changelog drafted", source: "work-item", at: "2026-10-11T00:00:00.000Z",
  });
  insertReceipt(store, {
    id: PWR, title: "Public audit delivered", source: "public-work",
    hashes: [`sha256:${"b".repeat(64)}`], at: "2026-10-12T00:00:00.000Z",
  });
  insertReceipt(store, {
    id: OTHER, title: "Another room's secret win", source: "work-claim", origin: "other-room", room: "other-room",
    pullRequest: "https://github.com/Uuriko/project-room/pull/9", mergedAt: "2026-10-12T00:00:00.000Z",
    at: "2026-10-12T00:00:00.000Z",
  });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey, store };
}

async function raw(origin, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers }, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test("proofLevelOf names only what each record proves", () => {
  const merged = { source: "work-claim", mergedAt: "2026-10-10T00:00:00.000Z", pullRequest: "https://github.com/Uuriko/project-room/pull/1" };
  assert.equal(proofLevelOf(merged), "server-verified-merge");
  // A work-claim record without a server-recorded merge never upgrades.
  assert.equal(proofLevelOf({ source: "work-claim", mergedAt: null, pullRequest: null }), "room-recorded");
  assert.equal(proofLevelOf({ source: "work-item" }), "room-recorded-completion");
  assert.equal(proofLevelOf({ source: "public-work" }), "artifact-hash-recorded");
  for (const level of Object.keys(PROOF_LEVELS)) assert.ok(PROOF_LEVELS[level].note.length > 0);
  // The honesty block must never claim a payment proof.
  assert.ok(PROOF_HONESTY.some(line => line.includes("No payment is proved")));
  assert.equal(typeof roomProofView, "function");
});

test("proof page presents the room's results with honest proof levels", async t => {
  const { origin } = await serve(t);
  const page = await raw(origin, "/r/commons/proof");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  // All three of the room's own receipts, none of the other room's.
  assert.ok(page.text.includes("Merged fix for the parser"));
  assert.ok(page.text.includes("Weekly changelog drafted"));
  assert.ok(page.text.includes("Public audit delivered"));
  assert.ok(!page.text.includes("Another room's secret win"));
  assert.ok(!page.text.includes(OTHER));
  // Levels named in plain words, one per shape.
  assert.ok(page.text.includes("Server-verified merge"));
  assert.ok(page.text.includes("Room-recorded completion"));
  assert.ok(page.text.includes("Artifact hash recorded"));
  // Computed counts strip.
  assert.ok(page.text.includes("3 published results"));
  assert.ok(page.text.includes("1 server-verified merge"));
  // Traceability: every entry links to its own receipt page.
  for (const id of [WCR, WIR, PWR]) assert.ok(page.text.includes(`href="/receipts/${id}"`), `entry links to /receipts/${id}`);
  assert.ok(page.text.includes("https://github.com/Uuriko/project-room/pull/123"));
  // Honesty block: what the page does not prove.
  assert.ok(page.text.includes("not identity-verified"));
  assert.ok(page.text.includes("not re-verified"));
  assert.ok(page.text.includes("unsigned"));
  assert.ok(page.text.includes("No payment is proved on this page"));
});

test("proof JSON twin carries levels, counts, and receipt hrefs", async t => {
  const { origin } = await serve(t);
  const res = await raw(origin, "/r/commons/proof.json");
  assert.equal(res.status, 200);
  const doc = JSON.parse(res.text);
  assert.equal(doc.schema, "project-room-public-room-proof/1");
  assert.equal(doc.slug, "commons");
  assert.deepEqual(doc.counts, { total: 3, serverVerifiedMerges: 1, roomRecordedCompletions: 1, artifactHashRecorded: 1 });
  const byId = new Map(doc.entries.map(entry => [entry.id, entry]));
  assert.equal(byId.get(WCR).proofLevel, "server-verified-merge");
  assert.equal(byId.get(WIR).proofLevel, "room-recorded-completion");
  assert.equal(byId.get(PWR).proofLevel, "artifact-hash-recorded");
  assert.equal(byId.get(WCR).receiptHref, `/receipts/${WCR}`);
  assert.equal(byId.get(WCR).pullRequest, "https://github.com/Uuriko/project-room/pull/123");
  assert.ok(!byId.has(OTHER));
  assert.ok(Array.isArray(doc.honesty) && doc.honesty.length >= 4);
  // Newest first.
  assert.equal(doc.entries[0].id, PWR);
});

test("proof page fails closed: unknown room and receipts-off room 404", async t => {
  const { origin } = await serve(t);
  assert.equal((await raw(origin, "/r/no-such-room/proof")).status, 404);
  assert.equal((await raw(origin, "/r/no-such-room/proof.json")).status, 404);

  const off = await serve(t, { receiptsEnabled: 0 });
  assert.equal((await raw(off.origin, "/r/commons/proof")).status, 404);
  assert.equal((await raw(off.origin, "/r/commons/proof.json")).status, 404);
});

test("owner toggle flip empties the proof page without leaking titles", async t => {
  const { origin, ownerKey } = await serve(t);
  const flip = await raw(origin, "/api/rooms/commons/directory", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ discoverable: false, publicReceipts: false }),
  });
  assert.equal(flip.status, 200);
  const page = await raw(origin, "/r/commons/proof");
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes("Merged fix for the parser"), "toggle-off must hide receipt titles");
  assert.ok(!page.text.includes(WCR));
  const doc = JSON.parse((await raw(origin, "/r/commons/proof.json")).text);
  assert.equal(doc.counts.total, 0);
  assert.deepEqual(doc.entries, []);
});

test("operator unpublish of the room removes the proof page", async t => {
  const { origin, store } = await serve(t);
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'commons', ?, 'op')")
    .run(Date.now());
  assert.equal((await raw(origin, "/r/commons/proof")).status, 404);
  assert.equal((await raw(origin, "/r/commons/proof.json")).status, 404);
});

test("proof page escapes room-authored titles", async t => {
  const { origin, store } = await serve(t);
  insertReceipt(store, {
    id: `wir_${"77".repeat(16)}`, title: "<script>alert(1)</script>", source: "work-item",
    at: "2026-10-13T00:00:00.000Z",
  });
  const page = await raw(origin, "/r/commons/proof");
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes("<script>alert(1)</script>"));
  assert.ok(page.text.includes("&lt;script&gt;"));
});

test("proof page paginates by cursor and rejects a foreign cursor", async t => {
  const { origin, store } = await serve(t);
  for (let i = 0; i < 25; i += 1) {
    insertReceipt(store, {
      id: `wir_${String(i).padStart(2, "0")}${"f".repeat(30)}`, title: `Bulk item ${i}`, source: "work-item",
      at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  const first = JSON.parse((await raw(origin, "/r/commons/proof.json")).text);
  assert.equal(first.entries.length, 20);
  assert.ok(first.nextCursor);
  const second = JSON.parse((await raw(origin, `/r/commons/proof.json?cursor=${first.nextCursor}`)).text);
  assert.equal(second.entries.length, 8); // 28 total (25 bulk + 3 seeded), 20 + 8
  assert.equal(second.nextCursor, null);
  const seen = new Set([...first.entries, ...second.entries].map(entry => entry.id));
  assert.equal(seen.size, 28);
  const bad = await raw(origin, "/r/commons/proof.json?cursor=wcr_deadbeef");
  assert.equal(bad.status, 422);
});

test("room page links to the proof page and the sitemap lists it", async t => {
  const { origin } = await serve(t);
  const room = await raw(origin, "/r/commons");
  assert.equal(room.status, 200);
  assert.ok(room.text.includes('href="/r/commons/proof"'));
  const doc = JSON.parse((await raw(origin, "/r/commons.json")).text);
  assert.equal(doc.proofHref, "/r/commons/proof");
  const sitemap = await raw(origin, "/sitemap.xml");
  assert.ok(sitemap.text.includes("/r/commons/proof"));
});

test("proof share layer: JSON-LD mirrors the entries and the OG card rides the same gate", async t => {
  const { origin } = await serve(t);
  const page = await raw(origin, "/r/commons/proof");
  assert.equal(page.status, 200);
  assert.match(page.text, /application\/ld\+json/);
  assert.match(page.text, /\/r\/commons\/proof\/og\.png/);
  const marker = '<script type="application/ld+json">';
  const start = page.text.indexOf(marker) + marker.length;
  const ld = JSON.parse(page.text.slice(start, page.text.indexOf("</script>", start)));
  assert.equal(ld["@type"], "CollectionPage");
  assert.equal(ld.mainEntity.itemListElement.length, 3);
  assert.match(ld.mainEntity.itemListElement[0].description, /Artifact hash recorded/);
  const og = await fetch(`${origin}/r/commons/proof/og.png`);
  assert.equal(og.status, 200);
  assert.match(og.headers.get("content-type"), /image\/png/);
  assert.match(og.headers.get("cache-control"), /max-age=300/);
  const bytes = new Uint8Array(await og.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [137, 80, 78, 71]);
  assert.equal((await fetch(`${origin}/r/nope/proof/og.png`)).status, 404);
  // A work-item receipt's own share card rides the same renderer and gate.
  const wirOg = await fetch(`${origin}/receipts/${WIR}/og.png`);
  assert.equal(wirOg.status, 200);
  assert.match(wirOg.headers.get("content-type"), /image\/png/);
  const wirBytes = new Uint8Array(await wirOg.arrayBuffer());
  assert.deepEqual([...wirBytes.slice(0, 4)], [137, 80, 78, 71]);
});
