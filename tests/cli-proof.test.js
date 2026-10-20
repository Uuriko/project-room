import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";
import { mediaTypeFor, parseProofArgs, proofBody, proofCommand } from "../cli/commands/proof.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("parseProofArgs, body and media type", () => {
  assert.deepEqual(parseProofArgs(["shot.png", "--work", "w1", "--note", "tests green"]), { file: "shot.png", work: "w1", note: "tests green" });
  assert.throws(() => parseProofArgs([]), /room proof/);
  assert.throws(() => parseProofArgs(["a", "b"]), /room proof/);
  assert.equal(proofBody({ filename: "ci.log", work: "w1", note: "" }), "Proof for w1: ci.log");
  assert.equal(proofBody({ filename: "ci.log", work: null, note: "all 40 pass" }), "Proof: all 40 pass");
  assert.equal(mediaTypeFor("x.PNG"), "image/png");
  assert.equal(mediaTypeFor("x.bin"), "application/octet-stream");
});

test("room proof posts the evidence message with the file committed onto it", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const agent = fixture.store.identities.create("proof-agent");
  fixture.store.identities.link(fixture.keys.owner, "commons", { identityId: agent.identityId, memberId: "prover", displayName: "Prover", permissions: ["accept_work"] });
  // room_put_file is a paid call: the owner gives the agent a spend grant.
  ensureSpendGrantsSchema(fixture.store.db);
  issueSpendGrant(fixture.store.db, "commons", "prover", { grantedBy: "owner", capCents: "1000", perTxCapCents: "100", nowMs: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const file = join(dir, "ci.log");
  writeFileSync(file, "ok 1 - all tests pass\n");
  const env = { ROOM_ORIGIN: origin, ROOM_ID: "commons", PROJECT_ROOM_SECRET: agent.secret };
  const lines = [];
  assert.equal(await proofCommand([file, "--work", "w-42", "--note", "CI green"], { env, out: l => lines.push(l) }), 0);
  assert.deepEqual(lines, ["Attached ci.log as proof for w-42."]);
  const message = fixture.store.room("commons").state.messages.find(m => m.body === "Proof for w-42: CI green");
  assert.ok(message, "the proof message was posted");
  const row = fixture.store.db.prepare("SELECT filename, state FROM room_attachments WHERE message_id=?").get(message.id);
  assert.deepEqual({ ...row }, { filename: "ci.log", state: "committed" });
});

test("room proof refuses files over 1 MiB before calling the room", async t => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const file = join(dir, "big.log");
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  let called = false;
  const lines = [];
  const code = await proofCommand([file], { env: { ROOM_ORIGIN: "http://127.0.0.1:1", ROOM_ID: "x", PROJECT_ROOM_SECRET: "s" }, out: l => lines.push(l), fetchImpl: async () => { called = true; } });
  assert.equal(code, 1);
  assert.equal(called, false);
  assert.match(lines[0], /at most 1 MiB/);
});
