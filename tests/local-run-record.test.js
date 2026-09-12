import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync, symlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { executeLocalRun, inspectLocalRun } from "../client/local-run-record.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-run-record-")), privateDir = join(directory, "run");
  mkdirSync(privateDir, { mode: 0o700 });
  const store = new RoomStore(":memory:"); store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: "member", type: "member.added", data: {
    memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  store.command(owner, "commons", { id: "task", type: "work.proposed", data: {
    workItemId: "task", title: "Record fixture", definitionOfDone: "Separate review", accountableMemberId: "agent", mode: "read" } });
  const token = store.issueAccessKey("commons", "agent"), server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const connectionDirectory = join(directory, "connection");
  saveAgentConnection(connectionDirectory, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "agent", token });
  const config = { version: 1, connectionDirectory, workItemId: "task", runId: "once", expectedRevision: 0,
    command: process.execPath, args: ["-e", "console.log('PRIVATE_OUTPUT')"], cwd: directory, env: {}, maxRuntimeMs: 3000, maxOutputBytes: 4096 };
  const path = join(privateDir, "run.json"), journal = join(privateDir, "run-once.jsonl");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const cli = async (...args) => {
    try { return { ...(await promisify(execFile)(process.execPath, ["scripts/room-run.mjs", ...args], { timeout: 10000 })), code: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  };
  return { directory, privateDir, store, token, config, path, journal, cli };
}

test("CLI records a real run privately; status hides output and repeats cannot execute", async t => {
  const f = await fixture(t), run = await f.cli("run", f.privateDir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "done");
  assert.equal(run.stdout.includes("PRIVATE_OUTPUT"), false);
  const source = readFileSync(f.journal, "utf8");
  assert.equal(source.includes(f.token), false); assert.equal(statSync(f.journal).mode & 0o777, 0o600);
  assert.deepEqual(source.trim().split("\n").map(line => JSON.parse(line).state), ["reserved", "finished"]);
  const status = await f.cli("status", f.privateDir, "once");
  assert.equal(status.code, 0); assert.equal(status.stdout.includes("PRIVATE_OUTPUT"), false);
  const output = await f.cli("output", f.privateDir, "once");
  assert.equal(JSON.parse(output.stdout).output, "PRIVATE_OUTPUT\n");
  const again = await f.cli("run", f.privateDir);
  assert.equal(again.code, 1); assert.equal(JSON.parse(again.stderr).error, "run_exists");
  assert.equal(readFileSync(f.journal, "utf8"), source);
});

test("simultaneous invocations acquire exactly one private reservation", async t => {
  const f = await fixture(t), results = await Promise.allSettled([executeLocalRun(f.privateDir), executeLocalRun(f.privateDir)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "EEXIST");
  assert.equal(f.store.room("commons").state.workItems.task.attempt_count, 1);
});

test("private configuration rejects public files and linked paths before execution", async t => {
  const f = await fixture(t);
  chmodSync(f.path, 0o644);
  await assert.rejects(executeLocalRun(f.privateDir), /private_file_required/);
  chmodSync(f.path, 0o600);
  const link = join(f.directory, "linked-run"); symlinkSync(f.privateDir, link);
  await assert.rejects(executeLocalRun(link), /private_directory_required/);
  const original = join(f.directory, "original"); writeFileSync(original, "preserved", { mode: 0o600 });
  symlinkSync(original, f.journal);
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
  assert.equal(readFileSync(original, "utf8"), "preserved");
  assert.equal(f.store.room("commons").state.workItems.task.status, undefined);
});

test("a crash reservation or torn terminal record never authorizes a rerun", async t => {
  const f = await fixture(t);
  writeFileSync(f.journal, JSON.stringify({ version: 1, runId: "once", state: "reserved" }) + "\n", { mode: 0o600 });
  appendFileSync(f.journal, '{"version":1,"state":"finished"');
  assert.equal(inspectLocalRun(f.privateDir, "once").state, "reserved");
  assert.match(inspectLocalRun(f.privateDir, "once").message, /do not rerun/);
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
});

test("failed configuration after reservation records uncertainty without leaking arguments", async t => {
  const f = await fixture(t);
  f.config.command = "PRIVATE_BAD_COMMAND";
  writeFileSync(f.path, JSON.stringify(f.config), { mode: 0o600 });
  const result = await f.cli("run", f.privateDir);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).state, "unconfirmed");
  assert.equal((result.stdout + result.stderr).includes("PRIVATE_BAD_COMMAND"), false);
  assert.equal(readFileSync(f.journal, "utf8").includes("PRIVATE_BAD_COMMAND"), false);
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
});
