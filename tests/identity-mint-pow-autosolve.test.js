// E5-b (PERF-50): the fresh-agent cold path dead-ends at the mint proof
// cliff. The join kit's mint (client/room-agent.mjs createAgentIdentity,
// used by the resumable join flow in client/agent-setup.mjs) pre-solves a
// proof at the fixed base difficulty, but when the server answers 428
// proof_required — e.g. the escalated difficulty the 428 body itself
// names — the kit threw the refusal away and the join stopped. The cure:
// on 428, solve the recipe the 428 body carries (its prefix, at one of
// its acceptBuckets) and retry exactly once. The retry's proof is checked
// with the server's own verifier (verifyIdentityMintProof) — no difficulty
// is weakened and no gate is bypassed: a nonce that does not meet the
// stated prefix is still refused.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentIdentities, verifyIdentityMintProof } from "../server/agent-identities.mjs";
import { createAgentIdentity, solveIdentityMintProof } from "../client/room-agent.mjs";

const ESCALATED_BITS = 16;

// A display name whose base-difficulty (12-bit) proof does NOT meet the
// escalated 16-bit difficulty, chosen at runtime so the first attempt's
// 428 is deterministic rather than a 15-in-16 coincidence.
function nameWhoseBaseProofMissesEscalated() {
  for (let i = 0; i < 200; i++) {
    const name = `Auto Solve Agent ${i}`;
    const baseProof = solveIdentityMintProof(name);
    if (!verifyIdentityMintProof(name, baseProof, Date.now(), ESCALATED_BITS)) return name;
  }
  assert.fail("no candidate name missed the escalated difficulty");
}

// The 428 body the real server sends: error envelope plus the proof
// recipe at top level (server/http.mjs merges the ServiceError detail).
function challengeBody(displayName, bits) {
  const detail = AgentIdentities.prototype.proofDetail.call(
    { powBits: bits }, displayName.trim(), Date.now(), bits);
  return { error: { code: "proof_required", message: "Identity mint proof required" }, ...detail };
}

test("createAgentIdentity solves the 428 recipe and retries once, verified by the server verifier", async () => {
  const displayName = nameWhoseBaseProofMissesEscalated();
  const attempts = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    attempts.push(body);
    assert.equal(body.displayName, displayName);
    // The stub endpoint is the PoW-demanding tier: it mints only when the
    // presented proof satisfies the escalated difficulty under the
    // server's own verifier.
    if (verifyIdentityMintProof(displayName, body.proof, Date.now(), ESCALATED_BITS)) {
      return Response.json({ identityId: "ai_autosolved", displayName, secret: "pri_stub" }, { status: 201 });
    }
    return Response.json(challengeBody(displayName, ESCALATED_BITS), { status: 428 });
  };
  const minted = await createAgentIdentity("https://room.example", displayName, { fetchImpl });
  assert.equal(minted.identityId, "ai_autosolved");
  assert.equal(attempts.length, 2, "exactly one retry after the 428");
  assert.equal(
    verifyIdentityMintProof(displayName, attempts[1].proof, Date.now(), ESCALATED_BITS),
    true,
    "the retried proof meets the difficulty the 428 body stated");
});

test("createAgentIdentity does not retry a second 428, and does not retry other failures", async () => {
  let calls = 0;
  const alwaysChallenged = async () => {
    calls++;
    return Response.json(challengeBody("Stubborn Agent", ESCALATED_BITS), { status: 428 });
  };
  await assert.rejects(
    createAgentIdentity("https://room.example", "Stubborn Agent", { fetchImpl: alwaysChallenged }),
    error => error.status === 428 && error.code === "proof_required");
  assert.equal(calls, 2, "one initial attempt plus exactly one auto-solve retry");

  calls = 0;
  const limited = async () => {
    calls++;
    return Response.json({ error: { code: "rate_limited", message: "Too many identity mints" } }, { status: 429 });
  };
  await assert.rejects(
    createAgentIdentity("https://room.example", "Limited Agent", { fetchImpl: limited }),
    error => error.status === 429 && error.code === "rate_limited");
  assert.equal(calls, 1, "a non-proof failure is never retried");
});

test("join flow completes against a real PoW-demanding mint endpoint after the free quota tier", async t => {
  const directory = mkdtempSync(join(tmpdir(), "identity-mint-autosolve-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  // The PoW-demanding tier: proof required from the first mint, at the
  // escalated difficulty, with the address budgets otherwise wide open.
  store.identities = new AgentIdentities(store, {
    anonymousDailyLimit: 1000,
    addressDailyLimit: 1000,
    networkDailyLimit: 1000,
    addressMinuteLimit: 1000,
    proofFreePerAddress: 0,
    powBits: ESCALATED_BITS,
  });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const displayName = nameWhoseBaseProofMissesEscalated();
  const minted = await createAgentIdentity(origin, displayName);
  assert.match(minted.secret, /^pri_[A-Za-z0-9_-]{43}$/);
  assert.ok(store.identities.resolveGlobalIdentitySecret(minted.secret),
    "the auto-solved mint is a real identity the server issued and resolves");
});
