// 2026-09-25: the Durable Object exceeded its CPU time limit and was reset.
// DO-backed /api/version failed with the other room routes, so nobody could
// tell what was deployed. /api/version/worker answers from the Worker and
// does not open the object. /api/health/jobs still answers its caught 503.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const origin = "https://room.example.test";
const cpuReset = "Durable Object exceeded its CPU time limit and was reset";

function installWorkersShim() {
  const dir = mkdtempSync(join(tmpdir(), "incident-2026-09-25-"));
  const shimUrl = pathToFileURL(join(dir, "shim.mjs")).href;
  writeFileSync(join(dir, "shim.mjs"), [
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export function httpServerHandler() { return { fetch() { return new Response(null, { status: 500 }); } }; }",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "hook.mjs"), [
    `const shim = ${JSON.stringify(shimUrl)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:node') return { url: shim, shortCircuit: true };",
    "  return nextResolve(specifier, context);",
    "}",
    "",
  ].join("\n"));
  register(pathToFileURL(join(dir, "hook.mjs")).href, import.meta.url);
}

installWorkersShim();
const { default: worker } = await import(pathToFileURL(join(root, "cloudflare/room.mjs")).href);

function roomEnv(getByName) {
  return {
    ROOM_ORIGIN: origin,
    ROOM: {
      idFromName(name) {
        assert.equal(name, "invite-only-pilot");
        return { toString: () => "ab".repeat(32) };
      },
      getByName,
    },
  };
}

test("2026-09-25: a CPU-reset Durable Object takes down /api/version while /api/version/worker still answers", async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  let opened = 0;
  const down = () => {
    opened += 1;
    throw new Error(cpuReset);
  };
  try {
    const workerVersion = await worker.fetch(
      new Request(`${origin}/api/version/worker`),
      roomEnv(() => { throw new Error("version/worker must not open the Durable Object"); }),
    );
    assert.equal(workerVersion.status, 200);
    const signal = await workerVersion.json();
    assert.equal(signal.status, "ok");
    assert.equal(signal.servedBy, "worker");
    assert.equal(signal.durableObject.name, "invite-only-pilot");
    assert.equal(typeof signal.sourceRevision, "string");
    assert.equal(signal.sourceRevision.length > 0, true);
    assert.equal(opened, 0);

    const version = await worker.fetch(
      new Request(`${origin}/api/version`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
      roomEnv(down),
    );
    assert.equal(version.status, 503);
    const body = await version.json();
    assert.equal(body.error.code, "room_unavailable");
    assert.equal(JSON.stringify(body).includes(cpuReset), false);
    assert.equal(opened, 1);

    const jobs = await worker.fetch(new Request(`${origin}/api/health/jobs`), roomEnv(down));
    assert.equal(jobs.status, 503);
    const jobsBody = await jobs.json();
    assert.equal(jobsBody.schema, "room.job-health/1");
    assert.equal(jobsBody.status, "unavailable");
    assert.equal(opened, 2);
    assert.equal(JSON.stringify(jobsBody).includes(cpuReset), false);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});
