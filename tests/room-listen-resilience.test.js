// Owner: the always-on listener loops (scripts/room-listen.mjs poll mode,
// client/claude-channel.mjs via scripts/agent-claude-channel.mjs).
// Contract: ONE transient failure of the wake poll (an HTTP 500, as a
// redeploy or restart produces) must not end the listener: the process
// stays alive, backs off, retries, and later wakes are still delivered.
// Credible regression: the pre-fix behavior — both loops wrapped the whole
// wait loop in a single try/catch, so the first 500 exited the shipped
// listener (exit 1, service_unavailable) and every later wake was lost
// until a human restarted it. Existing wake tests never fail a poll
// mid-run, so nothing else covers survival.
// Method: real child processes against a real local Room server behind a
// loopback proxy that answers exactly one armed poll request with a 500.
// Synthetic fixtures only — no external calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, roomId) {
  const store = new RoomStore(":memory:");
  const owner = store.identities.create("Resilience owner");
  const agent = store.identities.create("Resilience receiver");
  new AgentRooms(store).create(owner.secret, { roomId, title: "Resilience", purpose: "Synthetic listener survival" });
  linkWithProof(store, owner.secret, roomId, agent, { memberId: "receiver", displayName: "Receiver", permissions: [] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;

  // Loopback proxy: forwards everything, answers one armed poll with a 500.
  let armed = false, injected = 0;
  const proxy = createServer(async (req, res) => {
    if (armed && req.url.includes("/api/agent-wakes/poll")) {
      armed = false; injected += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal", message: "injected transient failure" } }));
      return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers, host: new URL(origin).host };
    if (headers.origin) headers.origin = origin;
    const upstream = await fetch(origin + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));

  const directory = mkdtempSync(join(tmpdir(), "room-listen-resilience-"));
  const config = join(directory, "private");
  saveAgentConnection(config, { version: 1, origin: "http://127.0.0.1:" + proxy.address().port, roomId, memberId: "receiver", token: agent.secret });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    proxy.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const enqueue = messageId => store.agentHeartbeats.enqueueWake({ agentId: agent.identityId, kind: "mention", roomId, messageId }).signal;
  const env = { ...process.env, ROOM_AGENT_CONFIG: config, NODE_NO_WARNINGS: "1" };
  for (const name of ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"]) delete env[name];
  return { enqueue, env, children, arm: () => { armed = true; }, injected: () => injected };
}

async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return; await sleep(100); }
  throw new Error("Timed out waiting for " + label);
}

test("poll listener survives one injected 500 and keeps delivering wakes", async t => {
  const f = await fixture(t, "listen-survival-room");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/room-listen.mjs", import.meta.url)),
    "--mode", "poll", "--host", "survival-host", "--cadence-seconds", "5"], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  f.children.push(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const pointers = id => stdout.split("\n").filter(line => line.includes('"signalId"') && line.includes(id)).length;

  f.enqueue("survival-1");
  await until(() => pointers("survival-1") === 1, 20000, "first pointer");

  // Release the parked poll with a second wake; the NEXT poll request gets
  // the injected 500.
  f.arm();
  f.enqueue("survival-2");
  await until(() => f.injected() === 1, 30000, "the injected 500");
  await sleep(500);
  assert.equal(child.exitCode, null, "listener must still be alive after one transient 500; stderr: " + stderr.trim().split("\n").at(-1));

  f.enqueue("survival-3");
  await until(() => pointers("survival-3") === 1, 30000, "post-fault pointer");
  assert.equal(child.exitCode, null, "listener still running after recovery");
});

test("channel listener survives one injected 500 and keeps notifying", async t => {
  const f = await fixture(t, "channel-survival-room");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/agent-claude-channel.mjs", import.meta.url)),
    "--host", "survival-channel", "--cadence-seconds", "5"], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  f.children.push(child);
  let buffer = "", stderr = "";
  const frames = [];
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const send = frame => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "resilience-peer", version: "1" } } });
  await until(() => frames.some(frame => frame.id === 1), 20000, "initialize response");
  send({ method: "notifications/initialized" });
  const notified = id => frames.some(frame => frame.method === "notifications/claude/channel" && JSON.stringify(frame.params?.meta ?? {}).includes(id));

  const first = f.enqueue("channel-survival-1");
  await until(() => notified(first.signalId), 30000, "first channel notification");

  f.arm();
  const second = f.enqueue("channel-survival-2");
  await until(() => notified(second.signalId), 30000, "second channel notification");
  await until(() => f.injected() === 1, 30000, "the injected 500");
  await sleep(500);
  assert.equal(child.exitCode, null, "channel must still be alive after one transient 500; stderr: " + stderr.trim().split("\n").at(-1));

  const third = f.enqueue("channel-survival-3");
  await until(() => notified(third.signalId), 30000, "post-fault channel notification");
  assert.equal(child.exitCode, null, "channel still running after recovery");
});
