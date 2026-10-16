// Landing route + feed builder (#3548): module-level contracts for
// server/routes/landing.mjs and server/landing-page.mjs — the route's
// registration and public auth posture, the feed's exact payload shape
// computed from the read model, and the SSR fill's exact slot behavior.
// The browser-level golden path lives in scripts/landing-hero-browser-check.mjs
// and the wall-level contracts in tests/landing-hero.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { publicReceiptCounts, queryPublicReceipts } from "../server/public-read-model.mjs";
import { LANDING_ROUTES } from "../server/routes/landing.mjs";
import { buildLandingFeed, renderLandingHtml, landingReceiptMeta, landingReceiptHash } from "../server/landing-page.mjs";

async function plainStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-landing-route-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedVerifiedClaim(store, { id = "claim-1", title = "Settled work", at = "2026-10-01T12:00:00.000Z" } = {}) {
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: `publish-${id}`, type: "room.public_receipts_set", data: { enabled: true } });
  store.workClaims.set("commons", {
    id, title, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: at },
    blobs: [`sha256:${"ab".repeat(32)}`], updatedAt: at,
  });
}

test("the landing route is registered once, as a public unauthenticated GET", () => {
  assert.equal(LANDING_ROUTES.length, 1);
  const [route] = LANDING_ROUTES;
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/api/public/landing");
  assert.equal(route.auth, "none", "the front-door feed is public by design");
  assert.equal(route.scope, "public");
  assert.equal(route.capability, null);
  assert.equal(typeof route.handler, "function");
  assert.ok(route.rate?.max > 0, "the public feed carries a rate limit");
});

test("buildLandingFeed on an empty store reports zeroes and no featured receipt", async t => {
  const store = await plainStore(t);
  const feed = buildLandingFeed(store);
  assert.deepEqual(feed, {
    counters: { resultsVerified: 0, receiptsIssued: 0, workAvailableNow: 0 },
    featuredReceipt: null,
  });
});

test("buildLandingFeed computes counters from the read model and features the newest receipt", async t => {
  const store = await plainStore(t);
  seedVerifiedClaim(store);
  const feed = buildLandingFeed(store);
  const counts = publicReceiptCounts(store);
  assert.equal(feed.counters.receiptsIssued, counts.receiptsIssued);
  assert.equal(feed.counters.resultsVerified, counts.resultsVerified);
  assert.equal(feed.counters.workAvailableNow, store.publicWorkClaims.list({ limit: 100 }).claimableCount);
  const newest = queryPublicReceipts(store, { limit: 1 }).receipts[0];
  assert.ok(newest, "seeded receipt is visible");
  assert.equal(feed.featuredReceipt.id, newest.id);
  assert.deepEqual(Object.keys(feed.featuredReceipt).sort(), [
    "agents", "at", "hashLabel", "hashes", "humans", "id", "mergedAt", "meta", "pullRequest", "room", "source", "title",
  ], "the featured receipt carries exactly the public fields plus display meta/hash label");
  assert.equal(feed.featuredReceipt.meta, landingReceiptMeta(newest));
  assert.equal(feed.featuredReceipt.hashLabel, landingReceiptHash(newest));
  assert.ok(feed.featuredReceipt.hashLabel.startsWith("sha256:"));
});

test("renderLandingHtml fills only the exact empty slots and never invents a receipt", async t => {
  const store = await plainStore(t);
  const shell = [
    '<strong data-landing-counter="resultsVerified">–</strong>',
    '<strong data-landing-counter="receiptsIssued">–</strong>',
    '<strong data-landing-counter="workAvailableNow">–</strong>',
    '<a class="button primary" id="landing-receipt-cta" href="/receipts">',
    '<article id="landing-receipt-card" class="landing-receipt-card" hidden>',
    '<a id="landing-receipt-link" href="/receipts">Receipt</a>',
    '<p id="landing-receipt-meta" class="form-hint"></p>',
    '<p id="landing-receipt-hash" class="landing-receipt-hash" hidden></p>',
  ].join("\n");
  const empty = renderLandingHtml(shell, buildLandingFeed(store));
  assert.ok(empty.includes('<strong data-landing-counter="receiptsIssued">0</strong>'), "counters render as facts");
  assert.ok(empty.includes('<article id="landing-receipt-card" class="landing-receipt-card" hidden>'),
    "no receipt on an empty store: the card stays hidden");
  assert.ok(empty.includes('id="landing-receipt-cta" href="/receipts"'), "CTA keeps the gallery target");

  seedVerifiedClaim(store);
  const filled = renderLandingHtml(shell, buildLandingFeed(store));
  const receipt = queryPublicReceipts(store, { limit: 1 }).receipts[0];
  assert.ok(filled.includes(`id="landing-receipt-cta" href="/receipts/${encodeURIComponent(receipt.id)}"`),
    "CTA points at the featured receipt");
  assert.ok(filled.includes('<article id="landing-receipt-card" class="landing-receipt-card">'),
    "the card unhides only with a real receipt");
  assert.ok(filled.includes(`<a id="landing-receipt-link" href="/receipts/${encodeURIComponent(receipt.id)}">Settled work</a>`));
});

test("GET /api/public/landing serves the feed anonymously with no-store", async t => {
  const store = await plainStore(t);
  seedVerifiedClaim(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/public/landing`);
  assert.equal(response.status, 200, "no credential is required or accepted as necessary");
  assert.equal(response.headers.get("cache-control"), "no-store",
    "the featured receipt is toggle-controlled, so the feed is never cached");
  assert.match(response.headers.get("content-type"), /application\/json/);
  const feed = await response.json();
  assert.deepEqual(Object.keys(feed).sort(), ["counters", "featuredReceipt"]);
  assert.deepEqual(feed, JSON.parse(JSON.stringify(buildLandingFeed(store))),
    "the served feed is exactly the builder's payload");
});
