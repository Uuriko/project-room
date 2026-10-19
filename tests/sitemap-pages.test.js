// PERF2-SITEMAP (C-2) door tests: /sitemap.xml is a sitemap INDEX; the
// core urlset keeps every non-receipt entry the old single file carried;
// receipt URLs live in paged child sitemaps (/sitemap-receipts-<n>.xml)
// with no silent clamp. The consent filters of the public read model apply
// unchanged: operator-unpublished rooms/receipts and owner-toggled-off
// rooms never appear. Lot receipts have no public_receipts row and are
// enumerated nowhere here — their recorded-opt-in read (#3594, PR #4151)
// is a separate surface this change does not touch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const ORIGIN = "https://room.trydemigod.com";

async function serve(t, seed) {
  const directory = mkdtempSync(join(tmpdir(), "room-sitemap-pages-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  if (seed) seed(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function seedRoom(store, slug, { receiptsEnabled = 1 } = {}) {
  store.db.prepare(`INSERT INTO public_rooms (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?, 'T', 'p', 1, 1, '[]', '[]', '[]', ?, 'request', NULL, NULL, '2026-01-01', '2026-01-01')`).run(slug, receiptsEnabled);
}

function seedReceipt(store, id, room, at = "2026-10-01T00:00:00.000Z") {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, 'T', 'work-claim', ?, ?, 'T', '[]', '[]', NULL, NULL, '{}', ?, 'x')`).run(id, room, room, at);
}

const locs = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

test("sitemap index lists the core and receipt child sitemaps, and no receipt URLs", async t => {
  const origin = await serve(t, store => {
    seedRoom(store, "alpha");
    seedReceipt(store, "wcr_a", "alpha");
    seedReceipt(store, "wcr_b", "alpha");
  });
  const res = await fetch(`${origin}/sitemap.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/xml/);
  assert.equal(res.headers.get("x-robots-tag"), "all");
  const xml = await res.text();
  assert.match(xml, /<sitemapindex/);
  assert.deepEqual(locs(xml), [
    `${ORIGIN}/sitemap-core.xml`,
    `${ORIGIN}/sitemap-receipts-1.xml`,
  ]);
  assert.ok(!xml.includes("/receipts/wcr_"), "index carries no receipt URLs itself");
});

test("empty store: the index lists only the core sitemap", async t => {
  const origin = await serve(t);
  const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.deepEqual(locs(xml), [`${ORIGIN}/sitemap-core.xml`]);
});

test("core sitemap keeps rooms, proof pages, and static entries — and no receipts", async t => {
  const origin = await serve(t, store => {
    seedRoom(store, "alpha");
    seedRoom(store, "beta", { receiptsEnabled: 0 });
    seedReceipt(store, "wcr_a", "alpha");
  });
  const res = await fetch(`${origin}/sitemap-core.xml`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<urlset/);
  const paths = locs(xml);
  assert.ok(paths.includes(`${ORIGIN}/r/alpha`), "room page listed");
  assert.ok(paths.includes(`${ORIGIN}/r/alpha/proof`), "proof page listed for a receipts-enabled room");
  assert.ok(paths.includes(`${ORIGIN}/r/beta`), "room page listed");
  assert.ok(!paths.includes(`${ORIGIN}/r/beta/proof`), "no proof page when receipts are disabled");
  assert.ok(paths.includes(`${ORIGIN}/receipts`), "receipts index page listed");
  assert.ok(paths.includes(`${ORIGIN}/about`), "static pages listed");
  assert.ok(!xml.includes("/receipts/wcr_"), "core carries no receipt URLs");
});

test("receipt page lists the receipts with their dates; a page past the end is 404", async t => {
  const origin = await serve(t, store => {
    seedRoom(store, "alpha");
    seedReceipt(store, "wcr_a", "alpha", "2026-10-02T00:00:00.000Z");
    seedReceipt(store, "wcr_b", "alpha", "2026-10-01T00:00:00.000Z");
  });
  const page = await fetch(`${origin}/sitemap-receipts-1.xml`);
  assert.equal(page.status, 200);
  const xml = await page.text();
  assert.match(xml, /<urlset/);
  assert.deepEqual(locs(xml), [`${ORIGIN}/receipts/wcr_a`, `${ORIGIN}/receipts/wcr_b`]);
  assert.match(xml, /<lastmod>2026-10-02<\/lastmod>/);
  const past = await fetch(`${origin}/sitemap-receipts-2.xml`);
  assert.equal(past.status, 404, "a page beyond the receipt count is an explicit 404, never a silent truncation");
  assert.equal((await fetch(`${origin}/sitemap-receipts-0.xml`)).status, 404);
  assert.equal((await fetch(`${origin}/sitemap-receipts-x.xml`)).status, 404);
});

test("consent filters: unpublished and toggled-off content never reaches the sitemap", async t => {
  const origin = await serve(t, store => {
    seedRoom(store, "alpha");
    seedRoom(store, "ghost");
    seedRoom(store, "quiet");
    seedReceipt(store, "wcr_a", "alpha");
    seedReceipt(store, "wcr_g", "ghost");
    seedReceipt(store, "wcr_q", "quiet");
    seedReceipt(store, "wcr_taken", "alpha");
    store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'ghost', '2026-01-02T00:00:00.000Z', 'op')").run();
    store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('receipt', 'wcr_taken', '2026-01-02T00:00:00.000Z', 'op')").run();
    store.db.prepare("INSERT INTO room_directory_settings (room_id, public_receipts, updated_at) VALUES ('quiet', 0, 1700000000)").run();
  });
  const core = await (await fetch(`${origin}/sitemap-core.xml`)).text();
  assert.ok(core.includes("/r/alpha"));
  assert.ok(!core.includes("/r/ghost"), "operator-unpublished room absent from the core sitemap");
  const page = await (await fetch(`${origin}/sitemap-receipts-1.xml`)).text();
  assert.deepEqual(locs(page), [`${ORIGIN}/receipts/wcr_a`],
    "unpublished room's receipt, toggled-off room's receipt, and unpublished receipt all absent");
});

test("the /room-prefixed aliases serve the same three documents", async t => {
  const origin = await serve(t, store => {
    seedRoom(store, "alpha");
    seedReceipt(store, "wcr_a", "alpha");
  });
  for (const path of ["/room/sitemap.xml", "/room/sitemap-core.xml", "/room/sitemap-receipts-1.xml"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} serves`);
    assert.match(res.headers.get("content-type"), /application\/xml/);
  }
  const index = await (await fetch(`${origin}/room/sitemap.xml`)).text();
  assert.match(index, /<sitemapindex/);
});

test("HEAD answers headers only on all three documents", async t => {
  const origin = await serve(t, store => {
    seedRoom(store, "alpha");
    seedReceipt(store, "wcr_a", "alpha");
  });
  for (const path of ["/sitemap.xml", "/sitemap-core.xml", "/sitemap-receipts-1.xml"]) {
    const res = await fetch(`${origin}${path}`, { method: "HEAD" });
    assert.equal(res.status, 200, `${path} HEAD`);
    assert.equal(await res.text(), "");
  }
});
