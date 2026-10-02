import { createHash } from "node:crypto";

export function solveIdentityMintProof(displayName, now = Date.now()) {
  const name = displayName.trim();
  const bucket = Math.floor(now / 600000);
  for (let i = 0; i < 1000000; i++) {
    const nonce = i.toString(36);
    if (createHash("sha256").update(`${bucket}:${name}:${nonce}`).digest("hex").startsWith("000")) return nonce;
  }
  throw new Error("proof search exhausted");
}
