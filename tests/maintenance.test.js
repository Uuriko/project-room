import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintenanceEnabled, maintenanceResponse } from "../server/maintenance.mjs";

const call = (port, path, method, host) => new Promise((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host } }, res => {
    let body = ""; res.on("data", chunk => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }); req.on("error", reject); req.end();
});

test("maintenance is explicit operator configuration and an uncached unavailable response", async () => {
  assert.equal(maintenanceEnabled(), false); assert.equal(maintenanceEnabled("0"), false); assert.equal(maintenanceEnabled("1"), true);
  for (const value of [null, "", "true", "false", 1, true]) assert.throws(() => maintenanceEnabled(value));
  const response = maintenanceResponse(new Request("https://room.example.test/api/session"));
  assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "60"); assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await response.json()).error.code, "maintenance");
  assert.equal(await maintenanceResponse(new Request("https://room.example.test/", { method: "HEAD" })).text(), "");
});

for (const production of [false, true]) for (const state of ["missing", "unreadable-database"]) test(`actual paused Node ${production ? "production" : "development"} service never opens ${state} storage`, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-paused-"));
  const filename = join(directory, state === "missing" ? "not-created/room.sqlite" : "room.sqlite");
  const bytes = Buffer.from("Synthetic invalid database. Preserve unchanged.\n");
  if (state !== "missing") writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = production ? "https://room.example.test" : `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: production ? "production" : "development", ROOM_DEPLOYMENT: production ? "invite-only" : "",
    ROOM_MAINTENANCE: "1", ROOM_DB: filename, PORT: String(port), HOST: "127.0.0.1", ROOM_ORIGIN: origin };
  const child = spawn(process.execPath, ["server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const stopped = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => { child.kill("SIGTERM"); await stopped; rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Paused service did not become ready")), 10000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Paused service exited before readiness")); });
  });
  for (const [path, method] of [["/", "GET"], ["/api/session", "POST"], ["/api/rooms/commons/commands", "POST"], ["/api/ready?ROOM_MAINTENANCE=0", "GET"]]) {
    const result = await call(port, path, method, new URL(origin).host);
    assert.equal(result.status, 503); assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.match(result.body, /temporarily paused/);
  }
  assert.equal((await call(port, "/", "GET", "wrong.example.test")).status, 403);
  if (state === "missing") assert.equal(existsSync(join(directory, "not-created")), false);
  else assert.deepEqual(readFileSync(filename), bytes);
  assert.equal(existsSync(`${filename}-wal`), false); assert.equal(existsSync(`${filename}-shm`), false);
  child.kill("SIGTERM"); assert.equal((await stopped).code, 0);
  if (production) {
    const normal = spawnSync(process.execPath, ["server.mjs"], { env: { ...env, ROOM_MAINTENANCE: "0" }, timeout: 10000, encoding: "utf8" });
    assert.notEqual(normal.status, 0); assert.equal(normal.error, undefined);
    assert.equal(normal.stdout.includes("invite-only pilot"), false, "resuming requires healthy provisioned storage");
    if (state === "missing") assert.equal(existsSync(join(directory, "not-created")), false);
    else assert.deepEqual(readFileSync(filename), bytes);
  }
});

test("invalid pause configuration fails before creating any database directory", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-invalid-pause-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "not-created", "room.sqlite");
  const result = spawnSync(process.execPath, ["server.mjs"], { env: { ...process.env, NODE_ENV: "development", ROOM_DEPLOYMENT: "",
    ROOM_MAINTENANCE: "true", ROOM_DB: filename, HOST: "127.0.0.1", PORT: "52781", ROOM_ORIGIN: "http://127.0.0.1:52781" }, timeout: 10000, encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /ROOM_MAINTENANCE must be 0 or 1/);
  assert.equal(existsSync(join(directory, "not-created")), false);
});
