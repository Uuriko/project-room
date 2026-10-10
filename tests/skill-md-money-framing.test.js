import test from "node:test";
import assert from "node:assert/strict";
import { skillMd, llmsTxt, llmsFullTxt, agentCardJson } from "../deploy/agent-discovery.mjs";

// PRODUCT-200 HP-05: money framing across the served agent documents.
// Audit result (2026-10-09): agent-card.json's description is honest
// ("work currently earns reputation receipts only — ... no real-value payout
// path exists yet"), while /SKILL.md promises "claim it, do it, and get paid"
// and frames USDC bounties as "real amounts with the owner's standing
// authority behind them" ("The amounts are committed"). Both framings are
// documented verbatim in the failing assertion below; resolving the
// contradiction is John's call, not a worker's. This test cannot go green
// until one framing wins and both documents agree.

function honestOnlySentence() {
  return /work currently earns reputation receipts only/i;
}

test("one true money story: SKILL.md and agent-card.json agree on whether real-value payouts exist", () => {
  const skill = skillMd();
  const cardDescription = JSON.parse(agentCardJson()).description;
  const skillCarriesHonestSentence = honestOnlySentence().test(skill);
  const cardCarriesHonestSentence = honestOnlySentence().test(cardDescription);
  assert.equal(
    skillCarriesHonestSentence,
    cardCarriesHonestSentence,
    [
      "SKILL.md vs agent-card.json USDC contradiction (HP-05 audit, 2026-10-09; flagged for John's call, not resolved here):",
      "- agent-card.json: 'Payment is honest here: work currently earns reputation receipts only — bounties and escrow settle ledger credits, not cash, and no real-value payout path exists yet.'",
      "- /SKILL.md frontmatter: 'Find real work in Uuriko Project Room, claim it, do it, and get paid.'",
      "- /SKILL.md body: 'Project Room is where agents find work and get paid.' / 'B. Paid bounty offers. These carry real amounts:'",
      "- /SKILL.md Money honesty: 'Cash bounties — offers denominated in USDC are real amounts with the owner's standing authority behind them' ... 'The amounts are committed; the timing is the owner's tap.'",
      "Both documents are built from deploy/agent-discovery.mjs (skillMd() / agentCard()). John's call decides which framing survives; the other side must be edited to match.",
    ].join("\n"),
  );
});

test("served agent docs keep the money caveats agents rely on", () => {
  const skill = skillMd();
  const text = llmsTxt();
  const full = llmsFullTxt();
  // llms.txt public-work section: volunteer work is not funded assignments.
  assert.match(text, /proposed credits\/cash are not funded assignments/);
  // SKILL.md: the Money honesty section stays present with the rail caveat.
  assert.match(skill, /## Money honesty/);
  assert.match(skill, /the payout rail is not yet configured/i);
  assert.match(skill, /no cash-out/i);
  // llms-full.txt carries the same public-work caveat.
  assert.match(full, /proposed credits\/cash are not funded assignments/);
});
