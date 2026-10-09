// PRODUCT-200 C3 (429 variants): the mint endpoints' 429 section in
// docs/openapi.yaml was stale — "Per-address creation rate limit; retry
// after a minute" — while the server enforces a 428 PoW gate plus a
// four-tier 429 stack (minute/day address, day network, day global). The
// openapi spec is the agent-facing contract; it must name the tiers, their
// user-facing messages, and the Retry-After semantics. Mirrors the
// mint-budget-docs.test.js pattern for the walkthrough, but this pins the
// openapi spec, which is what agents code against.
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

const spec = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
// Both mint paths must exist in the spec.
for (const path of ["/api/agent-identities", "/api/identity-create"]) {
  assert.ok(spec.includes(path), `spec documents ${path}`);
}

test("openapi mint 429 names the four budget-tier messages", () => {
  for (const message of [
    "Too many identity mints from this address",
    "Identity mint address budget reached",
    "Identity mint network budget reached",
    "Identity mint daily budget reached",
  ]) {
    assert.ok(spec.includes(message), `spec names the 429 message: ${message}`);
  }
});

test("openapi mint 429 states the tier limits and Retry-After semantics", () => {
  for (const [name, value] of [
    ["per-address minute", ANONYMOUS_ADDRESS_MINUTE_LIMIT],
    ["per-address day", ANONYMOUS_ADDRESS_DAILY_LIMIT],
    ["per-network day", ANONYMOUS_NETWORK_DAILY_LIMIT],
    ["global day", ANONYMOUS_MINT_DAILY_LIMIT],
  ]) {
    assert.ok(spec.includes(String(value)), `spec mentions the ${name} limit (${value})`);
  }
  assert.ok(/Retry-After/i.test(spec), "spec names the Retry-After header");
});

test("openapi mint paths document the 428 proof-of-work gate before the 429 tiers", () => {
  assert.ok(/428/.test(spec), "spec documents the 428 proof_required gate");
  assert.ok(
    spec.includes(String(ANONYMOUS_PROOF_FREE_PER_ADDRESS)),
    `spec mentions the ${ANONYMOUS_PROOF_FREE_PER_ADDRESS} proof-free mints per address`
  );
});
