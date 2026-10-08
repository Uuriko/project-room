// Invite-redeem mints must spend the shared anonymous identity-mint budgets
// (per-address/day, per-network/day, global day, proof-of-work gate), exactly
// like /api/identity-create and referral-redeem do. Before the fix,
// store.invites.redeem called identities.create(name) with no anonymous
// param, so a self-issued invite code was the cheapest Sybil mint: burst
// redeeming with an exhausted anonymous budget still returned 201.
// These tests fail on the pre-fix code (redeem succeeds past the budget)
// and pass after redeem() routes through the anonymous limiter with
// limitCode "identity_mint_limited".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { solveIdentityMintProof } from "../server/agent-identities.mjs";

// The HTTP boundary is the owner here: it also proves remoteAddress is
// plumbed into the mint address. A fixed client address keeps the anonymous
// buckets deterministic and isolated from other tests on 127.0.0.1.
const TEST_ADDRESS = "10.20.30.40";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "invite-redeem-anon-limiter-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({
    store,
    resolveClientAddress: req => req.headers["x-test-address"] || TEST_ADDRESS,
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

const post = (origin, path, body, token, address = TEST_ADDRESS) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, "X-Test-Address": address,
    ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));

async function mintCode(origin, ownerKey) {
  const res = await post(origin, "/api/rooms/commons/agent-invites", { permissions: ["accept_work", "complete_work"] }, ownerKey);
  assert.equal(res.status, 201, `mint failed: ${JSON.stringify(res.json)}`);
  return res.json.code;
}

const redeem = (origin, code, displayName, proof) => post(origin, "/api/agent-invites/redeem",
  proof === undefined ? { code, displayName } : { code, displayName, proof });

test("a single legitimate redeem is unaffected by the anonymous mint limiter", { timeout: 60000 }, async t => {
  const { origin, ownerKey } = await serve(t);
  const code = await mintCode(origin, ownerKey);
  const res = await redeem(origin, code, "Legit Redeemer");
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.ok(res.json.identityId, "a fresh identity was minted");
  assert.equal(res.json.roomId, "commons");
});

test("redeem past the proof-free per-address quota without proof answers 428 proof_required", { timeout: 120000 }, async t => {
  const { origin, ownerKey } = await serve(t);
  // 8 proof-free anonymous mints from TEST_ADDRESS, one per redeem.
  for (let i = 0; i < 8; i++) {
    const code = await mintCode(origin, ownerKey);
    const res = await redeem(origin, code, `Sybil Probe ${i + 1}`);
    assert.equal(res.status, 201, `redeem ${i + 1}: ${JSON.stringify(res.json)}`);
  }
  // The 9th redeem without a proof hits the PoW gate (same 428 as
  // /api/identity-create). Pre-fix this minted a fresh identity: 201.
  const code = await mintCode(origin, ownerKey);
  const denied = await redeem(origin, code, "Sybil Probe Nine");
  assert.equal(denied.status, 428, `expected 428, got ${denied.status}: ${JSON.stringify(denied.json)}`);
  assert.equal(denied.json?.error?.code, "proof_required");
});

test("redeem past the per-address minute budget with a valid proof answers 429 identity_mint_limited", { timeout: 120000 }, async t => {
  const { origin, ownerKey } = await serve(t);
  for (let i = 0; i < 8; i++) {
    const code = await mintCode(origin, ownerKey);
    const res = await redeem(origin, code, `Sybil Burst ${i + 1}`);
    assert.equal(res.status, 201, `redeem ${i + 1}: ${JSON.stringify(res.json)}`);
  }
  // The 9th redeem presents a valid proof of work, so the PoW gate passes
  // and the per-address minute budget bites: 429 identity_mint_limited —
  // the same code referral-redeem and identity-create return. Pre-fix this
  // minted a fresh identity: 201.
  const name = "Sybil Burst Nine";
  const code = await mintCode(origin, ownerKey);
  const proof = solveIdentityMintProof(name);
  const limited = await redeem(origin, code, name, proof);
  assert.equal(limited.status, 429, `expected 429, got ${limited.status}: ${JSON.stringify(limited.json)}`);
  assert.equal(limited.json?.error?.code, "identity_mint_limited");
});

test("attaching an existing identity to a redeem spends no anonymous budget", { timeout: 120000 }, async t => {
  const { origin, ownerKey } = await serve(t);
  // Burn the whole proof-free quota plus the minute budget on fresh mints.
  for (let i = 0; i < 8; i++) {
    const code = await mintCode(origin, ownerKey);
    const res = await redeem(origin, code, `Quota Eater ${i + 1}`);
    assert.equal(res.status, 201, `redeem ${i + 1}: ${JSON.stringify(res.json)}`);
  }
  // Mint an identity on a different address (unspent budget) and redeem a
  // fresh code with its credential: no new mint happens, so the exhausted
  // TEST_ADDRESS budget must not block the attached path.
  const created = await post(origin, "/api/agent-identities", { displayName: "Attached Agent" }, null, "10.20.30.99");
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const code = await mintCode(origin, ownerKey);
  const res = await post(origin, "/api/agent-invites/redeem", { code, displayName: "Attached Agent" }, created.json.secret);
  assert.equal(res.status, 201, `attached redeem: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.identityId, created.json.identityId, "the existing identity was reused, not re-minted");
});
