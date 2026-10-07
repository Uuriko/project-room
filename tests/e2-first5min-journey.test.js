// E2 lane (2026-10-07): first-5-minutes journey gaps, verified live on prod.
//
// A fresh identity walked mint -> find work -> claim -> receipt against
// room.trydemigod.com and hit three doc-drift dead ends:
//   1. The public-work queue was fully drained (7/7 tasks in claim.state
//      "submitted"; match -> 0 recommendations; claim -> 409
//      public_work_already_submitted) while AGENT-START-HERE.md and the
//      llms.txt packet teach no empty-queue branch — the 409 table says
//      "pick another task" but there is no other task.
//   2. The unauthenticated MCP catalog serves 7 tools (room_identity_mint
//      landed after the docs were written) while three doc surfaces still
//      say "six public tools".
//   3. The room board rejects claimed -> done directly (422
//      invalid_claim_input per the server/work-claims.mjs transition table);
//      llms.txt lists the in_progress and done updates without the order.
//
// These tests pin the doc repairs so the drift fails CI instead of stranding
// the next fresh agent. Docs are downstream of the code: when a count test
// fails, fix the docs, not the served catalog.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { livePublicMcpTools } from "../server/mcp-discovery.mjs";
import { llmsTxt } from "../deploy/agent-discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

test("docs' public-tool count matches the served unauthenticated catalog", () => {
  // livePublicMcpTools() builds the same list tools/list serves anonymous
  // callers, so this fails the moment a public tool ships without a doc update
  // (exactly how room_identity_mint made "six" stale).
  const served = livePublicMcpTools().length;
  assert.ok(served > 0, "unauthenticated catalog is non-empty");
  const spots = [
    ["deploy/agent-discovery.mjs", /(\w+) public tools with no credential/],
    ["docs/SWARM-PLUG-IN.md", /tools\/list is (\w+) public tools/],
    ["docs/openapi.yaml", /the (\w+) public tools \(four join tools/],
  ];
  for (const [rel, re] of spots) {
    const m = read(rel).match(re);
    assert.ok(m, `${rel} states a public-tool count`);
    assert.equal(
      WORDS[m[1].toLowerCase()],
      served,
      `${rel} says "${m[1]}" but the server lists ${served} unauthenticated tools`,
    );
  }
});

test("AGENT-START-HERE.md guides the drained-queue case", () => {
  // The doc's promise is "your first claimed task in under 10 minutes". When
  // the volunteer queue is drained it must name that state and give a next
  // step instead of dead-ending at "pick another task".
  const doc = read("docs/AGENT-START-HERE.md");
  assert.match(doc, /"recommendations": \[\]|zero recommendations/i, "doc names the empty match case");
  assert.match(doc, /queue is drained/i, "doc explains what zero recommendations means");
  assert.match(
    doc,
    /check back later|work-claims/i,
    "doc gives the agent a next step when nothing is claimable",
  );
});

test("llms.txt public-work section guides the drained-queue case", () => {
  // MCP-only agents read the packet, not AGENT-START-HERE.md; the packet's
  // "Find work without joining a private room" section needs the same branch.
  const text = llmsTxt();
  const section = text.split("## Find work without joining a private room")[1].split("\n## ")[0];
  assert.match(section, /"recommendations": \[\]|zero recommendations/i, "packet names the empty match case");
  assert.match(section, /drained/i, "packet explains what zero recommendations means");
});

test("llms.txt work-claim board section teaches the claimed -> in_progress -> done order", () => {
  // server/work-claims.mjs: claimed -> [in_progress, blocked, unclaimed];
  // claimed -> done answers 422 invalid_claim_input. The board section must
  // teach the order so a fresh agent does not learn it from a rejection.
  const text = llmsTxt();
  const section = text.split("## Work-claim board")[1].split("\n## ")[0];
  assert.match(
    section,
    /claimed\s*→\s*in_progress\s*→\s*done/,
    "board section states the close order (claimed -> done direct is 422)",
  );
});
