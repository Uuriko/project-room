// REL-22: a paused Node service blocks every read and write, keeps the
// release receipt readable for deploy checks, and never opens storage.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const call = (port, path, method, host, body) => new Promise((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host, ...(body ? { "content-type": "application/json" } : {}) } }, res => {
    let text = ""; res.on("data", c => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
  }); req.on("error", reject); if (body) req.write(body); req.end();
});

test("paused service: version 200 without storage; health, ready, reads, writes 503", async t => {
  const dir = mkdtempSync(join(tmpdir(), "room-rel22-"));
  const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: "development", ROOM_DEPLOYMENT: "", ROOM_MAINTENANCE: "1",
    ROOM_DB: join(dir, "not-created/room.sqlite"), PORT: String(port), HOST: "127.0.0.1", ROOM_ORIGIN: origin };
  const child = spawn(process.execPath, ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const stopped = new Promise(r => child.once("exit", (code) => r(code)));
  t.after(async () => { child.kill("SIGTERM"); await stopped; rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("not ready")), 10000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("exited")); });
  });
  const v = await call(port, "/api/version", "GET", host);
  assert.equal(v.status, 200); assert.equal(v.headers["cache-control"], "no-store"); assert.equal(v.headers["set-cookie"], undefined);
  const parsed = JSON.parse(v.body);
  assert.deepEqual(Object.keys(parsed).sort(), ["buildId", "mode", "sourceRevision", "status"]);
  assert.equal(parsed.status, "paused"); assert.equal(parsed.mode, "maintenance");
  const head = await call(port, "/api/version", "HEAD", host); assert.equal(head.status, 200); assert.equal(head.body, "");
  for (const [path, method, body] of [["/api/health", "GET"], ["/api/ready", "GET"], ["/api/rooms/commons/events?after=0", "GET"],
    ["/api/rooms/commons/orient", "GET"], ["/api/version", "POST", "{}"], ["/api/rooms/commons/commands", "POST", "{}"], ["/api/session", "POST", "{}"]]) {
    const r = await call(port, path, method, host, body);
    assert.equal(r.status, 503, `${method} ${path}`); assert.equal(r.headers["retry-after"], "60"); assert.equal(r.headers["set-cookie"], undefined);
  }
  assert.equal((await call(port, "/api/version", "GET", "wrong.example.test")).status, 403);
  assert.equal(existsSync(join(dir, "not-created")), false, "pause never opens storage");
});
