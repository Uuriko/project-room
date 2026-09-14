// Cold-start measurement (re-audit 2026-09-14, M5).
//
// cloudflare/wrangler.jsonc caps the Worker at `limits.cpu_ms`; the Durable
// Object's first request evaluates the modules, opens the store (schema
// verification, provenance and invitation audits) and answers. This script
// measures those phases so the cap is chosen against a number, not a guess.
//
//   node scripts/measure-cold-start.mjs [runs=3] [--json] [--no-miniflare]
//
// Node: each run is a fresh child process that times import of
// server/store.mjs + server/http.mjs, a fresh store (initialize), listen plus
// the first /api/health, the first authenticated room snapshot, and reopening
// the existing database (the constructor path a restarted object takes).
// CPU is process.cpuUsage() (user + system); wall is performance.now().
//
// miniflare: when cloudflare/node_modules has miniflare and esbuild (pnpm
// install in cloudflare/), the real cloudflare/room.mjs entry runs in workerd
// and the same requests are timed from outside. workerd exposes no CPU
// counter, so those rows are wall time only; `await mf.ready` runs first so
// the cold row is isolate creation + module evaluation + object constructor,
// not the workerd process start. Results in docs/WORKER-LIMITS.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const childIndex = args.indexOf("--child");
const ms = value => Math.round(value * 100) / 100;
const median = values => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---------------------------------------------------------------- Node child
if (childIndex >= 0) {
  const directory = args[childIndex + 1];
  const phases = [];
  let cpu = process.cpuUsage(), wall = performance.now();
  const mark = name => {
    const c = process.cpuUsage(cpu), w = performance.now();
    phases.push({ name, cpuMs: ms((c.user + c.system) / 1000), wallMs: ms(w - wall) });
    cpu = process.cpuUsage(); wall = performance.now();
  };
  const { RoomStore } = await import(pathToFileURL(join(root, "server/store.mjs")));
  const { createRoomServer } = await import(pathToFileURL(join(root, "server/http.mjs")));
  const { initialRoom } = await import(pathToFileURL(join(root, "server/bootstrap.mjs")));
  mark("import server/store.mjs + server/http.mjs");
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  mark("fresh store: constructor + initialize");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${origin}/api/health`);
  if (health.status !== 200) throw new Error(`health ${health.status}`);
  await health.arrayBuffer();
  mark("listen + first GET /api/health");
  const snapshot = await fetch(`${origin}/api/rooms/commons`, { headers: { Authorization: `Bearer ${ownerKey}` } });
  if (snapshot.status !== 200) throw new Error(`snapshot ${snapshot.status}`);
  await snapshot.arrayBuffer();
  mark("first authenticated GET /api/rooms/commons");
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();
  cpu = process.cpuUsage(); wall = performance.now();
  const reopened = new RoomStore(file);
  mark("reopen existing store (constructor only)");
  reopened.close();
  console.log(JSON.stringify(phases));
  process.exit(0);
}

// ------------------------------------------------------------ Node parent
const RUNS = Number(args.filter(a => !a.startsWith("--"))[0] ?? 3);
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error("Usage: node scripts/measure-cold-start.mjs [runs>=1] [--json] [--no-miniflare]");
  process.exit(2);
}
const table = [];
const nodeRuns = [];
for (let run = 0; run < RUNS; run++) {
  const directory = mkdtempSync(join(tmpdir(), "room-cold-start-"));
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", directory], { encoding: "utf8" });
    if (child.status !== 0) { console.error(child.stderr); process.exit(child.status || 1); }
    nodeRuns.push(JSON.parse(child.stdout.trim().split("\n").at(-1)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
for (const [index, { name }] of nodeRuns[0].entries()) {
  table.push({ runtime: `Node ${process.version}`, phase: name,
    cpuMs: ms(median(nodeRuns.map(run => run[index].cpuMs))), wallMs: ms(median(nodeRuns.map(run => run[index].wallMs))) });
}

// -------------------------------------------------------------- miniflare
let miniflareNote = "skipped (--no-miniflare)";
if (!flags.has("--no-miniflare")) {
  const requireCloudflare = createRequire(join(root, "cloudflare/package.json"));
  let modules = null;
  try { modules = { miniflare: requireCloudflare.resolve("miniflare"), esbuild: requireCloudflare.resolve("esbuild") }; }
  catch { miniflareNote = "skipped: miniflare/esbuild not installed (run pnpm install --frozen-lockfile --ignore-scripts in cloudflare/)"; }
  if (modules) {
    const { Miniflare, Response } = await import(pathToFileURL(modules.miniflare));
    const { build } = await import(pathToFileURL(modules.esbuild));
    // LOCAL MEASUREMENT ONLY: the real cloudflare/room.mjs entry with one
    // extra route that initialises the empty workspace (as the operator
    // bootstrap would). It is bundled from memory and never deployed.
    const fixture = `import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
export class MeasureRoom extends ProjectRoom {
  fetch(request) {
    if (new URL(request.url).pathname === '/__measure-provision') {
      if (!this.store.db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) this.store.initialize(initialRoom());
      return Response.json({ ownerKey: this.store.issueAccessKey('commons', 'owner') });
    }
    return super.fetch(request);
  }
}
export default entry;
`;
    const bundled = await build({ stdin: { contents: fixture, resolveDir: join(root, "cloudflare"), sourcefile: "measure-room.mjs", loader: "js" },
      bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"] });
    const origin = "https://room.example.test";
    const samples = { cold: [], warm: [], reopen: [], snapshot: [], warmSnapshot: [] };
    for (let run = 0; run < RUNS; run++) {
      const persistence = mkdtempSync(join(tmpdir(), "room-cold-start-cf-"));
      const config = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
        durableObjects: { ROOM: { className: "MeasureRoom", useSQLite: true } }, durableObjectsPersist: persistence,
        bindings: { ROOM_ORIGIN: origin }, serviceBindings: { ASSETS: async () => new Response(null, { status: 404 }) } };
      const headers = { Host: new URL(origin).host, "CF-Connecting-IP": "192.0.2.1" };
      const timed = async (mf, path, extra = {}) => {
        const start = performance.now();
        const response = await mf.dispatchFetch(origin + path, { headers: { ...headers, ...extra } });
        await response.arrayBuffer();
        if (response.status !== 200) throw new Error(`${path} -> ${response.status}`);
        return ms(performance.now() - start);
      };
      let mf = new Miniflare(config);
      try {
        await mf.ready;
        samples.cold.push(await timed(mf, "/api/health"));
        samples.warm.push(await timed(mf, "/api/health"));
        const provisioned = await mf.dispatchFetch(origin + "/__measure-provision", { headers });
        if (!provisioned.ok) throw new Error(`provision (/__measure-provision) -> ${provisioned.status}: ${await provisioned.text()}`);
        const { ownerKey } = await provisioned.json();
        await mf.dispose();
        mf = new Miniflare(config);
        await mf.ready;
        samples.reopen.push(await timed(mf, "/api/health"));
        samples.snapshot.push(await timed(mf, "/api/rooms/commons", { Authorization: `Bearer ${ownerKey}` }));
        samples.warmSnapshot.push(await timed(mf, "/api/rooms/commons", { Authorization: `Bearer ${ownerKey}` }));
      } finally { await mf.dispose(); rmSync(persistence, { recursive: true, force: true }); }
    }
    const version = requireCloudflare("miniflare/package.json").version;
    const runtime = `miniflare ${version}`;
    table.push({ runtime, phase: "cold object, empty storage: first GET /api/health (isolate + modules + constructor + schema)", cpuMs: null, wallMs: ms(median(samples.cold)) });
    table.push({ runtime, phase: "warm GET /api/health", cpuMs: null, wallMs: ms(median(samples.warm)) });
    table.push({ runtime, phase: "cold object, existing store: first GET /api/health (reopen + verify)", cpuMs: null, wallMs: ms(median(samples.reopen)) });
    table.push({ runtime, phase: "first authenticated GET /api/rooms/commons", cpuMs: null, wallMs: ms(median(samples.snapshot)) });
    table.push({ runtime, phase: "warm authenticated GET /api/rooms/commons", cpuMs: null, wallMs: ms(median(samples.warmSnapshot)) });
    miniflareNote = `${runtime}; wall time only (workerd exposes no CPU counter); workerd process start excluded via mf.ready`;
  }
}

// ----------------------------------------------------------------- report
if (flags.has("--json")) {
  console.log(JSON.stringify({ node: process.version, runs: RUNS, statistic: "median", miniflare: miniflareNote, rows: table }, null, 2));
} else {
  const width = Math.max(...table.map(row => row.phase.length));
  console.log(`Cold-start measurement, median of ${RUNS} run${RUNS === 1 ? "" : "s"} (CPU = process user+system time; wall = elapsed)`);
  console.log(`${"runtime".padEnd(22)} ${"phase".padEnd(width)} ${"CPU ms".padStart(8)} ${"wall ms".padStart(8)}`);
  for (const row of table) console.log(`${row.runtime.padEnd(22)} ${row.phase.padEnd(width)} ${(row.cpuMs === null ? "n/a" : String(row.cpuMs)).padStart(8)} ${String(row.wallMs).padStart(8)}`);
  console.log(`miniflare: ${miniflareNote}`);
}
