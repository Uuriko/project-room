// Lane 1 funnel repair: an anonymous MCP stranger can mint its own identity
// secret natively over POST /mcp (tools/call room_identity_mint) instead of
// dead-ending on the public catalog. The 2026-10-06 production probe confirmed
// the gap: the MCP doors answer 200 (initialize, tools/list, join packet) but
// inside the flow a stranger had no path to mint or post a secret without
// leaving MCP for the HTTP door or a share link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { solveIdentityMintProof } from "./fixtures/identity-mint-solver.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-identity-mint-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const rpc = async (origin, method, params, secret) => {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "project-room-agent",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "mint-t", method, params }),
  });
  return { status: res.status, json: await res.json() };
};
const call = (origin, name, args, secret) =>
  rpc(origin, "tools/call", { name, arguments: args }, secret);
// Unwrap a tools/call reply: fail loudly when the tool itself is unknown so a
// missing tool reads as the enrollment gap, not a TypeError on .result.
const unwrapCall = (reply, label) => {
  assert.equal(reply.json.error, undefined,
    `${label}: tools/call must not be a JSON-RPC error, got ${JSON.stringify(reply.json.error)}`);
  assert.ok(reply.json.result, `${label}: tools/call must return a result`);
  return reply.json.result;
};

test("anonymous tools/list advertises room_identity_mint", async t => {
  const origin = await serve(t);
  const { status, json } = await rpc(origin, "tools/list");
  assert.equal(status, 200);
  const names = json.result.tools.map(tool => tool.name);
  assert.ok(names.includes("room_identity_mint"),
    `anonymous catalog must include room_identity_mint, got: ${names.join(",")}`);
});

test("anonymous stranger mints a secret over MCP and authenticates with it", async t => {
  const origin = await serve(t);
  const minted = await call(origin, "room_identity_mint", { displayName: "MCP Mint Agent" });
  assert.equal(minted.status, 200, `mint must answer 200, got ${JSON.stringify(minted.json).slice(0, 300)}`);
  const mintResult = unwrapCall(minted, "room_identity_mint");
  assert.equal(mintResult.isError, undefined,
    `mint must not be a tool error: ${JSON.stringify(mintResult.structuredContent).slice(0, 300)}`);
  const created = mintResult.structuredContent;
  assert.match(created.secret, /^pri_[A-Za-z0-9_-]{43}$/, "mint returns a one-time identity secret");
  assert.match(created.identityId, /^ai_/);
  assert.equal(typeof created.privateKey, "string");
  // The minted secret authenticates on the same MCP door: an unenrolled
  // identity gets the enrolled public-work catalog (7 tools + 4 join readers),
  // which the anonymous door never lists — proof the secret was accepted.
  const listed = await rpc(origin, "tools/list", undefined, created.secret);
  assert.equal(listed.status, 200);
  const enrolledNames = listed.json.result.tools.map(tool => tool.name);
  assert.equal(enrolledNames.length, 11, `enrolled public-work catalog must be 11 tools, got ${enrolledNames.length}`);
  assert.ok(enrolledNames.includes("public_work_claim"),
    "enrolled catalog must include identity-gated public_work_claim");
  const check = await call(origin, "room_check_access", {}, created.secret);
  const checkResult = unwrapCall(check, "room_check_access");
  assert.equal(checkResult.structuredContent.status, "credential_accepted");
});

test("mint rejects bad input with the HTTP door's error contract", async t => {
  const origin = await serve(t);
  const empty = await call(origin, "room_identity_mint", { displayName: "" });
  const emptyResult = unwrapCall(empty, "room_identity_mint (empty name)");
  assert.equal(emptyResult.isError, true);
  assert.equal(emptyResult.structuredContent.status, 422);
  assert.equal(emptyResult.structuredContent.code, "invalid_identity");
  const extra = await call(origin, "room_identity_mint", { displayName: "Fine Name", bogus: 1 });
  assert.equal(extra.json.error?.code, -32602,
    `extra fields must be invalid_arguments, got ${JSON.stringify(extra.json).slice(0, 200)}`);
});

test("proof-of-work challenge carries the recipe after the free quota is spent", async t => {
  const origin = await serve(t);
  // Spend this address's free quota (8): the 9th mint must challenge.
  for (let i = 1; i <= 8; i++) {
    const first = await call(origin, "room_identity_mint", { displayName: `PoW Funnel Agent ${i}` });
    const firstResult = unwrapCall(first, `free mint ${i}`);
    assert.equal(firstResult.isError, undefined, `free mint ${i} must succeed`);
  }
  const challenged = await call(origin, "room_identity_mint", { displayName: "PoW Funnel Agent Nine" });
  const challengedResult = unwrapCall(challenged, "proof challenge");
  assert.equal(challengedResult.isError, true);
  const failure = challengedResult.structuredContent;
  assert.equal(failure.status, 428);
  assert.equal(failure.code, "proof_required");
  assert.ok(failure.detail?.proof, "the 428 must carry the proof recipe so the client can solve it");
  assert.equal(failure.detail.proof.algorithm, "sha256-prefix");
  // ...and a bogus proof is challenged again, never minted.
  const bogus = await call(origin, "room_identity_mint", { displayName: "PoW Bogus Agent", proof: "zzzz" });
  const bogusResult = unwrapCall(bogus, "bogus proof");
  assert.equal(bogusResult.isError, true);
  assert.equal(bogusResult.structuredContent.code, "proof_required");
});

test("a valid proof-of-work is accepted on first mint", async t => {
  const origin = await serve(t);
  const proof = solveIdentityMintProof("PoW Proven Agent", Date.now());
  const proven = await call(origin, "room_identity_mint", { displayName: "PoW Proven Agent", proof });
  const provenResult = unwrapCall(proven, "proof mint");
  assert.equal(provenResult.isError, undefined,
    `valid proof must mint, got ${JSON.stringify(provenResult.structuredContent).slice(0, 300)}`);
  assert.match(provenResult.structuredContent.secret, /^pri_[A-Za-z0-9_-]{43}$/);
});
