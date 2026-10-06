import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enroll } from "../../machine/lib/enroll.mjs";
import { MachineDaemon } from "../../machine/lib/daemon.mjs";
import { loadConfig } from "../../machine/lib/config.mjs";
import { acceptKey, createFrameParser, encodeFrame } from "../../machine/lib/ws.mjs";
import {
  claimOnSlot, expireCode, machineStatus, mint, postCall, readBody, secret, startRelay,
} from "./harness.mjs";

const INVITE = "RM-0123456789ABCDEF";

test("the room-machine daemon enrolls and says hello against the relay", async () => {
  const ctx = await startRelay({ passthrough: true, lockCacheMs: "0" });
  const room = await startRoomStub();
  const bridge = await startBridge(ctx);
  const homes = [];
  let daemon = null;
  try {
    const home = tempHome(homes);
    const env = machineEnv(home, bridge.origin, room.origin);
    const bogus = await enroll({ code: "bogus", home, env, relayHttp: bridge.origin, insecure: true });
    assert.equal(bogus.ok, false);
    assert.equal(bogus.error, "enroll_rejected");
    assert.equal(bogus.status, 401);

    const minted = await mint(ctx, {
      label: "Potter spare MacBook",
      rooms: ["room_alpha"],
      ownerMemberId: "mem_owner",
      inviteCode: INVITE,
      roomOrigin: room.origin,
      displayName: "Mac bot (contract)",
      passthroughOptIn: true,
      passthroughCaps: ["machine.status"],
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const enrolled = await enroll({ code: minted.body.code, home, env, relayHttp: bridge.origin, insecure: true });
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    assert.equal(enrolled.roomId, "room_alpha");
    assert.equal(enrolled.machineId, minted.body.machineId);
    const config = loadConfig(home);
    assert.equal(config.relayUrl, `ws://127.0.0.1:${bridge.port}/v0/machines/link`);
    assert.equal(config.roomOrigin, room.origin);
    assert.equal(config.displayName, "Mac bot (contract)");
    assert.equal(config.label, "Potter spare MacBook");

    const usedHome = tempHome(homes);
    const used = await enroll({
      code: minted.body.code, home: usedHome, env: machineEnv(usedHome, bridge.origin, room.origin), relayHttp: bridge.origin, insecure: true,
    });
    assert.equal(used.ok, false);
    assert.equal(used.error, "code_used");

    const expiring = await mint(ctx, {
      label: "Spare", rooms: ["room_alpha"], ownerMemberId: "mem_owner", inviteCode: INVITE, roomOrigin: room.origin,
    });
    assert.equal((await expireCode(ctx, expiring.body.machineId)).status, 200);
    const late = await enroll({
      code: expiring.body.code, home: tempHome(homes), env, relayHttp: bridge.origin, insecure: true,
    });
    assert.equal(late.ok, false);
    assert.equal(late.error, "code_expired");

    const token = secret("pri");
    ctx.room.person({ token, memberId: "mem_ada", identityId: "idn_ada", handle: "Ada", rooms: ["room_alpha"] });
    ctx.room.claims("room_alpha", [
      claimOnSlot({
        id: "claim_desk", owner: "mem_ada", machineId: minted.body.machineId, slot: "desk", at: Date.now() - 1000,
      }),
    ]);
    daemon = new MachineDaemon({ home, env });
    const started = await daemon.start();
    assert.equal(started.enrolled, true);
    const linked = await waitFor(async () => {
      const body = (await machineStatus(ctx, minted.body.machineId)).body;
      return body?.online && body.toolCount > 0 ? body : null;
    });
    assert.ok(linked.toolCount >= 1);
    const call = await postCall(ctx, minted.body.machineId, { tool: "machine.status", arguments: {} }, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(call.status, 200, JSON.stringify(call.body));
    assert.equal(call.body.isError, false, JSON.stringify(call.body));
    assert.equal(call.body.structuredContent.halted, false);
    assert.equal(call.body.structuredContent.deadman, false);
    assert.equal(call.body.structuredContent.error, undefined);
  } finally {
    if (daemon) await daemon.stop();
    await bridge.close();
    await room.close();
    await ctx.dispose();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

function machineEnv(home, relayHttp, roomOrigin) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ROOM_MACHINE_ENABLED: "1",
    ROOM_MACHINE_HOME: home,
    ROOM_MACHINE_RELAY_URL: relayHttp,
    ROOM_ORIGIN: roomOrigin,
  };
}

function tempHome(homes) {
  const home = mkdtempSync(join(tmpdir(), "room-machine-contract-"));
  homes.push(home);
  return home;
}

function trackSockets(server) {
  const sockets = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return sockets;
}

function closeServer(server, sockets) {
  return new Promise(done => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    server.close(done);
  });
}

function startRoomStub() {
  const server = createServer((req, res) => {
    res.setHeader("connection", "close");
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === "POST" && path === "/api/agent-identities") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ identityId: "ai_contract", secret: "sek_contract" }));
        return;
      }
      if (req.method === "POST" && path === "/api/agent-invites/redeem") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ roomId: "room_alpha", memberId: "mem_machine" }));
        return;
      }
      if (req.method === "POST" && path === "/api/agent-heartbeats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_stubbed" }));
    });
  });
  const sockets = trackSockets(server);
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => closeServer(server, sockets),
      });
    });
  });
}

function startBridge(ctx) {
  const server = createServer((req, res) => {
    res.setHeader("connection", "close");
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const target = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
        const body = Buffer.concat(chunks);
        const response = await ctx.mf.dispatchFetch(target, {
          method: req.method,
          headers: { "content-type": req.headers["content-type"] || "application/json" },
          ...(body.length ? { body } : {}),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        const headers = { connection: "close" };
        response.headers.forEach((value, key) => { headers[key] = value; });
        headers.connection = "close";
        res.writeHead(response.status, headers);
        res.end(bytes);
      } catch (error) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(error?.message ?? error));
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    pipeLink(ctx, server, req, socket, head).catch(() => {
      socket.destroy();
    });
  });
  const sockets = trackSockets(server);
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => closeServer(server, sockets),
      });
    });
  });
}

async function pipeLink(ctx, server, req, socket, head) {
  const target = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
  const response = await ctx.mf.dispatchFetch(target, {
    headers: {
      upgrade: "websocket",
      authorization: req.headers.authorization || "",
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    const failed = await readBody(response);
    socket.write(`HTTP/1.1 ${failed.status} Unauthorized\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(failed.body ?? {})}`);
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const ws = response.webSocket;
  let opened = false;
  const queued = [];
  const sendToDaemon = text => {
    const frame = encodeFrame(1, text, { mask: false });
    if (opened) socket.write(frame);
    else queued.push(frame);
  };
  ws.addEventListener("message", event => {
    Promise.resolve(frameText(event.data)).then(sendToDaemon);
  });
  ws.addEventListener("close", () => socket.end());
  ws.accept();
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "",
    "",
  ].join("\r\n"));
  opened = true;
  while (queued.length) socket.write(queued.shift());
  const parser = createFrameParser(frame => {
    if (frame.opcode === 9) {
      socket.write(encodeFrame(10, frame.payload, { mask: false }));
      return;
    }
    if (frame.opcode === 8) {
      try { ws.close(); } catch { /* already closed */ }
      return;
    }
    if (frame.opcode === 1) ws.send(frame.payload.toString("utf8"));
  });
  if (head?.length) parser(head);
  socket.on("data", parser);
  socket.on("error", () => {});
  socket.on("close", () => {
    try { ws.close(); } catch { /* already closed */ }
  });
}

function frameText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

async function waitFor(read, timeout = 5000) {
  const start = Date.now();
  let last = null;
  for (;;) {
    last = await read();
    if (last) return last;
    if (Date.now() - start > timeout) throw new Error(`timed out; last ${JSON.stringify(last)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
