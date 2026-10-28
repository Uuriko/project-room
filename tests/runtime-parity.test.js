import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { workerErrorBody, workerErrorResponse } from "../cloudflare/edge-public.mjs";
import { workerLivenessResponse } from "../cloudflare/health-probe.mjs";

// Cross-runtime parity net (#3272/#3273/#3274, D2). The drift class behind
// all three issues survived because each runtime's suite pinned its OWN
// shape and no check compared them. This test pins BOTH runtimes to the same
// contract, side by side: the Node handler live over HTTP, and the Worker
// layer's own builders (the exact functions cloudflare/room.mjs and
// cloudflare/edge-public.mjs answer with). If either side regresses to a
// bare shape or a missing field, this fails — no hunt required.
const ENVELOPE_KEYS = ["error", "status", "reason", "hint", "next", "operationId", "category"];

function assertEnvelope(body, code, label) {
  for (const key of ENVELOPE_KEYS) assert.ok(Object.hasOwn(body, key), `${label}: envelope key ${key} missing`);
  assert.equal(body.error.code, code, `${label}: error.code`);
  assert.equal(typeof body.error.message, "string", `${label}: error.message`);
  assert.equal(typeof body.hint, "string", `${label}: hint is a string`);
  assert.ok(body.hint.length > 0, `${label}: hint is non-empty`);
  assert.ok(Array.isArray(body.next), `${label}: next is an array`);
  assert.equal(typeof body.operationId, "string", `${label}: operationId`);
  assert.equal(typeof body.category, "string", `${label}: category`);
}

async function bootNode(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-parity-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return origin;
}

test("Node handler errors carry the standard envelope (POST / 404, POST /llms.txt 405)", async t => {
  const origin = await bootNode(t);
  const rootPost = await fetch(`${origin}/`, { method: "POST" });
  assert.equal(rootPost.status, 404);
  assertEnvelope(await rootPost.json(), "not_found", "node POST /");
  const llmsPost = await fetch(`${origin}/llms.txt`, { method: "POST" });
  assert.equal(llmsPost.status, 405);
  assertEnvelope(await llmsPost.json(), "method_not_allowed", "node POST /llms.txt");
});

test("Worker-layer error bodies carry the identical envelope for the same codes", () => {
  for (const [httpStatus, code, message] of [
    [405, "method_not_allowed", "Method not allowed"],
    [403, "origin_denied", "Request origin is not allowed"],
    [403, "host_denied", "Unexpected host"],
    [404, "not_found", "Not found"],
    [503, "room_unavailable", "Project Room is temporarily unavailable. Please try again in 30 seconds."]
  ]) {
    assertEnvelope(workerErrorBody({ httpStatus, code, message }), code, `worker ${code}`);
  }
  const response = workerErrorResponse({ httpStatus: 405, code: "method_not_allowed", message: "Method not allowed" });
  assert.equal(response.status, 405);
  assert.match(response.headers.get("content-type"), /application\/json/);
});

test("health parity: Node handler and Worker liveness both report emailVerification", async t => {
  const origin = await bootNode(t);
  const nodeHealth = await (await fetch(`${origin}/api/health`)).json();
  assert.ok(["enforced", "relaxed-no-mailer"].includes(nodeHealth.emailVerification), "node /api/health emailVerification");
  const workerHealth = await workerLivenessResponse(new Request("https://room.example/api/health"), {
    mode: "cloudflare-production", deployment: "production", emailVerification: nodeHealth.emailVerification
  }).json();
  assert.equal(workerHealth.emailVerification, nodeHealth.emailVerification);
});

test("ready parity: Node answers ready on an empty workspace (Worker storage-probe semantics)", async t => {
  const origin = await bootNode(t);
  const ready = await fetch(`${origin}/api/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });
});
