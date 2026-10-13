// #2972: the browser identity-mint proof was solved at a fixed 12 bits
// while the server escalates the required difficulty to 16 bits at >=50%
// of the global daily mint budget and 20 bits at >=80% (POW_STEPS in
// server/agent-identities.mjs). A 12-bit proof meets a 16-bit prefix only
// ~1/16 of the time (20-bit ~1/256), and both browser submitters were
// single-shot, so minting failed with no recovery exactly under load.
// The fix: submitters re-solve at the difficulty the 428 proof_required
// body states (its proof.bits) and resubmit, stepping 12 -> 16 -> 20.
import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/client.js";
import * as clientModule from "../src/client.js";
import { verifyIdentityMintProof } from "../server/agent-identities.mjs";

const { submitIdentityMint, escalatedIdentityMintPowBits, solveIdentityMintProof } = clientModule;

const proofRequired = bits => {
  const error = new Error("Identity mint proof required");
  error.code = "proof_required";
  error.status = 428;
  if (bits !== undefined) error.proof = { bits, prefix: "0".repeat(bits / 4) };
  return error;
};

test("submitIdentityMint re-solves at the difficulty each 428 states, 12 -> 16 -> 20", async () => {
  const solvedAt = [], submitted = [];
  const solve = async (name, now, bits) => { solvedAt.push(bits); return `nonce-${bits}`; };
  const submit = async proof => {
    submitted.push(proof);
    if (proof === "nonce-12") throw proofRequired(16);
    if (proof === "nonce-16") throw proofRequired(20);
    return { identityId: "ai_escalated" };
  };
  const minted = await submitIdentityMint("Escalating Agent", submit, solve);
  assert.equal(minted.identityId, "ai_escalated");
  assert.deepEqual(solvedAt, [12, 16, 20], "each refusal re-solves at the stated difficulty");
  assert.deepEqual(submitted, ["nonce-12", "nonce-16", "nonce-20"]);
});

test("submitIdentityMint escalates through the known steps when a 428 states no difficulty", async () => {
  const solvedAt = [];
  const solve = async (name, now, bits) => { solvedAt.push(bits); return `nonce-${bits}`; };
  const submit = async proof => {
    if (proof !== "nonce-20") throw proofRequired(undefined);
    return { identityId: "ai_escalated" };
  };
  const minted = await submitIdentityMint("Escalating Agent", submit, solve);
  assert.equal(minted.identityId, "ai_escalated");
  assert.deepEqual(solvedAt, [12, 16, 20]);
});

test("submitIdentityMint does not retry other failures and stops at the top difficulty", async () => {
  let solves = 0;
  const solve = async () => { solves++; return "nonce"; };
  const limited = new Error("Too many identity mints"); limited.code = "rate_limited"; limited.status = 429;
  await assert.rejects(
    submitIdentityMint("Agent", async () => { throw limited; }, solve),
    error => error === limited);
  assert.equal(solves, 1, "a non-proof failure is submitted once, unchanged");

  solves = 0;
  await assert.rejects(
    submitIdentityMint("Agent", async () => { throw proofRequired(20); }, solve),
    error => error.code === "proof_required");
  assert.equal(solves, 2, "12, then the stated 20, then no higher step exists to try");
});

test("escalatedIdentityMintPowBits trusts only a real escalation from the 428 body", () => {
  assert.equal(escalatedIdentityMintPowBits(proofRequired(16), 12), 16);
  assert.equal(escalatedIdentityMintPowBits(proofRequired(20), 12), 20);
  assert.equal(escalatedIdentityMintPowBits(proofRequired(12), 12), 16, "a restated current difficulty falls through to the next known step");
  assert.equal(escalatedIdentityMintPowBits(proofRequired(18), 12), 16, "a non-step difficulty is not trusted");
  assert.equal(escalatedIdentityMintPowBits(proofRequired(undefined), 16), 20);
  assert.equal(escalatedIdentityMintPowBits(proofRequired(20), 20), null, "nothing above the top step");
  assert.equal(escalatedIdentityMintPowBits(new Error("offline"), 12), 16);
});

test("the browser solver rejects a difficulty the server verifier would never accept", async () => {
  await assert.rejects(solveIdentityMintProof("Agent", Date.now(), 18), /invalid_proof_difficulty/);
  await assert.rejects(solveIdentityMintProof("Agent", Date.now(), 2), /invalid_proof_difficulty/);
});

test("mintAccessIdentity recovers when the server requires 16 bits, verifying with the real solver and verifier", async () => {
  const requiredBits = 16;
  const submitted = [];
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const client = new AccountClient({
    fetcher: async (path, options) => {
      assert.equal(path, "/api/agent-identities");
      assert.equal(options.credentials, "omit");
      const { displayName, proof } = JSON.parse(options.body);
      submitted.push(proof);
      // The escalated server: a proof that does not meet the required
      // difficulty is a 428 whose body names that difficulty.
      if (!verifyIdentityMintProof(displayName, proof, Date.now(), requiredBits)) {
        return response({
          error: { code: "proof_required", message: "Identity mint proof required" },
          proof: { bits: requiredBits, prefix: "0".repeat(requiredBits / 4) },
        }, 428);
      }
      return response({ identityId: "ai_escalated", displayName }, 201);
    },
  });
  const minted = await client.mintAccessIdentity("Escalated Mint Agent");
  assert.equal(minted.identityId, "ai_escalated");
  assert.ok(submitted.length >= 1 && submitted.length <= 2, `expected one base attempt plus at most one escalated retry, got ${submitted.length}`);
  assert.equal(
    verifyIdentityMintProof("Escalated Mint Agent", submitted.at(-1), Date.now(), requiredBits),
    true,
    "the accepted proof meets the escalated 16-bit difficulty, not just the 12-bit base");
});
