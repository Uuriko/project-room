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
import { wireNodeJobs } from "../server/jobs.mjs";
import worker from "../cloudflare/external-probe-worker.mjs";
import { CRON_JOBS, jobHealthView, jobHealthResponse, jobHealthUnavailable } from "../cloudflare/job-heartbeat.mjs";
import { runExternalProbe, ProbeStateError } from "../cloudflare/external-probe.mjs";

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
  // A bare room server has no wired scheduler, so /api/health/jobs serves
  // no job rows and the probe's jobs check would (correctly) fail
  // jobs_missing. Wire one and run a real tick so the healthy room reports
  // healthy jobs.
  const scheduler = wireNodeJobs(store, { env: {}, tickMs: 0 });
  await scheduler.runOnce();
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
  assert.deepEqual(result.checks.map(check => check.id), ["ready", "mcp", "llms", "jobs", "receipts"]);
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

  await assert.rejects(run({ PROBE_ORIGIN: down, PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook` }),
    error => error instanceof ProbeStateError && error.code === "state_unbound");
  await assert.rejects(run({ PROBE_ORIGIN: down, PROBE_ALERT_WEBHOOK_URL: `${webhook}/hook` }),
    error => error instanceof ProbeStateError && error.code === "state_unbound");
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
  await assert.rejects(run(env),
    error => error instanceof ProbeStateError && error.code === "state_unwritable");
  await assert.rejects(run(env),
    error => error instanceof ProbeStateError && error.code === "state_unwritable");
  assert.deepEqual(hooks, []);
});

test("a probe that cannot use its state fails the run instead of reporting healthy", async () => {
  // Regression for the silent self-failure mode: a probe whose streak state
  // is unbound or unreadable used to return a normal result with alerts: []
  // and consecutiveFailures: null — a dead watcher indistinguishable from a
  // healthy one in Cron Events, with the two-failure paging threshold
  // structurally unreachable. State failures now throw ProbeStateError,
  // which the scheduled handler surfaces as a failed invocation.
  const healthy = jobsFetch(HEALTHY_JOBS);
  const unreadableState = () => ({
    async get() { throw new Error("kv read failed"); },
    async put() {}
  });
  await assert.rejects(
    runExternalProbe({ PROBE_ORIGIN: "https://probe.example" }, healthy),
    error => error instanceof ProbeStateError && error.code === "state_unbound"
  );
  await assert.rejects(
    runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: unreadableState() }, healthy),
    error => error instanceof ProbeStateError && error.code === "state_unreadable"
  );
  // Origin down AND state broken: the run confesses the state failure
  // rather than returning an empty, healthy-looking result, and no alert
  // send is attempted (there is no streak to alert against).
  const alertPosts = [];
  const downFetch = async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/hook")) { alertPosts.push(url); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ status: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    runExternalProbe({
      PROBE_ORIGIN: "https://probe.example",
      PROBE_STATE: unreadableState(),
      PROBE_ALERT_WEBHOOK_URL: "https://alerts.example/hook"
    }, downFetch),
    error => error instanceof ProbeStateError && error.code === "state_unreadable"
  );
  assert.deepEqual(alertPosts, []);
  // The scheduled entry propagates the rejection to the cron host.
  await assert.rejects(
    run({ PROBE_ORIGIN: "https://probe.example" }),
    error => error instanceof ProbeStateError && error.code === "state_unbound"
  );
});

test("ops-room alert is prefixed with /room on a getdasha door origin, and not on a service origin", async () => {
  // Regression for #2863: ROOM_AGENT_ORIGIN=https://www.getdasha.com is the
  // documented door form (no /room path). On that host /api/* is Webflow, so
  // the room command must go to /room/api/rooms/<id>/commands or it is lost.
  for (const [doorOrigin, expected] of [
    ["https://www.getdasha.com", "https://www.getdasha.com/room/api/rooms/ops/commands"],
    ["https://getdasha.com", "https://getdasha.com/room/api/rooms/ops/commands"],
    ["https://room.trydemigod.com", "https://room.trydemigod.com/api/rooms/ops/commands"]
  ]) {
    const posted = [];
    const fetchImpl = async input => {
      const url = String(input instanceof URL ? input.href : input);
      if (url.includes("/rooms/ops/commands")) {
        posted.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ status: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    };
    const env = {
      PROBE_ORIGIN: "https://probe.example",
      PROBE_STATE: memoryKv(),
      ROOM_AGENT_ORIGIN: doorOrigin,
      ROOM_AGENT_ROOM: "ops",
      ROOM_AGENT_TOKEN: "probe-test-token"
    };
    const first = await runExternalProbe(env, fetchImpl);
    assert.equal(first.consecutiveFailures, 1);
    assert.deepEqual(posted, []);
    const second = await runExternalProbe(env, fetchImpl);
    assert.equal(second.consecutiveFailures, 2);
    assert.deepEqual(posted, [expected], `room alert URL for ${doorOrigin}`);
    assert.equal(second.alerts.find(alert => alert.destination === "room")?.ok, true);
  }
});

test("fetch does not run the probe", async t => {
  const calls = watchFetch(t);
  const response = await worker.fetch(new Request("https://probe.invalid/"));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /schedule/);
  assert.deepEqual(calls, []);
});

// The jobs check: /api/health/jobs is the only outside view of the cron
// heartbeats. A failing job, a stale job, and a healthy board are three
// different signals and must not collapse into one "jobs failed".
function jobsFetch(jobsPayload) {
  return async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/api/ready")) return new Response(JSON.stringify({ status: "ready" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", result: { tools: [{ name: "room_status" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/llms.txt")) return new Response("# Uuriko Project Room\n", { status: 200, headers: { "content-type": "text/plain" } });
    if (url.endsWith("/api/health/jobs")) return new Response(JSON.stringify(jobsPayload), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/public/receipts")) return new Response(JSON.stringify(HEALTHY_RECEIPTS), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };
}

const HEALTHY_RECEIPTS = { schema: "project-room-public-receipt-list/1", receipts: [
  { schema: "project-room-public-receipt/1", id: "wir_00000000000000000000000000aa", title: "Specimen receipt" }
] };

const HEALTHY_JOBS = { schema: "room.job-health/1", status: "ok", jobs: [
  { name: "integrity", status: "ok", stale: false, consecutiveFailures: 0 },
  { name: "claim-prs", status: "ok", stale: false, consecutiveFailures: 0 },
  { name: "gmail-sync", status: "disabled", stale: false, consecutiveFailures: 0, enabled: false }
] };

test("jobs check passes a healthy board and ignores disabled jobs", async () => {
  const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, jobsFetch(HEALTHY_JOBS));
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.checks.find(check => check.id === "jobs").ok, true);
});

test("jobs check distinguishes a failing job, naming it and its public error code", async () => {
  const payload = { schema: "room.job-health/1", status: "degraded", jobs: [
    { name: "integrity", status: "failing", stale: false, consecutiveFailures: 57, lastErrorCode: "messages_parity_failed" },
    { name: "claim-prs", status: "ok", stale: false, consecutiveFailures: 0 }
  ] };
  const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, jobsFetch(payload));
  assert.equal(result.ok, false);
  const jobs = result.checks.find(check => check.id === "jobs");
  assert.equal(jobs.ok, false);
  assert.equal(jobs.reason, "job_failing");
  assert.match(jobs.detail, /integrity \(messages_parity_failed\)/);
  // No free-text error or secret material rides along: name + code only.
  assert.equal(JSON.stringify(result.checks).match(/token|secret|Bearer/i), null);
});

test("jobs check distinguishes staleness from failure", async () => {
  const payload = { schema: "room.job-health/1", status: "ok", jobs: [
    { name: "room-backup", status: "ok", stale: true, consecutiveFailures: 0 },
    { name: "integrity", status: "ok", stale: false, consecutiveFailures: 0 }
  ] };
  const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, jobsFetch(payload));
  assert.equal(result.ok, false);
  const jobs = result.checks.find(check => check.id === "jobs");
  assert.equal(jobs.reason, "job_stale");
  assert.match(jobs.detail, /room-backup/);
});

test("jobs check fails closed when the health view carries no job rows", async () => {
  const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() },
    jobsFetch({ schema: "room.job-health/1", status: "ok" }));
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => check.id === "jobs").reason, "jobs_missing");
});

test("a jobs-only outage alerts after two runs and recovers with the board", async () => {
  const hooks = [];
  const failing = { schema: "room.job-health/1", status: "degraded", jobs: [
    { name: "claim-prs", status: "failing", stale: false, consecutiveFailures: 121, lastErrorCode: "claim_pr_sync_failed" }
  ] };
  let payload = failing;
  const fetchImpl = async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/hook")) { return new Response(null, { status: 204 }); }
    return jobsFetch(payload)(input);
  };
  const env = {
    PROBE_ORIGIN: "https://probe.example",
    PROBE_STATE: memoryKv(),
    PROBE_ALERT_WEBHOOK_URL: "https://alerts.example/hook"
  };
  const first = await runExternalProbe(env, fetchImpl);
  assert.equal(first.ok, false);
  assert.deepEqual(first.alerts, []);
  const second = await runExternalProbe(env, async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/hook")) { hooks.push("outage"); return new Response(null, { status: 204 }); }
    return jobsFetch(payload)(input);
  });
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.alerts.find(alert => alert.destination === "webhook")?.kind, "outage");
  payload = HEALTHY_JOBS;
  const recovered = await runExternalProbe(env, async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/hook")) { hooks.push("recovery"); return new Response(null, { status: 204 }); }
    return jobsFetch(payload)(input);
  });
  assert.equal(recovered.ok, true);
  assert.deepEqual(hooks, ["outage", "recovery"]);
});


test("jobs diagnostics consume the real Worker health response, including 503", async () => {
  const now = Date.now();
  const healthy = Object.fromEntries(CRON_JOBS.map(job => [job.name, { lastRunAt: now, lastSuccessAt: now, consecutiveFailures: 0 }]));
  const name = CRON_JOBS[0].name;
  const probe = async response => {
    const fallback = jobsFetch(HEALTHY_JOBS);
    const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, input =>
      String(input).endsWith("/api/health/jobs") ? response : fallback(input));
    assert.doesNotMatch(JSON.stringify(result.checks), /private-error-secret/);
    return result.checks.find(check => check.id === "jobs");
  };
  assert.equal((await probe(jobHealthResponse(jobHealthView(healthy, now)))).ok, true);
  const stale = structuredClone(healthy); stale[name].lastSuccessAt = 0;
  const staleCheck = await probe(jobHealthResponse(jobHealthView(stale, now)));
  assert.equal(staleCheck.status, 503); assert.equal(staleCheck.reason, "job_stale"); assert.equal(staleCheck.detail, name);
  const failing = structuredClone(healthy); failing[name].consecutiveFailures = 1; failing[name].lastError = "private-error-secret";
  const failingCheck = await probe(jobHealthResponse(jobHealthView(failing, now)));
  assert.equal(failingCheck.status, 503); assert.equal(failingCheck.reason, "job_failing"); assert.equal(failingCheck.detail, `${name} (unclassified)`);
  for (const response of [jobHealthUnavailable(), new Response("private-error-secret", { status: 503 }),
    new Response(JSON.stringify({ ...HEALTHY_JOBS, schema: "unknown" }), { status: 503 }),
    new Response(JSON.stringify(HEALTHY_JOBS), { status: 503 })]) {
    const check = await probe(response);
    assert.equal(check.ok, false); assert.equal(check.status, 503); assert.equal(check.reason, "http_status"); assert.equal(check.detail, null);
  }
});

test("the persisted streak state advances its timestamp across runs", async () => {
  // DP-17's smoke cell: after revival this is the two-read the operator
  // acceptance performs against the real PROBE_STATE namespace — two reads
  // at least one cron apart must show a moved lastAt, or the Worker is
  // still not remembering anything.
  const kv = memoryKv();
  const down = async () => { throw new TypeError("fetch failed"); };
  const env = { PROBE_ORIGIN: "https://probe.example", PROBE_STATE: kv };
  const first = await runExternalProbe(env, down);
  const firstState = JSON.parse(await kv.get("streak"));
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(firstState.consecutiveFailures, 1);
  assert.equal(typeof firstState.lastAt, "string");
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await runExternalProbe(env, down);
  const secondState = JSON.parse(await kv.get("streak"));
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(secondState.consecutiveFailures, 2);
  assert.ok(Date.parse(secondState.lastAt) > Date.parse(firstState.lastAt),
    `lastAt advanced: ${firstState.lastAt} -> ${secondState.lastAt}`);
});

// The receipts check: the public wall is graded on its list envelope. A
// healthy envelope (even with an empty list) passes; a misshapen one, a
// non-JSON body, and an HTTP failure are three distinct failures.
function receiptsFetch(receiptsResponse) {
  const healthy = jobsFetch(HEALTHY_JOBS);
  return async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/api/public/receipts")) return receiptsResponse;
    return healthy(input);
  };
}

test("receipts check passes a healthy envelope and an empty list", async () => {
  for (const payload of [HEALTHY_RECEIPTS, { schema: "project-room-public-receipt-list/1", receipts: [] }]) {
    const response = new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, receiptsFetch(response));
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.equal(result.checks.find(check => check.id === "receipts").ok, true);
  }
});

test("receipts check fails closed on a misshapen envelope, a non-JSON body, and an HTTP failure", async () => {
  const cases = [
    [new Response(JSON.stringify({ receipts: [] }), { status: 200, headers: { "content-type": "application/json" } }), "receipts_missing"],
    [new Response(JSON.stringify({ schema: "project-room-public-receipt-list/1", receipts: {} }), { status: 200, headers: { "content-type": "application/json" } }), "receipts_missing"],
    [new Response("<html>wall</html>", { status: 200, headers: { "content-type": "text/html" } }), "invalid_json"],
    [new Response(JSON.stringify(HEALTHY_RECEIPTS), { status: 500, headers: { "content-type": "application/json" } }), "http_status"]
  ];
  for (const [response, reason] of cases) {
    const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, receiptsFetch(response));
    assert.equal(result.ok, false);
    const receipts = result.checks.find(check => check.id === "receipts");
    assert.equal(receipts.ok, false);
    assert.equal(receipts.reason, reason);
  }
});

test("a receipts-only outage alerts after two runs and recovers with the wall", async () => {
  const hooks = [];
  let wall = new Response("wall down", { status: 503 });
  const fetchImpl = async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/hook")) { return new Response(null, { status: 204 }); }
    if (url.endsWith("/api/public/receipts")) return wall;
    return jobsFetch(HEALTHY_JOBS)(input);
  };
  const env = {
    PROBE_ORIGIN: "https://probe.example",
    PROBE_STATE: memoryKv(),
    PROBE_ALERT_WEBHOOK_URL: "https://alerts.example/hook"
  };
  const first = await runExternalProbe(env, fetchImpl);
  assert.equal(first.ok, false);
  assert.deepEqual(first.alerts, []);
  const second = await runExternalProbe(env, async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/hook")) { hooks.push("outage"); return new Response(null, { status: 204 }); }
    if (url.endsWith("/api/public/receipts")) return wall;
    return jobsFetch(HEALTHY_JOBS)(input);
  });
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.alerts.find(alert => alert.destination === "webhook")?.kind, "outage");
  wall = new Response(JSON.stringify(HEALTHY_RECEIPTS), { status: 200, headers: { "content-type": "application/json" } });
  const recovered = await runExternalProbe(env, async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/hook")) { hooks.push("recovery"); return new Response(null, { status: 204 }); }
    if (url.endsWith("/api/public/receipts")) return wall;
    return jobsFetch(HEALTHY_JOBS)(input);
  });
  assert.equal(recovered.ok, true);
  assert.deepEqual(hooks, ["outage", "recovery"]);
});
