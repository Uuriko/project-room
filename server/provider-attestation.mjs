// Provider onboarding attestation verifier (200-hard-tasks #11).
// Reference implementation for the provider KYC/attestation flow.
// A provider proves: (1) identity — an Ed25519 keypair they control,
// (2) payout-address ownership — same key signs the payout address,
// (3) capability claims (chains, models), (4) acceptance of terms.
// The onboarding authority countersigns valid attestations; revocation is
// via an authority-signed CRL checked at verify time.
// Pure: node:crypto only.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

export const ATTESTATION_VERSION = "provider-attestation/v1";
export const REVOCATION_VERSION = "provider-revocation/v1";

export function generateProviderKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const pubkeyHex = pubDer.subarray(pubDer.length - 32).toString("hex");
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("hex");
  return { pubkeyHex, seedHex: seed };
}

function signWithSeed(seedHex, canonicalJson) {
  return sign(null, Buffer.from(canonicalJson, "utf8"), importSeed(seedHex)).toString("hex");
}

function importSeed(seedHex) {
  const header = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ key: Buffer.concat([header, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
}

function verifySig(pubkeyHex, canonicalJson, signatureHex) {
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(pubkeyHex, "hex"),
  ]);
  try {
    return verify(null, Buffer.from(canonicalJson, "utf8"), { key: spki, format: "der", type: "spki" }, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export function canonicalAttestation(a) {
  return JSON.stringify({
    version: ATTESTATION_VERSION,
    providerId: a.providerId,
    pubkeyHex: a.pubkeyHex,
    payoutAddress: a.payoutAddress,
    payoutChainId: a.payoutChainId,
    capabilities: a.capabilities,
    termsVersion: a.termsVersion,
    issuedAtIso: a.issuedAtIso,
    expiresAtIso: a.expiresAtIso,
    nonce: a.nonce,
  });
}

// Provider self-attestation: signed by the provider key. Proves key
// ownership and binds the payout address to that key.
export function issueProviderAttestation({ seedHex, providerId, pubkeyHex, payoutAddress, payoutChainId, capabilities = [], termsVersion, issuedAtIso = new Date().toISOString(), expiresAtIso, nonce }) {
  const partial = { providerId, pubkeyHex, payoutAddress, payoutChainId, capabilities, termsVersion, issuedAtIso, expiresAtIso, nonce };
  return { ...partial, version: ATTESTATION_VERSION, providerSignature: signWithSeed(seedHex, canonicalAttestation(partial)) };
}

// Authority countersignature: the onboarding authority endorses the
// attestation after its own (off-band) KYC checks. This is what the
// gateway trusts — never a bare self-attestation.
export function countersignAttestation(attestation, authoritySeedHex) {
  const payload = canonicalAttestation(attestation) + "." + attestation.providerSignature;
  return { ...attestation, authoritySignature: signWithSeed(authoritySeedHex, payload) };
}

export function canonicalRevocation(r) {
  return JSON.stringify({
    version: REVOCATION_VERSION,
    providerId: r.providerId,
    pubkeyHex: r.pubkeyHex,
    reason: r.reason,
    revokedAtIso: r.revokedAtIso,
  });
}

export function issueRevocation({ authoritySeedHex, providerId, pubkeyHex, reason, revokedAtIso = new Date().toISOString() }) {
  const partial = { providerId, pubkeyHex, reason, revokedAtIso };
  return { ...partial, version: REVOCATION_VERSION, authoritySignature: signWithSeed(authoritySeedHex, canonicalRevocation(partial)) };
}

export class RevocationList {
  constructor() {
    this.entries = new Map(); // pubkeyHex -> revocation
  }
  add(revocation, authorityPubkeyHex) {
    if (revocation.version !== REVOCATION_VERSION) throw new Error("bad revocation version");
    const ok = verifySig(authorityPubkeyHex, canonicalRevocation(revocation), revocation.authoritySignature);
    if (!ok) throw new Error("revocation: bad authority signature");
    this.entries.set(revocation.pubkeyHex, revocation);
  }
  isRevoked(pubkeyHex) {
    return this.entries.has(pubkeyHex);
  }
  size() {
    return this.entries.size;
  }
}

// Full verification: schema -> provider signature -> authority
// countersignature -> expiry -> revocation.
export function verifyProviderAttestation(att, { authorityPubkeyHex, crl = null, nowIso = new Date().toISOString() }) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  if (!att || att.version !== ATTESTATION_VERSION) return fail("bad_version", "not a provider attestation");
  for (const f of ["providerId", "pubkeyHex", "payoutAddress", "payoutChainId", "termsVersion", "issuedAtIso", "expiresAtIso", "nonce", "providerSignature", "authoritySignature"]) {
    if (att[f] == null || att[f] === "") return fail("missing_field", `missing ${f}`);
  }
  if (!/^[0-9a-f]{64}$/.test(att.pubkeyHex)) return fail("bad_pubkey", "pubkeyHex must be 64 hex chars");
  if (att.issuedAtIso >= att.expiresAtIso) return fail("bad_window", "issuedAt must precede expiresAt");
  if (!verifySig(att.pubkeyHex, canonicalAttestation(att), att.providerSignature)) {
    return fail("bad_provider_signature", "provider self-attestation signature invalid");
  }
  const payload = canonicalAttestation(att) + "." + att.providerSignature;
  if (!verifySig(authorityPubkeyHex, payload, att.authoritySignature)) {
    return fail("bad_authority_signature", "authority countersignature invalid or missing");
  }
  if (nowIso >= att.expiresAtIso) return fail("expired", `attestation expired at ${att.expiresAtIso}`);
  if (nowIso < att.issuedAtIso) return fail("not_yet_valid", "attestation issued in the future");
  if (crl && crl.isRevoked(att.pubkeyHex)) return fail("revoked", "provider key is revoked");
  return { ok: true, providerId: att.providerId };
}
