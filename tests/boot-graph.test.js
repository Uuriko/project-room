// BG-1 — boot-graph census (standing instrument; fix programme v2,
// readpath.md §3 + §5 item 3; drains NEW-RC-5).
//
// "The server" was two different executed graphs: the production entry
// (server.mjs) evaluated 139 server modules the fixture drives never
// loaded (runtime cartography RC-5, V8-coverage method over store-level
// seed drives). This census is the standing, deterministic guard: it
// boots BOTH entries under a module-load recorder and diffs the loaded
// module sets, so a new silent divergence fails CI instead of shipping.
//
// Method (named, so the numbers are never conflated with RC-5's):
// loaded-module sets via an ESM load hook (tests/helpers/module-census
// .mjs), scoped to the app graph (server.mjs, server/, src/,
// cloudflare/). The fixture boot is the canonical suite boot,
// createRoomServer({ store }) on an in-memory store
// (tests/helpers/fixture-boot.mjs). The production boot is the real
// entry, `node server.mjs`, in dev config semantics — the loaded graph
// is env-invariant because the entry's imports are static, and the
// config gate's production throw is covered separately in
// tests/boot-config.test.js. Each boot is driven with exactly one
// GET /api/health request. Known limit: this counts loaded modules,
// not executed functions; RC-5's coverage probe remains the deeper,
// one-off instrument.
//
// Intentional differences live in tests/boot-graph-allowlist.json —
// every entry names an owner and a reason; a stale entry (a difference
// that no longer exists) fails like a new one, so the registry only
// ever shrinks toward convergence.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";
import { telegramConfig } from "../server/channel-adapters/telegram-config.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const recorder = pathToFileURL(join(repo, "tests/helpers/module-census.mjs")).href;
const inScope = path => path === "server.mjs" || path.startsWith("server/") || path.startsWith("src/") || path.startsWith("cloudflare/");
const readCensus = file => new Set(
  JSON.parse(readFileSync(file, "utf8"))
    .map(url => relative(repo, fileURLToPath(url)).split(sep).join("/"))
    .filter(inScope)
);

function childEnv(out, dir, extra = {}) {
  const env = { ...process.env, MODULE_CENSUS_OUT: out, TMPDIR: dir, ...extra };
  for (const key of ["NODE_ENV", "ROOM_DEPLOYMENT", "ROOM_MAINTENANCE", "ROOM_ORIGIN", "ROOM_DB", "HOST", "PORT"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function bootFixture(dir) {
  const out = join(dir, "fixture.json");
  const run = spawnSync(process.execPath, ["--import", recorder, join(repo, "tests/helpers/fixture-boot.mjs")], {
    cwd: repo, env: childEnv(out, dir), encoding: "utf8", timeout: 60_000,
  });
  assert.equal(run.status, 0, `fixture boot failed: ${run.stderr || run.stdout}`);
  assert.match(run.stdout, /fixture boot ready: GET \/api\/health -> 200/);
  return readCensus(out);
}

async function bootProduction(dir) {
  const out = join(dir, "production.json");
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", recorder, join(repo, "server.mjs")], {
    cwd: repo,
    env: childEnv(out, dir, { HOST: "127.0.0.1", PORT: String(port), ROOM_DB: join(dir, "room.sqlite") }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`production boot produced no ready line in 30s\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 30_000);
      child.stdout.on("data", () => { if (stdout.includes("Project Room")) { clearTimeout(timer); resolve(); } });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`production boot exited (${code}) before readiness\nstdout:\n${stdout}\nstderr:\n${stderr}`)); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" } });
    assert.equal(response.status, 200, "production boot answers /api/health");
    await response.text();
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
  return readCensus(out);
}

test("boot-graph census: fixture and production boots execute the same module graph, modulo the allowlist", { timeout: 180_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "boot-graph-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = bootFixture(dir);
  const production = await bootProduction(dir);

  const productionOnly = [...production].filter(m => !fixture.has(m)).sort();
  const fixtureOnly = [...fixture].filter(m => !production.has(m)).sort();

  const allowlist = JSON.parse(readFileSync(join(repo, "tests/boot-graph-allowlist.json"), "utf8"));
  const entries = allowlist.entries.filter(entry => entry.suites.includes("node"));
  for (const entry of entries) {
    assert.ok(entry.module && entry.side && entry.owner && entry.reason,
      `allowlist entry must name module, side, owner and reason: ${JSON.stringify(entry)}`);
  }
  const allowed = side => new Set(entries.filter(entry => entry.side === side).map(entry => entry.module));
  const residualProduction = productionOnly.filter(m => !allowed("production-only").has(m));
  const residualFixture = fixtureOnly.filter(m => !allowed("fixture-only").has(m));
  const stale = [
    ...[...allowed("production-only")].filter(m => !productionOnly.includes(m)).map(m => `${m} (production-only)`),
    ...[...allowed("fixture-only")].filter(m => !fixtureOnly.includes(m)).map(m => `${m} (fixture-only)`),
  ];

  // The diff count is printed on every run: it is the number future
  // divergence is measured against (RC-5's coverage-method baseline was
  // 139 production-only server modules; this load-method census starts
  // from the measured values below).
  console.log(`boot-graph census: fixture=${fixture.size} production=${production.size} production-only=${productionOnly.length} fixture-only=${fixtureOnly.length} allowlisted=${entries.length} residual=${residualProduction.length + residualFixture.length}`);

  assert.deepEqual(residualProduction, [], `production-only modules with no allowlist entry (fix the divergence or register it with owner + reason in tests/boot-graph-allowlist.json): ${residualProduction.join(", ")}`);
  assert.deepEqual(residualFixture, [], `fixture-only modules with no allowlist entry: ${residualFixture.join(", ")}`);
  assert.deepEqual(stale, [], `stale allowlist entries (the difference no longer exists — remove the entry): ${stale.join(", ")}`);
});

test("smoke layer: a fixture boot through the shared boot path (defaultServerArgs, production-shaped arguments) serves health", async t => {
  // BG-1 scope (c): the smoke/fixture layer boots the way production
  // boots — same argument assembly (defaultServerArgs), same entry
  // function (createRoomServer), config validation on — instead of a
  // hand-rolled minimal argument set that skips the wired graph.
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  // server.mjs's shape: the origin is derived from the configured port
  // before listen, so pick the port first and derive the origin from it.
  const port = await freePort();
  const server = createRoomServer(defaultServerArgs({
    store, origin: `http://127.0.0.1:${port}`, streamInterval: 250,
    telegram: telegramConfig(process.env), growth: null,
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" } });
  assert.equal(response.status, 200);
  await response.text();
});
