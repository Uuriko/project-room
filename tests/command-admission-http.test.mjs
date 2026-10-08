// Command admission gate, HTTP-layer half (WAVE-300 item 2).
//
// Drives the real server. Sixteen POST /commands with trickled (never
// completed) request bodies park inside `await body(req)` — each past the
// admission gate — pinning all 16 gauge slots the way slow clients do in
// production. The next request must refuse FAST (503 shed_load +
// Retry-After) instead of silently queueing, and completing the trickled
// bodies must drain the gauge (leave() runs even on the held path) so a
// fresh command is admitted afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-command-admission-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { origin, request, ownerKey };
}

// Start a POST whose body is sent in two halves with the second half held
// back: the server admits it through the gate, then parks at body(). The
// returned request completes the body when end() is called.
function trickle(origin, path, token) {
  const url = new URL(path, origin);
  const req = http.request({
    host: url.hostname, port: url.port, path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked",
      Origin: origin,
      Authorization: `Bearer ${token}`,
    },
  });
  req.on("response", response => { response.resume(); });
  req.write(`{"id":"${randomUUID()}","type":"message.posted","data":{"body":"trickle`);
  return req;
}

const command = () => ({ id: randomUUID(), type: "message.posted", data: { body: "admission probe" } });

async function untilTrue(fn, ms = 8000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error("timed out waiting for the admission gauge to fill");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("a saturated command gauge sheds fast with 503 shed_load + Retry-After, then drains cleanly", { timeout: 60000 }, async t => {
  const { origin, request, ownerKey } = await serve(t);
  const post = () => request("/api/rooms/commons/commands", { method: "POST", token: ownerKey, data: command() });

  // Pin all 16 default gauge slots with trickled bodies parked at body().
  const tricklers = Array.from({ length: 16 }, () => trickle(origin, "/api/rooms/commons/commands", ownerKey));

  // Refused probes consume no capacity, so polling for the first 503 both
  // waits out the race and proves the gauge is full.
  await untilTrue(async () => {
    const probe = await post();
    await probe.text();
    return probe.status === 503;
  });

  // The shed refusal must be FAST — it never queued behind the 16 held ones.
  const start = Date.now();
  const shed = await post();
  const elapsed = Date.now() - start;
  assert.equal(shed.status, 503, "an over-gauge command must shed fast, not hang");
  assert.ok(elapsed < 2000, `shed must be fast, took ${elapsed}ms`);
  assert.equal(shed.headers.get("retry-after"), "1");
  const shedBody = await shed.json();
  assert.equal(shedBody.code, "shed_load");
  assert.ok(typeof shedBody.message === "string" && shedBody.message.length > 0);
  assert.equal(shedBody.retryAfterMs, 1000);
  assert.equal(shedBody.inFlight, 16);

  // Complete the trickled bodies: the held requests finish and the gauge
  // must drain to zero (leave() runs on every admitted request's way out),
  // so a fresh command is admitted and processed normally.
  for (const req of tricklers) req.end(`"}`);
  await untilTrue(async () => {
    const fresh = await post();
    await fresh.text();
    return fresh.status === 201;
  }, 8000);
});
