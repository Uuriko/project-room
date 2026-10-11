import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSocket } from "../lib/ws.mjs";
import { startFakeRelay } from "./fake-relay.mjs";
import { MachineDaemon } from "../lib/daemon.mjs";

async function fixture(t, onConnection) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}/`;
}

function daemon(t) {
  const home = mkdtempSync(join(tmpdir(), "room-transport-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return new MachineDaemon({ home, env: {} });
}

for (const scenario of ["silent", "oversized", "rejected"]) {
  test(`socket retires a ${scenario} handshake exactly once`, { timeout: 2000 }, async t => {
    const url = await fixture(t, socket => {
      socket.once("data", () => {
        if (scenario === "oversized") socket.write("HTTP/1.1 101\r\nX:" + "x".repeat(17000));
        if (scenario === "rejected") socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      });
    });
    let closes = 0;
    let link;
    await new Promise(resolve => {
      link = connectSocket(url, { connectTimeoutMs: scenario === "silent" ? 50 : 1000,
        onOpen: () => assert.fail("invalid peer cannot open"),
        onClose: () => { closes++; resolve(); } });
      t.after(() => link.close());
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(link.socket.destroyed, true);
    assert.equal(closes, 1);
  });
}

test("dead-peer timeout retires the socket and remains gated until peer recovery", async t => {
  const d = daemon(t);
  let closes = 0;
  d.socket = { close() { closes++; } };
  d.lastInbound = Date.now() - d.deadmanMs() - 100;
  await d.tick();
  assert.equal(closes, 1);
  assert.equal(d.socket, null);
  assert.equal(d.state.deadman, true);
  await d.tick();
  assert.equal(closes, 1);
  await d.handleRaw(JSON.stringify({ type: "heartbeat" }));
  assert.equal(d.state.deadman, false);
});

test("queued calls from a retired connection never execute", async t => {
  const d = daemon(t);
  const old = {};
  d.socket = old;
  let release;
  d.control = new Promise(resolve => { release = resolve; });
  let calls = 0;
  d.call = async () => { calls++; return {}; };
  const waiting = d.receive(JSON.stringify({ type: "call", id: "old" }), old);
  d.socket = {};
  release();
  await waiting;
  assert.equal(calls, 0);
});

test("in-flight old results cannot be sent on a replacement connection", async t => {
  const d = daemon(t);
  const sent = [];
  const old = { send: value => sent.push(value) };
  d.socket = old;
  let finish;
  d.call = () => new Promise(resolve => { finish = resolve; });
  const pending = d.handleRaw(JSON.stringify({ type: "call", id: "same-id" }), old);
  d.socket = { send: value => sent.push(value) };
  finish({ type: "result", id: "same-id", ok: true });
  await pending;
  assert.deepEqual(sent, []);
});

test("Stop closes transport before waiting for bot cleanup", async t => {
  const d = daemon(t);
  let closed = false;
  let finish;
  d.socket = { close() { closed = true; } };
  d.botStop = () => new Promise(resolve => { finish = resolve; });
  const pending = d.stop();
  assert.equal(closed, true);
  assert.equal(d.socket, null);
  finish();
  await pending;
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("transport recovery timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("a silent open relay is replaced and requires a fresh heartbeat", { timeout: 3000 }, async t => {
  const d = daemon(t);
  const relay = await startFakeRelay();
  t.after(async () => { await d.stop(); await relay.close(); });
  relay.mint("unused", { machineToken: "test-token" });
  d.token = "test-token";
  d.config.relayUrl = relay.ws;
  d.config.reconnectBackoffMs = 10;
  d.connectLoop();
  await waitFor(() => relay.hellos.length === 1);
  const first = d.socket;
  d.lastInbound = Date.now() - d.deadmanMs() - 100;
  await d.tick();
  await waitFor(() => relay.hellos.length === 2);
  assert.notEqual(d.socket, first);
  assert.equal(first.socket.destroyed, true);
  assert.equal(d.state.deadman, true);
  relay.send({ type: "heartbeat" });
  await waitFor(() => !d.state.deadman);
});
