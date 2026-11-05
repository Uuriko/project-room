// DOOR-CURE-5 remainder: settled bounty lots must be discoverable on the
// agent packet and the served OpenAPI inventory, not only on the receipts
// wall / sitemap (those two surfaces are PR #4501's listing merge).
//
// Pins, pure-function level (no store, no disk):
//   - llms.txt (short packet) names the receipts surface and lot receipts;
//   - llms-full.txt (full packet, PUBLIC_WORK_SECTION) explains where a
//     settled lot lists and where it reads, including the opt-in gate;
//   - the generated OpenAPI document carries GET+HEAD /api/public/receipts
//     whose summary names bounty lot receipts, with unique operationIds.
//
// Run: node --test tests/lot-discovery.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { llmsTxt, llmsFullTxt } from "../server/agent-discovery.mjs";
import { buildOpenApiJson, DISCOVERABILITY_ROUTES } from "../server/discoverability.mjs";

test("llms.txt short packet names settled bounty lots on the receipts surface", () => {
  const text = llmsTxt();
  assert.match(text, /\[Receipts\]\(https:\/\/room\.trydemigod\.com\/receipts\)/);
  assert.match(text, /lot_/, "short packet names the lot_ receipt id shape");
  assert.match(text, /bounty-lot/, "short packet names the bounty-lot source");
});

test("llms-full.txt explains where a settled lot lists and reads", () => {
  const text = llmsFullTxt();
  assert.match(text, /Settled bounty lots are receipts too\./);
  assert.match(text, /payoutReceipt\.receiptId/);
  assert.match(text, /GET \/receipts\/<lotId>\.json/, "the lot JSON face is named");
  assert.match(text, /public-receipts opt-in/, "the opt-in gate is stated, not implied");
});

test("served OpenAPI inventory documents the public receipts list incl. lots", () => {
  const entry = DISCOVERABILITY_ROUTES.find(r => r.path === "/api/public/receipts");
  assert.ok(entry, "route table inventories /api/public/receipts");
  assert.deepEqual([...entry.methods].sort(), ["GET", "HEAD"]);
  assert.equal(entry.auth, "none");
  const doc = buildOpenApiJson({ origin: "https://room.trydemigod.com" });
  const item = doc.paths["/api/public/receipts"];
  assert.ok(item?.get && item?.head, "GET and HEAD operations are generated");
  assert.match(item.get.summary, /bounty lot/, "summary names bounty lot receipts");
  assert.equal(item.get.operationId, "listPublicReceipts");
  assert.equal(item.head.operationId, "headPublicReceipts");
  const paramNames = (item.get.parameters ?? []).map(q => q.name);
  for (const name of ["room", "agent", "cursor", "limit"]) assert.ok(paramNames.includes(name), `documents the ${name} query parameter`);
});
