// The external probe Worker notifies after two consecutive failed runs, and
// stays quiet after one. Checks and notices go through real HTTP. The ops
// room post is a real message.posted command on a real room store.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import worker from "../cloudflare/external-probe-worker.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function httpServer(t, handler) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      handler(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

function memoryKv() {
  const values = new Map();
  return {
    async get(key, type) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, String(value)); }
  };
}

function watchFetch(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    calls.push({ url, method: (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), authorization: headers.get("authorization") });
    return original(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function opsRoom(t) {
  const directory = mkdtempSync(join(tmpdir(), "external-probe-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("ops"));
  const ownerKey = store.issueAccessKey("ops", "owner");
  const invite = store.invites.create(ownerKey, "ops", { profile: "chat" });
  const server = createRoomServer({ store });
  const origin = await listen(server);
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await close(server);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const redeemed = await fetch(`${origin}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: invite.code, displayName: "Probe" })
  });
  const body = await redeemed.json();
  assert.equal(redeemed.status, 201, JSON.stringify(body));
  assert.equal(typeof body.mcpToken?.credential, "string");
  return { origin, token: body.mcpToken.credential, roomId: "ops" };
}

async function probeMessages(origin, token) {
  const response = await fetch(`${origin}/api/rooms/ops/events?after=0&limit=100`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return (body.events ?? [])
    .map(row => row.event)
    .filter(event => event?.type === "message.posted" && String(event.data?.body ?? "").startsWith("External probe:"))
    .map(event => event.data.body);
}

async function run(env) {
  return worker.scheduled({}, env, { waitUntil() {} });
}

test("a healthy room passes ready, anonymous tools/list, and llms.txt without a notice", async t => {
  const room = await opsRoom(t);
  const calls = watchFetch(t);
  const result = await run({ PROBE_ORIGIN: room.origin, PROBE_STATE: memoryKv() });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.checks.map(check => check.id), ["ready", "mcp", "llms"]);
  assert.ok(result.checks.every(check => check.ok), JSON.stringify(result.checks));
  assert.deepEqual(result.alerts, []);
  const mcp = calls.filter(call => call.url === `${room.origin}/mcp`);
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0].method, "POST");
  assert.equal(mcp[0].authorization, null);
  assert.deepEqual(await probeMessages(room.origin, room.token), []);
});

test("the worker alerts on the second consecutive failure and not on the first", async t => {
  const room = await opsRoom(t);
  const hooks = [];
  const webhook = await httpServer(t, (req, res, body) => {
    hooks.push(JSON.parse(body));
    res.writeHead(204);
    res.end();
  });
  const down = await httpServer(t, (_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "unavailable" }));
  });
  const env = {
    PROBE_ORIGIN: down,
    PROBE_STATE: memoryKv(),
    PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook`,
    ROOM_AGENT_ORIGIN: room.origin,
    ROOM_AGENT_ROOM: room.roomId,
    ROOM_AGENT_TOKEN: room.token
  };
  const first = await run(env);
  assert.equal(first.ok, false);
  assert.equal(first.consecutiveFailures, 1);
  assert.deepEqual(first.alerts, []);
  assert.deepEqual(hooks, []);
  assert.deepEqual(await probeMessages(room.origin, room.token), []);

  const second = await run(env);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].kind, "outage");
  assert.equal(hooks[0].consecutiveFailures, 2);
  assert.equal(hooks[0].origin, down);
  assert.ok(hooks[0].checks.every(check => check.ok === false));
  assert.equal(JSON.stringify(hooks[0]).includes(room.token), false);
  const outage = await probeMessages(room.origin, room.token);
  assert.equal(outage.length, 1);
  assert.match(outage[0], /failed two probe runs in a row/);
  assert.equal(outage[0].includes(room.token), false);
  assert.match(outage[0], /ready failed \(HTTP 503\)/);
  assert.match(outage[0], /The 6-hour GitHub probes still run the deep checks/);

  const third = await run(env);
  assert.equal(third.consecutiveFailures, 3);
  assert.deepEqual(third.alerts, []);
  assert.equal(hooks.length, 1);
  assert.equal((await probeMessages(room.origin, room.token)).length, 1);

  env.PROBE_ORIGIN = room.origin;
  const recovered = await run(env);
  assert.equal(recovered.ok, true);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[1].kind, "recovery");
  assert.equal(hooks[1].incidentId, hooks[0].incidentId);
  const afterRecovery = await probeMessages(room.origin, room.token);
  assert.equal(afterRecovery.length, 2);
  assert.match(afterRecovery[1], /is answering again/);

  env.PROBE_ORIGIN = down;
  const again = await run(env);
  assert.equal(again.consecutiveFailures, 1);
  assert.deepEqual(again.alerts, []);
  assert.equal(hooks.length, 2);
  assert.equal((await probeMessages(room.origin, room.token)).length, 2);
});

test("one failed run followed by a pass does not notify, including no recovery", async t => {
  const room = await opsRoom(t);
  const hooks = [];
  const webhook = await httpServer(t, (_req, res, body) => {
    hooks.push(body);
    res.writeHead(204);
    res.end();
  });
  const redirect = await httpServer(t, (_req, res) => {
    res.writeHead(302, { location: "/elsewhere" });
    res.end();
  });
  const env = {
    PROBE_ORIGIN: redirect,
    PROBE_STATE: memoryKv(),
    PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook`,
    PROBE_ROOM_ORIGIN: room.origin,
    PROBE_ROOM_ID: room.roomId,
    PROBE_ROOM_TOKEN: room.token,
    ROOM_AGENT_ORIGIN: "http://127.0.0.1:9",
    ROOM_AGENT_ROOM: "other-room",
    ROOM_AGENT_TOKEN: "not-the-ops-token"
  };
  const failed = await run(env);
  assert.equal(failed.consecutiveFailures, 1);
  assert.ok(failed.checks.every(check => check.ok === false && check.status === 302), JSON.stringify(failed.checks));
  env.PROBE_ORIGIN = room.origin;
  const passed = await run(env);
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.alerts, []);
  assert.deepEqual(hooks, []);
  assert.deepEqual(await probeMessages(room.origin, room.token), []);
});

test("a missing destination stays quiet while the other still notifies", async t => {
  const room = await opsRoom(t);
  const hooks = [];
  const webhook = await httpServer(t, (_req, res, body) => {
    hooks.push(JSON.parse(body));
    res.writeHead(204);
    res.end();
  });
  const down = await httpServer(t, (_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("no");
  });
  const kv = memoryKv();
  const roomOnly = {
    PROBE_ORIGIN: down,
    PROBE_STATE: kv,
    PROBE_ROOM_ORIGIN: room.origin,
    PROBE_ROOM_ID: room.roomId,
    PROBE_ROOM_TOKEN: room.token
  };
  await run(roomOnly);
  const posted = await run(roomOnly);
  assert.equal(hooks.length, 0);
  assert.equal(posted.alerts.find(alert => alert.destination === "webhook").inert, "unset");
  assert.equal(posted.alerts.find(alert => alert.destination === "room").ok, true);
  assert.equal((await probeMessages(room.origin, room.token)).length, 1);

  const sinkHits = [];
  const sink = await httpServer(t, (req, res, body) => {
    if (req.url.includes("/commands")) sinkHits.push(body);
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  const calls = watchFetch(t);
  const webhookOnly = {
    PROBE_ORIGIN: down,
    PROBE_STATE: memoryKv(),
    PROBE_ALERT_WEBHOOK_URL: "http://203.0.113.10/hook",
    PROBE_ROOM_ORIGIN: room.origin,
    PROBE_ROOM_ID: room.roomId,
    PROBE_ROOM_TOKEN: room.token,
    ROOM_AGENT_ORIGIN: sink,
    ROOM_AGENT_ROOM: "ops",
    ROOM_AGENT_TOKEN: "alias-token-not-used"
  };
  await run(webhookOnly);
  const invalidWebhook = await run(webhookOnly);
  assert.equal(invalidWebhook.alerts.find(alert => alert.destination === "webhook").inert, "invalid");
  assert.equal(calls.some(call => call.url.includes("203.0.113.10")), false);
  assert.deepEqual(sinkHits, []);
  assert.equal((await probeMessages(room.origin, room.token)).length, 2);

  const noRoom = {
    PROBE_ORIGIN: down,
    PROBE_STATE: memoryKv(),
    PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook`
  };
  await run(noRoom);
  const hooked = await run(noRoom);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].kind, "outage");
  assert.equal(hooked.alerts.find(alert => alert.destination === "room").inert, "unset");
  assert.equal((await probeMessages(room.origin, room.token)).length, 2);

  const unbound = await run({ PROBE_ORIGIN: down, PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook` });
  await run({ PROBE_ORIGIN: down, PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook` });
  assert.equal(unbound.error, "state_unbound");
  assert.equal(hooks.length, 1);
});

test("one failing check fails the run, and a hung check times out", async t => {
  const partial = await httpServer(t, (req, res) => {
    if (req.url === "/api/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready" }));
      return;
    }
    if (req.url === "/llms.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("# Uuriko Project Room\n");
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  const kv = memoryKv();
  const env = { PROBE_ORIGIN: partial, PROBE_STATE: kv };
  const once = await run(env);
  assert.equal(once.ok, false);
  assert.equal(once.checks.find(check => check.id === "ready").ok, true);
  assert.equal(once.checks.find(check => check.id === "llms").ok, true);
  assert.equal(once.checks.find(check => check.id === "mcp").status, 500);
  assert.deepEqual(once.alerts, []);
  const twice = await run(env);
  assert.equal(twice.consecutiveFailures, 2);
  assert.match(twice.alerts.find(alert => alert.destination === "room").inert, /unset/);

  const hung = createServer(() => {});
  const origin = await listen(hung);
  t.after(() => { hung.closeAllConnections(); return close(hung); });
  const timed = await run({ PROBE_ORIGIN: origin, PROBE_STATE: memoryKv(), PROBE_CHECK_TIMEOUT_MS: "200" });
  assert.ok(timed.checks.every(check => check.reason === "timeout"), JSON.stringify(timed.checks));
  assert.equal(timed.consecutiveFailures, 1);
  assert.deepEqual(timed.alerts, []);
});

test("a streak that cannot be saved does not notify", async t => {
  const hooks = [];
  const webhook = await httpServer(t, (_req, res, body) => {
    hooks.push(body);
    res.writeHead(204);
    res.end();
  });
  const down = await httpServer(t, (_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end("{}");
  });
  const kv = memoryKv();
  kv.put = async () => { throw new Error("kv down"); };
  const env = { PROBE_ORIGIN: down, PROBE_STATE: kv, PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook` };
  const first = await run(env);
  const second = await run(env);
  assert.equal(first.error, "state_unwritable");
  assert.equal(second.error, "state_unwritable");
  assert.deepEqual(first.alerts, []);
  assert.deepEqual(second.alerts, []);
  assert.deepEqual(hooks, []);
});

test("fetch does not run the probe", async t => {
  const calls = watchFetch(t);
  const response = await worker.fetch(new Request("https://probe.invalid/"));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /schedule/);
  assert.deepEqual(calls, []);
});
