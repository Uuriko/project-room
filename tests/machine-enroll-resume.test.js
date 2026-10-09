import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { spawnContext } from "../machine/lib/spawn.mjs";
import { loadConfig } from "../machine/lib/config.mjs";
import { readSecret } from "../machine/lib/secrets.mjs";
import { enroll } from "../machine/lib/enroll.mjs";
import { startFakeRelay } from "../machine/test/fake-relay.mjs";

// The relay spends the one-time enroll code on the exchange, and three Room
// calls follow it (identity mint, invite redeem, heartbeat). When one of them
// fails (the daily identity limit, a 5xx, a dropped connection), running
// enroll again with the same code must finish the job. Before this, the retry
// got 410 code_used from the relay and the Mac stayed half-enrolled until the
// owner minted a new machine.
const fakes = fileURLToPath(new URL("../machine/fakes/", import.meta.url));

function machineEnv(home, extra = {}) {
  return {
    PATH: `${fakes}:${process.env.PATH}`, HOME: home, TMPDIR: home, LANG: "C", LC_ALL: "C",
    USER: "room", LOGNAME: "room", TERM: "dumb", ROOM_MACHINE_ENABLED: "1", ROOM_MACHINE_HOME: home, ...extra,
  };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// A real Room server behind a proxy that fails chosen calls a set number of
// times, and counts what reached it.
async function flakyRoom(t, failures) {
  const directory = mkdtempSync(join(tmpdir(), "room-enroll-resume-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  const target = new URL(await listen(server));
  const seen = [];
  const proxy = createServer((req, res) => {
    const key = `${req.method} ${new URL(req.url, "http://x").pathname}`;
    seen.push(key);
    const failure = failures[key];
    if (failure && failure.times > 0) {
      failure.times -= 1;
      req.resume();
      res.writeHead(failure.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: failure.code, message: "injected" } }));
      return;
    }
    // The Room server only answers its own host and origin.
    const headers = { ...req.headers, host: target.host };
    if (headers.origin) headers.origin = target.origin;
    const forward = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    req.pipe(forward);
  });
  const origin = await listen(proxy);
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const invite = await fetch(new URL("/api/rooms/commons/agent-invites", origin), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}`, origin },
    body: JSON.stringify({ profile: "contribute", displayName: "Room machine" }),
  });
  assert.equal(invite.status, 201, await invite.clone().text());
  const { code: inviteCode } = await invite.json();
  return { origin, inviteCode, seen, minted: () => seen.filter(key => key === "POST /api/agent-identities").length };
}

async function setup(t, failures) {
  const room = await flakyRoom(t, failures);
  const relay = await startFakeRelay();
  const home = mkdtempSync(join(tmpdir(), "room-machine-enroll-"));
  writeFileSync(join(home, "argv-log"), "");
  writeFileSync(join(home, "env-log"), "");
  t.after(async () => {
    await relay.close();
    rmSync(home, { recursive: true, force: true });
  });
  relay.mint("one-time", {
    machineToken: "tok-enroll-resume",
    machineId: "mac-1",
    label: "spare",
    roomId: "commons",
    ownerMemberId: "owner",
    inviteCode: room.inviteCode,
    displayName: "Room machine",
    relayUrl: relay.ws,
    roomOrigin: room.origin,
  });
  const env = machineEnv(home, { ROOM_ORIGIN: room.origin });
  const run = code => spawnContext.run({ env }, () => enroll({ code, home, env, relayHttp: relay.http, insecure: true }));
  return { room, relay, home, env, run };
}

async function heartbeatHosts(origin, secret) {
  const response = await fetch(new URL("/api/agent-heartbeats", origin), {
    headers: { authorization: `Bearer ${secret}`, accept: "application/json", origin },
  });
  return { status: response.status, json: await response.json() };
}

test("enroll resumes with the same code after the heartbeat fails, without a second identity", async t => {
  const { room, home, env, run } = await setup(t, {
    "POST /api/agent-heartbeats": { times: 1, status: 503, code: "unavailable" },
  });
  const first = await run("one-time");
  assert.equal(first.ok, false);
  assert.equal(first.error, "heartbeat_failed");
  assert.equal(first.resumable, true);
  assert.match(first.next, /same code/);
  assert.equal(loadConfig(home).enabled, false);

  const second = await run("one-time");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(room.minted(), 1, "the Room identity is minted once and reused");
  const config = loadConfig(home);
  assert.equal(config.enabled, true);
  assert.equal(config.roomId, "commons");
  assert.equal(config.machineId, "mac-1");
  assert.equal(config.pendingEnroll, undefined);
  const secret = await spawnContext.run({ env }, () => readSecret("identity", home));
  const hosts = await heartbeatHosts(room.origin, secret);
  assert.equal(hosts.status, 200, JSON.stringify(hosts.json));
  assert.equal(hosts.json.hosts[0].hostId, "room-machine");
  assert.equal(await spawnContext.run({ env }, () => readSecret("machine", home)), "tok-enroll-resume");
});

test("enroll resumes with the same code after the identity mint is refused (daily limit)", async t => {
  const { room, home, run } = await setup(t, {
    "POST /api/agent-identities": { times: 1, status: 429, code: "identity_rate_limited" },
  });
  const first = await run("one-time");
  assert.equal(first.ok, false);
  assert.equal(first.error, "identity_rate_limited");

  const second = await run("one-time");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(loadConfig(home).enabled, true);
  assert.equal(room.minted(), 2, "the refused mint plus the one that worked");
});

test("enroll resumes after the invite redeem fails, and a finished enroll is not redone", async t => {
  const { room, home, run } = await setup(t, {
    "POST /api/agent-invites/redeem": { times: 1, status: 502, code: "bad_gateway" },
  });
  const first = await run("one-time");
  assert.equal(first.ok, false);
  const second = await run("one-time");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(room.minted(), 1);
  // Once enrolled, the code is spent for good: the relay answers code_used and
  // nothing on the Mac or in the Room is touched again.
  const before = room.seen.length;
  const third = await run("one-time");
  assert.equal(third.ok, false);
  assert.equal(third.error, "code_used");
  assert.equal(room.seen.length, before);
  assert.equal(loadConfig(home).enabled, true);
});

test("a different code never resumes someone else's pending enroll", async t => {
  const { room, home, run } = await setup(t, {
    "POST /api/agent-heartbeats": { times: 1, status: 503, code: "unavailable" },
  });
  const first = await run("one-time");
  assert.equal(first.ok, false);
  const before = room.seen.length;
  const wrong = await run("not-the-code");
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, "enroll_rejected");
  assert.equal(wrong.status, 401);
  assert.equal(room.seen.length, before);
  assert.equal(loadConfig(home).enabled, false);
});
