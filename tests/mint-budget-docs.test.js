// QA-200 AO-05: a stranger hitting the anonymous mint budget tiers during a
// traffic spike gets 429s that the cold-agent walkthrough never mentions.
// The walkthrough is the onboarding contract; it must name the tiers, their
// user-facing messages, and the Retry-After semantics so a stranger reading
// only the doc is not blindsided.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ANONYMOUS_PROOF_FREE_PER_ADDRESS,
  ANONYMOUS_ADDRESS_MINUTE_LIMIT,
  ANONYMOUS_ADDRESS_DAILY_LIMIT,
  ANONYMOUS_NETWORK_DAILY_LIMIT,
  ANONYMOUS_MINT_DAILY_LIMIT,
} from "../server/agent-identities.mjs";

const doc = readFileSync(new URL("../docs/COLD-AGENT-WALKTHROUGH.md", import.meta.url), "utf8");

test("walkthrough names the four anonymous mint budget tiers", () => {
  // The exact user-facing messages a cold agent will see (server/agent-identities.mjs).
  assert.ok(doc.includes("Too many identity mints from this address"), "minute-tier message");
  assert.ok(doc.includes("Identity mint address budget reached"), "address-day-tier message");
  assert.ok(doc.includes("Identity mint network budget reached"), "network-day-tier message");
  assert.ok(doc.includes("Identity mint daily budget reached"), "global-day-tier message");
});

test("walkthrough states the tier limits and that PoW does not bypass them", () => {
  for (const [name, value] of [
    ["proof-free per address", ANONYMOUS_PROOF_FREE_PER_ADDRESS],
    ["per-address minute", ANONYMOUS_ADDRESS_MINUTE_LIMIT],
    ["per-address day", ANONYMOUS_ADDRESS_DAILY_LIMIT],
    ["per-network day", ANONYMOUS_NETWORK_DAILY_LIMIT],
    ["global day", ANONYMOUS_MINT_DAILY_LIMIT],
  ]) {
    assert.ok(doc.includes(String(value)), `walkthrough mentions the ${name} limit (${value})`);
  }
  assert.ok(/429/.test(doc), "walkthrough names the 429 status for budget exhaustion");
  assert.ok(/Retry-After/i.test(doc), "walkthrough names the Retry-After semantics");
  assert.ok(
    /proof-of-work does (?:\*\*)?not(?:\*\*)? bypass|PoW does not bypass/i.test(doc),
    "walkthrough says a valid proof does not bypass the budgets"
  );
});
