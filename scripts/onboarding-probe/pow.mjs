// Remote copy of the identity-mint proof search.
// scripts/onboarding-probe keeps this equal to solveIdentityMintProof in
// server/agent-identities.mjs. Loopback runs import that function instead.
import { createHash } from "node:crypto";

const BITS = 12;
const WINDOW_MS = 10 * 60 * 1000;

export function solveIdentityMintProofRemote(displayName, now = Date.now(), bits = BITS) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  const bucket = Math.floor(now / WINDOW_MS);
  const prefix = "0".repeat(bits / 4);
  for (let i = 0; i < 1_000_000; i++) {
    const nonce = i.toString(36);
    const hex = createHash("sha256").update(`${bucket}:${name}:${nonce}`).digest("hex");
    if (hex.startsWith(prefix)) return nonce;
  }
  throw new Error("proof search exhausted");
}
