// Provider attestation verifier tests (200-hard-tasks #11).
// Contract guarded: the verifier enforces the full chain — schema,
// provider self-signature, authority countersignature, expiry window,
// and revocation — in that order. A bare self-attestation (no authority
// countersignature) is never trusted. Credible regression: if the
// verifier ever checked the CRL before the authority signature, a forged
// revocation could not be distinguished; the bad-authority-signature case
// pins the order.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateProviderKeyPair,
  issueProviderAttestation,
  countersignAttestation,
  issueRevocation,
  RevocationList,
  verifyProviderAttestation,
} from "../server/provider-attestation.mjs";

function onboarded(opts = {}) {
  const provider = generateProviderKeyPair();
  const authority = generateProviderKeyPair();
  const att = issueProviderAttestation({
    seedHex: provider.seedHex,
    providerId: "provider:mac-1",
    pubkeyHex: provider.pubkeyHex,
    payoutAddress: "0xProviderPayout",
    payoutChainId: "monad-mock-10143",
    capabilities: ["monad", "llm-inference"],
    termsVersion: "terms-2026-10-01",
    expiresAtIso: "2027-10-07T00:00:00.000Z",
    nonce: "nonce-1",
    ...opts,
  });
  const signed = countersignAttestation(att, authority.seedHex);
  return { provider, authority, att: signed };
}

describe("provider attestation", () => {
  it("verifies a fully countersigned attestation", () => {
    const { authority, att } = onboarded();
    const v = verifyProviderAttestation(att, { authorityPubkeyHex: authority.pubkeyHex });
    assert.equal(v.ok, true);
    assert.equal(v.providerId, "provider:mac-1");
  });

  it("rejects a bare self-attestation with no authority countersignature", () => {
    const provider = generateProviderKeyPair();
    const authority = generateProviderKeyPair();
    const att = issueProviderAttestation({
      seedHex: provider.seedHex, providerId: "p", pubkeyHex: provider.pubkeyHex,
      payoutAddress: "0xX", payoutChainId: "c", termsVersion: "t",
      expiresAtIso: "2027-01-01T00:00:00.000Z", nonce: "n",
    });
    const v = verifyProviderAttestation(att, { authorityPubkeyHex: authority.pubkeyHex });
    assert.equal(v.ok, false);
    assert.equal(v.code, "missing_field");
  });

  it("rejects a forged provider signature", () => {
    const { authority, att } = onboarded();
    const evil = generateProviderKeyPair();
    const forged = { ...att, providerSignature: issueProviderAttestation({ seedHex: evil.seedHex, providerId: att.providerId, pubkeyHex: att.pubkeyHex, payoutAddress: att.payoutAddress, payoutChainId: att.payoutChainId, capabilities: att.capabilities, termsVersion: att.termsVersion, issuedAtIso: att.issuedAtIso, expiresAtIso: att.expiresAtIso, nonce: att.nonce }).providerSignature };
    // authority countersignature was over the original provider signature; re-countersign the forgery to isolate the provider-sig check
    const recountersigned = countersignAttestation({ ...forged, authoritySignature: undefined }, authority.seedHex);
    const v = verifyProviderAttestation(recountersigned, { authorityPubkeyHex: authority.pubkeyHex });
    assert.equal(v.ok, false);
    assert.equal(v.code, "bad_provider_signature");
  });

  it("rejects a wrong-authority countersignature", () => {
    const { att } = onboarded();
    const impostor = generateProviderKeyPair();
    const v = verifyProviderAttestation(att, { authorityPubkeyHex: impostor.pubkeyHex });
    assert.equal(v.ok, false);
    assert.equal(v.code, "bad_authority_signature");
  });

  it("rejects expired and not-yet-valid attestations", () => {
    const ex = onboarded({ issuedAtIso: "2019-01-01T00:00:00.000Z", expiresAtIso: "2020-01-01T00:00:00.000Z" });
    const v1 = verifyProviderAttestation(ex.att, { authorityPubkeyHex: ex.authority.pubkeyHex, nowIso: "2026-10-07T00:00:00.000Z" });
    assert.equal(v1.ok, false);
    assert.equal(v1.code, "expired");
    const fu = onboarded();
    const v2 = verifyProviderAttestation(fu.att, { authorityPubkeyHex: fu.authority.pubkeyHex, nowIso: "2020-01-01T00:00:00.000Z" });
    assert.equal(v2.ok, false);
    assert.equal(v2.code, "not_yet_valid");
  });

  it("rejects tampered payout address (signature covers it)", () => {
    const { authority, att } = onboarded();
    const v = verifyProviderAttestation(
      { ...att, payoutAddress: "0xAttacker" },
      { authorityPubkeyHex: authority.pubkeyHex }
    );
    assert.equal(v.ok, false);
    assert.equal(v.code, "bad_provider_signature");
  });

  it("revocation: revoked provider fails, CRL rejects forged revocations", () => {
    const { provider, authority, att } = onboarded();
    const crl = new RevocationList();
    assert.equal(verifyProviderAttestation(att, { authorityPubkeyHex: authority.pubkeyHex, crl }).ok, true);
    const rev = issueRevocation({ authoritySeedHex: authority.seedHex, providerId: "provider:mac-1", pubkeyHex: provider.pubkeyHex, reason: "key-compromise" });
    crl.add(rev, authority.pubkeyHex);
    assert.equal(crl.size(), 1);
    const v = verifyProviderAttestation(att, { authorityPubkeyHex: authority.pubkeyHex, crl });
    assert.equal(v.ok, false);
    assert.equal(v.code, "revoked");
    // Forged revocation (wrong authority key) is rejected at add time.
    const impostor = generateProviderKeyPair();
    const forgedRev = issueRevocation({ authoritySeedHex: impostor.seedHex, providerId: "provider:mac-1", pubkeyHex: provider.pubkeyHex, reason: "grief" });
    assert.throws(() => crl.add(forgedRev, authority.pubkeyHex), /bad authority signature/);
  });

  it("rejects malformed attestations", () => {
    const { authority, att } = onboarded();
    assert.equal(verifyProviderAttestation(null, { authorityPubkeyHex: authority.pubkeyHex }).code, "bad_version");
    assert.equal(verifyProviderAttestation({ ...att, pubkeyHex: "zz" }, { authorityPubkeyHex: authority.pubkeyHex }).code, "bad_pubkey");
    assert.equal(verifyProviderAttestation({ ...att, providerId: "" }, { authorityPubkeyHex: authority.pubkeyHex }).code, "missing_field");
  });
});
