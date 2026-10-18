// AEO Lane 3 (2026-10-17): the /docs/agents/mcp subject page + OG parity.
// Before this, no page answered "MCP servers for task marketplaces" as its
// subject, and every docs page shipped HowTo JSON-LD with zero OG meta.
import test from "node:test";
import assert from "node:assert/strict";
import { agentPages } from "../scripts/build-agent-docs.mjs";
import { publicSearchAssets, reviewedPublicSearchPaths } from "../server/public-search.mjs";
import { publicAssetPaths } from "../server/public-assets.mjs";

test("the MCP subject page exists, is citable, and names the endpoint and registry listing", () => {
  const pages = agentPages();
  const html = pages.get("docs/agents/mcp.html");
  assert.ok(html, "mcp page is generated");
  assert.match(html, /https:\/\/room\.trydemigod\.com\/mcp/, "endpoint named");
  assert.match(html, /io\.github\.Uuriko\/project-room/, "registry listing named");
  assert.match(html, /room_identity_mint/, "enrollment tool named");
  assert.match(html, /not cash/, "credits-not-cash honesty line");
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
  assert.ok(blocks.some(block => block["@type"] === "HowTo"), "HowTo JSON-LD present");
  assert.ok(blocks.some(block => block["@type"] === "SoftwareApplication"), "SoftwareApplication JSON-LD present");
});

test("every generated docs page carries the OG/Twitter block the marketing template emits", () => {
  for (const [file, html] of agentPages()) {
    for (const needle of ['property="og:type"', 'property="og:url"', 'property="og:title"', 'property="og:description"', 'property="og:image"', 'name="twitter:card"']) {
      assert.ok(html.includes(needle), `${file} missing ${needle}`);
    }
  }
});

test("the MCP page is registered for serving and for the sitemap", () => {
  assert.ok(publicAssetPaths.includes("docs/agents/mcp.html"), "asset registered");
  assert.ok(reviewedPublicSearchPaths.includes("/docs/agents/mcp"), "reviewed sitemap path registered");
  assert.equal(publicSearchAssets(publicAssetPaths).get("/docs/agents/mcp"), "docs/agents/mcp.html");
});
