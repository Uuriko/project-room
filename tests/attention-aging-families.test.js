// Charter B-3 step 2, PR2: the remaining clocked families read their
// TTLs from the one aging doctrine (server/attention-aging.mjs), so a
// future doctrine change moves every mechanism's clock together and no
// family can silently fork its own constant again.
import test from "node:test";
import assert from "node:assert/strict";
import { ASK_AGING, DAY_MS } from "../server/attention-aging.mjs";
import { BOND_TTL_MS } from "../server/bonds.mjs";
import { CHALLENGE_WINDOW_MS, CHALLENGE_WINDOW_SMALL_MS, DISPUTE_TIMEOUT_MS } from "../server/bounty-escrow.mjs";

test("bonds and bounty escrow clocks are the doctrine's clocks", () => {
  assert.equal(BOND_TTL_MS, ASK_AGING.bond_proposal.ttlMs);
  assert.equal(BOND_TTL_MS, 7 * DAY_MS);
  assert.equal(CHALLENGE_WINDOW_MS, ASK_AGING.bounty_challenge.ttlMs);
  assert.equal(CHALLENGE_WINDOW_MS, 3 * DAY_MS);
  assert.equal(CHALLENGE_WINDOW_SMALL_MS, ASK_AGING.bounty_challenge_small.ttlMs);
  assert.equal(CHALLENGE_WINDOW_SMALL_MS, 1 * DAY_MS);
  assert.equal(DISPUTE_TIMEOUT_MS, ASK_AGING.bounty_dispute.ttlMs);
  assert.equal(DISPUTE_TIMEOUT_MS, 14 * DAY_MS);
});

test("every doctrine family states its expiry resolution and consequence", () => {
  for (const [name, entry] of Object.entries(ASK_AGING)) {
    assert.ok(entry.escalateAfterMs > 0, `${name} escalates`);
    assert.ok(typeof entry.consequence === "string" && entry.consequence.length > 10, `${name} consequence`);
    if (entry.ttlMs == null) assert.equal(entry.expiry, "none", `${name}: no TTL means no expiry`);
    else assert.notEqual(entry.expiry, "none", `${name}: a TTL must resolve somehow`);
  }
});
