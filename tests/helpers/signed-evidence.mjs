// Test helper: sign external evidence for work.completed completions.
// Uses the room's real identity issuance + key registry, so tests exercise
// the same trust root as production.
import { issueSignedEvidence, contentHashOf } from "../../server/signed-evidence.mjs";

export function issueTestIdentity(store, displayName = "Test Evidence Agent") {
  const created = store.identities.create(displayName);
  return { ...created, seedHex: Buffer.from(created.privateKey, "base64").toString("hex") };
}

export function signTestEvidence(identity, overrides = {}) {
  return issueSignedEvidence({
    signerIdentityId: identity.identityId,
    issuedAt: new Date().toISOString(),
    contentHash: contentHashOf("test-external-bytes"),
    seedHex: identity.seedHex,
    ...overrides,
  });
}
