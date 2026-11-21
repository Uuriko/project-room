import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { generateKeyPair, publicKeyToJwk, signCardJws } from "../server/agent-card-signing.mjs";
import { verifyReleaseEvidence } from "../scripts/verify-release-evidence.mjs";

const origin = "https://room.example";
const workItemId = "release-work";
const completionEventId = "exact-completion";
const roomId = "room";
const evidenceVersion = "sha256:" + "e".repeat(64);
const candidateRevision = "a".repeat(40);
const keyId = "instance-key";
const jku = origin + "/.well-known/jwks.json";
const { privateKey, publicKey } = generateKeyPair();
const keys = { keys: [publicKeyToJwk({ publicKey, keyId })] };
const qualification = { "build.json": "b".repeat(64), "browser.json": "c".repeat(64), "deployment-result.json": "d".repeat(64) };

function fixture({ inline = false, fallback = false, jkuOverride = jku } = {}) {
  const proof = { schema: "project-room-batch-source-to-package/1", origin, workItemId, roomId,
    composition: { revision: candidateRevision }, package: { manifestSha256: "f".repeat(64) }, qualification };
  const envelope = JSON.stringify({ proof, signature: signCardJws({ card: proof, keyId, privateKey, jku: jkuOverride }) });
  const digest = createHash("sha256").update(envelope).digest("hex");
  const producer = "producer";
  const chunks = Buffer.from(envelope).toString("base64url").match(/.{1,600}/g);
  const parts = chunks.map((chunk, i) => ({
    id: `release-proof-${digest}-${i + 1}`, authorId: producer, workItemId,
    body: `room-source-proof-part/1 ${i + 1}/${chunks.length} sha256:${digest}\n${chunk}`
  }));
  const prefix = "Signed source-to-package proof (same-origin JWKS)";
  const body = inline ? `${prefix}.\n${envelope}` : `${prefix}, SHA-256 ${digest}. Proof parts.\n${parts.map(part => part.id).join("\n")}`;
  const selected = {
    roomId, workItemId, selection: { status: "historical" },
    result: { text: { body }, receipt: { eventId: completionEventId, evidenceVersion, reportedById: producer } },
    workThread: { releaseChecks: { completionEventId, evidenceVersion, candidateRevision,
      checks: ["build", "browser", "deploy"].map((stage, i) => ({
        stage, status: "passed", evidenceDigest: "sha256:" + Object.values(qualification)[i], evidenceMessageId: stage
      })) } }
  };
  const calls = [];
  const client = {
    async workResult(id, selected) {
      assert.equal(id, workItemId);
      assert.equal(selected.completionEventId, completionEventId);
      calls.push("result");
      return snapshot;
    },
    async workDiscussion() {
      calls.push("discussion");
      return { discussion: { items: (fallback ? parts.slice(1) : parts).map(message => ({ message })) } };
    },
    async messageThread(id) {
      calls.push("part");
      return { thread: parts.find(part => part.id === id) };
    }
  };
  const snapshot = selected;
  const run = () => verifyReleaseEvidence({ client, origin, roomId, workItemId, completionEventId,
    fetchImpl: async (url, options) => {
      assert.equal(url, jku);
      assert.equal(options.redirect, "error");
      calls.push("keys");
      return Response.json(keys);
    } });
  return { run, parts, selected, calls };
}

test("verifies large proof and exact stage bindings in two Room reads", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.candidateRevision, candidateRevision);
  assert.equal(result.completionEventId, completionEventId);
  assert.equal(result.selection, "historical");
  assert.equal(result.checks.length, 3);
  assert.deepEqual(f.calls, ["result", "discussion", "keys"]);
});
test("inline proof skips discussion and an unlisted part uses its exact read", async () => {
  const inline = fixture({ inline: true });
  await inline.run();
  assert.deepEqual(inline.calls, ["result", "keys"]);
  const paged = fixture({ fallback: true });
  await paged.run();
  assert.deepEqual(paged.calls, ["result", "discussion", "keys", "part"]);
});
test("rejects stale bindings, foreign parts, changed bytes and misplaced signing keys", async () => {
  const stale = fixture({ inline: true });
  stale.selected.workThread.releaseChecks.completionEventId = "older";
  await assert.rejects(stale.run, /exact selected completion/);
  const wrongEvidence = fixture({ inline: true });
  wrongEvidence.selected.workThread.releaseChecks.checks[1].evidenceDigest = "sha256:" + "a".repeat(64);
  await assert.rejects(wrongEvidence.run, /selected browser receipt/);
  const copied = fixture();
  copied.parts[0].workItemId = "other-work";
  await assert.rejects(copied.run, /does not belong/);
  const altered = fixture();
  const body = altered.parts[0].body;
  altered.parts[0].body = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
  await assert.rejects(altered.run, /selected result digest/);
  await assert.rejects(fixture({ inline: true, jkuOverride: "https://other.example/.well-known/jwks.json" }).run,
    /signature did not verify/);
});
