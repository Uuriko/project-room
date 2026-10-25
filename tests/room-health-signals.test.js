// Batch 5 health signals. A down Durable Object must degrade /api/health
// with a status link, the stale writer-permit counter must be readable, and
// room_health must answer without a secret.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentErrorAx } from "../src/agent-error.mjs";
import { healthLivenessResponse, workerHealthResponse } from "../cloudflare/health-probe.mjs";
import { edgePublicResponse } from "../cloudflare/edge-public.mjs";
import { noteWriterPermitReset, readWriterPermitHeal } from "../server/writer-permit-heal.mjs";
import { roomHealthFromStore, roomHealthMcpReply } from "../server/room-health.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function installWorkersShim() {
  const dir = mkdtempSync(join(tmpdir(), "room-health-signals-"));
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
const { default: worker } = await import(pathToFileURL(join(root, "cloudflare/room.mjs")).href);

const origin = "https://room.example.test";
const envFor = room => ({
  ROOM_ORIGIN: origin,
  ROOM_SERVICE_MODE: "cloudflare-staging",
  ROOM: { getByName: () => room }
});

test("room_unavailable points at status and does not name room_check_access", () => {
  const ax = agentErrorAx({ httpStatus: 503, code: "room_unavailable", message: "Project Room is temporarily unavailable. Please try again in 30 seconds." });
  assert.equal(ax.status, "failed");
  assert.ok(ax.next.some(step => step.path === "/api/health"));
  assert.equal(JSON.stringify(ax).includes("room_check_access"), false);
  assert.match(ax.next.map(step => step.command).join(" "), /Retry-After/);
});

test("a degraded health body carries Retry-After and a status link", async () => {
  const response = healthLivenessResponse(new Request(`${origin}/api/health`), {
    mode: "cloudflare-staging", readiness: "error", elapsedMs: 12, timeoutMs: 1000
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.match(response.headers.get("link"), /<\/api\/health>; rel="status"/);
  const body = await response.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.retryAfter, 30);
  assert.ok(body.next.some(step => step.path === "/api/health"));
  assert.equal(JSON.stringify(body).includes("room_check_access"), false);
  const head = healthLivenessResponse(new Request(`${origin}/api/health`, { method: "HEAD" }), {
    mode: "cloudflare-staging", readiness: "timeout"
  });
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
});

test("a successful worker health body keeps liveness fields and adds do", async () => {
  const body = await workerHealthResponse(new Request(`${origin}/api/health`), {
    mode: "cloudflare-staging", deployment: "staging", emailVerification: "relaxed-no-mailer",
    snapshot: { status: 200 }, elapsedMs: 4
  }).json();
  assert.equal(body.status, "ok");
  assert.equal(body.emailVerificationScope, "worker");
  assert.deepEqual(body.do, { status: "ok", statusCode: 200, ms: 4 });
});

test("worker /api/health is 503 degraded when the Durable Object cannot answer", async () => {
  const response = await worker.fetch(new Request(`${origin}/api/health`, { headers: { "CF-Connecting-IP": "192.0.2.9" } }), envFor({
    probeStorage() { throw new Error("do down"); }
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.match(response.headers.get("link"), /<\/api\/health>; rel="status"/);
  const body = await response.json();
  assert.equal(body.status, "degraded");
  assert.equal(JSON.stringify(body).includes("room_check_access"), false);
  assert.ok(body.next.some(step => step.path === "/api/health"));
});

test("worker room_health answers degraded when the Durable Object is down", async () => {
  const response = await worker.fetch(new Request(`${origin}/mcp`, {
    method: "POST",
    headers: { "CF-Connecting-IP": "192.0.2.9", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_health", arguments: {} } })
  }), envFor({
    probeStorage() { throw new Error("do down"); },
    readJobHealth() { throw new Error("do down"); }
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.structuredContent.status, "degraded");
  assert.equal(body.result.structuredContent.schema, "room.health/1");
  assert.equal(JSON.stringify(body).includes("room_check_access"), false);
  assert.ok(body.result.structuredContent.next.some(step => step.path === "/api/health"));
});

test("worker room_health reports the writer-permit reset count when the object is up", async () => {
  const response = await worker.fetch(new Request(`${origin}/mcp`, {
    method: "POST",
    headers: { "CF-Connecting-IP": "192.0.2.9", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "h", method: "tools/call", params: { name: "room_health", arguments: {} } })
  }), envFor({
    probeStorage: async () => ({ ok: true, emailVerification: "relaxed-no-mailer" }),
    readJobHealth: async () => ({
      schema: "room.job-health/1", status: "ok", jobs: [], publicReports: 0,
      writerPermitResets: { count: 2, lastResetAt: "2026-10-25T21:00:00.000Z" }
    })
  }));
  assert.equal(response.status, 200);
  const report = (await response.json()).result.structuredContent;
  assert.equal(report.status, "ok");
  assert.deepEqual(report.writerPermitResets, { count: 2, lastResetAt: "2026-10-25T21:00:00.000Z" });
  assert.equal(report.do.status, "ok");
});

test("a store with no heal table reports zero writer-permit resets", () => {
  const db = new DatabaseSync(":memory:");
  assert.deepEqual(readWriterPermitHeal(db), { count: 0, lastResetAt: null });
  db.close();
});

test("stale writer-permit resets increment the counter and keep the latest time", () => {
  const db = new DatabaseSync(":memory:");
  const wrapped = {
    storage: { sql: { exec(sql, ...args) { args.length ? db.prepare(sql).run(...args) : db.exec(sql); } } },
    prepare(sql) { return db.prepare(sql); }
  };
  noteWriterPermitReset(wrapped, "2026-10-25T21:00:00.000Z");
  assert.deepEqual(readWriterPermitHeal(wrapped), { count: 1, lastResetAt: "2026-10-25T21:00:00.000Z" });
  noteWriterPermitReset(wrapped, "2026-10-25T22:00:00.000Z");
  assert.deepEqual(readWriterPermitHeal(wrapped), { count: 2, lastResetAt: "2026-10-25T22:00:00.000Z" });
  db.close();
});

test("node room_health is public and includes writerPermitResets", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-health-node-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const nodeOrigin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const response = await fetch(`${nodeOrigin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: nodeOrigin },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_health", arguments: {} } })
  });
  assert.equal(response.status, 200);
  const report = (await response.json()).result.structuredContent;
  assert.equal(report.schema, "room.health/1");
  assert.equal(report.status, "ok");
  assert.deepEqual(report.writerPermitResets, roomHealthFromStore(store).writerPermitResets);
  const reply = roomHealthMcpReply({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_health", arguments: { extra: true } } }, report);
  assert.equal(reply.error.data.reason, "invalid_arguments");
});

test("python user agents receive /openapi.json from the worker", async () => {
  for (const ua of ["python-requests/2.32.3", "Python-urllib/3.12"]) {
    const request = new Request(`${origin}/openapi.json`, { headers: { "user-agent": ua } });
    const response = await edgePublicResponse(request, {}, new URL(request.url));
    assert.equal(response.status, 200, ua);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.openapi, "3.1.0");
  }
});
