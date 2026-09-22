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

// Migration aid for pre-existing tests that complete work as setup rather
// than testing evidence itself: issues a real identity on the store and
// returns a signer closure. Each call mints a FRESH evidence object (unique
// evidenceId, so replay dedup never fires), with issuedAt taken from the
// store's own clock so fake-clock tests stay inside the key validity window.
// Usage: const sign = makeTestSigner(f.store); ... signedEvidence: sign()
export function makeTestSigner(store) {
  const identity = issueTestIdentity(store);
  return (overrides = {}) => signTestEvidence(identity, {
    issuedAt: new Date(store.now()).toISOString(),
    ...overrides,
  });
}
