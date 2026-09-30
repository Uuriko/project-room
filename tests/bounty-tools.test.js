import test from "node:test";
import assert from "node:assert/strict";

import { bountyTools, isBountyTool, validBountyToolArguments } from "../client/bounty-tools.mjs";
import { hostedStdioToolDefinitions, isHostedStdioTool, validHostedStdioArgs } from "../server/mcp-full-profile.mjs";

// The gap this surface closes: the escrow has been wired into the store and
// served over HTTP since the work-exchange slices, and no MCP tool named it,
// so a hosted-profile agent could not discover the room has an economy.
test("the hosted profile now advertises the bounty economy", () => {
  const names = hostedStdioToolDefinitions().map(entry => entry.name);
  for (const expected of ["bounty_list", "bounty_post", "bounty_fund", "bounty_claim",
    "bounty_submit", "bounty_accept", "bounty_dispute", "bounty_finalize",
    "bounty_transfer", "bounty_read_balances", "bounty_read_history", "bounty_watch"])
    assert.ok(names.includes(expected), `${expected} missing from the hosted profile`);
});

// Arbiter and operator seats stay off the agent surface: the room requires a
// human tap for steer/verify/admin work, and these three decide other
// members' outcomes.
test("adjudication and sweep operations are not exposed as agent tools", () => {
  const names = hostedStdioToolDefinitions().map(entry => entry.name);
  for (const withheld of ["bounty_dispute_decide", "bounty_decide_dispute",
    "bounty_close_epoch", "bounty_epoch_close", "bounty_resolve_sybil_flag"])
    assert.ok(!names.includes(withheld), `${withheld} must stay off the agent surface`);
});

test("every bounty tool is routable and carries roomId", () => {
  for (const entry of bountyTools) {
    assert.ok(isBountyTool(entry.name));
    assert.ok(isHostedStdioTool(entry.name));
    const hosted = hostedStdioToolDefinitions().find(d => d.name === entry.name);
    assert.ok(hosted.inputSchema.required.includes("roomId"));
    assert.equal(hosted.inputSchema.additionalProperties, false);
  }
});

test("reads are marked read-only and writes are not", () => {
  const readOnly = new Set(["bounty_list", "bounty_read_balances", "bounty_read_history"]);
  for (const entry of bountyTools)
    assert.equal(entry.annotations.readOnlyHint, readOnly.has(entry.name),
      `${entry.name} has the wrong readOnlyHint`);
});

test("required arguments are enforced", () => {
  assert.ok(validBountyToolArguments("bounty_claim", { bountyId: "ROOM-1" }));
  assert.ok(!validBountyToolArguments("bounty_claim", {}));
  assert.ok(!validBountyToolArguments("bounty_claim", { bountyId: "   " }));
  assert.ok(!validBountyToolArguments("bounty_submit", { bountyId: "ROOM-1", summary: "done" }));
  assert.ok(validBountyToolArguments("bounty_submit",
    { bountyId: "ROOM-1", evidenceUrl: "https://example.test/pr/1", summary: "done" }));
});

test("unknown arguments are rejected rather than silently dropped", () => {
  assert.ok(!validBountyToolArguments("bounty_claim", { bountyId: "ROOM-1", confirm: true }));
  assert.ok(!validBountyToolArguments("bounty_list", { group: "open", limit: 10 }));
});

// An amount is the one field that moves credits, so a sign or type error here
// must not reach the escrow.
test("amounts must be positive finite numbers", () => {
  assert.ok(validBountyToolArguments("bounty_transfer", { to: "lane-a", amount: 2.5 }));
  for (const bad of [-1, 0, "5", Number.NaN, Number.POSITIVE_INFINITY])
    assert.ok(!validBountyToolArguments("bounty_transfer", { to: "lane-a", amount: bad }),
      `amount ${String(bad)} must be rejected`);
});

test("enum fields reject values outside the declared set", () => {
  assert.ok(validBountyToolArguments("bounty_list", { group: "open" }));
  assert.ok(!validBountyToolArguments("bounty_list", { group: "everything" }));
  assert.ok(validBountyToolArguments("bounty_read_history", { state: "locked" }));
  assert.ok(!validBountyToolArguments("bounty_read_history", { state: "spent" }));
});

test("the hosted arg validator routes bounty tools through the bounty validator", () => {
  assert.ok(validHostedStdioArgs("bounty_claim", { roomId: "muse-room", bountyId: "ROOM-1" }));
  assert.ok(!validHostedStdioArgs("bounty_claim", { bountyId: "ROOM-1" }));
  assert.ok(!validHostedStdioArgs("bounty_claim", { roomId: "muse-room" }));
  assert.ok(!validHostedStdioArgs("bounty_nonexistent", { roomId: "muse-room" }));
});

// Money-moving tools are the ones a retry can double, so each must offer the
// idempotency key the HTTP routes already accept.
test("every write tool accepts an idempotency key", () => {
  for (const entry of bountyTools) {
    if (entry.annotations.readOnlyHint) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(entry.inputSchema.properties, "idempotencyKey"),
      `${entry.name} needs an idempotencyKey`);
  }
});

// Credits are valueless ledger units. A description that implies cash would
// be the first step toward a surface nobody intended to ship.
test("no tool description promises money", () => {
  // Credits are valueless ledger units. A description may DENY cash value
  // ("no cash value"); what it must never do is promise it.
  const promises = /\b(?<!no )(?:cash out|cash-out|withdraw|paid in (?:cash|dollars|usd)|real money|dollars)\b/i;
  for (const entry of bountyTools) {
    assert.ok(!promises.test(entry.description), `${entry.name} description promises real money`);
    assert.ok(!/\bUSD\b/.test(entry.description), `${entry.name} description names a currency`);
  }
});

test("optional-key writes do not promise unconditional retry safety", () => {
  for (const entry of bountyTools) {
    assert.equal(entry.annotations.idempotentHint, entry.annotations.readOnlyHint);
    if (!entry.annotations.readOnlyHint)
      assert.ok(!entry.inputSchema.required.includes("idempotencyKey"));
  }
});
