// Public pages read public_receipts, public_rooms, and public_directory_entries.
// A private room, including one with receipts and a sentinel in its messages,
// stays off every public route. Opt-out deletes the row in that same write.
// Anonymous GETs do not query rooms.projection and do not write.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { START_ROOM_URL } from "../deploy/room-entry.mjs";
import { PUBLIC_START_URL, backfillPublicReadModel } from "../server/public-read-model.mjs";

const SENTINEL = "SENTINEL-private-9f3a-not-public";

const changes = store => store.db.prepare("SELECT total_changes() AS n").get().n;
const shareLinks = store => store.db.prepare("SELECT COUNT(*) AS n FROM share_links").get().n;

function command(store, key, roomId, id, type, data) {
  return store.command(key, roomId, { id, type, data });
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-public-read-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("private-room"));
  store.initialize(initialRoom("public-room"));
  const privateKey = store.issueAccessKey("private-room", "owner");
  const publicKey = store.issueAccessKey("public-room", "owner");
  command(store, privateKey, "private-room", "secret-msg", "message.posted", { messageId: "secret-msg", body: SENTINEL });
  store.workClaims.set("private-room", {
    id: "secret-claim", title: SENTINEL, state: "done", owner: "owner",
    history: [{ action: "pr_merged", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/3", outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  });
  store.workClaims.set("public-room", {
    id: "visible-claim", title: "Visible claim", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", actor: "not-a-member", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/4", outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  });
  store.workClaims.set("public-room", {
    id: "unverified-claim", title: "UNVERIFIED-merge-claim", state: "done", owner: "owner",
    history: [{ action: "state:done", agentId: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/8", outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  });
  command(store, publicKey, "public-room", "publish-page", "room.public_page_set", { enabled: true });
  command(store, publicKey, "public-room", "publish-receipts", "room.public_receipts_set", { enabled: true });
  command(store, publicKey, "public-room", "publish-join", "room.join_link_set", { enabled: true });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, publicKey };
}

async function raw(origin, path) {
  const res = await fetch(`${origin}${path}`);
  return { status: res.status, text: await res.text() };
}

const PUBLIC_PATHS = [
  "/receipts",
  "/api/public/receipts",
  "/sitemap.xml",
  "/agents",
  "/templates",
  "/templates.json",
  "/llms.txt",
  "/r/public-room",
  "/r/public-room.json",
  "/r/private-room",
  "/r/private-room.json",
  "/r/no-such-room",
  "/room/receipts",
  "/room/sitemap.xml",
];

function spy(store) {
  const sql = [];
  const native = store.db.prepare.bind(store.db);
  store.db.prepare = (text, ...rest) => {
    sql.push(String(text));
    return native(text, ...rest);
  };
  return {
    sql,
    stop() { store.db.prepare = native; },
  };
}

test("the public start link matches the room door", () => {
  assert.equal(PUBLIC_START_URL, START_ROOM_URL);
});

test("a private room with receipts never appears on a public route", async t => {
  const { origin } = await serve(t);
  const hidden = await raw(origin, "/r/private-room");
  const hiddenJson = await raw(origin, "/r/private-room.json");
  assert.equal(hidden.status, 404);
  assert.equal(hiddenJson.status, 404);
  const listed = await raw(origin, "/receipts");
  assert.equal(listed.status, 200);
  assert.match(listed.text, /Visible claim/);
  assert.equal(listed.text.includes("UNVERIFIED-merge-claim"), false);
  assert.equal(listed.text.includes("not-a-member"), false);
  const room = await raw(origin, "/r/public-room");
  assert.equal(room.status, 200);
  assert.match(room.text, /Join/);
  for (const path of PUBLIC_PATHS) {
    const page = await raw(origin, path);
    assert.equal(page.text.includes(SENTINEL), false, path);
    assert.equal(page.status < 500, true, path);
  }
});

test("public routes do not read rooms.projection, write nothing, and stay constant with 500 private rooms", async t => {
  const { origin, store } = await serve(t);
  const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'public_%'").all().map(row => row.name);
  for (const name of ["public_receipts_listing", "public_receipts_room", "public_rooms_listing", "public_directory_listing"]) {
    assert.ok(indexes.includes(name), name);
  }
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM public_receipts ORDER BY at DESC, id ASC LIMIT 20").all();
  assert.equal(plan.some(row => /\brooms\b/.test(row.detail ?? "")), false);
  const links = shareLinks(store);
  const token = store.db.prepare("SELECT join_token FROM public_rooms WHERE slug='public-room'").get();
  assert.equal(typeof token.join_token, "string");
  assert.ok(token.join_token.length > 10);
  const watch = spy(store);
  const before = changes(store);
  const first = [];
  try {
    for (const path of ["/receipts", "/api/public/receipts", "/sitemap.xml", "/agents", "/r/public-room", "/r/no-such-room", "/llms.txt", "/templates"]) {
      first.push(await raw(origin, path));
    }
  } finally { watch.stop(); }
  assert.equal(changes(store), before);
  assert.equal(shareLinks(store), links);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n, 1);
  assert.equal(first.find(page => page.status === 404) != null, true);
  const roomsScan = watch.sql.filter(sql => /\brooms\b/.test(sql) || /\bprojection\b/.test(sql));
  assert.deepEqual(roomsScan, []);
  t.diagnostic(`public route queries before extra rooms: ${watch.sql.length}`);
  store.transaction(() => {
    const insert = store.db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 0, ?, NULL)");
    for (let i = 0; i < 500; i += 1) {
      const id = `priv-${String(i).padStart(4, "0")}`;
      insert.run(id, JSON.stringify({ room: { id, title: SENTINEL }, messages: [{ body: SENTINEL }] }));
    }
  });
  const again = spy(store);
  const beforeAgain = changes(store);
  try {
    for (const path of ["/receipts", "/api/public/receipts", "/sitemap.xml", "/agents", "/r/public-room", "/r/no-such-room", "/llms.txt", "/templates"]) {
      const page = await raw(origin, path);
      assert.equal(page.text.includes(SENTINEL), false, path);
    }
  } finally { again.stop(); }
  assert.equal(changes(store), beforeAgain);
  assert.deepEqual(again.sql, watch.sql);
  assert.equal(again.sql.filter(sql => /\brooms\b/.test(sql) || /\bprojection\b/.test(sql)).length, 0);
});

test("opting out removes the room and its receipts in that write", async t => {
  const { origin, store, publicKey } = await serve(t);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms WHERE slug='public-room'").get().n, 1);
  assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM public_receipts WHERE origin_room_id='public-room'").get().n > 0);
  command(store, publicKey, "public-room", "hide-receipts", "room.public_receipts_set", { enabled: false });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_receipts WHERE origin_room_id='public-room' AND source!='public-work'").get().n, 0);
  command(store, publicKey, "public-room", "hide-page", "room.public_page_set", { enabled: false });
  assert.equal(store.db.prepare("SELECT slug FROM public_rooms WHERE slug='public-room'").get(), undefined);
  const before = changes(store);
  const page = await raw(origin, "/r/public-room");
  assert.equal(page.status, 404);
  assert.equal(page.text.includes(SENTINEL), false);
  assert.equal(changes(store), before);
  assert.equal(store.db.prepare("SELECT slug FROM public_rooms WHERE slug='public-room'").get(), undefined);
});

test("an unknown room GET is a 404 and writes nothing", async t => {
  const { origin, store } = await serve(t);
  const before = changes(store);
  const links = shareLinks(store);
  const rooms = store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n;
  const page = await raw(origin, "/r/no-such-room");
  assert.equal(page.status, 404);
  assert.equal(changes(store), before);
  assert.equal(shareLinks(store), links);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n, rooms);
});

test("receipt and agent listings are one page at a time", async t => {
  const { origin, store } = await serve(t);
  store.db.prepare("DELETE FROM public_receipts").run();
  const insertReceipt = store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, ?, 'public-work', NULL, NULL, NULL, '[]', '[]', NULL, NULL, '[]', ?, ?)`);
  for (let i = 0; i < 21; i += 1) {
    insertReceipt.run(`pwr_${String(i).padStart(32, "0")}`, `Paged receipt ${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), PUBLIC_START_URL);
  }
  const insertAgent = store.db.prepare(`INSERT INTO public_directory_entries
    (agent_id, name, description, skills_json, identity_id, receipt_count, room_count, updated_at)
    VALUES (?, ?, '', '[]', NULL, 0, 0, ?)`);
  for (let i = 1; i <= 51; i += 1) {
    const name = `Paged Agent ${String(i).padStart(3, "0")}`;
    insertAgent.run(`paged-agent-${String(i).padStart(3, "0")}`, name, "2026-10-01T00:00:00.000Z");
  }
  const first = await raw(origin, "/api/public/receipts");
  const body = JSON.parse(first.text);
  assert.equal(body.receipts.length, 20);
  assert.equal(typeof body.nextCursor, "string");
  const second = await raw(origin, `/api/public/receipts?cursor=${encodeURIComponent(body.nextCursor)}`);
  const rest = JSON.parse(second.text);
  assert.equal(rest.receipts.length, 1);
  assert.equal(rest.nextCursor, null);
  const agents = await raw(origin, "/agents");
  assert.match(agents.text, /Paged Agent 001/);
  assert.equal(agents.text.includes("Paged Agent 051"), false);
  assert.match(agents.text, /More agents/);
  const cursor = agents.text.match(/\/agents\?cursor=([^"]+)/)[1];
  const more = await raw(origin, `/agents?cursor=${cursor}`);
  assert.match(more.text, /Paged Agent 051/);
  assert.equal(more.text.includes("Paged Agent 001"), false);
  const missing = await raw(origin, "/agents?cursor=not-an-agent");
  assert.equal(missing.status, 422);
});

test("opening the store does not backfill, and one batch publishes a bounded set", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-public-backfill-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const id of ["room-a", "room-b", "room-c"]) {
    store.initialize(initialRoom(id));
    const key = store.issueAccessKey(id, "owner");
    command(store, key, id, `page-${id}`, "room.public_page_set", { enabled: true });
  }
  store.initialize(initialRoom("room-private"));
  const privateKey = store.issueAccessKey("room-private", "owner");
  command(store, privateKey, "room-private", "secret", "message.posted", { messageId: "secret", body: SENTINEL });
  store.workClaims.set("room-private", {
    id: "secret-claim", title: SENTINEL, state: "done", owner: "owner",
    history: [], pullRequest: { url: "https://github.com/Uuriko/project-room/pull/1", outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n, 3);
  store.db.prepare("DELETE FROM public_rooms").run();
  store.db.prepare("DELETE FROM public_receipts").run();
  store.db.prepare("DELETE FROM public_read_model_backfill").run();
  store.close();
  store = new RoomStore(filename);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n, 0, "the constructor does not scan rooms");
  const first = backfillPublicReadModel(store, { limit: 1 });
  assert.equal(first.rooms, 1);
  assert.equal(first.done, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n, 1);
  backfillPublicReadModel(store, { limit: 1 });
  backfillPublicReadModel(store, { limit: 1 });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n, 3);
  const skipped = backfillPublicReadModel(store, { limit: 1 });
  assert.equal(skipped.rooms, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_rooms").get().n, 3);
  const published = JSON.stringify(store.db.prepare("SELECT slug, title, purpose, names_json, tasks_json FROM public_rooms").all());
  assert.equal(published.includes(SENTINEL), false);
  assert.equal(published.includes("room-private"), false);
});

const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
};

test("receipts, room pages, the directory, and the sitemap stay within 20 ms p95 with 2000 private rooms", async t => {
  const { origin, store } = await serve(t);
  store.transaction(() => {
    const insert = store.db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 0, ?, NULL)");
    for (let i = 0; i < 2000; i += 1) {
      const id = `priv-${String(i).padStart(4, "0")}`;
      insert.run(id, JSON.stringify({ room: { id, title: SENTINEL }, messages: [{ body: SENTINEL }] }));
    }
  });
  const paths = ["/receipts", "/api/public/receipts", "/sitemap.xml", "/agents", "/r/public-room"];
  for (const path of paths) await raw(origin, path);
  const samples = new Map(paths.map(path => [path, []]));
  for (let i = 0; i < 20; i += 1) {
    for (const path of paths) {
      const started = performance.now();
      const page = await raw(origin, path);
      samples.get(path).push(performance.now() - started);
      assert.equal(page.status, 200, path);
      assert.equal(page.text.includes(SENTINEL), false, path);
    }
  }
  for (const path of paths) {
    const p95 = percentile(samples.get(path), 0.95);
    t.diagnostic(`${path} p95 ${p95.toFixed(2)} ms`);
    assert.ok(p95 <= 20, `${path} p95 ${p95.toFixed(2)} ms`);
  }
});

test("public receipts JSON allows any origin and the public pages allow the analytics beacon", async t => {
  const { origin } = await serve(t);
  const json = await fetch(`${origin}/api/public/receipts`, { headers: { Origin: "https://example.test" } });
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("access-control-allow-origin"), "*");
  assert.equal(json.headers.get("access-control-allow-credentials"), null);
  const list = await json.json();
  const id = list.receipts.find(item => item.title === "Visible claim")?.id;
  assert.match(id, /^wcr_/);
  const detail = await fetch(`${origin}/receipts/${id}.json`, { headers: { Origin: "https://example.test" } });
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("access-control-allow-origin"), "*");
  assert.equal(detail.headers.get("access-control-allow-credentials"), null);
  const preflight = await fetch(`${origin}/api/public/receipts`, { method: "OPTIONS", headers: { Origin: "https://example.test" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const html = await fetch(`${origin}/receipts`, { headers: { Origin: "https://example.test" } });
  assert.equal(html.status, 403);
  for (const path of ["/receipts", "/agents", "/r/public-room"]) {
    const page = await fetch(`${origin}${path}`);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /https:\/\/static\.cloudflareinsights\.com/);
    assert.match(csp, /https:\/\/cloudflareinsights\.com/);
  }
});
