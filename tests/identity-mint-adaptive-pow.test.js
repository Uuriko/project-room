// Adaptive anonymous-mint proof difficulty and the capacity alert.
//
// Authoring gate:
// 1. Below HEAVY_NETWORK_MINTS mints from the network, or below 50% of the
//    global budget, the base 12-bit proof is enough (hard-coded clients keep
//    working). A heavy network at 50% of the global budget needs 16 bits, at
//    80% 20 bits; the 428 detail names the bits and a proof at the old bits is
//    refused. The operator alert fires once per hour from 80% of the budget.
// 2. Dropping the heavy-network condition, a step, the verify-at-required-bits
//    change, or the alert fails these tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentIdentities, HEAVY_NETWORK_MINTS, IDENTITY_POW_BITS, IDENTITY_POW_WINDOW_MS, requiredPowBits } from "../server/agent-identities.mjs";

const now = Date.parse("2026-06-01T00:00:00Z");

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "identity-adaptive-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function solve(name, bits) {
  const bucket = Math.floor(now / IDENTITY_POW_WINDOW_MS), prefix = "0".repeat(bits / 4);
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (createHash("sha256").update(`${bucket}:${name}:${nonce}`).digest("hex").startsWith(prefix)) return nonce;
  }
}

function refusal(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail("expected a refusal");
}

const ids = (store, overrides = {}) => new AgentIdentities(store, {
  anonymousDailyLimit: 20, addressDailyLimit: 100, networkDailyLimit: 100, addressMinuteLimit: 100, proofFreePerAddress: 100, ...overrides });

test("requiredPowBits steps up only for heavy networks at 50% and 80%", () => {
  const at = (globalDay, networkDay) => requiredPowBits(12, { globalDay, globalLimit: 200, networkDay });
  assert.equal(at(99, 50), 12);
  assert.equal(at(100, HEAVY_NETWORK_MINTS), 16);
  assert.equal(at(159, 50), 16);
  assert.equal(at(160, 50), 20);
  assert.equal(at(190, HEAVY_NETWORK_MINTS - 1), 12);
});

test("a heavy network pays 16 bits at half the budget and 12-bit proofs are refused there", t => {
  const store = openStore(t), alerts = [];
  const identities = ids(store, { capacityAlert: message => alerts.push(message) });
  // 10 mints from one /24 plus 2 elsewhere: 12 of 20 is 60% of the global budget.
  for (let i = 0; i < HEAVY_NETWORK_MINTS; i++) identities.create(`Heavy ${i}`, { anonymous: { address: `198.51.100.${i + 1}`, requireProof: false } });
  for (let i = 0; i < 2; i++) identities.create(`Light ${i}`, { anonymous: { address: `203.0.113.${i + 1}`, requireProof: false } });
  assert.equal(alerts.length, 0);
  const low = refusal(() => identities.create("Heavy Low", { anonymous: { address: "198.51.100.200", proof: solve("Heavy Low", IDENTITY_POW_BITS) } }));
  assert.equal(low.status, 428);
  assert.equal(low.detail.proof.bits, 16);
  assert.equal(low.detail.proof.prefix, "0000");
  const created = identities.create("Heavy High", { anonymous: { address: "198.51.100.200", proof: solve("Heavy High", 16) } });
  assert.match(created.secret, /^pri_/);
  // A network with few mints keeps the base difficulty at the same global usage.
  const light = identities.create("Light Base", { anonymous: { address: "192.0.2.9", proof: solve("Light Base", IDENTITY_POW_BITS) } });
  assert.match(light.secret, /^pri_/);
});

test("the capacity alert fires from 80% and at most once an hour", t => {
  const store = openStore(t), alerts = [];
  const identities = ids(store, { capacityAlert: message => alerts.push(message), anonymousDailyLimit: 10, networkDailyLimit: 100 });
  for (let i = 0; i < 8; i++) identities.create(`Fill ${i}`, { anonymous: { address: `198.51.${i}.1`, requireProof: false } });
  assert.equal(alerts.length, 0, "7 of 10 recorded before the 8th mint; below 80%");
  identities.create("Fill 8", { anonymous: { address: "198.52.0.1", requireProof: false } });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /\[capacity\] anonymous identity mints 8\/10/);
  const refused = refusal(() => { identities.create("Fill 9", { anonymous: { address: "198.53.0.1", requireProof: false } }); identities.create("Fill 10", { anonymous: { address: "198.54.0.1", requireProof: false } }); });
  assert.equal(refused.status, 429);
  assert.equal(alerts.length, 1, "same hour: no repeat");
});
