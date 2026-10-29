// F-C5-2: /sitemap.xml had no rate-limit call at all and listPublicRoomSitemap
// returned every public room slug uncapped in one response, alongside the
// (already capped) 1,000 receipt ids. The cure mirrors the sibling idioms
// already in the tree: the receipts handler's rate(`receipts:<addr>`, 120)
// call for the sitemap handler, and listPublicReceiptSitemap's
// default/clamp-1000 + LIMIT-in-SQL cap for the room-slug list.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { listPublicRoomSitemap } from "../server/public-read-model.mjs";
import { publicSitemapEntries } from "../server/public-rooms.mjs";

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-sitemap-cure-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedRooms(store, count) {
  const now = "2026-10-01T00:00:00.000Z";
  const insert = store.db.prepare(`INSERT INTO public_rooms
    (slug, title, purpose, humans, agents, names_json, tasks_json, members_json,
     receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?, 'Room', 'Purpose', 0, 0, '[]', '[]', '[]', 0, 'request', NULL, NULL, ?, ?)`);
  store.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(`room-${String(i).padStart(4, "0")}`, now, now);
    }
  });
}

test("listPublicRoomSitemap caps the room-slug list at 1000 in SQL", t => {
  const store = openStore(t);
  seedRooms(store, 1005);

  const sql = [];
  const native = store.db.prepare.bind(store.db);
  store.db.prepare = (text, ...rest) => { sql.push(String(text)); return native(text, ...rest); };
  let entries;
  try { entries = listPublicRoomSitemap(store); } finally { store.db.prepare = native; }

  assert.equal(entries.length, 1000, "the default room sitemap list is capped at 1000");
  assert.equal(entries[0].slug, "room-0000");
  assert.equal(entries.at(-1).slug, "room-0999", "the cap keeps the slug-ascending head of the list");
  assert.ok(sql.some(text => /FROM public_rooms[\s\S]*LIMIT \?/.test(text)),
    "the cap is applied as a LIMIT in the SQL, not by slicing a full read in memory");

  // Cap-parameter abuse: an explicit over-large limit clamps to the same 1000,
  // a small limit is honoured, and a non-positive limit falls back to 1000 —
  // exactly the listPublicReceiptSitemap idiom.
  assert.equal(listPublicRoomSitemap(store, 5000).length, 1000, "a limit above the cap clamps to 1000");
  assert.equal(listPublicRoomSitemap(store, 3).length, 3, "a limit below the cap is honoured");
  assert.equal(listPublicRoomSitemap(store, 0).length, 1000, "a non-positive limit falls back to the default cap");

  // The sole consumer (publicSitemapEntries, server/public-rooms.mjs) is
  // capped through the same call: 1000 room entries, no more.
  const roomEntries = publicSitemapEntries(store).filter(entry => entry.path.startsWith("/r/"));
  assert.equal(roomEntries.length, 1000, "publicSitemapEntries cannot emit more than the capped room list");
});

test("GET /sitemap.xml is rate-limited per address in the sibling shape", async t => {
  const store = openStore(t);
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers["x-test-address"] || "127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sitemap = address => fetch(`${origin}/sitemap.xml`, { headers: { "X-Test-Address": address } });

  for (let i = 0; i < 120; i += 1) {
    const response = await sitemap("10.7.7.7");
    assert.equal(response.status, 200, `request ${i + 1} within the allowance`);
    await response.text();
  }
  const limited = await sitemap("10.7.7.7");
  assert.equal(limited.status, 429, "request 121 from the same address is refused");
  assert.equal((await limited.json()).error.code, "rate_limited");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "120");
  assert.equal(limited.headers.get("x-ratelimit-bucket"), "sitemap", "the 429 names the sitemap bucket");
  assert.equal(Number(limited.headers.get("retry-after")), 60, "Retry-After matches the one-minute window");

  const other = await sitemap("10.7.7.8");
  assert.equal(other.status, 200, "a different address keeps its own allowance");
  await other.text();
});
