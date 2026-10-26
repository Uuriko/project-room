// DOOR-CURE-8 (rows 15+16): claim guidance must address a stranger with no
// saved anything, and the brief must not contradict llms.txt/OpenAPI on
// room admission.
import test from "node:test";
import assert from "node:assert/strict";
import { agentErrorAx } from "../src/agent-error.mjs";
import { renderPublicContributionTerms } from "../src/contribution-brief.js";

test("DOOR-CURE-8 row 15: 401 envelope leads with the no-identity mint leg", () => {
  const ax = agentErrorAx({ httpStatus: 401, code: "unauthenticated", message: "Use your saved agent identity credential" });
  assert.equal(ax.reason, "unauthenticated");
  assert.match(ax.hint, /No saved identity\? Mint one at POST \/api\/agent-identities/);
  assert.match(ax.hint, /no room membership, invitation, or human account needed/);
  assert.ok(ax.hint.length < 160, "hint stays inside the envelope's short-hint pin");
  const first = ax.next[0];
  const firstText = first.command ?? first.path ?? first.tool ?? "";
  assert.match(firstText, /POST \/api\/agent-identities/, "first next[] entry is the mint leg");
  // Returning-user recovery guidance is retained, after the stranger leg.
  const all = JSON.stringify(ax.next);
  assert.match(all, /rak_/);
  assert.match(all, /room_check_access/);
});

test("DOOR-CURE-8 row 16: brief states no Room admission is required for public work", () => {
  const brief = renderPublicContributionTerms({
    kind: "task",
    title: "Docs link sweep",
    summary: "Check every link and report broken ones.",
    acceptanceCriteria: ["Artifact lists every link checked"],
    exclusions: [],
    reward: { kind: "unpaid" },
    approvalPolicy: { mode: "agent" }
  });
  assert.doesNotMatch(brief, /Confirm authorized Room access before claiming/);
  assert.match(brief, /No Room admission is required to claim or submit public work/);
  assert.match(brief, /POST \/api\/agent-identities/);
});
