// PRODUCT-200 docs slice A1: the served /SKILL.md (server/agent-discovery.mjs
// skillMd()) is the recovery contract a stranger reads after a mint 429.
// QA-200 found four drift points here: the minute tier was undocumented, the
// doc said Retry-After: 3600 was always sent (the outer per-address endpoint
// limiter 429s without it, and the minute tier sends 60), the wait location
// was never stated, and only the network tier was named. The UT2 cure made
// Retry-After the true computed wait and put it in the body too
// (retryAfterSeconds + mintBudget). These assert on the rendered skill text
// so a doc edit cannot silently drop a tier or re-introduce the "always 3600" claim.
// Companion to tests/mint-budget-docs.test.js, which covers only
// docs/COLD-AGENT-WALKTHROUGH.md — a different boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { skillMd } from "../server/agent-discovery.mjs";
import {
  ANONYMOUS_ADDRESS_MINUTE_LIMIT,
  ANONYMOUS_ADDRESS_DAILY_LIMIT,
  ANONYMOUS_NETWORK_DAILY_LIMIT,
  ANONYMOUS_MINT_DAILY_LIMIT,
} from "../server/agent-identities.mjs";

const skill = skillMd();

test("served SKILL.md names all four anonymous mint budget tiers and their messages", () => {
  // Exact user-facing messages from server/agent-identities.mjs
  // enforceAnonymousMintLimits().
  assert.ok(skill.includes("Too many identity mints from this address"), "minute-tier message");
  assert.ok(skill.includes("Identity mint address budget reached"), "address-day-tier message");
  assert.ok(skill.includes("Identity mint network budget reached"), "network-day-tier message");
  assert.ok(skill.includes("Identity mint daily budget reached"), "global-day-tier message");
  for (const [name, value] of [
    ["per-address minute", ANONYMOUS_ADDRESS_MINUTE_LIMIT],
    ["per-address day", ANONYMOUS_ADDRESS_DAILY_LIMIT],
    ["per-network day", ANONYMOUS_NETWORK_DAILY_LIMIT],
    ["global day", ANONYMOUS_MINT_DAILY_LIMIT],
  ]) {
    assert.ok(skill.includes(String(value)), `served SKILL.md states the ${name} limit (${value})`);
  }
});

test("served SKILL.md gets Retry-After semantics right per tier", () => {
  // Retry-After is computed per refusal: seconds until the oldest counted
  // mint leaves its rolling window (minute tier at most 60, day tiers up to
  // a day). The old doc's fixed 3600s for the day tiers was the UT2 defect:
  // a caller that waited it out was still refused.
  assert.ok(/Retry-After:?\s*60\b/.test(skill), "names the 60s Retry-After for the outer limiter");
  assert.ok(/true wait in seconds/.test(skill), "states Retry-After is the true computed wait");
  assert.ok(!/Retry-After:?\s*3600\b/.test(skill), "never claims the day tiers send a fixed 3600s Retry-After");
  assert.ok(!/always\s+sends\s+[`']?Retry-After:?\s*3600/.test(skill), "never claims Retry-After: 3600 is always sent");
});

test("served SKILL.md says the wait lives in the header and in the body", () => {
  // Mint 429 refusals carry the wait twice: the Retry-After header and the
  // body's retryAfterSeconds + mintBudget detail (which is also how the
  // value reaches MCP callers, who never see headers).
  assert.ok(/Retry-After/i.test(skill), "names the Retry-After header");
  assert.ok(/header/i.test(skill) && /body/i.test(skill), "contrasts header vs body");
  assert.ok(/retryAfterSeconds/.test(skill), "names the body's retryAfterSeconds field");
  assert.ok(/mintBudget/.test(skill), "names the body's mintBudget scope disclosure");
});

test("served SKILL.md covers the outer per-address limiter 429", () => {
  // The outer per-address endpoint limiter (30/min, "Too many requests; retry
  // after a minute") 429s WITH Retry-After: 60: http.mjs sets it for every 429
  // before the typed headers apply. The doc must not claim the header is absent.
  assert.ok(skill.includes("Too many requests; retry after a minute"), "names the outer limiter message");
  assert.ok(!/NO\s+[`\\']*Retry-After/.test(skill) && !/without\s+a\s+[`\\']*Retry-After/i.test(skill),
    "never claims a 429 arrives without Retry-After");
  assert.ok(/at least 60 seconds/i.test(skill), "gives the 60s wait");
});

test("served SKILL.md documents the invite escape hatch and proof behavior", () => {
  assert.ok(skill.includes("/api/agent-invites/redeem"), "names the invite redeem escape hatch");
  assert.ok(/proof-of-work|proof of work/i.test(skill), "mentions proof-of-work");
  assert.ok(/does not bypass/i.test(skill), "states proof-of-work does not bypass the budgets");
  assert.ok(/re-solve|solve.*again/i.test(skill), "tells the agent to re-solve a stale proof after waiting");
  assert.ok(/rolling/i.test(skill), "mentions the rolling-window refill");
});
