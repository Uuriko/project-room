// Landing hero (#3548): the collaboration front door. Contracts:
// - The served wall carries the hero framing (workforce-noun headline per
//   charter D4), the doors with a live receipt as primary, the gallery
//   link, and the facts server-rendered into the raw HTML (charter D5) —
//   with the GitHub door hidden until verification.
// - GET /api/public/landing computes every counter from its source query
//   and features a real receipt from the read model, never a mock.
// - The GitHub gate in GET /api/auth/signin-options flips to verified only
//   after a real sign-in completes against this deployment's secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { collectPublicReceipts, publicReceiptCounts } from "../server/public-read-model.mjs";
import { projectPublicWorkReceipt } from "../server/receipts-live.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { GITHUB_START_PATH, GITHUB_CALLBACK_PATH } from "../server/github-oauth.mjs";

async function serve(t, store, options = {}) {
  const server = createRoomServer({ store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return origin;
}

async function plainStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-landing-hero-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return store;
}

// A real verified result in the commons room: a claim the server settled
// as a merged pull request, with the room's receipts public.
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

test("logged-out entry serves the collaboration hero with the GitHub door locked", async t => {
  const store = await plainStore(t);
  const origin = await serve(t, store);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /<h1 id="auth-title"[^>]*>PROJECT ROOM<\/h1>/);
  // SSR/indexing contract (charter D5): canonical in the raw HTML.
  assert.ok(html.includes('<link rel="canonical" href="https://room.trydemigod.com/">'), "canonical in raw HTML");
  assert.ok(html.includes('<meta property="og:title" content="Project Room">'), "OG card in raw HTML");
  const hero = html.match(/<section id="landing-hero"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(hero, "hero section is served");
  assert.ok(hero.includes("Put AI teammates to work — and prove what they did."), "headline: workforce noun + verifiability claim");
  assert.ok(hero.includes("Put agents to work where humans can direct, review, and prove the results."), "adopted product line carries the subhead");
  assert.ok(hero.includes('id="landing-receipt-cta" href="/receipts">See a real receipt'), "primary door is a live receipt (gallery until one exists)");
  assert.ok(hero.includes('href="#auth-panel">Start a room'), "secondary door starts a room");
  assert.ok(hero.includes('href="/agent-signin">Send your agent to work'), "agent door");
  assert.ok(hero.includes('href="/receipts">Browse the receipts gallery'), "gallery linked");
  for (const key of ["resultsVerified", "receiptsIssued", "workAvailableNow"]) {
    assert.ok(hero.includes(`data-landing-counter="${key}">0</strong>`), `counter ${key} server-rendered as a fact`);
  }
  assert.ok(hero.includes('<article id="landing-receipt-card" class="landing-receipt-card" hidden>'),
    "no receipt on an empty store: the card stays hidden, never a mock");
  assert.ok(!/bounty/i.test(hero), "no bounty-first copy in the hero");
  const github = html.match(/<a id="github-signin"[^>]*>/)?.[0] ?? "";
  assert.ok(github.includes("hidden"), "GitHub door starts hidden — shown only after live verification");
  const google = html.match(/<a id="google-signin"[^>]*>/)?.[0] ?? "";
  assert.ok(google && !google.includes("hidden"), "Google door is not gated");
  assert.ok(html.includes('href="/agent-signin"'), "agent entry retains its separate surface");
});

test("the served hero server-renders the featured real receipt and its facts", async t => {
  const store = await plainStore(t);
  seedVerifiedClaim(store);
  const origin = await serve(t, store);
  const html = await (await fetch(`${origin}/`)).text();
  const receipt = collectPublicReceipts(store)[0];
  assert.ok(receipt, "seeded receipt exists");
  assert.ok(html.includes(`data-landing-counter="receiptsIssued">1</strong>`), "receipts issued in raw HTML");
  assert.ok(html.includes(`data-landing-counter="resultsVerified">1</strong>`), "results verified in raw HTML");
  assert.ok(html.includes(`id="landing-receipt-cta" href="/receipts/${receipt.id}"`), "primary door targets the live receipt");
  assert.ok(html.includes('<article id="landing-receipt-card" class="landing-receipt-card">'), "card rendered, not hidden");
  assert.ok(html.includes(`<a id="landing-receipt-link" href="/receipts/${receipt.id}">Settled work</a>`), "card title is the real receipt");
  assert.ok(html.includes("Merged pull request · settled by the server"), "verification label in visible text");
});

test("landing feed on an empty store computes zeroes and no featured receipt", async t => {
  const store = await plainStore(t);
  const origin = await serve(t, store);
  const feed = await (await fetch(`${origin}/api/public/landing`)).json();
  assert.deepEqual(feed.counters, {
    resultsVerified: 0,
    receiptsIssued: 0,
    workAvailableNow: store.publicWorkClaims.list({ limit: 100 }).claimableCount,
  });
  assert.equal(feed.featuredReceipt, null);
});

test("landing feed counters match their source queries and feature the newest real receipt", async t => {
  const store = await plainStore(t);
  seedVerifiedClaim(store);
  const origin = await serve(t, store);
  let feed = await (await fetch(`${origin}/api/public/landing`)).json();
  assert.equal(feed.counters.receiptsIssued, 1);
  assert.equal(feed.counters.resultsVerified, 1, "a server-settled merge counts as verified");
  assert.equal(feed.featuredReceipt.title, "Settled work");
  assert.equal(feed.featuredReceipt.source, "work-claim");
  // A public-work finish issues its receipt over the artifact hash.
  const sha = "cd".repeat(32);
  projectPublicWorkReceipt(store, {
    receiptId: `pwr_${sha}`, title: "Public work result", namespaceId: "commons",
    identityId: "ai_fixture", agentName: "Fixture Agent", createdAt: "2026-10-02T12:00:00.000Z",
  }, sha);
  feed = await (await fetch(`${origin}/api/public/landing`)).json();
  const counts = publicReceiptCounts(store);
  assert.equal(feed.counters.receiptsIssued, counts.receiptsIssued);
  assert.equal(feed.counters.resultsVerified, counts.resultsVerified);
  assert.equal(feed.counters.receiptsIssued, collectPublicReceipts(store).length);
  assert.equal(feed.counters.resultsVerified, 2);
  assert.equal(feed.counters.workAvailableNow, store.publicWorkClaims.list({ limit: 100 }).claimableCount);
  assert.equal(feed.featuredReceipt.id, `pwr_${sha}`, "newest receipt is featured");
  assert.equal(feed.featuredReceipt.id, collectPublicReceipts(store)[0].id);
  assert.ok(feed.featuredReceipt.hashes.some(hash => hash.includes(sha)), "artifact hash rides the card");
});

test("product and agent guides remain available away from the entry", async t => {
  const store = await plainStore(t);
  const origin = await serve(t, store);
  for (const path of ["/about", "/llms.txt"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, `${path} serves 200`);
  }
});

// The gate's two halves, against a stub GitHub (no network, no real
// credentials — the same fixture shape as tests/github-oauth-http.test.js).
const fixtureGithubFetch = async url => {
  if (url === "https://github.com/login/oauth/access_token") {
    return Response.json({ access_token: "gho_fixturetoken", token_type: "bearer", scope: "read:user user:email" }); // secrets-allowlist (fixture value, not a credential)
  }
  if (url === "https://api.github.com/user") return Response.json({ id: 424242, login: "octofixture" });
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: "gh-user@example.com", primary: true, verified: true }]);
  }
  return new Response("missing", { status: 404 });
};

test("GitHub reports configured-but-unverified until a real sign-in completes", async t => {
  const f = createAcceptanceFixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const origin = await serve(t, f.store, {
    githubAuth: { clientId: "Iv1.fixtureclientid0000", clientSecret: "fixture-secret-never-real", fetchImpl: fixtureGithubFetch }, // secrets-allowlist (fixture value, not a credential)
  });
  const options = async () => (await (await fetch(`${origin}/api/auth/signin-options`)).json()).providers.github;
  assert.deepEqual(await options(), { configured: true, verified: false });
  const slot = f.store.createAccountSessionSlot();
  const start = await fetch(`${origin}${GITHUB_START_PATH}?sessionToken=${slot.token}`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  const callback = await fetch(
    `${origin}${GITHUB_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=code-fixture`,
    { redirect: "manual" });
  assert.equal(callback.status, 200, "the sign-in itself completes");
  assert.deepEqual(await options(), { configured: true, verified: true },
    "one completed sign-in is the durable verification record");
});

test("GitHub reports unconfigured and unverified when the deployment has no secrets", async t => {
  const store = await plainStore(t);
  const origin = await serve(t, store);
  const github = (await (await fetch(`${origin}/api/auth/signin-options`)).json()).providers.github;
  assert.deepEqual(github, { configured: false, verified: false });
});
