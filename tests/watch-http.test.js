import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const script = new URL("../scripts/agent-inbox.mjs", import.meta.url).pathname;
function cli(args, env = {}) {
  const child = spawn(process.execPath, [script, "watch", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done };
}
const lines = value => value.trim() ? value.trim().split("\n").map(line => JSON.parse(line)) : [];
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

test("actual foreground CLI uses authenticated GETs only; restart is quiet and key rotation preserves identity", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-watch-http-"));
  const store = new RoomStore(":memory:"); store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-worker", type: T.MEMBER_ADDED, data: {
    memberId: "worker", displayName: "Synthetic worker", kind: "agent", accountableHumanId: "owner", permissions: ["accept_work", "complete_work"]
  } });
  let workerKey = store.issueAccessKey("commons", "worker");
  store.command(ownerKey, "commons", { id: "post-source", type: T.MESSAGE_POSTED, data: { messageId: "source", body: "Synthetic local watcher test only." } });
  store.command(ownerKey, "commons", { id: "propose", type: T.WORK_PROPOSED, data: {
    workItemId: "sample", title: "Check the welcome text", definitionOfDone: "A reviewed suggestion, not an executed change.", sourceMessageId: "source",
    accountableMemberId: "worker", verifierMemberId: "owner", independentVerificationRequired: false,
    ownerDecisionRequired: false, humanDecisionMakerId: "owner", mode: "read"
  } });
  store.markCaughtUp(workerKey, "commons", 2);
  const server = createRoomServer({ store });
  const requests = []; server.prependListener("request", request => requests.push({ method: request.method, path: request.url }));
  const origin = await listen(server), state = join(directory, "private-watch");
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const env = () => ({ ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_TOKEN: workerKey });
  const before = store.snapshot(workerKey, "commons");
  const first = await cli(["start", state, "--once"], env()).done;
  assert.equal(first.code, 0, first.stderr);
  const notices = lines(first.stdout);
  assert.equal(notices.length, 1); assert.equal(notices[0].reason, "initial");
  assert.equal(notices[0].workItemId, "sample"); assert.equal(notices[0].next.action, "accept");
  assert.equal(notices[0].notifyOnly, true); assert.ok(!first.stdout.includes(workerKey)); assert.ok(!first.stderr.includes(workerKey));
  assert.deepEqual(store.snapshot(workerKey, "commons"), before, "watching neither mutates Room nor changes the human read marker");
  const second = await cli(["start", state, "--once"], env()).done;
  assert.equal(second.code, 0, second.stderr); assert.equal(second.stdout, "");
  workerKey = store.issueAccessKey("commons", "worker");
  const rotated = await cli(["start", state, "--once"], env()).done;
  assert.equal(rotated.code, 0, rotated.stderr); assert.equal(rotated.stdout, "");
  const wrongMember = await cli(["start", state, "--once"], { ...env(), ROOM_AGENT_TOKEN: ownerKey }).done;
  assert.equal(wrongMember.code, 1); assert.equal(wrongMember.stdout, ""); assert.match(wrongMember.stderr, /identity_changed/);
  store.revoke(workerKey);
  const revoked = await cli(["start", state, "--once"], env()).done;
  assert.equal(revoked.code, 1); assert.equal(revoked.stdout, ""); assert.match(revoked.stderr, /access_ended/);
  assert.ok(requests.length > 5); assert.ok(requests.every(request => request.method === "GET"));
  assert.ok(requests.every(request => /^\/api\/rooms\/commons(?:\?|\/events\?|$)/.test(request.path)));
  const requestCount = requests.length;
  const status = await cli(["status", state]).done;
  assert.equal(status.code, 0); assert.equal(lines(status.stdout)[0].state, "stopped");
  assert.equal(lines(status.stdout)[0].pending, 0); assert.equal(requests.length, requestCount);
  if (process.env.ROOM_WATCH_TEST_EVIDENCE === "1") console.log(JSON.stringify({ evidence: "synthetic-local-http-cli",
    initialNotice: notices[0], unchangedRestartStdout: second.stdout, sameMemberRotatedStdout: rotated.stdout,
    wrongMemberExit: wrongMember.code, revokedExit: revoked.code, requestMethods: [...new Set(requests.map(request => request.method))],
    humanCursor: before.cursor, finalLocalStatus: lines(status.stdout)[0] }));
});

test("a separate stop command interrupts an in-flight HTTP read and does not claim acknowledged stop", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-watch-stop-http-"));
  let received; const requested = new Promise(resolve => received = resolve);
  const server = createServer((request, response) => { received(); /* deliberately held local read */ });
  const origin = await listen(server), state = join(directory, "private-watch");
  const running = cli(["start", state], { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_TOKEN: "x".repeat(43) });
  t.after(async () => { running.child.kill("SIGKILL"); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  await requested;
  const status = await cli(["status", state]).done;
  assert.equal(lines(status.stdout)[0].state, "held"); assert.equal(lines(status.stdout)[0].health, "starting");
  const stopped = await cli(["stop", state]).done;
  assert.equal(stopped.code, 0, stopped.stderr); assert.equal(lines(stopped.stdout)[0].state, "stop_requested");
  const finished = await running.done;
  assert.equal(finished.code, 0, finished.stderr); assert.equal(finished.stdout, ""); assert.match(finished.stderr, /"state":"stopped"/);
  const after = await cli(["status", state]).done;
  assert.equal(lines(after.stdout)[0].state, "stopped"); assert.equal(lines(after.stdout)[0].lastCheckedAt, null);
});
