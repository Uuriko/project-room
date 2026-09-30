// Public claim registry — the ONE public verb (John's directive 2026-09-30).
//
// "we already have three doors open and nothing worth walking through...
//  there's no public verb anywhere, so an outside agent can read everything
//  about us and do nothing. so i wouldn't build a new api, i'd open one verb.
//  and the verb worth selling isn't chat or files, those are commodity, it's
//  the claim. two agents on one repo and neither steps on the other, with a
//  lease that expires and a receipt at the end that a third party can check.
//  nobody else sells that. escrow hangs off the same receipt, which is the
//  bounty work already in flight."
//
// A claim is a public coordination primitive: any agent (with an identity,
// but WITHOUT room membership) can claim a task scope, hold an expiring
// lease, and produce a third-party-verifiable receipt on completion.
//
// This is NOT the room-scoped work-claims (server/work-claims.mjs) — those
// require room membership. This is PUBLIC: the verb that makes the three
// doors (MCP, HTTP, A2A) worth walking through.
//
// Lease model:
// - Claims have a lease (default 6h, max 72h) that expires automatically.
// - Expiry is evaluated on every read — no sweeper needed.
// - Expired claims auto-release with a history entry.
// - Heartbeat renews the lease (claimant only).
//
// Receipt model (AIUNION schema):
// - On complete, a signed receipt is issued (Ed25519).
// - Receipts are immutable and publicly verifiable.
// - Escrow/bounty settlement hangs off the receipt.
//
// Security:
// - Writes require a valid agent identity (Bearer token), but NO room.
// - Reads (list, get, receipt verify) are fully public — no auth.
// - Rate-limited per identity (inherited from http.mjs rate limiter).
// - Claim scopes are advisory (like the GitHub board) — they coordinate,
//   they don't enforce. The receipt is the proof.

import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_LEASE_HOURS = 6;
const MAX_LEASE_HOURS = 72;

class ClaimError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClaimError";
    this.code = code;
  }
}

// In-memory registry (per-process). A future slice persists to store.mjs.
// The GitHub board (#1160) remains the swarm's coordination surface;
// this is the PUBLIC verb for outside agents.
export function createPublicClaimRegistry() {
  const claims = new Map(); // claimId -> claim
  const receipts = new Map(); // receiptId -> receipt
  const byTask = new Map(); // taskId -> claimId (for duplicate detection)

  // Server keypair for receipt signing (per-process; a future slice uses
  // the room's signing key from custody).
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const now = () => Date.now();

  const isExpired = (claim) => {
    return claim.state === "active" && claim.leaseExpiresAt <= now();
  };

  const expireIfNeeded = (claim) => {
    if (isExpired(claim)) {
      claim.state = "expired";
      claim.history.push({
        at: now(),
        action: "expired",
        note: "Lease expired; claim auto-released.",
      });
      // Free the task slot
      if (byTask.get(claim.taskId) === claim.id) {
        byTask.delete(claim.taskId);
      }
    }
    return claim;
  };

  const publicClaim = (claim) => {
    // Public view: no identity secrets, no internal notes.
    const { id, taskId, claimant, scope, leaseExpiresAt, state, createdAt, completedAt, receiptId } = claim;
    return Object.freeze({
      id, taskId, claimant: { id: claimant.id, displayName: claimant.displayName },
      scope, leaseExpiresAt, state, createdAt, completedAt: completedAt ?? null,
      receiptId: receiptId ?? null,
    });
  };

  return {
    // Create a claim. Requires: taskId, claimant {id, displayName}, scope.
    // Optional: leaseHours (default 6, max 72), intent.
    create({ taskId, claimant, scope, leaseHours, intent }) {
      if (!taskId || typeof taskId !== "string" || taskId.length > 128) {
        throw new ClaimError("invalid_claim_input", "taskId must be a non-empty string (max 128).");
      }
      if (!claimant || !claimant.id || !claimant.displayName) {
        throw new ClaimError("invalid_claim_input", "claimant must have id and displayName.");
      }
      if (!scope || typeof scope !== "object") {
        throw new ClaimError("invalid_claim_input", "scope must be an object describing the work.");
      }
      const hours = leaseHours ?? DEFAULT_LEASE_HOURS;
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_LEASE_HOURS) {
        throw new ClaimError("invalid_claim_input", `leaseHours must be >0 and <=${MAX_LEASE_HOURS}.`);
      }

      // Duplicate guard: one active claim per taskId.
      const existingId = byTask.get(taskId);
      if (existingId) {
        const existing = claims.get(existingId);
        if (existing && expireIfNeeded(existing).state === "active") {
          throw new ClaimError("claim_conflict", `Task ${taskId} is already claimed by ${existing.claimant.displayName} (lease expires ${new Date(existing.leaseExpiresAt).toISOString()}).`);
        }
        // Expired — free the slot.
        byTask.delete(taskId);
      }

      const id = `pc_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = now();
      const claim = {
        id,
        taskId,
        claimant: { id: claimant.id, displayName: claimant.displayName },
        scope: Object.freeze({ ...scope }),
        intent: intent ?? null,
        leaseExpiresAt: createdAt + hours * 3600 * 1000,
        state: "active",
        createdAt,
        completedAt: null,
        receiptId: null,
        history: [{ at: createdAt, action: "claimed", note: intent ?? "Claim created." }],
      };
      claims.set(id, claim);
      byTask.set(taskId, id);
      return publicClaim(claim);
    },

    // Get a claim by ID (public). Auto-expires if needed.
    get(id) {
      if (!CLAIM_ID_PATTERN.test(id)) return null;
      const claim = claims.get(id);
      if (!claim) return null;
      return publicClaim(expireIfNeeded(claim));
    },

    // List active claims (public). Optionally filter by taskId prefix.
    list({ taskPrefix } = {}) {
      const result = [];
      for (const claim of claims.values()) {
        expireIfNeeded(claim);
        if (claim.state !== "active") continue;
        if (taskPrefix && !claim.taskId.startsWith(taskPrefix)) continue;
        result.push(publicClaim(claim));
      }
      // Newest first.
      result.sort((a, b) => b.createdAt - a.createdAt);
      return Object.freeze(result);
    },

    // Heartbeat: renew the lease (claimant only).
    heartbeat(id, claimantId) {
      const claim = claims.get(id);
      if (!claim || !CLAIM_ID_PATTERN.test(id)) {
        throw new ClaimError("not_found", "Claim not found.");
      }
      expireIfNeeded(claim);
      if (claim.state !== "active") {
        throw new ClaimError("claim_not_active", `Claim is ${claim.state}, not active.`);
      }
      if (claim.claimant.id !== claimantId) {
        throw new ClaimError("not_authorized", "Only the claimant can heartbeat this claim.");
      }
      // Renew for the default lease duration from now.
      claim.leaseExpiresAt = now() + DEFAULT_LEASE_HOURS * 3600 * 1000;
      claim.history.push({ at: now(), action: "heartbeat", note: "Lease renewed." });
      return publicClaim(claim);
    },

    // Release: give up the claim early (claimant only).
    release(id, claimantId, note) {
      const claim = claims.get(id);
      if (!claim || !CLAIM_ID_PATTERN.test(id)) {
        throw new ClaimError("not_found", "Claim not found.");
      }
      expireIfNeeded(claim);
      if (claim.state !== "active") {
        throw new ClaimError("claim_not_active", `Claim is ${claim.state}, not active.`);
      }
      if (claim.claimant.id !== claimantId) {
        throw new ClaimError("not_authorized", "Only the claimant can release this claim.");
      }
      claim.state = "released";
      claim.history.push({ at: now(), action: "released", note: note ?? "Released by claimant." });
      if (byTask.get(claim.taskId) === id) byTask.delete(claim.taskId);
      return publicClaim(claim);
    },

    // Complete: finish with a signed receipt (claimant only).
    complete(id, claimantId, { summary, evidenceUrl, resultHash }) {
      const claim = claims.get(id);
      if (!claim || !CLAIM_ID_PATTERN.test(id)) {
        throw new ClaimError("not_found", "Claim not found.");
      }
      expireIfNeeded(claim);
      if (claim.state !== "active") {
        throw new ClaimError("claim_not_active", `Claim is ${claim.state}, not active.`);
      }
      if (claim.claimant.id !== claimantId) {
        throw new ClaimError("not_authorized", "Only the claimant can complete this claim.");
      }
      if (!summary || typeof summary !== "string" || summary.length > 5000) {
        throw new ClaimError("invalid_claim_input", "summary must be a non-empty string (max 5000).");
      }

      const completedAt = now();
      const receiptId = `rcpt_${completedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      // Build the receipt (AIUNION schema shape).
      const receipt = {
        receiptId,
        schemaVersion: "agent-receipt/v1",
        claimId: id,
        taskId: claim.taskId,
        issuer: { id: claim.claimant.id, displayName: claim.claimant.displayName },
        scope: claim.scope,
        summary,
        evidenceUrl: evidenceUrl ?? null,
        resultHash: resultHash ?? null,
        startedAt: claim.createdAt,
        completedAt,
        // Signatures added below.
      };

      // Sign with the server Ed25519 key (null algorithm = pure Ed25519).
      const payload = JSON.stringify(receipt);
      const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
      receipt.signatures = Object.freeze([{
        algorithm: "Ed25519",
        publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
        signature,
        signedAt: completedAt,
      }]);
      Object.freeze(receipt);

      receipts.set(receiptId, receipt);

      claim.state = "completed";
      claim.completedAt = completedAt;
      claim.receiptId = receiptId;
      claim.history.push({ at: completedAt, action: "completed", note: summary.slice(0, 200) });
      if (byTask.get(claim.taskId) === id) byTask.delete(claim.taskId);

      return { claim: publicClaim(claim), receipt };
    },

    // Get a receipt by ID (public, no auth). Returns the receipt + verification.
    getReceipt(receiptId) {
      const receipt = receipts.get(receiptId);
      if (!receipt) return null;
      // Verify the signature.
      const { signatures, ...unsigned } = receipt;
      const payload = JSON.stringify(unsigned);
      const sig = signatures[0];
      try {
        const pubKey = createPublicKey({
          key: Buffer.from(sig.publicKey, "base64url"),
          type: "spki",
          format: "der",
        });
        const valid = verify(null, Buffer.from(payload), pubKey, Buffer.from(sig.signature, "base64url"));
        return { receipt, verified: valid };
      } catch {
        return { receipt, verified: false };
      }
    },

    // For testing: clear all.
    _clear() {
      claims.clear();
      receipts.clear();
      byTask.clear();
    },

    // For testing: get the server public key.
    _serverPublicKey() {
      return publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    },
  };
}

export { ClaimError };
