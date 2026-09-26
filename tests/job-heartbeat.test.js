// Cron heartbeat: every scheduled job records lastSuccessAt / lastError and
// GET /api/health/jobs exposes them read-only. Regression for the silent cron
// outage where every tick failed with a DO RPC error but pages stayed green.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRON_JOBS, HEARTBEAT_STORAGE_KEY, applyOutcomes, compactSummary, jobHealthView, redactError, runCronJobs, summaryFailure
} from "../cloudflare/job-heartbeat.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const RPC_ERROR = "The receiving Durable Object does not support RPC, because its class was not declared with `extends DurableObject`.";

function installWorkersShim() {
  const dir = mkdtempSync(join(tmpdir(), "room-job-heartbeat-"));
  const shimUrl = pathToFileURL(join(dir, "shim.mjs")).href;
  writeFileSync(join(dir, "shim.mjs"), [
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export function httpServerHandler() { return { fetch() { return new Response(null, { status: 500 }); } }; }",
    ""
  ].join("\n"));
  writeFileSync(join(dir, "hook.mjs"), [
    `const shim = ${JSON.stringify(shimUrl)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:node') return { url: shim, shortCircuit: true };",
    "  return nextResolve(specifier, context);",
    "}",
    ""
  ].join("\n"));
  register(pathToFileURL(join(dir, "hook.mjs")).href, import.meta.url);
}
installWorkersShim();
const { default: worker, ProjectRoom } = await import(pathToFileURL(join(root, "cloudflare/room.mjs")).href);

function memoryStorage() {
  const map = new Map();
  return { map, async get(key) { return structuredClone(map.get(key)); }, async put(key, value) { map.set(key, structuredClone(value)); } };
}

// A DO stub that behaves like workerd RPC: real ProjectRoom methods only, each
// dispatched to a plain object that owns ctx.storage.
function roomStub(overrides = {}) {
  const self = { ctx: { storage: memoryStorage() } };
  const calls = [];
  const stub = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof ProjectRoom.prototype[prop] !== "function") return () => Promise.reject(new TypeError(`no RPC method ${String(prop)}`));
      return async (...args) => {
        calls.push(String(prop));
        if (overrides[prop]) return overrides[prop](...args);
        if (prop === "recordCronTick" || prop === "readJobHealth") return ProjectRoom.prototype[prop].apply(self, args);
        return { checked: 0 };
      };
    }
  });
  return { stub, self, calls };
}

test("every cron job in scheduled() has a heartbeat entry", () => {
  assert.deepEqual(CRON_JOBS.map(job => job.name).sort(), ["channel-drain", "gmail-sync", "land-queue", "retention", "webhook-dispatch"]);
  for (const job of CRON_JOBS) assert.equal(job.periodSeconds, 60);
});

test("runCronJobs records failures, summary failures and redacts gmail errors", async () => {
  const logs = [];
  let t = 1_000;
  const outcomes = await runCronJobs({
    "land-queue": () => Promise.reject(new Error(RPC_ERROR)),
    "channel-drain": async () => ({ connections: 1, errors: 0, scanError: "SQLITE_BUSY" }),
    "gmail-sync": () => Promise.reject(Object.assign(new Error("mailbox alice@example.com body leak"), { code: "gmail_reconnect_required" })),
    "retention": () => ({ dryRun: true, deleted: 0 }),
    "webhook-dispatch": async () => ({ processed: 2, delivered: 2, id: "secret-ish" })
  }, { now: () => (t += 5), log: line => logs.push(line) });
  const by = Object.fromEntries(outcomes.map(o => [o.job, o]));
  assert.equal(by["land-queue"].ok, false);
  assert.match(by["land-queue"].error, /does not support RPC/);
  assert.equal(by["channel-drain"].ok, false);
  assert.match(by["channel-drain"].error, /scanError/);
  assert.equal(by["gmail-sync"].error, "gmail_reconnect_required");
  assert.ok(!JSON.stringify(outcomes).includes("alice@example.com"));
  assert.equal(by.retention.ok, true);
  assert.deepEqual(by["webhook-dispatch"].summary, { processed: 2, delivered: 2 });
  assert.ok(logs.some(line => line.startsWith("[land-queue] cron tick failed:")));
});

test("redactError drops tokens, secrets and query strings", () => {
  const out = redactError("fetch https://hook.example/x?sig=abc failed: Bearer pri_abcdefghijklmnop token=zzz ghp_1234567890abcdef " + "A".repeat(40));
  assert.ok(!/pri_abc|ghp_123|sig=abc|zzz|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.test(out), out);
  assert.ok(redactError("x".repeat(1000)).length <= 240);
  assert.equal(summaryFailure({ errors: 2 }), "2 error(s) in tick");
  assert.equal(summaryFailure({ checked: 1 }), null);
  assert.deepEqual(compactSummary({ a: 1, b: "no", c: true, d: { x: 1 } }), { a: 1, c: true });
});

test("jobHealthView marks stale beyond 3x period and failing on errors", () => {
  const now = Date.parse("2026-09-24T22:00:00Z");
  const fresh = applyOutcomes({}, CRON_JOBS.map(job => ({ job: job.name, ok: true, at: now - 30_000, summary: { checked: 1 } })));
  assert.equal(jobHealthView(fresh, now).status, "ok");
  const view = jobHealthView(fresh, now + 181_000);
  assert.equal(view.status, "stale");
  assert.ok(view.jobs.every(job => job.stale && job.staleAfterSeconds === 180));
  const failing = applyOutcomes(fresh, [{ job: "land-queue", ok: false, at: now, error: RPC_ERROR }]);
  const failingView = jobHealthView(failing, now);
  const land = failingView.jobs.find(job => job.name === "land-queue");
  assert.equal(land.status, "failing");
  assert.equal(land.consecutiveFailures, 1);
  assert.equal(land.lastSuccessAt, new Date(now - 30_000).toISOString());
  assert.match(land.lastError, /does not support RPC/);
  assert.equal(failingView.status, "failing");
  assert.equal(jobHealthView(undefined, now).status, "stale", "never-run jobs are stale");
});

test("scheduled() records a heartbeat and fails the invocation when a job fails", async () => {
  const { stub, self, calls } = roomStub({ refreshLandQueue: () => Promise.reject(new Error(RPC_ERROR)) });
  const warn = console.warn; console.warn = () => {};
  try {
    await assert.rejects(worker.scheduled({ cron: "* * * * *" }, { ROOM_MAINTENANCE: "0", ROOM: { getByName: () => stub } }, { waitUntil() {} }),
      /cron jobs failed: land-queue/);
  } finally { console.warn = warn; }
  assert.ok(calls.includes("recordCronTick"));
  const stored = self.ctx.storage.map.get(HEARTBEAT_STORAGE_KEY);
  assert.equal(stored["land-queue"].consecutiveFailures, 1);
  assert.ok(Number.isFinite(stored.retention.lastSuccessAt));
});

test("scheduled() resolves when every job succeeds", async () => {
  const { stub, self } = roomStub();
  await worker.scheduled({ cron: "* * * * *" }, { ROOM_MAINTENANCE: "0", ROOM: { getByName: () => stub } }, { waitUntil() {} });
  const view = jobHealthView(self.ctx.storage.map.get(HEARTBEAT_STORAGE_KEY), Date.now());
  assert.equal(view.status, "ok");
});

test("GET /api/health/jobs is read-only, no-store, and 503 when stale", async () => {
  const env = (stub) => ({ ROOM_ORIGIN: "https://room.example.test", ROOM: { getByName: () => stub } });
  const { stub, self } = roomStub();
  let res = await worker.fetch(new Request("https://room.example.test/api/health/jobs"), env(stub));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).status, "stale");
  await ProjectRoom.prototype.recordCronTick.call(self, CRON_JOBS.map(job => ({ job: job.name, ok: true, at: Date.now() })));
  res = await worker.fetch(new Request("https://room.example.test/api/health/jobs"), env(stub));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, "room.job-health/1");
  assert.equal(body.jobs.length, CRON_JOBS.length);
  const broken = { readJobHealth: () => Promise.reject(new Error(RPC_ERROR)) };
  const error = console.error; console.error = () => {};
  try {
    res = await worker.fetch(new Request("https://room.example.test/api/health/jobs"), env(broken));
  } finally { console.error = error; }
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, "unavailable");
});

// Storage tests cover a running Node server; these cover failure before a DO
// handler exists and a rejected cross-object request at the public Worker.
test("Room request boundary contains DO failures without leaking or replaying", async () => {
  const failures = [
    () => { throw new Error("private constructor detail token=secret"); },
    () => ({ fetch() { throw new Error("private synchronous detail"); } }),
    () => ({ fetch() { return Promise.reject(new Error("private storage detail")); } }),
    () => ({ fetch(request) {
      // Execute the actual DO constructor: its storage failure happens before
      // ProjectRoom.fetch can run, so catching only there is insufficient.
      const room = new ProjectRoom({ get storage() { throw new Error("private storage detail"); } }, { ROOM_ORIGIN: "https://room.example.test" });
      return room.fetch(request);
    } })
  ];
  const origin = "https://room.example.test";
  for (const getStub of failures) for (const [method, url, json] of [
    ["GET", origin + "/", false], ["HEAD", origin + "/api/version", true],
    ["GET", origin + "/api/version", true], ["POST", origin + "/api/rooms", true],
    ["GET", origin + "/room/api/version", true],
    ["GET", "https://www.getdasha.com/room/api/version", true],
    ["POST", "https://www.getdasha.com/room/mcp", true]
  ]) {
    let attempts = 0, fetches = 0;
    const env = { ROOM_ORIGIN: origin, ROOM: { getByName() {
      attempts++;
      const stub = getStub();
      return { fetch(request) { fetches++; return stub.fetch(request); } };
    } } };
    const res = await worker.fetch(new Request(url, { method, headers: { "CF-Connecting-IP": "192.0.2.1" } }), env);
    assert.equal(res.status, 503);
    assert.equal(attempts, 1);
    assert.ok(fetches <= 1, "must not replay a possibly committed mutation");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("retry-after"), "30");
    const text = await res.text();
    assert.doesNotMatch(text, /private|secret|constructor|storage detail/);
    if (method === "HEAD") { assert.equal(text, ""); continue; }
    if (json) {
      assert.match(res.headers.get("content-type"), /application\/json/);
      const body = JSON.parse(text);
      assert.equal(body.error.code, "room_unavailable");
      assert.match(body.error.message, method === "POST" ? /Check.*before repeating/ : /try again/);
    } else assert.match(text, /Project Room.*temporarily unavailable/);
  }
});

test("Room outage containment preserves guards and maintenance before DO access", async () => {
  const origin = "https://room.example.test";
  const env = { ROOM_ORIGIN: origin, ROOM: { getByName() { assert.fail("must not access DO"); } } };
  for (const [url, ip, status] of [
    ["https://wrong.example/api/version", "192.0.2.1", 403],
    [origin + "/api/version", "invalid", 403], [origin + "/api/version", "", 403],
    ["https://www.getdasha.com/roommates", "192.0.2.1", 404]
  ]) assert.equal((await worker.fetch(new Request(url, { headers: { "CF-Connecting-IP": ip } }), env)).status, status);
  const paused = await worker.fetch(new Request(origin + "/api/version"), { ...env, ROOM_MAINTENANCE: "1" });
  assert.equal(paused.status, 503);
  assert.equal((await paused.json()).error.code, "maintenance");
});

test("Room boundary passes responses through and retains trusted forwarding headers", async () => {
  const origin = "https://room.example.test";
  for (const status of [200, 401, 503]) {
    const expected = new Response("existing response", { status, headers: { "X-Test": "preserved" } });
    let calls = 0;
    const env = { ROOM_ORIGIN: origin, ROOM: { getByName() { return { async fetch(request) {
      calls++;
      assert.equal(request.headers.get("host"), "room.example.test");
      assert.equal(request.headers.get("x-room-visitor-ip"), "192.0.2.1");
      assert.equal(request.headers.get("x-real-ip"), null);
      assert.equal(request.headers.get("x-forwarded-for"), null);
      return expected;
    } }; } } };
    const response = await worker.fetch(new Request(origin + "/api/version", { headers: {
      "CF-Connecting-IP": "192.0.2.1", "X-Room-Visitor-IP": "203.0.113.1", "X-Real-IP": "203.0.113.1", "X-Forwarded-For": "203.0.113.1"
    } }), env);
    assert.equal(response, expected);
    assert.equal(calls, 1);
  }
});
