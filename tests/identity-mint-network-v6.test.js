// Anonymous identity mint network buckets for bracketed IPv6 (research r176).
//
// Authoring gate:
// 1. The production resolvers (cloudflare/room.mjs, and server/deployment.mjs
//    behind the trusted local proxy) pass IPv6 visitors as URL hostnames, with
//    brackets. Those callers must get the documented /64 network bucket
//    (docs/openapi.yaml: "80 mints per 24 hours per egress network (/24 IPv4,
//    /64 IPv6)"), not one "unknown" bucket shared by every IPv6 caller.
// 2. Dropping the bracket handling in mintNetworkPrefix fails these tests.
// 3. tests/identity-mint-capacity.test.js covers unbracketed IPv6 only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentIdentities, anonymousMintBuckets, mintNetworkPrefix } from "../server/agent-identities.mjs";

// The exact shape cloudflare/room.mjs resolveClientAddress returns for IPv6.
const workerAddress = address => new URL(`http://[${address}]`).hostname;

test("bracketed IPv6 visitor addresses map to their /64", () => {
  assert.equal(workerAddress("2001:DB8:1:2::1"), "[2001:db8:1:2::1]");
  assert.equal(mintNetworkPrefix(workerAddress("2001:db8:1:2::1")), "2001:0db8:0001:0002::/64");
  assert.equal(mintNetworkPrefix(workerAddress("2001:db8:1:2::1")), mintNetworkPrefix("2001:db8:1:2::1"));
  assert.notEqual(anonymousMintBuckets(workerAddress("2001:db8:1:2::1")).network, anonymousMintBuckets(workerAddress("2a00:1450:4001:81c::1")).network);
  assert.equal(anonymousMintBuckets(workerAddress("2001:db8:1:2::1")).network, anonymousMintBuckets(workerAddress("2001:db8:1:2:ffff::9")).network);
  assert.notEqual(mintNetworkPrefix(workerAddress("2001:db8:1:2::1")), "unknown");
  assert.equal(mintNetworkPrefix("[not-an-ip]"), "unknown");
  assert.equal(mintNetworkPrefix("[203.0.113.7]"), "203.0.113.0/24");
  // The per-address bucket is unchanged by this fix (no stored hash moves).
  assert.notEqual(anonymousMintBuckets("[2001:db8:1:2::1]").address, anonymousMintBuckets("2001:db8:1:2::1").address);
});

test("Worker-shaped IPv6 mints from two networks do not share one budget", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  const directory = mkdtempSync(join(tmpdir(), "identity-mint-v6-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  try {
    store.initialize(initialRoom("commons"));
    const ids = new AgentIdentities(store, {
      anonymousDailyLimit: 30, addressDailyLimit: 30, networkDailyLimit: 1, addressMinuteLimit: 30, proofFreePerAddress: 30,
    });
    const anon = address => ({ anonymous: { address } });
    assert.equal(ids.create("Net A", anon(workerAddress("2001:db8:1:2::1"))).displayName, "Net A");
    // A different /64 (a different caller entirely) still has its own budget.
    assert.equal(ids.create("Net B", anon(workerAddress("2a00:1450:4001:81c::1"))).displayName, "Net B");
    // Rotating inside the first /64 is still refused by the network budget.
    let refused = null;
    try { ids.create("Net A2", anon(workerAddress("2001:db8:1:2::abcd"))); } catch (error) { refused = error; }
    assert.ok(refused, "a second mint from the same /64 was accepted");
    assert.equal(refused.status, 429);
    assert.match(refused.message, /network budget/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
