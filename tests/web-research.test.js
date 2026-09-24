// Room-side knowledge router (RC-2026-09-24-310): competitive mining of Firecrawl's
// Alexandria launch. Unit tests for the pure pieces (keywords, planner, validation)
// plus store-level tests with a fixture DB (room-cache leg, docs leg, rate limits,
// planOnly, provider unconfigured/configured with injected fetch) and HTTP tests
// (auth posture, guest gate, planOnly end-to-end). No external network anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import {
  WebResearch,
  webResearchSchema,
  researchKeywords,
  hasRecencySignal,
  providerStatus,
  webResearchContract,
  WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY,
} from "../server/web-research.mjs";
import { WebFetchError } from "../server/web-fetch.mjs";

const sha256 = text => createHash("sha256").update(String(text), "utf8").digest("hex");

// Minimal fake store: real SQLite DB + injectable webFetch + controllable clock.
function makeService(opts = {}, seed) {
  const db = new DatabaseSync(":memory:");
  db.exec(webResearchSchema);
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY)`);
  db.prepare("INSERT OR IGNORE INTO rooms(id) VALUES('room1')").run();
  db.exec(`CREATE TABLE IF NOT EXISTS web_fetch_cache (
    key TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT NOT NULL,
    markdown TEXT NOT NULL, metadata_json TEXT NOT NULL, bytes INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL)`);
  let now = 1_000_000;
  const store = { db, now: () => now, webFetch: opts.webFetch ?? null };
  const service = new WebResearch(store, opts.serviceOpts ?? {});
  if (seed) seed(db);
  return { db, service, setNow: v => { now = v; } };
}

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------
test("researchKeywords extracts deduped content words", () => {
  assert.deepEqual(researchKeywords("How does the room handle web fetch rate limits?"),
    ["room", "handle", "web", "fetch", "rate", "limits"]);
  assert.deepEqual(researchKeywords("the and of"), []);
  assert.deepEqual(researchKeywords(""), []);
});

test("hasRecencySignal spots freshness language", () => {
  assert.equal(hasRecencySignal("What did Firecrawl just announce?"), true);
  assert.equal(hasRecencySignal("latest news on Alexandria"), true);
  assert.equal(hasRecencySignal("how do claims work"), false);
});

test("planner is deterministic and cost-visible", () => {
  const { service } = makeService();
  const plan = service.plan({ question: "how do claims work", sources: ["room", "docs", "fetch", "provider"], urls: [], maxEvidence: 5 });
  const bySource = Object.fromEntries(plan.map(p => [p.source, p]));
  assert.equal(bySource.room.status, "disabled");
  assert.match(bySource.room.reason, /scoping fix/);
  assert.equal(bySource.room.cost, "n/a");
  assert.equal(bySource.docs.status, "planned");
  assert.equal(bySource.fetch.status, "skipped");
  assert.match(bySource.fetch.reason, /no urls/);
  // No provider env in test process by default for these names.
  return withEnv({ WEB_RESEARCH_PROVIDER: undefined, ALEXANDRIA_API_KEY: undefined }, () => {
    const p2 = service.plan({ question: "q", sources: ["provider"], urls: [], maxEvidence: 5 });
    assert.equal(p2[0].status, "unconfigured");
    assert.match(p2[0].reason, /WEB_RESEARCH_PROVIDER/);
  });
});

test("planner marks fetch leg planned when urls given, provider ready when keyed", () => {
  const { service } = makeService();
  return withEnv({ WEB_RESEARCH_PROVIDER: "alexandria", ALEXANDRIA_API_KEY: "test-key-never-real" }, () => {
    const plan = service.plan({ question: "q", sources: ["fetch", "provider"], urls: ["https://example.com/"], maxEvidence: 5 });
    const bySource = Object.fromEntries(plan.map(p => [p.source, p]));
    assert.equal(bySource.fetch.status, "planned");
    assert.match(bySource.fetch.cost, /web-fetch quota/);
    assert.equal(bySource.provider.status, "planned");
    assert.match(bySource.provider.reason, /alexandria/);
    assert.match(bySource.provider.cost, /provider credits/);
  });
});

test("providerStatus never leaks the key", () => {
  return withEnv({ WEB_RESEARCH_PROVIDER: "alexandria", ALEXANDRIA_API_KEY: "super-secret-value" }, () => {
    const status = providerStatus(true);
    assert.equal(status.status, "ready");
    assert.ok(!JSON.stringify(status).includes("super-secret-value"));
  });
});

test("input validation rejects bad shapes loudly", async () => {
  const { service } = makeService();
  const bad = [
    null, "q", [],
    {},
    { question: "" },
    { question: "x".repeat(2001) },
    { question: "q", bogus: 1 },
    { question: "q", sources: [] },
    { question: "q", sources: ["room", "nope"] },
    { question: "q", urls: "https://example.com/" },
    { question: "q", urls: new Array(11).fill("https://example.com/") },
    { question: "q", maxEvidence: 0 },
    { question: "q", maxEvidence: 21 },
    { question: "q", maxAgeMs: -1 },
    { question: "q", tags: "t" },
    { question: "q", tags: new Array(21).fill("t") },
  ];
  for (const input of bad) {
    await assert.rejects(() => service.research("r", "m", input),
      error => error instanceof WebFetchError && error.code === "invalid_research_input",
      JSON.stringify(input)?.slice(0, 60));
  }
});

// ---------------------------------------------------------------------------
// planOnly: planning is free, bills nothing
// ---------------------------------------------------------------------------
test("planOnly returns the plan without executing or billing quota", async () => {
  const { service, db } = makeService();
  const res = await service.research("room1", "member1",
    { question: "how do claims work", planOnly: true });
  assert.equal(res.plan_only, true);
  assert.ok(res.plan.length >= 3);
  assert.deepEqual(res.evidence, []);
  assert.ok(res.request_id);
  const row = db.prepare("SELECT plan_only, evidence_count FROM web_research_log").get();
  assert.equal(row.plan_only, 1);
  assert.equal(row.evidence_count, 0);
});

// ---------------------------------------------------------------------------
// room leg: the room's own fetch memory
// ---------------------------------------------------------------------------
function seedCache(db) {
  const insert = db.prepare(`INSERT INTO web_fetch_cache(key, url, final_url, markdown, metadata_json, bytes, fetched_at)
    VALUES(?,?,?,?,?,?,?)`);
  insert.run("k1", "https://example.com/claims-guide", "https://example.com/claims-guide",
    "# Claims Guide\n\nClaims have leases. A claim block needs lease=6h.",
    JSON.stringify({ title: "Claims Guide" }), 100, 900_000);
  insert.run("k2", "https://example.com/unrelated", "https://example.com/unrelated",
    "# Cooking\n\nNothing about claims here at all.",
    JSON.stringify({ title: "Cooking" }), 100, 950_000);
}

test("room leg is interim-disabled: no room evidence, plan marks it disabled", async () => {
  // INTERIM (2026-09-24): the room leg searched the global web_fetch_cache
  // with no room scope (cross-room disclosure). Disabled until the
  // room-scoped web_fetch_cache_rooms fix lands. Seeded cache rows must NOT
  // surface as evidence.
  const { service } = makeService({}, seedCache);
  const res = await service.research("room1", "member1", { question: "how do claim leases work" });
  const room = res.evidence.filter(e => e.source === "room");
  assert.equal(room.length, 0);
  const planRoom = res.plan.find(p => p.source === "room");
  assert.equal(planRoom.status, "disabled");
});

// ---------------------------------------------------------------------------
// docs leg: local markdown corpus
// ---------------------------------------------------------------------------
test("docs leg searches a corpus with typed ids and provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "room-research-docs-"));
  try {
    writeFileSync(join(dir, "claims.md"), "# Claim Leases\n\nEvery claim carries a lease like lease=6h.\n");
    writeFileSync(join(dir, "other.md"), "# Other\n\nNothing relevant here.\n");
    const { service } = makeService({ serviceOpts: { docsFiles: [join(dir, "claims.md"), join(dir, "other.md")] } });
    const res = await service.research("room1", "member1",
      { question: "claim lease format", sources: ["docs"] });
    assert.equal(res.evidence.length, 1);
    const [e] = res.evidence;
    assert.equal(e.source, "docs");
    assert.ok(e.id.startsWith("doc:"));
    assert.equal(e.title, "Claim Leases");
    assert.match(e.excerpt, /lease=6h/);
    assert.equal(e.provenance.source, "docs");
    assert.equal(e.provenance.content_sha256.length, 64);
    assert.equal(e.provenance.cache, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fetch leg: explicit URLs through WebFetch; one bad URL never kills the call
// ---------------------------------------------------------------------------
test("fetch leg bills web-fetch and degrades per-URL failures", async () => {
  const calls = [];
  const fakeWebFetch = {
    async fetch(roomId, memberId, input, opts) {
      calls.push(input.url);
      if (input.url.includes("bad")) {
        const error = new WebFetchError(400, "invalid_url", "nope");
        throw error;
      }
      return {
        url: input.url, metadata: { title: "T" },
        markdown: { data: "# T\n\nbody about leases" },
        highlights: { data: ["[T] body about leases"] },
        cache_metadata: { status: "miss", age_ms: 0 },
        request_id: "req-1",
      };
    },
  };
  const { service } = makeService({ webFetch: fakeWebFetch });
  const res = await service.research("room1", "member1",
    { question: "leases", sources: ["fetch"], urls: ["https://example.com/ok", "https://example.com/bad"] });
  assert.deepEqual(calls, ["https://example.com/ok", "https://example.com/bad"]);
  assert.equal(res.evidence.length, 1);
  assert.equal(res.evidence[0].source, "fetch");
  assert.ok(res.evidence[0].id.startsWith("fetch:"));
  assert.equal(res.evidence[0].provenance.cache.status, "miss");
  assert.equal(res.fetch_errors.length, 1);
  assert.equal(res.fetch_errors[0].code, "invalid_url");
});

// ---------------------------------------------------------------------------
// provider leg: env-pluggable, injected fetch, key never logged
// ---------------------------------------------------------------------------
test("provider leg maps Alexandria-style results with injected fetch", async () => {
  let seenAuth = null;
  const fakeFetch = async (url, opts) => {
    seenAuth = opts.headers.Authorization;
    assert.equal(url, "https://api.firecrawl.dev/v2/search");
    return {
      ok: true,
      json: async () => ({ data: { web: [{ url: "https://p.example/a", title: "A", description: "alpha beta" }] } }),
    };
  };
  const { service } = makeService({ serviceOpts: { fetchImpl: fakeFetch } });
  await withEnv({ WEB_RESEARCH_PROVIDER: "alexandria", ALEXANDRIA_API_KEY: "k-test" }, async () => {
    const res = await service.research("room1", "member1",
      { question: "alpha", sources: ["provider"] });
    assert.equal(seenAuth, "Bearer k-test");
    assert.equal(res.evidence.length, 1);
    const [e] = res.evidence;
    assert.equal(e.source, "provider");
    assert.ok(e.id.startsWith("alexandria:"));
    assert.equal(e.title, "A");
    assert.equal(e.excerpt, "alpha beta");
    assert.equal(e.provenance.source, "provider:alexandria");
    assert.equal(res.provider_status.status, "ready");
  });
});

test("provider HTTP failure degrades to provider_errors, never a 500", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const { service } = makeService({ serviceOpts: { fetchImpl: fakeFetch } });
  await withEnv({ WEB_RESEARCH_PROVIDER: "alexandria", ALEXANDRIA_API_KEY: "k-test" }, async () => {
    const res = await service.research("room1", "member1",
      { question: "alpha", sources: ["provider"] });
    assert.deepEqual(res.evidence, []);
    assert.equal(res.provider_errors.length, 1);
    assert.equal(res.provider_errors[0].code, "provider_failed");
  });
});

// ---------------------------------------------------------------------------
// rate limits: execution billed, planning free
// ---------------------------------------------------------------------------
test("research quota is enforced with typed 429 and retry info", async () => {
  const { service, db, setNow } = makeService();
  const insert = db.prepare(`INSERT INTO web_research_log(request_id, room_id, member_id, credential_hash, question_hash, sources_json, evidence_count, plan_only, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY; i++) {
    insert.run(`r${i}`, "room1", "member1", null, "q", "[]", 0, 0, 1_000_000 - 1000);
  }
  setNow(1_000_000);
  await assert.rejects(() => service.research("room1", "member1", { question: "one more" }),
    error => error instanceof WebFetchError && error.code === "rate_limited" && error.status === 429
      && error.retryAfterMs > 0 && error.resetAt > 1_000_000);
  // planOnly still works at quota: planning is free.
  const planned = await service.research("room1", "member1", { question: "one more", planOnly: true });
  assert.equal(planned.plan_only, true);
});

// ---------------------------------------------------------------------------
// schema + contract
// ---------------------------------------------------------------------------
test("verifySchema converges on the additive journal table", () => {
  const { service } = makeService();
  assert.equal(service.verifySchema(), true);
  assert.equal(service.verifySchema({ allowAbsent: true }), true);
});

test("webResearchContract describes the route", () => {
  const contract = webResearchContract();
  assert.equal(contract.route, "POST /api/web/research");
  assert.deepEqual(contract.sources, ["room", "docs", "fetch", "provider"]);
});

// ---------------------------------------------------------------------------
// HTTP: auth posture mirrors /api/web/fetch
// ---------------------------------------------------------------------------
async function redeemGuest(origin, store, ownerKey, name = "Synapse") {
  const postJson = (path, { data, token } = {}) => fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data),
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  const mint = await postJson("/api/rooms/commons/guest-invites", {
    token: ownerKey, data: { requestId: randomUUID(), guestLabel: `${name} visit`, expectedOwnerRevision: 0 },
  });
  assert.equal(mint.status, 201);
  const identity = store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await postJson("/api/guest-invites/redeem", {
    token: identity.secret, data: { inviteCode: mint.json.code, card },
  });
  assert.equal(redeemed.status, 201);
  return redeemed.json.token;
}

async function serveHttp(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-web-research-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const command = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  command(T.MEMBER_ADDED, { memberId: "member", displayName: "Member", kind: "human", permissions: ["accept_work"] });
  store.bindHumanAccount("commons", "member", "account-member");
  const memberKey = store.issueAccessKey("commons", "member");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const guestKey = await redeemGuest(origin, store, ownerKey);
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const post = (data, token) => fetch(origin + "/api/web/research", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data),
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  return { post, ownerKey, memberKey, guestKey };
}

test("HTTP: planOnly end-to-end, 401 without credential, 403 for guests, 422 on bad input", async t => {
  const { post, ownerKey, memberKey, guestKey } = await serveHttp(t);
  const ok = await post({ question: "how do claims work", planOnly: true }, ownerKey);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.plan_only, true);
  assert.ok(ok.json.plan.some(p => p.source === "room"));
  assert.ok(ok.json.request_id);

  const member = await post({ question: "how do claims work", planOnly: true }, memberKey);
  assert.equal(member.status, 200);

  const anon = await post({ question: "how do claims work", planOnly: true });
  assert.equal(anon.status, 401);

  const guest = await post({ question: "how do claims work", planOnly: true }, guestKey);
  assert.equal(guest.status, 403);
  assert.equal(guest.json.error.code, "guest_scope_denied");

  const bad = await post({ question: "", planOnly: true }, ownerKey);
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "invalid_research_input");
});
