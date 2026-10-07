// H5 audit+fix hardening for the plug-in funnel (PR #1937 follow-up).
//
// Fail-first coverage for the gaps the audit found with live evidence:
//
//  1. doc_read counted AI crawlers (robots.txt explicitly invites GPTBot et
//     al. to /llms.txt), HEAD probes (which server/feedback-routes.mjs:198
//     calls "a metadata probe, never a read"), and signed-in browsers (not
//     anonymous prospects; a stable per-account key is per-user tracking).
//  2. identity_mint was hooked at two call sites but AgentIdentities.create()
//     has five: POST /api/agent-identities, the MCP mint tool, the
//     personal-room onboarding mint (server/http.mjs), the invite-code redeem
//     (server/agent-invites.mjs) and the referral redeem
//     (server/referral-invites.mjs). Three doors never recorded.
//  3. room_join was hooked inside linkIdentity, but the two redeem paths
//     INSERT INTO identity_links directly — their joins never recorded.
//  4. day-7 message activity used body LIKE '%"type":"message.posted"%':
//     misses pretty-printed envelopes and matches any event quoting the
//     literal string. The codebase convention (server/store.mjs:1264) is
//     json_extract(body,'$.type')='message.posted'.
//  5. GET /api/plugin-funnel ran a full events-table scan per anonymous
//     request; the report is now cached briefly (TTL well under an hour).
//  6. the create() hook must sit after the genuine INSERT: recoverable
//     re-registration (duplicate secret) returns early and is not a mint.
//
// Authoring-gate answers: each test pins an observable contract at its owner
// boundary (the recorder, create(), the redeem HTTP door, the collector, the
// handler). Credible regressions are named per test. No test-only production
// seams were added.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensurePluginFunnelSchema,
  recordPluginFunnelReader,
  recordPluginFunnelStage,
  collectPluginFunnelInputs,
  handlePluginFunnelRequest,
} from "../server/plugin-funnel.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-07T17:00:00.000Z");

function memoryDb() {
  return new DatabaseSync(":memory:");
}

async function httpFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return { store, ownerKey, origin: `http://127.0.0.1:${server.address().port}` };
}

test("doc_read skips crawlers, HEAD probes, and signed-in browsers", () => {
  const db = memoryDb();
  // AI crawler: robots.txt explicitly invites GPTBot to /llms.txt — a fetch
  // by a crawler is not a prospect reading the docs.
  assert.equal(recordPluginFunnelReader(db, { address: "9.9.9.9", userAgent: "GPTBot/1.2", method: "GET" }), false);
  // Generic web crawler.
  assert.equal(recordPluginFunnelReader(db, { address: "9.9.9.9", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)", method: "GET" }), false);
  // HEAD is a metadata probe, never a read.
  assert.equal(recordPluginFunnelReader(db, { address: "9.9.9.9", userAgent: "curl/8.0", method: "HEAD" }), false);
  // Signed-in browser: not an anonymous prospect, and a stable per-account
  // key in the funnel table would be per-user tracking.
  assert.equal(recordPluginFunnelReader(db, { address: "9.9.9.9", session: "sess-abc", userAgent: "Mozilla/5.0", method: "GET" }), false);
  // Anonymous GET from a real client still records, first-reach-wins.
  assert.equal(recordPluginFunnelReader(db, { address: "9.9.9.9", userAgent: "Mozilla/5.0", method: "GET" }), true);
  assert.equal(recordPluginFunnelReader(db, { address: "9.9.9.9", userAgent: "Mozilla/5.0", method: "GET" }), true);
  const n = db.prepare("SELECT count(*) AS n FROM plugin_funnel_events WHERE stage='doc_read'").get().n;
  assert.equal(n, 1, "exactly one anonymous doc_read recorded");
  db.close();
});

test("identity_mint is recorded at the create() choke point, not per call site", () => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  try {
    // No HTTP involved: create() itself must record, so every mint door
    // (HTTP, MCP, invite-code redeem, referral redeem, personal-room
    // onboarding) is counted even when a new door is added later.
    const created = store.identities.create("choke-bot");
    assert.ok(created.identityId, "identity created");
    const n = store.db.prepare("SELECT count(*) AS n FROM plugin_funnel_events WHERE stage='identity_mint'").get().n;
    assert.equal(n, 1, "create() records identity_mint with no HTTP call");
  } finally {
    store.close();
  }
});

test("recoverable re-registration with the same secret is not a new mint", () => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  try {
    const secret = `pri_${"A".repeat(43)}`;
    const first = store.identities.create("recovery-bot", { secret });
    assert.ok(first.identityId);
    // Same credential, new display name: the duplicate path returns early.
    const second = store.identities.create("recovery-bot-2", { secret });
    assert.equal(second.duplicate, true);
    assert.equal(second.identityId, first.identityId);
    // Pins the hook placement: after the genuine INSERT, not at the top of
    // create(). A hook above the duplicate early-returns would record 2.
    // (Fails on the pre-fix code with 0 for the same reason as the choke-point
    // test above; together they pin existence AND placement.)
    const n = store.db.prepare("SELECT count(*) AS n FROM plugin_funnel_events WHERE stage='identity_mint'").get().n;
    assert.equal(n, 1, "duplicate recovery records no additional mint");
  } finally {
    store.close();
  }
});

test("invite-code redeem records identity_mint and room_join", async t => {
  const { store, ownerKey, origin } = await httpFixture(t);
  // The funnel table is created lazily by the first record; ensure it so the
  // baseline read works even before anything is recorded.
  ensurePluginFunnelSchema(store.db);
  const funnelCount = stage =>
    store.db.prepare("SELECT count(*) AS n FROM plugin_funnel_events WHERE stage=?").get(stage).n;
  const mintedBefore = funnelCount("identity_mint");
  const joinedBefore = funnelCount("room_join");

  const mkRes = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "contribute" }),
  });
  assert.ok([200, 201].includes(mkRes.status), "owner mints an invite code");
  const { code } = await mkRes.json();
  assert.ok(code, "invite code returned");

  const rdRes = await fetch(`${origin}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, displayName: "redeem-bot" }),
  });
  assert.ok([200, 201].includes(rdRes.status), "anonymous agent redeems");

  assert.equal(funnelCount("identity_mint"), mintedBefore + 1, "redeem door records the mint");
  assert.equal(funnelCount("room_join"), joinedBefore + 1, "redeem door records the join");
});

test("day-7 message activity matches the event type, not a body substring", () => {
  const db = memoryDb();
  ensurePluginFunnelSchema(db);
  db.exec(`CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence))`);
  const at = new Date(NOW - DAY).toISOString();
  // Pretty-printed envelope (spaces after colons): still a real message.
  const pretty = JSON.stringify({ id: "e1", type: "message.posted", actorId: "m-1", roomId: "r1", at, data: {} }, null, 2);
  // Decoy: a different event type quoting the literal substring in payload.
  const decoy = JSON.stringify({ id: "e2", type: "note.added", actorId: "m-2", roomId: "r1", at, data: { text: 'saw "type":"message.posted" in the docs' } });
  db.prepare("INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)").run("r1", 1, "e1", pretty);
  db.prepare("INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)").run("r1", 2, "e2", decoy);
  const inputs = collectPluginFunnelInputs({ db }, { nowMs: NOW });
  // The LIKE pre-filter missed the pretty envelope and matched the decoy.
  assert.equal(inputs.messageActivity.length, 1, "exactly the real message.posted counts");
  assert.equal(inputs.messageActivity[0].memberId, "m-1");
  db.close();
});

test("the public report is cached briefly, then refreshes", () => {
  const db = memoryDb();
  ensurePluginFunnelSchema(db);
  let now = NOW;
  const store = { db, now: () => now };
  recordPluginFunnelStage(db, { identityId: "c-1", stage: "identity_mint", atMs: NOW - DAY });

  const first = handlePluginFunnelRequest(store, { method: "GET" });
  assert.equal(first.status, 200);
  assert.equal(first.body.stages.identity_mint.count, 1);

  // A second mint lands, but the cached report still serves the old count.
  recordPluginFunnelStage(db, { identityId: "c-2", stage: "identity_mint", atMs: now });
  const second = handlePluginFunnelRequest(store, { method: "GET" });
  assert.equal(second.body.generatedAt, first.body.generatedAt, "report cached within the TTL");
  assert.equal(second.body.stages.identity_mint.count, 1, "cached count, not the fresh one");

  // Well past the TTL (this suite assumes a TTL under an hour) it refreshes.
  now += 3_600_000;
  const third = handlePluginFunnelRequest(store, { method: "GET" });
  assert.equal(third.body.stages.identity_mint.count, 2, "fresh count after TTL");
  assert.notEqual(third.body.generatedAt, first.body.generatedAt);
  db.close();
});
