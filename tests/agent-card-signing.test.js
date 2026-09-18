// Signed agent cards (RC-2026-09-18-014, research rec A4): Ed25519
// sign/verify over the canonical card body, rotation chain of custody, and
// unsigned-publish rejection. Synthetic identities only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair,
  signCard,
  verifyCardSignature,
  signKeyRotation,
  verifyKeyRotation,
  isValidPublicKey,
  canonicalCardBytes,
  SigningError,
} from "../server/agent-card-signing.mjs";
import { createAgentDirectory, DirectoryError } from "../server/agent-directory.mjs";

const CARD = {
  name: "Sig Test Agent",
  description: "A synthetic agent for signed-card tests.",
  url: "https://agent.example.test/sig",
  capabilities: ["chat", "triage"],
  skills: ["testing"],
  version: "1.0.0",
};

const signedPublish = (dir, { agentId, card = CARD, keyPair, visibility, rotationSignature, allowRecovery }) => {
  const signature = signCard({ agentId, card, privateKey: keyPair.privateKey });
  return dir.publish({
    agentId, card, visibility,
    publicKey: keyPair.publicKey, signature, rotationSignature, allowRecovery,
  });
};

// ---- signing module ----

test("generateKeyPair produces valid 32-byte keys", () => {
  const kp = generateKeyPair();
  assert.equal(Buffer.from(kp.publicKey, "base64").length, 32);
  assert.equal(Buffer.from(kp.privateKey, "base64").length, 32);
  assert.ok(isValidPublicKey(kp.publicKey));
  assert.ok(!isValidPublicKey("not-a-key"));
  assert.ok(!isValidPublicKey(kp.privateKey.slice(0, 20)));
});

test("sign -> verify roundtrip", () => {
  const kp = generateKeyPair();
  const signature = signCard({ agentId: "sig-agent", card: CARD, privateKey: kp.privateKey });
  assert.equal(Buffer.from(signature, "base64").length, 64);
  assert.ok(verifyCardSignature({ agentId: "sig-agent", card: CARD, publicKey: kp.publicKey, signature }));
});

test("signature is canonical: field order does not matter", () => {
  const kp = generateKeyPair();
  const reordered = { version: "1.0.0", capabilities: ["chat", "triage"], skills: ["testing"], description: CARD.description, url: CARD.url, name: CARD.name };
  const signature = signCard({ agentId: "sig-agent", card: CARD, privateKey: kp.privateKey });
  assert.ok(verifyCardSignature({ agentId: "sig-agent", card: reordered, publicKey: kp.publicKey, signature }));
  assert.deepEqual(
    canonicalCardBytes({ agentId: "sig-agent", card: CARD }).toString(),
    canonicalCardBytes({ agentId: "sig-agent", card: reordered }).toString());
});

test("tampered card body is rejected", () => {
  const kp = generateKeyPair();
  const signature = signCard({ agentId: "sig-agent", card: CARD, privateKey: kp.privateKey });
  for (const tampered of [
    { ...CARD, description: "Evil twin." },
    { ...CARD, capabilities: ["chat"] },
    { ...CARD, version: "9.9.9" },
  ]) {
    assert.ok(!verifyCardSignature({ agentId: "sig-agent", card: tampered, publicKey: kp.publicKey, signature }),
      "tampered field must not verify");
  }
  // Transplanting the signed card under another agentId must not verify.
  assert.ok(!verifyCardSignature({ agentId: "other-agent", card: CARD, publicKey: kp.publicKey, signature }));
});

test("wrong key, malformed signature, malformed key all verify false (never throw)", () => {
  const kp = generateKeyPair();
  const other = generateKeyPair();
  const signature = signCard({ agentId: "sig-agent", card: CARD, privateKey: kp.privateKey });
  assert.ok(!verifyCardSignature({ agentId: "sig-agent", card: CARD, publicKey: other.publicKey, signature }));
  assert.ok(!verifyCardSignature({ agentId: "sig-agent", card: CARD, publicKey: kp.publicKey, signature: "AAAA" }));
  assert.ok(!verifyCardSignature({ agentId: "sig-agent", card: CARD, publicKey: "junk", signature }));
  assert.ok(!verifyCardSignature({ agentId: "sig-agent", card: CARD, publicKey: kp.publicKey, signature: null }));
  assert.ok(!verifyCardSignature({ agentId: "sig-agent", card: null, publicKey: kp.publicKey, signature }));
});

test("signing with a malformed private key throws SigningError", () => {
  assert.throws(() => signCard({ agentId: "sig-agent", card: CARD, privateKey: "junk" }), SigningError);
});

test("key rotation: old key authorizes the new key (chain of custody)", () => {
  const oldKp = generateKeyPair();
  const newKp = generateKeyPair();
  const rotationSignature = signKeyRotation({
    agentId: "sig-agent", card: CARD, newPublicKey: newKp.publicKey, oldPrivateKey: oldKp.privateKey,
  });
  assert.ok(verifyKeyRotation({
    agentId: "sig-agent", card: CARD, newPublicKey: newKp.publicKey,
    oldPublicKey: oldKp.publicKey, rotationSignature,
  }));
  // Rotation bound to a different new key or card must not verify.
  const attacker = generateKeyPair();
  assert.ok(!verifyKeyRotation({
    agentId: "sig-agent", card: CARD, newPublicKey: attacker.publicKey,
    oldPublicKey: oldKp.publicKey, rotationSignature,
  }));
  assert.ok(!verifyKeyRotation({
    agentId: "sig-agent", card: { ...CARD, version: "2.0.0" }, newPublicKey: newKp.publicKey,
    oldPublicKey: oldKp.publicKey, rotationSignature,
  }));
  // A rotation "signed" by anyone but the old key must not verify.
  const forged = signKeyRotation({
    agentId: "sig-agent", card: CARD, newPublicKey: newKp.publicKey, oldPrivateKey: attacker.privateKey,
  });
  assert.ok(!verifyKeyRotation({
    agentId: "sig-agent", card: CARD, newPublicKey: newKp.publicKey,
    oldPublicKey: oldKp.publicKey, rotationSignature: forged,
  }));
});

// ---- directory publish ----

test("unsigned publish is rejected (invalid_card_signature)", () => {
  const dir = createAgentDirectory({});
  assert.throws(() => dir.publish({ agentId: "sig-agent", card: CARD }), err =>
    err instanceof DirectoryError && err.code === "invalid_card_signature");
  const kp = generateKeyPair();
  assert.throws(() => dir.publish({ agentId: "sig-agent", card: CARD, publicKey: kp.publicKey }), err =>
    err instanceof DirectoryError && err.code === "invalid_card_signature");
});

test("publish with a bad signature is rejected (invalid_card_signature)", () => {
  const dir = createAgentDirectory({});
  const kp = generateKeyPair();
  const other = generateKeyPair();
  const signature = signCard({ agentId: "sig-agent", card: CARD, privateKey: other.privateKey });
  assert.throws(() => dir.publish({ agentId: "sig-agent", card: CARD, publicKey: kp.publicKey, signature }), err =>
    err instanceof DirectoryError && err.code === "invalid_card_signature");
});

test("signed publish exposes publicKey + signature for offline verification", () => {
  const dir = createAgentDirectory({});
  const kp = generateKeyPair();
  const doc = signedPublish(dir, { agentId: "sig-agent", keyPair: kp });
  assert.equal(doc.publicKey, kp.publicKey);
  assert.ok(typeof doc.signature === "string" && doc.signature.length > 0);
  // Any third party can verify offline from the public document alone.
  const publicDoc = dir.buildDocument({ serviceOrigin: "https://room.example.test" });
  const listed = publicDoc.agents.find(a => a.agentId === "sig-agent");
  assert.ok(listed, "card is listed");
  const { agentId, name, description, url, capabilities, skills, version } = listed;
  assert.ok(verifyCardSignature({
    agentId,
    card: { name, description, url, capabilities: [...capabilities], skills: [...skills], version },
    publicKey: listed.publicKey,
    signature: listed.signature,
  }), "offline verification of the listed card must pass");
  // And the single-card read exposes the same envelope.
  const single = dir.get("sig-agent");
  assert.equal(single.publicKey, kp.publicKey);
  assert.equal(single.signature, doc.signature);
});

test("same-key republish updates the card; key swap without rotation is rejected", () => {
  const dir = createAgentDirectory({});
  const kp = generateKeyPair();
  signedPublish(dir, { agentId: "sig-agent", keyPair: kp });
  const updated = signedPublish(dir, { agentId: "sig-agent", keyPair: kp, card: { ...CARD, version: "1.2.4" } });
  assert.equal(updated.version, "1.2.4");
  assert.equal(updated.publicKey, kp.publicKey);

  const attacker = generateKeyPair();
  const forgedSignature = signCard({ agentId: "sig-agent", card: CARD, privateKey: attacker.privateKey });
  assert.throws(() => dir.publish({
    agentId: "sig-agent", card: CARD, publicKey: attacker.publicKey, signature: forgedSignature,
  }), err => err instanceof DirectoryError && err.code === "invalid_card_signature");
});

test("key rotation with the old key's rotation signature succeeds", () => {
  const dir = createAgentDirectory({});
  const oldKp = generateKeyPair();
  const newKp = generateKeyPair();
  signedPublish(dir, { agentId: "sig-agent", keyPair: oldKp });
  const rotationSignature = signKeyRotation({
    agentId: "sig-agent", card: CARD, newPublicKey: newKp.publicKey, oldPrivateKey: oldKp.privateKey,
  });
  const doc = signedPublish(dir, { agentId: "sig-agent", keyPair: newKp, rotationSignature });
  assert.equal(doc.publicKey, newKp.publicKey);
  // The old key can no longer publish for this agent without the current
  // key's authorization — and the current key CAN authorize a switch back.
  const staleSignature = signCard({ agentId: "sig-agent", card: CARD, privateKey: oldKp.privateKey });
  assert.throws(() => dir.publish({
    agentId: "sig-agent", card: CARD, publicKey: oldKp.publicKey, signature: staleSignature,
  }), err => err instanceof DirectoryError && err.code === "invalid_card_signature");
  const back = dir.publish({
    agentId: "sig-agent", card: CARD, publicKey: oldKp.publicKey, signature: staleSignature,
    rotationSignature: signKeyRotation({
      agentId: "sig-agent", card: CARD, newPublicKey: oldKp.publicKey, oldPrivateKey: newKp.privateKey,
    }),
  });
  assert.equal(back.publicKey, oldKp.publicKey);
});

test("rotation after withdraw still requires the old key's signature (no laundering via withdraw)", () => {
  const dir = createAgentDirectory({});
  const kp = generateKeyPair();
  const attacker = generateKeyPair();
  signedPublish(dir, { agentId: "sig-agent", keyPair: kp });
  dir.withdraw("sig-agent");
  const forgedSignature = signCard({ agentId: "sig-agent", card: CARD, privateKey: attacker.privateKey });
  assert.throws(() => dir.publish({
    agentId: "sig-agent", card: CARD, publicKey: attacker.publicKey, signature: forgedSignature,
  }), err => err instanceof DirectoryError && err.code === "invalid_card_signature");
  // Same-key republish after withdraw still works.
  const doc = signedPublish(dir, { agentId: "sig-agent", keyPair: kp });
  assert.equal(doc.publicKey, kp.publicKey);
});

test("owner-signed recovery rotates the key without the old key's signature", () => {
  const dir = createAgentDirectory({});
  const oldKp = generateKeyPair();
  const newKp = generateKeyPair();
  signedPublish(dir, { agentId: "sig-agent", keyPair: oldKp });
  const doc = signedPublish(dir, { agentId: "sig-agent", keyPair: newKp, allowRecovery: true });
  assert.equal(doc.publicKey, newKp.publicKey);
});

test("legacy card (no pinned key) pins the new key on its next publish", () => {
  const store = new Map();
  // Simulate a pre-signing row: entry without publicKey/signature.
  store.set("legacy-agent", {
    agentId: "legacy-agent", card: { ...CARD }, visibility: "public",
    publishedAt: 1, updatedAt: 1, withdrawn: false,
  });
  const dir = createAgentDirectory({ store });
  const kp = generateKeyPair();
  const doc = signedPublish(dir, { agentId: "legacy-agent", keyPair: kp });
  assert.equal(doc.publicKey, kp.publicKey);
  assert.ok(verifyCardSignature({
    agentId: "legacy-agent", card: CARD, publicKey: doc.publicKey, signature: doc.signature,
  }));
});

// ---- canonicalization regression: omitted optional fields ----

test("card signed with url/skills omitted verifies against the normalized public document", () => {
  const dir = createAgentDirectory({});
  const kp = generateKeyPair();
  // Publisher omits the optional fields entirely.
  const sparse = { name: "Sparse Agent", description: "Omits optional fields.", capabilities: ["chat"], version: "1.0.0" };
  const doc = signedPublish(dir, { agentId: "sparse-agent", card: sparse, keyPair: kp });
  // The public document normalizes url -> null and skills -> [].
  assert.equal(doc.url, null);
  assert.deepEqual(doc.skills, []);
  // Offline verification against the public document shape must hold.
  assert.ok(verifyCardSignature({
    agentId: "sparse-agent", card: doc, publicKey: doc.publicKey, signature: doc.signature,
  }), "signature must verify against the normalized public document");
  // And the exact submitted shape still verifies too.
  assert.ok(verifyCardSignature({
    agentId: "sparse-agent", card: sparse, publicKey: doc.publicKey, signature: doc.signature,
  }));
});

test("rotation statement normalizes omitted url/skills the same way", () => {
  const oldKp = generateKeyPair(); const newKp = generateKeyPair();
  const sparse = { name: "Sparse Agent", description: "Omits optional fields.", capabilities: ["chat"], version: "1.0.0" };
  const rotationSignature = signKeyRotation({
    agentId: "sparse-agent", card: sparse, newPublicKey: newKp.publicKey, oldPrivateKey: oldKp.privateKey,
  });
  // A verifier holding the normalized public-document card must accept it.
  const normalized = { ...sparse, url: null, skills: [] };
  assert.ok(verifyKeyRotation({
    agentId: "sparse-agent", card: normalized, newPublicKey: newKp.publicKey,
    oldPublicKey: oldKp.publicKey, rotationSignature,
  }));
});
