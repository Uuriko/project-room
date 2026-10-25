// A long-failing integrity job must not keep /api/health/jobs red after
// the other crons are healthy, and a stale minute cron must still be
// reported. Integrity stays enabled: its lastError is a live
// messages_parity mismatch, not a retired checker.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alarmAlreadyScheduled } from "../server/job-alarm-arm.mjs";
import { jobHealthSignal } from "../server/job-health-signal.mjs";
import { jobHealthResponse } from "../cloudflare/job-heartbeat.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T08:08:30Z");

// The rows are the per-job shape /api/health/jobs already publishes.
// Waiting suppresses stale, which is why a parity failure that is still
// on its hourly cadence stays "failing" after two weeks.
function job(fields) {
  return {
    periodSeconds: 60,
    stale: false,
    required: false,
    consecutiveFailures: 0,
    lastSuccessAt: new Date(NOW).toISOString(),
    status: "ok",
    ...fields,
  };
}

function board(jobs, status = "failing") {
  return {
    schema: "room.job-health/1",
    status,
    generatedAt: new Date(NOW).toISOString(),
    jobs,
  };
}

async function bodyOf(view) {
  const response = jobHealthResponse(view);
  return { http: response.status, body: await response.json() };
}

test("a long-failing job does not mask healthy jobs, and a stale cron is still reported", async () => {
  const parity = job({
    name: "integrity",
    periodSeconds: 3600,
    status: "failing",
    consecutiveFailures: 285,
    lastSuccessAt: "2026-10-11T19:30:55.702Z",
    lastError: "scanError: integrity messages_parity failed (messages_parity_failed)",
  });
  const quietView = board([
    parity,
    job({ name: "webhook-dispatch" }),
    job({ name: "claim-prs" }),
    job({ name: "patrol" }),
  ]);
  const quiet = await bodyOf(quietView);
  const signaled = jobHealthSignal(quietView);
  assert.equal(quiet.body.status, signaled.status);
  assert.equal(
    quiet.body.jobs.find(entry => entry.name === "integrity").quarantined,
    signaled.jobs.find(entry => entry.name === "integrity").quarantined,
  );
  assert.equal(quiet.http, 200);
  assert.equal(quiet.body.status, "ok");
  const quarantined = quiet.body.jobs.find(entry => entry.name === "integrity");
  assert.equal(quarantined.status, "failing");
  assert.equal(quarantined.quarantined, true);
  assert.equal(quiet.body.jobs.find(entry => entry.name === "patrol").status, "ok");

  const once = await bodyOf(board([
    job({ name: "claim-prs", status: "failing", consecutiveFailures: 1, lastError: "once" }),
    job({ name: "patrol" }),
  ]));
  assert.equal(once.http, 503);
  assert.equal(once.body.status, "failing");
  assert.equal(once.body.jobs.find(entry => entry.name === "claim-prs").quarantined, undefined);

  const short = await bodyOf(board([
    job({
      name: "webhook-dispatch",
      status: "failing",
      consecutiveFailures: 30,
      lastSuccessAt: new Date(NOW - 60_000).toISOString(),
      lastError: "recent",
    }),
    job({ name: "patrol" }),
  ]));
  assert.equal(short.http, 503);
  assert.equal(short.body.status, "failing");
  assert.equal(short.body.jobs.find(entry => entry.name === "webhook-dispatch").quarantined, undefined);

  const required = await bodyOf(board([
    job({
      name: "room-backup",
      required: true,
      periodSeconds: 86400,
      status: "failing",
      consecutiveFailures: 285,
      lastSuccessAt: new Date(NOW - 14 * DAY).toISOString(),
      lastError: "backup failed",
    }),
    job({ name: "patrol" }),
  ]));
  assert.equal(required.http, 503);
  assert.equal(required.body.status, "failing");
  assert.equal(required.body.jobs.find(entry => entry.name === "room-backup").quarantined, undefined);

  const reported = await bodyOf(board([
    parity,
    job({ name: "webhook-dispatch", status: "stale", stale: true, lastSuccessAt: new Date(NOW - 401_000).toISOString() }),
    job({ name: "claim-prs", status: "stale", stale: true, lastSuccessAt: new Date(NOW - 401_000).toISOString() }),
    job({ name: "patrol", status: "stale", stale: true, lastSuccessAt: new Date(NOW - 401_000).toISOString() }),
  ], "stale"));
  assert.equal(reported.http, 503);
  assert.equal(reported.body.status, "stale");
  for (const name of ["webhook-dispatch", "claim-prs", "patrol"]) {
    assert.equal(reported.body.jobs.find(entry => entry.name === name).status, "stale", name);
  }
  assert.equal(reported.body.jobs.find(entry => entry.name === "integrity").status, "failing");
  assert.equal(reported.body.jobs.find(entry => entry.name === "integrity").quarantined, true);
});

test("a past alarm is not treated as already scheduled", () => {
  const now = Date.parse("2026-10-25T08:08:30Z");
  assert.equal(alarmAlreadyScheduled(now - 1000, now + 60_000, now), false);
  assert.equal(alarmAlreadyScheduled(now + 1000, now + 60_000, now), true);
  assert.equal(alarmAlreadyScheduled(now + 90_000, now + 60_000, now), false);
  assert.equal(alarmAlreadyScheduled(null, now + 60_000, now), false);
  assert.equal(alarmAlreadyScheduled(now + 1000, null, now), false);
});

function installWorkersShim() {
  const dir = mkdtempSync(join(tmpdir(), "room-job-health-signal-"));
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
  return dir;
}

test("scheduled() still fails the cron when ensureJobAlarm returns failed jobs", async () => {
  const dir = installWorkersShim();
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const { default: worker, ProjectRoom } = await import(pathToFileURL(join(root, "cloudflare/room.mjs")).href);
    const calls = [];
    const stub = new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (typeof ProjectRoom.prototype[prop] !== "function") return () => Promise.reject(new TypeError(`no RPC method ${String(prop)}`));
        return async () => {
          calls.push(String(prop));
          if (prop === "ensureJobAlarm") return { failed: ["webhook-dispatch", "claim-prs", "patrol"], armed: true };
          return { checked: 0 };
        };
      },
    });
    await assert.rejects(
      () => worker.scheduled({ cron: "*/30 * * * *" }, { ROOM_MAINTENANCE: "0", ROOM: { getByName: () => stub } }, { waitUntil() {} }),
      /Scheduled job RPC failed: webhook-dispatch, claim-prs, patrol/
    );
    assert.equal(calls[0], "ensureJobAlarm");
    assert.ok(calls.filter(name => name === "runSlowJob").length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
