// PRODUCT-200 docs slice A1: the served /SKILL.md (deploy/agent-discovery.mjs
// skillMd()) is the recovery contract a stranger reads after a mint 429.
// QA-200 found four drift points here: the minute tier was undocumented, the
// doc said Retry-After: 3600 was always sent (the outer per-address endpoint
// limiter 429s without it, and the minute tier sends 60), the wait location
// (header only — the body carries no retry time) was never stated, and only
// the network tier was named. These assert on the rendered skill text so a
// doc edit cannot silently drop a tier or re-introduce the "always 3600" claim.
// Companion to tests/mint-budget-docs.test.js, which covers only
// docs/COLD-AGENT-WALKTHROUGH.md — a different boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { skillMd } from "../deploy/agent-discovery.mjs";
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
  // Minute tier sends Retry-After: 60, day tiers send 3600. The old doc claimed
  // "always sends Retry-After: 3600", which is false for the minute tier.
  assert.ok(/Retry-After:?\s*60\b/.test(skill), "names the 60s Retry-After for the minute tier");
  assert.ok(/Retry-After:?\s*3600\b/.test(skill), "names the 3600s Retry-After for the day tiers");
  assert.ok(!/always\s+sends\s+[`']?Retry-After:?\s*3600/.test(skill), "never claims Retry-After: 3600 is always sent");
});

test("served SKILL.md says the wait lives in the header, not the body", () => {
  // Mint 429 bodies are { error: { code, message }, ... } with no retryAfterMs/
  // resetAt (server/service-error.mjs + http.mjs error envelope); the wait is
  // header-only. A stranger must not go hunting for machine-readable fields.
  assert.ok(/Retry-After/i.test(skill), "names the Retry-After header");
  assert.ok(/header/i.test(skill) && /body/i.test(skill), "contrasts header vs body");
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
