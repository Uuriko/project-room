// FAIL-FIRST regression test for worker-41 finding W41-001:
// a request sent on a keep-alive connection immediately after an oversize
// POST (413) has its bytes consumed as the previous request's body and its
// socket destroyed -> the client sees "socket hang up" instead of a response.
// Run: node --test worker-41/keepalive-413.test.mjs   (repo root)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

function request(agent, port, opts, bodyBuf) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, agent, ...opts }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
      res.on("error", (e) => resolve({ status: "RESP-ERR", error: e.message }));
    });
    req.setTimeout(6000);
    req.on("timeout", () => req.destroy(new Error("client-timeout-6s")));
    req.on("error", (e) => resolve({ status: "REQ-ERR", error: e.message }));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

test("keep-alive request right after a 413 gets an HTTP response, not a hang-up", async (t) => {
  const dbDir = mkdtempSync(join(tmpdir(), "w41-test-"));
  const store = new RoomStore(join(dbDir, "room.db"));
  const server = createRoomServer({ store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true });
  t.after(async () => {
    agent.destroy();
    server.closeStreams(); server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  });

  const big = Buffer.from(JSON.stringify({ pad: "x".repeat(20000) }));
  const r1 = await request(agent, port,
    { path: "/api/access-requests", method: "POST", headers: { "content-type": "application/json" } }, big);
  assert.equal(r1.status, 413, "oversize body is rejected with 413");

  // The next request on the same keep-alive connection must receive an HTTP
  // response (405 for GET on this POST-only route), not a destroyed socket.
  const r2 = await request(agent, port, { path: "/api/access-requests", method: "GET" });
  assert.ok(typeof r2.status === "number",
    `expected an HTTP status for the follow-up request, got ${r2.status}${r2.error ? ": " + r2.error : ""}`);
  assert.equal(r2.status, 405);
});
