// CH-2040 adversarial challenge vs QA200-MUT-08 (PR #2040).
//
// MUT-08-A/B probed the owner-toggle mechanics on feed/detail/json/sitemap
// and concluded "no hardening test needed". This test probes a nearby
// surface the probes never touched: the public room page /r/<slug>.
//
// Fail-first: on the PR head this test FAILS — after the owner flips
// publicReceipts=false, the room page still lists the room's receipt
// titles with direct hrefs, while the toggle-wrapped surfaces hide them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const WCR = `wcr_${"ab".repeat(16)}`;
const TITLE = "Sensitive receipt title — Acme payroll fix";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "ch-2040-room-page-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  const now = new Date().toISOString();
  // A work-claim receipt belonging to the room (the shape roomPageReceipts serves).
  store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    WCR, TITLE, "work-claim", "commons", "commons", "Commons",
    JSON.stringify(["ada"]), JSON.stringify([]), null, null, JSON.stringify([]), now,
    "https://room.trydemigod.com/?start=room");
  // Publish the room's public page so /r/commons serves.
  store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "commons", "Commons", "", 0, 1, JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
    1, "request", null, "owner", now, now);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function raw(origin, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers }, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test("room page hides receipts after the owner flips the toggle", async t => {
  const { origin, ownerKey } = await serve(t);
  // Sanity: receipt is publicly visible before the flip.
  const before = await raw(origin, "/r/commons");
  assert.equal(before.status, 200);
  assert.ok(before.text.includes(WCR), "room page lists the receipt before the flip");

  const flip = await raw(origin, "/api/rooms/commons/directory", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ discoverable: false, publicReceipts: false }),
  });
  assert.equal(flip.status, 200);

  // Positive control: the toggle-wrapped feed hides the receipt.
  const feed = await raw(origin, "/api/public/receipts");
  assert.equal(feed.status, 200);
  assert.ok(!JSON.parse(feed.text).receipts.some(receipt => receipt.id === WCR),
    "toggle-wrapped feed hides the receipt");

  // The challenged surface: the room page must hide it too.
  const page = await raw(origin, "/r/commons");
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes(WCR), "room page must not leak the receipt id after the flip");
  assert.ok(!page.text.includes("Acme payroll fix"), "room page must not leak the receipt title after the flip");
  // The JSON document variant carries the same receipt list.
  const doc = await raw(origin, "/r/commons.json");
  assert.equal(doc.status, 200);
  assert.ok(!JSON.parse(doc.text).receipts.some(receipt => receipt.id === WCR),
    "room page JSON must not leak the receipt after the flip");
  // Toggle-controlled representation: never sit in a shared cache.
  assert.equal(page.headers.get("cache-control"), "no-store",
    "room page must not be cacheable once it carries toggle-controlled receipts");
});
