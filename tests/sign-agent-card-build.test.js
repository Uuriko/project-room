import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { signAgentCard } from "../scripts/sign-agent-card.mjs";
import { generateKeyPair, verifyCardSignature, verifyCardJws } from "../server/agent-card-signing.mjs";
import { AGENT_CARD_KEY_ID } from "../deploy/agent-card-key.mjs";

test("missing or wrong keys stop a release without overwriting its signature", t => {
  const directory = mkdtempSync(join(tmpdir(), "card-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "signed.mjs"), key = generateKeyPair();
  writeFileSync(outputPath, "existing signature");
  assert.throws(() => signAgentCard({ privateKey: null, card: {}, outputPath }), /key unavailable/);
  assert.equal(readFileSync(outputPath, "utf8"), "existing signature");
  assert.throws(() => signAgentCard({ privateKey: generateKeyPair().privateKey, publicKey: key.publicKey,
    card: { deployed: { revision: "abc" } }, outputPath }), /does not verify/);
  assert.equal(readFileSync(outputPath, "utf8"), "existing signature");
});

test("available key signs the exact revision; unsigned output requires explicit opt-in", async t => {
  const directory = mkdtempSync(join(tmpdir(), "card-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "signed.mjs"), key = generateKeyPair();
  const card = { name: "Fixture", deployed: { revision: "fixture-revision" } };
  signAgentCard({ privateKey: key.privateKey, publicKey: key.publicKey, agentId: "project-room", card, outputPath });
  const signed = await import(pathToFileURL(outputPath));
  assert.equal(signed.AGENT_CARD_SIGNED_REVISION, "fixture-revision");
  assert.equal(verifyCardSignature({ agentId: "project-room", card, publicKey: key.publicKey, signature: signed.AGENT_CARD_SIGNATURE }), true);
  assert.equal(readFileSync(outputPath, "utf8").includes(key.privateKey), false);
  signAgentCard({ privateKey: null, card, outputPath, allowUnsigned: true });
  assert.match(readFileSync(outputPath, "utf8"), /AGENT_CARD_SIGNATURE = null/);
});

test("mismatched key: unsigned hatch covers it with the flag; fails closed without", t => {
  const directory = mkdtempSync(join(tmpdir(), "card-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "signed.mjs"), key = generateKeyPair();
  const card = { name: "Fixture", deployed: { revision: "mismatch-revision" } };
  const wrongKey = generateKeyPair().privateKey;
  writeFileSync(outputPath, "existing signature");
  // Without the flag the mismatch still stops the release and leaves the file alone.
  assert.throws(() => signAgentCard({ privateKey: wrongKey, publicKey: key.publicKey,
    card, outputPath }), /does not verify/);
  assert.equal(readFileSync(outputPath, "utf8"), "existing signature");
  // With the flag the release proceeds unsigned — never with a wrong-key signature.
  signAgentCard({ privateKey: wrongKey, publicKey: key.publicKey, card, outputPath, allowUnsigned: true });
  const unsigned = readFileSync(outputPath, "utf8");
  assert.match(unsigned, /AGENT_CARD_SIGNATURE = null/);
  assert.match(unsigned, /AGENT_CARD_SIGNED_REVISION = null/);
  assert.match(unsigned, /does not match the pinned public key/);
});

test("signed build writes an A2A v1.0 JWS covering the served envelope", async t => {
  const directory = mkdtempSync(join(tmpdir(), "card-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "signed.mjs"), key = generateKeyPair();
  const card = { name: "Fixture", deployed: { revision: "jws-revision" } };
  signAgentCard({ privateKey: key.privateKey, publicKey: key.publicKey, agentId: "project-room", card, outputPath });
  const signed = await import(pathToFileURL(outputPath));
  // The JWS array is written alongside the house signature.
  assert.ok(Array.isArray(signed.AGENT_CARD_JWS_SIGNATURES), "JWS signatures array written");
  assert.equal(signed.AGENT_CARD_JWS_SIGNATURES.length, 1);
  const jws = signed.AGENT_CARD_JWS_SIGNATURES[0];
  assert.equal(typeof jws.protected, "string");
  assert.equal(typeof jws.signature, "string");
  // The served card is the fixture card plus the envelope attachCardSignatureEnvelope()
  // builds at serve time; the JWS must verify over exactly those bytes, or no
  // A2A client could ever verify the served card.
  const { attachCardSignatureEnvelope } = await import("../deploy/agent-discovery.mjs");
  const served = attachCardSignatureEnvelope({ ...card }, {
    signature: signed.AGENT_CARD_SIGNATURE,
    jwsSignatures: null,
    revision: signed.AGENT_CARD_SIGNED_REVISION,
  });
  assert.ok(verifyCardJws({ card: served, publicKey: key.publicKey, jws }), "JWS verifies over the served envelope");
  // The protected header names the room's key id and JWKS for key discovery.
  const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString("utf8"));
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, AGENT_CARD_KEY_ID);
  assert.match(header.jku ?? "", /\.well-known\/jwks\.json$/, "jku points at the JWKS");
  // No secret material in the generated module.
  assert.equal(readFileSync(outputPath, "utf8").includes(key.privateKey), false);
});

test("unsigned build writes AGENT_CARD_JWS_SIGNATURES = null", t => {
  const directory = mkdtempSync(join(tmpdir(), "card-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "signed.mjs"), key = generateKeyPair();
  const card = { name: "Fixture", deployed: { revision: "unsigned-jws-revision" } };
  signAgentCard({ privateKey: null, card, outputPath, allowUnsigned: true });
  const unsigned = readFileSync(outputPath, "utf8");
  assert.match(unsigned, /AGENT_CARD_JWS_SIGNATURES = null/, "no-key build nulls the JWS array");
});
