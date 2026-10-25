import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hostExecutionReadiness } from "../client/host-subprocess.mjs";
const config = { command: "/usr/bin/node", args: ["untrusted.js"], cwd: "/tmp/work", timeoutMs: 1000 };
const dependencies = { platform: "linux", exists: () => true,
  build: () => ({ command: "/usr/bin/bwrap", args: ["--unshare-all", "--", "/usr/bin/node", "untrusted.js"] }),
  launch: () => ({ status: 0 }) };
test("readiness distinguishes unsupported platforms, missing sandbox and invalid configuration", () => {
  assert.equal(hostExecutionReadiness(config, { ...dependencies, platform: "darwin" }).code, "unsupported_platform");
  assert.equal(hostExecutionReadiness(config, { ...dependencies, exists: () => false }).code, "sandbox_missing");
  assert.equal(hostExecutionReadiness({}, dependencies).code, "configuration_invalid");
  assert.equal(hostExecutionReadiness(config, { ...dependencies, build: () => { throw new Error("private detail"); } }).code, "configuration_invalid");
});
test("readiness executes only a bounded sandbox no-op without ambient environment", () => {
  const result = hostExecutionReadiness(config, { ...dependencies, launch(command, args, options) {
    assert.equal(command, "/usr/bin/bwrap");
    assert.deepEqual(args, ["--unshare-all", "--", "/usr/bin/true"]);
    assert.deepEqual(options.env, {}); assert.equal(options.shell, false);
    assert.equal(options.timeout, 3000); assert.equal(options.stdio, "ignore");
    return { status: 0 };
  } });
  assert.equal(result.ready, true); assert.equal(result.modelExecuted, false);
});
test("failed, signalled and uncertain probes never advertise readiness or expose diagnostics", () => {
  for (const result of [{ status: 1 }, { status: null }, { status: 0, signal: "SIGKILL" }, { error: new Error("secret") }]) {
    const value = hostExecutionReadiness(config, { ...dependencies, launch: () => result });
    assert.equal(value.ready, false); assert.equal(value.code, "sandbox_probe_failed");
    assert.ok(!JSON.stringify(value).includes("secret"));
  }
});
test("unsupported CLI check needs no Room credential and creates no journal", { skip: process.platform === "linux" }, t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "room-readiness-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "host.json"); writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(process.execPath, ["scripts/run-room-request.mjs", "--check", path], { encoding: "utf8", env: {}, timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "unsupported_platform");
  assert.equal(result.stderr.includes("Request run failed"), false);
});

test("programmatic readiness refusal precedes new claims but does not prevent saved-result redelivery", async t => {
  const { createAcceptanceFixture } = await import("../scripts/acceptance-fixture.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const { openRequestJournal, runRequestOnce } = await import("../client/request-runner.mjs");
  const f = createAcceptanceFixture({ dmConsent: true }), server = createRoomServer({ store: f.store });
  const db = openRequestJournal(join(f.directory, "readiness.sqlite"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { db.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.owner, "commons", { id: "readiness-request", type: "message.posted", data: {
    messageId: "readiness-message", requestKind: "reply", toMemberId: "producer", body: "Summarize the request." } });
  let executed = 0;
  const execute = async () => { executed++; return { body: "The requested summary." }; };
  execute.prepare = () => { throw Object.assign(new Error("sandbox unavailable"), { code: "sandbox_missing" }); };
  const args = { connection: { origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "producer", token: f.keys.producer },
    requestMessageId: "readiness-message", db, execute };
  await assert.rejects(runRequestOnce(args), { code: "sandbox_missing" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM request_runs").get().n, 0);
  assert.equal(executed, 0);
  execute.prepare = () => ({ ready: true });
  assert.equal((await runRequestOnce(args)).hostExecuted, true);
  execute.prepare = () => { throw new Error("backend disappeared"); };
  assert.equal((await runRequestOnce(args)).hostExecuted, false);
  assert.equal(executed, 1);
});

test("Linux qualification requires the real sandbox to launch", { skip: process.platform !== "linux" && "Linux backend qualification" }, t => {
  const cwd = realpathSync(mkdtempSync("/tmp/room-linux-readiness-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = hostExecutionReadiness({ command: "/usr/bin/true", args: [], cwd, timeoutMs: 1000 });
  assert.equal(result.ready, true, JSON.stringify(result));
});
