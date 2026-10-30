// 2026-10-24: /api/health stayed ok while room reads returned 503 and the
// five-minute probe, which never opens a room, stayed quiet. This check
// is that outage. The second failed read alerts once into the muse room.
// A later read of the posted nonce sends one recovery notice. Neither
// notice contains the scoped token.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "./external-probe-worker.mjs";
import { runExternalProbe } from "./external-probe.mjs";

const ORIGIN = "https://probe.example";
const QA_TOKEN = "qa-probe-scoped-token";
const MUSE_TOKEN = "muse-room-alert-token";
const QA_ROOM = "qa-external-probe";

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

function response(status, body, type = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": type } });
}

test("a health-ok origin that 503s room reads alerts once on the second run and recovers once", async () => {
  const kv = memoryKv();
  const notices = [];
  const hooks = [];
  const calls = [];
  let readStatus = 503;
  let postedBody = null;
  let openBody = null;

  const fetchImpl = async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ url, method, authorization: headers.get("authorization") });
    const parsed = new URL(url);
    if (parsed.origin === "https://muse.example" && parsed.pathname === "/api/rooms/muse-room/commands" && method === "POST") {
      const command = JSON.parse(init.body);
      notices.push(typeof command?.data?.body === "string" ? command.data.body : "");
      return response(200, {});
    }
    if (parsed.origin === "https://alerts.example" && parsed.pathname === "/hook" && method === "POST") {
      hooks.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname === "/api/health" && method === "GET") return response(200, { status: "ok" });
    if (parsed.pathname === "/api/ready" && method === "GET") return response(200, { status: "ready" });
    if (parsed.pathname === "/mcp" && method === "POST") {
      return response(200, { jsonrpc: "2.0", result: { tools: [{ name: "room_status" }] } });
    }
    if (parsed.pathname === "/llms.txt" && method === "GET") return response(200, "# Uuriko Project Room\n", "text/plain");
    if (parsed.pathname === "/api/health/jobs" && method === "GET") {
      return response(200, {
        schema: "room.job-health/1",
        status: "ok",
        jobs: [{ name: "integrity", status: "ok", stale: false, consecutiveFailures: 0 }]
      });
    }
    if (parsed.pathname === "/api/agent-rooms" && method === "POST") {
      openBody = init.body;
      return response(201, { roomId: QA_ROOM, duplicate: false });
    }
    if (parsed.pathname === `/api/rooms/${QA_ROOM}/commands` && method === "POST") {
      const command = JSON.parse(init.body);
      postedBody = typeof command?.data?.body === "string" ? command.data.body : null;
      return response(201, {});
    }
    if (parsed.pathname === `/api/rooms/${QA_ROOM}/conversation` && method === "GET") {
      if (readStatus !== 200) return response(readStatus, { status: "unavailable" });
      return response(200, { mode: "replace", messages: postedBody ? [{ id: "probe-msg", body: postedBody }] : [] });
    }
    return response(404, {});
  };

  const health = await fetchImpl(`${ORIGIN}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const readProbe = await fetchImpl(`${ORIGIN}/api/rooms/${QA_ROOM}/conversation?limit=1`);
  assert.equal(readProbe.status, 503);

  const env = {
    PROBE_ORIGIN: ORIGIN,
    PROBE_STATE: kv,
    PROBE_QA_TOKEN: QA_TOKEN,
    PROBE_NONCE_EVERY: "1",
    PROBE_ALERT_WEBHOOK_URL: "https://alerts.example/hook",
    PROBE_ROOM_ORIGIN: "https://muse.example",
    PROBE_ROOM_ID: "muse-room",
    PROBE_ROOM_TOKEN: MUSE_TOKEN
  };

  const first = await runExternalProbe(env, fetchImpl);
  assert.equal(first.ok, false, "a 503 room read must fail the probe while /api/health still says ok");
  assert.equal(first.checks.find(check => check.id === "ready")?.ok, true);
  assert.equal(first.checks.find(check => check.id === "room-read")?.status, 503);
  assert.equal(typeof first.checks.find(check => check.id === "room-read")?.latencyMs, "number");
  assert.deepEqual(first.alerts, []);
  assert.deepEqual(notices, []);

  const second = await runExternalProbe(env, fetchImpl);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(notices.length, 1);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].kind, "outage");
  assert.equal(hooks[0].checks.find(check => check.id === "room-read")?.status, 503);
  assert.match(notices[0], /room-read failed \(HTTP 503\)/);
  assert.equal(notices[0].includes(QA_TOKEN), false);
  assert.equal(notices[0].includes(MUSE_TOKEN), false);
  assert.equal(JSON.stringify(hooks[0]).includes(QA_TOKEN), false);
  assert.equal(JSON.stringify(hooks[0]).includes(MUSE_TOKEN), false);
  assert.equal(second.alerts.filter(alert => alert.destination === "room" && alert.kind === "outage" && alert.ok === true).length, 1);

  const third = await runExternalProbe(env, fetchImpl);
  assert.equal(third.consecutiveFailures, 3);
  assert.deepEqual(third.alerts, []);
  assert.equal(notices.length, 1);
  assert.equal(hooks.length, 1);

  readStatus = 200;
  const recovered = await runExternalProbe(env, fetchImpl);
  assert.equal(recovered.ok, true, JSON.stringify(recovered.checks));
  assert.equal(notices.length, 2);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[1].kind, "recovery");
  assert.equal(hooks[1].incidentId, hooks[0].incidentId);
  assert.match(notices[1], /is answering again/);
  assert.equal(notices[1].includes(QA_TOKEN), false);
  assert.equal(notices[1].includes(MUSE_TOKEN), false);
  assert.equal(JSON.stringify(hooks[1]).includes(QA_TOKEN), false);
  assert.equal(JSON.stringify(hooks[1]).includes(MUSE_TOKEN), false);
  assert.equal(recovered.checks.find(check => check.id === "room-read")?.ok, true);
  assert.equal(recovered.checks.find(check => check.id === "room-post")?.ok, true);
  assert.equal(recovered.checks.find(check => check.id === "room-open")?.ok, true);
  for (const check of recovered.checks) assert.equal(typeof check.latencyMs, "number");
  assert.equal(postedBody?.includes(QA_TOKEN), false);
  assert.match(postedBody ?? "", /^probe-nonce [a-f0-9]{32}$/);
  const opened = JSON.parse(openBody);
  assert.equal(opened.roomId, QA_ROOM);
  assert.equal(JSON.stringify(opened).includes(QA_TOKEN), false);
  assert.ok(calls.some(call => call.url === `${ORIGIN}/api/agent-rooms` && call.method === "POST" && call.authorization === `Bearer ${QA_TOKEN}`));
  assert.ok(calls.some(call => call.url === `${ORIGIN}/api/rooms/${QA_ROOM}/conversation?limit=1` && call.authorization === `Bearer ${QA_TOKEN}`));
  assert.ok(calls.some(call => call.url === "https://muse.example/api/rooms/muse-room/commands" && call.authorization === `Bearer ${MUSE_TOKEN}`));

  const beforeStatus = calls.length;
  const status = await worker.fetch(new Request("https://probe.invalid/status"), env);
  assert.equal(status.status, 200);
  assert.match(status.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(status.headers.get("cache-control"), "no-store");
  const body = await status.json();
  assert.equal(body.schema, "project-room.external-probe-status/1");
  assert.equal(body.ok, true);
  assert.equal(body.origin, ORIGIN);
  assert.equal(body.checks.find(check => check.id === "room-read")?.ok, true);
  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes(QA_TOKEN), false);
  assert.equal(encoded.includes(MUSE_TOKEN), false);
  assert.equal(calls.length, beforeStatus);

  const denied = await worker.fetch(new Request("https://probe.invalid/status", { method: "POST" }), env);
  assert.equal(denied.status, 405);
  assert.equal(calls.length, beforeStatus);
  const closed = await worker.fetch(new Request("https://probe.invalid/"));
  assert.equal(closed.status, 404);
  assert.match(await closed.text(), /schedule/);

  readStatus = 503;
  const reopened = await runExternalProbe(env, fetchImpl);
  assert.equal(reopened.ok, false);
  assert.equal(reopened.consecutiveFailures, 1);
  assert.deepEqual(reopened.alerts, []);
  assert.equal(notices.length, 2);
  assert.equal(hooks.length, 2);
});
