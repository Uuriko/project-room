import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { signAgentCard } from "../scripts/sign-agent-card.mjs";
import { generateKeyPair, verifyCardSignature } from "../server/agent-card-signing.mjs";

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
