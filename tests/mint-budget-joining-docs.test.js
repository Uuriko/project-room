// MINT-BUDGET Pack 1 (D4): the joining path itself must disclose the mint
// budgets. tests/mint-budget-docs.test.js asserts only on
// docs/COLD-AGENT-WALKTHROUGH.md and tests/mint-429-skill-guidance.test.js
// only on skillMd() — neither touches llmsTxt(), llmsFullTxt(), or
// /docs/agents, which is exactly how the packet stayed silent while the
// suite stayed green (USER-TEST ROUND 3 headline defect). These assertions
// cover the surfaces a joining agent actually reads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { llmsTxt, llmsFullTxt, skillMd } from "../server/agent-discovery.mjs";

const full = llmsFullTxt();
const short = llmsTxt();
const guideIndex = readFileSync(new URL("../docs/agents/index.md", import.meta.url), "utf8");
const guidePaste = readFileSync(new URL("../docs/agents/paste.md", import.meta.url), "utf8");

test("full joining packet names all four mint budget tiers verbatim", () => {
  assert.ok(full.includes("Mint budgets — read this before a group joins"), "packet budget heading");
  assert.ok(full.includes("Too many identity mints from this address"), "minute-tier message");
  assert.ok(full.includes("Identity mint address budget reached"), "address-day-tier message");
  assert.ok(full.includes("Identity mint network budget reached"), "network-day-tier message");
  assert.ok(full.includes("Identity mint daily budget reached"), "global-day-tier message");
  assert.ok(full.includes("80 per day per network"), "network tier figure");
  assert.ok(full.includes("200 per day in total"), "global tier figure");
});

test("full joining packet explains the wait and the non-mint alternatives", () => {
  assert.ok(full.includes("retryAfterSeconds"), "names retryAfterSeconds");
  assert.ok(full.includes("mintBudget"), "names mintBudget");
  assert.ok(full.includes("Retry-After"), "names the Retry-After header");
  assert.ok(full.includes("reuse it: reuse spends no budget"), "reuse spends no budget");
  assert.ok(full.includes("POST /api/agent-invites/redeem"), "invite redemption route");
  assert.ok(full.includes("re-solve the proof first"), "proof re-solve warning");
});

test("short packet points at the budget before a group joins", () => {
  assert.ok(/budget/i.test(short), "short packet mentions budget");
  assert.ok(
    short.includes("Minting is budgeted per address, per network and globally over a rolling 24 hours — see the full packet before a group joins from one network."),
    "short packet carries the pointer sentence verbatim"
  );
});

test("served guide sources carry the group-joining budget note", () => {
  assert.ok(guideIndex.includes("Joining as a group? Read this first."), "guide group-joining heading");
  assert.ok(guideIndex.includes("80 per day from one network"), "guide names the 80/network figure");
  assert.ok(guideIndex.includes("200 per day in total"), "guide names the global figure");
  assert.ok(
    guidePaste.includes("If the agent reports a 429 identity-mint budget, that is a shared 24-hour network budget, not a connection failure — see the guide's group-joining note."),
    "paste page carries the budget sentence verbatim"
  );
});

test("skill invite sentence tells the truth about the global budget (D0)", () => {
  const skill = skillMd();
  assert.ok(!skill.includes("skips the anonymous mint budgets entirely"), "false sentence is gone");
  assert.ok(
    skill.includes("redeeming an agent invite code skips the per-minute, per-address and per-network budgets and needs no proof, but it spends the shared global budget (200/day) and fails once that is spent. Redeeming a referral link does not skip any budget."),
    "corrected sentence verbatim"
  );
});
