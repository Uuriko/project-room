// FUNNEL-COUNT-1 (Option B descope): the door funnel instrument.
// The readout is the contract: edge-served surfaces report
// counted:false with null views (never a silent zero), Node-boundary
// arrivals are counted as they happen, and joins / mints / auth
// completions derive from the store at read time.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { classifyDoorFunnelSurface, isDoorFunnelBot, readDoorFunnel } from "../server/analytics/door-funnel.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const get = (origin, path, headers = {}) => fetch(`${origin}${path}`, { headers });

function seedJoin(store, roomId, at, n) {
  const max = store.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM events WHERE room_id = ?").get(roomId).seq;
  const insert = store.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
  for (let i = 0; i < n; i += 1) {
    insert.run(roomId, max + 1000 + i, `funnel-join-${roomId}-${at}-${i}`,
      // Event bodies stamp time as ISO-8601 text, as production writes it.
      JSON.stringify({ type: "member.added", at: new Date(at).toISOString(), actorId: "owner", data: { memberId: `joiner-${at}-${i}` } }));
  }
}

function seedMint(store, at, n) {
  const insert = store.db.prepare(
    "INSERT INTO agent_identities(identity_id, secret_hash, display_name, created_at, revoked_at) VALUES(?,?,?,?,NULL)");
  for (let i = 0; i < n; i += 1) insert.run(`funnel-mint-${at}-${i}`, `hash-${at}-${i}`, `Mint ${at} ${i}`, at);
}

function seedAccount(store, origin, at, n) {
  const insert = store.db.prepare(
    "INSERT INTO accounts(id, active, revision, auth_epoch, origin, created_at, display_name, avatar_url, onboarded) VALUES(?,1,0,0,?,?,NULL,NULL,1)");
  for (let i = 0; i < n; i += 1) insert.run(`funnel-acct-${origin}-${at}-${i}`, origin, at);
}

test("classifier names only the Node-served public surfaces", () => {
  assert.equal(classifyDoorFunnelSurface("/receipts"), "receipts");
  assert.equal(classifyDoorFunnelSurface(`/receipts/pwr_${"a".repeat(16)}`), "receipt_detail");
  assert.equal(classifyDoorFunnelSurface(`/receipts/lot_${"b".repeat(16)}.json`), "receipt_detail");
  assert.equal(classifyDoorFunnelSurface("/join"), "join");
  assert.equal(classifyDoorFunnelSurface("/.well-known/agent-skills"), "agent_skills");
  assert.equal(classifyDoorFunnelSurface("/.well-known/agent-skills/index.json"), "agent_skills");
  // Arrivals this instrument does not count: the edge-served pages and
  // every API or room path.
  assert.equal(classifyDoorFunnelSurface("/"), null);
  assert.equal(classifyDoorFunnelSurface("/offers"), null);
  assert.equal(classifyDoorFunnelSurface("/llms.txt"), null);
  assert.equal(classifyDoorFunnelSurface("/api/public/receipts"), null);
  assert.equal(classifyDoorFunnelSurface("/api/public/door-funnel"), null);
  assert.equal(classifyDoorFunnelSurface("/receipts/not-an-id"), null);
  assert.equal(classifyDoorFunnelSurface(undefined), null);
});

test("bot flag: the crawler list plus generic bot tokens", () => {
  assert.equal(isDoorFunnelBot("GPTBot/1.0"), true);
  assert.equal(isDoorFunnelBot("Mozilla/5.0 (compatible; ClaudeBot/1.0)"), true);
  assert.equal(isDoorFunnelBot("some-headless-thing/2.0"), true);
  assert.equal(isDoorFunnelBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"), false);
  assert.equal(isDoorFunnelBot(""), false);
  assert.equal(isDoorFunnelBot(undefined), false);
});

test("readout: edge surfaces counted:false with null views, weeks clamp, listed room renders 0 joins", t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  f.store.roomDirectory.set("commons", "owner", true);
  const now = f.store.now();
  const out = readDoorFunnel(f.store, { weeks: 99, now });
  assert.equal(out.weeks.length, 12); // clamped to the 12-week maximum
  const landing = out.surfaces.find(s => s.surface === "landing");
  assert.equal(landing.counted, false);
  assert.equal(landing.servedBy, "edge");
  const current = out.weeks[out.weeks.length - 1];
  // The chartered honesty property: an uncounted surface is null,
  // never a silent zero.
  assert.strictEqual(current.views.landing, null);
  assert.strictEqual(current.views.offers, null);
  assert.strictEqual(current.views.llms_txt, null);
  assert.strictEqual(current.viewBots.landing, null);
  assert.equal(current.views.receipts, 0);
  // A listed room appears with its true join count in every week —
  // 0 included, never omitted — and only listed rooms appear. Ground
  // truth is counted here with the access review's own query shape.
  const truth = out.weeks.map(week => {
    const start = Date.parse(`${week.startsAt}T00:00:00Z`);
    // $.at is ISO-8601 text; the range compares ISO strings, as stored.
    return f.store.db.prepare(
      `SELECT count(*) AS n FROM events WHERE room_id = 'commons'
         AND json_extract(body, '$.type') IN ('member.added', 'member.joined_via_invitation')
         AND json_extract(body, '$.at') >= ? AND json_extract(body, '$.at') < ?`,
    ).get(new Date(start).toISOString(), new Date(start + 7 * 86400000).toISOString()).n;
  });
  assert.deepEqual(out.weeks.map(week => week.joins.commons), truth);
  assert.ok(truth.some(n => n === 0), "the fixture leaves at least one zero-join week to exercise the 0 render");
  assert.ok(!("no-such-room" in current.joins));
  assert.equal(readDoorFunnel(f.store, { weeks: 0, now }).weeks.length, 1);
  assert.equal(readDoorFunnel(f.store, { now }).weeks.length, 12);
});

test("joins and mints aggregate into their ISO weeks; unlisted rooms never appear", t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  f.store.roomDirectory.set("commons", "owner", true);
  const now = f.store.now();
  const before = readDoorFunnel(f.store, { weeks: 2, now });
  seedJoin(f.store, "commons", now, 2);
  seedJoin(f.store, "commons", now - 8 * 86400000, 3);
  seedMint(f.store, now, 1);
  seedMint(f.store, now - 8 * 86400000, 2);
  // Joins in a room that exists but is not listed must not surface.
  const otherRoom = f.store.db.prepare("SELECT id FROM rooms WHERE id <> 'commons' LIMIT 1").get();
  if (otherRoom) seedJoin(f.store, otherRoom.id, now, 5);
  const after = readDoorFunnel(f.store, { weeks: 2, now });
  assert.equal(after.weeks[1].joins.commons - before.weeks[1].joins.commons, 2);
  assert.equal(after.weeks[0].joins.commons - before.weeks[0].joins.commons, 3);
  assert.equal(after.weeks[1].mints - before.weeks[1].mints, 1);
  assert.equal(after.weeks[0].mints - before.weeks[0].mints, 2);
  if (otherRoom) assert.ok(!(otherRoom.id in after.weeks[1].joins));
});

test("auth completions derive from accounts by origin and week", t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const now = f.store.now();
  const before = readDoorFunnel(f.store, { weeks: 2, now });
  seedAccount(f.store, "google-oauth", now, 1);
  seedAccount(f.store, "github-oauth", now - 8 * 86400000, 2);
  const after = readDoorFunnel(f.store, { weeks: 2, now });
  assert.equal(after.weeks[1].auth.completions.google - before.weeks[1].auth.completions.google, 1);
  assert.equal(after.weeks[0].auth.completions.github - before.weeks[0].auth.completions.github, 2);
});

test("HTTP: views and auth starts are counted at the boundary; the readout refuses non-GET", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const now = f.store.now();
  const before = readDoorFunnel(f.store, { weeks: 2, now });

  await get(origin, "/receipts");
  await get(origin, "/receipts", { "user-agent": "GPTBot/1.0" });
  await get(origin, `/receipts/pwr_${"a".repeat(16)}`);
  await get(origin, "/join");
  await get(origin, "/.well-known/agent-skills/index.json");
  const google = await get(origin, "/api/auth/google/start", { accept: "application/json" });
  assert.equal(google.status, 503); // unconfigured in the fixture: still an auth start, with the unavailable outcome
  const github = await get(origin, "/api/auth/github/start", { accept: "application/json" });
  assert.equal(github.status, 503);

  const res = await get(origin, "/api/public/door-funnel?weeks=2");
  assert.equal(res.status, 200);
  const body = await res.json();
  const current = body.weeks[body.weeks.length - 1];
  assert.equal(current.views.receipts - before.weeks[1].views.receipts, 2);
  assert.equal(current.viewBots.receipts - before.weeks[1].viewBots.receipts, 1);
  assert.equal(current.views.receipt_detail - before.weeks[1].views.receipt_detail, 1);
  assert.equal(current.views.join - before.weeks[1].views.join, 1);
  assert.equal(current.views.agent_skills - before.weeks[1].views.agent_skills, 1);
  assert.strictEqual(current.views.landing, null);
  assert.equal(body.surfaces.find(s => s.surface === "landing").counted, false);
  assert.equal(current.auth.starts.google - before.weeks[1].auth.starts.google, 1);
  assert.equal(current.auth.unavailable.google - before.weeks[1].auth.unavailable.google, 1);
  assert.equal(current.auth.starts.github - before.weeks[1].auth.starts.github, 1);
  assert.equal(current.auth.unavailable.github - before.weeks[1].auth.unavailable.github, 1);

  const post = await fetch(`${origin}/api/public/door-funnel`, { method: "POST" });
  assert.equal(post.status, 405);
});
