// Agent-card honesty guard (PRODUCT-200 HP-02).
//
// The served A2A agent card is the product's handshake with the outside
// world. It must never promise payouts, users, or traction the product does
// not have. These invariants stay true under any copy rewording:
//
//  1. The honest sentence: the card says, in some words, that work earns
//     reputation receipts only — never cash, never a payout path.
//  2. No payout promises: no dollar amounts, no USDC paydays, no "get paid"
//     language anywhere in the card.
//  3. No traction claims: no users/customers/MAU/traction/funding language
//     anywhere in the card.
//
// If a future copy change breaks one of these, this test goes red BEFORE the
// card ships — the fail-first proof runs against a mutated (lying) card.
import test from "node:test";
import assert from "node:assert/strict";
import { agentCard } from "../deploy/agent-discovery.mjs";

// The honest sentence, in any wording: reputation + receipts-only framing.
const HONESTY_HINTS = [/reputation/i, /receipt/i, /not cash/i, /no real-value/i];

// Payout promises the card must never carry.
const PAYOUT_WORDS = [
  /\bget paid\b/i,
  /\bearn\b.{0,20}\b(USDC|usd|cash)\b/i,
  /\bcash payout\b/i,
  /\bpayout path\b(?! exists yet)/i,
  /\$\d/,
  /\bUSDC\b.{0,40}\b(real|guaranteed|instant)\b/i,
];

// Traction/user claims the card must never carry.
const TRACTION_WORDS = [
  /\busers\b/i,
  /\btraction\b/i,
  /\bcustomers\b/i,
  /\binvestors\b/i,
  /\bfunding\b/i,
  /\bMAU\b/,
  /\bDAU\b/,
  /\bmillion\b/i,
];

function proseOf(card) {
  const parts = [card.name, card.description];
  for (const skill of card.skills ?? []) parts.push(skill.name, skill.description);
  for (const tier of card.join ?? []) parts.push(tier.summary);
  return parts.filter(Boolean).join("\n");
}

function honestyIssues(card) {
  const issues = [];
  const prose = proseOf(card);
  const honestyCount = HONESTY_HINTS.filter((re) => re.test(prose)).length;
  if (honestyCount < 2) {
    issues.push(`honesty sentence missing: fewer than 2 honesty hints matched (got ${honestyCount})`);
  }
  for (const re of PAYOUT_WORDS) {
    if (re.test(prose)) issues.push(`payout promise in card prose: ${re}`);
  }
  for (const re of TRACTION_WORDS) {
    if (re.test(prose)) issues.push(`traction claim in card prose: ${re}`);
  }
  return issues;
}

test("agent card carries the honest money sentence (reputation receipts only, no cash)", () => {
  const card = agentCard();
  assert.equal(typeof card.description, "string", "card needs a description");
  for (const hint of [/reputation/i, /receipt/i]) {
    assert.ok(hint.test(card.description), `description missing honesty hint ${hint}`);
  }
});

test("agent card makes no payout promises and no traction claims", () => {
  const issues = honestyIssues(agentCard());
  assert.deepEqual(issues, [], `card prose must be honest:\n${issues.join("\n")}`);
});

test("the guard actually fires on a dishonest card (fail-first proof)", () => {
  const honest = agentCard();
  const lying = {
    ...honest,
    description:
      "Get paid in USDC for your work! Millions of users already earn here. " +
      "Real amounts with instant payout — $50 per task, guaranteed.",
  };
  const issues = honestyIssues(lying);
  assert.ok(issues.length >= 3, `expected the guard to catch payout+traction lies, got: ${JSON.stringify(issues)}`);
  assert.deepEqual(honestyIssues(honest), [], "honest card must stay green");
});
