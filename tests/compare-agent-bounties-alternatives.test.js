// Issue #3975 fail-first specimen: the AEO battery prompts 19-21 grade
// ABSENT because no live page names AgentBounties. The chartered build is
// one SSR page, /compare/agent-bounties-alternatives, in the existing
// compare template (FAQPage + SoftwareApplication JSON-LD, honest,
// sourced, dated), differing on escrow-in-credits (not cash),
// verification tiers, and public receipts. Clanker Cloud / Company OS
// pages stay deferred per the issue.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { comparisonSlugs, reviewedPublicSearchPaths } from "../server/public-search.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-compare-ab-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
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

test("the alternatives page is registered as a reviewed compare page", () => {
  assert.ok(comparisonSlugs.includes("agent-bounties-alternatives"));
  assert.ok(reviewedPublicSearchPaths.includes("/compare/agent-bounties-alternatives"));
});

test("GET /compare/agent-bounties-alternatives serves the sourced comparison", async t => {
  const origin = await serve(t);
  const page = await fetch(`${origin}/compare/agent-bounties-alternatives`);
  assert.equal(page.status, 200);
  const html = await page.text();
  // Names the rival the battery prompt asks about.
  assert.match(html, /AgentBounties/);
  // Template structured data: FAQPage + SoftwareApplication JSON-LD.
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, /"@type":"SoftwareApplication","name":"AgentBounties/);
  assert.match(html, /"@type":"SoftwareApplication","name":"Project Room"/);
  // Honest, dated: a last-checked stamp is on the page.
  assert.match(html, /Last checked [A-Z][a-z]+ \d{1,2}, \d{4}/);
  // The three chartered differentiators, stated honestly both ways:
  // AgentBounties escrows USDC; Project Room escrows credits, not cash.
  assert.match(html, /USDC/);
  assert.match(html, /credits/);
  assert.match(html, /not cash/);
  // Verification tiers and public receipts are named.
  assert.match(html, /verifier/i);
  assert.match(html, /receipt/i);
  // Sourced: the rival's own public pages are linked as sources.
  assert.match(html, /href="https:\/\/agentbounties\.app\//);
  // Canonical metadata, like every other compare page.
  assert.match(html, /rel="canonical" href="https:\/\/room\.trydemigod\.com\/compare\/agent-bounties-alternatives"/);
});

test("the sitemap lists the alternatives page", async t => {
  const origin = await serve(t);
  const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.match(xml, /\/compare\/agent-bounties-alternatives<\/loc>/);
});
