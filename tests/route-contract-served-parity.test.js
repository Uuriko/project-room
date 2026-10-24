// #3689 served-vs-source parity: the W2 contract gate
// (tests/route-contract-coverage.test.js) classifies the route set DERIVED
// from router sources against the inventories — but it never reads the
// bytes agents actually consume. The served GET /openapi.json is generated
// from a second, hand-maintained inventory (server/discoverability.mjs),
// so drift can live in the generator or the serving path while every
// source-side gate stays green (instances: #3557, #1529, #3433).
//
// This test closes that gap WITHOUT single-sourcing the inventories (that
// decision is the #3689 PREP remainder): it boots the test server, fetches
// the actually-served /openapi.json (and its /room alias) and /llms.txt,
// and diffs the served route set against the route-contract census:
//
//   - every operation in the served bytes is a route the census serves
//     (no phantom operations in the artifact that ships);
//   - every operation the census credits to the served spec (inSpec) is
//     present in the served bytes (no generator/serve drift);
//   - every census operation is accounted for: in the served bytes, in
//     docs/openapi.yaml, classified in
//     scripts/route-contract-exemptions.json, or grandfathered in
//     scripts/route-contract-served-parity.json;
//   - every worked example (METHOD /path) in the served agent packet
//     names a census route or is grandfathered the same way.
//
// The parity file is shrink-only, reusing the exemptions mechanics:
// entries carry a class and a substantive reason, duplicates fail, and an
// entry whose divergence has closed (now served, now documented, now
// classified, or no longer served / no longer in the packet) is stale
// and fails — the list can only shrink.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildCensus } from "../scripts/route-contract-census.mjs";
import { templateKey } from "../scripts/routes-inventory.mjs";
import { templateKey as packetTemplateKey } from "../scripts/route-docs-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const census = buildCensus(root);
const exemptions = JSON.parse(readFileSync(new URL("../scripts/route-contract-exemptions.json", import.meta.url), "utf8"));
const parity = JSON.parse(readFileSync(new URL("../scripts/route-contract-served-parity.json", import.meta.url), "utf8"));

const censusKeys = new Set(census.records.map(r => r.key));
const specKeys = new Set(census.records.filter(r => r.inSpec).map(r => r.key));
const templateExempt = new Set(exemptions.templates.map(e => e.template));
const methodExempt = new Set(exemptions.methods.map(e => `${e.method} ${e.template}`));
const parityByKey = new Map(parity.entries.map(e => [`${e.method} ${e.template}`, e]));
const PARITY_CLASSES = new Set(["not-in-served-spec", "packet-example"]);

const OPENAPI_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "served-parity-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fetchServedSpec(origin, path) {
  const res = await fetch(`${origin}${path}`, { headers: { Origin: origin, "User-Agent": "project-room-agent" } });
  assert.equal(res.status, 200, `GET ${path} serves 200`);
  const doc = await res.json();
  assert.equal(typeof doc.openapi, "string", "served document declares an OpenAPI version");
  assert.ok(doc.paths && typeof doc.paths === "object", "served document carries paths");
  const ops = new Set();
  for (const [pathKey, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      if (OPENAPI_METHODS.has(method)) ops.add(`${method.toUpperCase()} ${templateKey(pathKey)}`);
    }
  }
  return ops;
}

// Worked examples in the agent packet: explicit "METHOD /path" mentions.
// Absolute URLs are the same paths with an origin in front and are not
// re-checked here; ALL-CAPS segments (TASK_ID) and {param}/:param forms
// normalise to {} like the docs gate, and the /room www-door prefix is an
// alias of the bare path.
function packetExamples(text) {
  const found = new Set();
  for (const match of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s`'"<>\]),;]+)/g)) {
    let path = match[2].replace(/[.:;]+$/, "").split(/[?#]/)[0];
    if (path.includes("…") || path.includes("*")) continue;
    if (path === "/room") continue;
    if (path.startsWith("/room/")) path = path.slice("/room".length);
    const segments = path.split("/").map(seg => /^[A-Z][A-Z0-9_]{1,}$/.test(seg) ? "{}" : seg);
    found.add(`${match[1]} ${packetTemplateKey(segments.join("/"))}`);
  }
  return found;
}

test("served /openapi.json is the source inventory, rendered — no generator or serve drift", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const served = await fetchServedSpec(origin, "/openapi.json");
  const alias = await fetchServedSpec(origin, "/room/openapi.json");
  assert.ok(served.size >= 80, `served operations floor (got ${served.size})`);
  assert.deepEqual([...alias].sort(), [...served].sort(),
    "the /room alias of /openapi.json serves the same route set as /openapi.json");
  assert.deepEqual([...served].filter(k => !specKeys.has(k)).sort(), [],
    "served /openapi.json carries operations the source inventory (server/discoverability.mjs, via the census) does not declare; the generator or the serving path drifted from the gated source");
  assert.deepEqual([...specKeys].filter(k => !served.has(k)).sort(), [],
    "the source inventory declares operations the served /openapi.json omits; agents reading the served bytes cannot see them (the #3557 shape)");
});

test("served /openapi.json describes only routes the census serves", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const served = await fetchServedSpec(origin, "/openapi.json");
  assert.deepEqual([...served].filter(k => !censusKeys.has(k)).sort(), [],
    "served /openapi.json describes operations the server does not serve; serve them or remove them from server/discoverability.mjs");
});

test("every census operation is in the served spec, the docs spec, a classification, or the shrink-only parity list", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const served = await fetchServedSpec(origin, "/openapi.json");
  const unaccounted = [];
  for (const r of census.records) {
    if (served.has(r.key) || r.inDocs) continue;
    if (templateExempt.has(r.templateKey) || methodExempt.has(r.key)) continue;
    if (parityByKey.has(r.key)) continue;
    unaccounted.push(r.key);
  }
  assert.deepEqual(unaccounted.sort(), [],
    "census operations accounted for nowhere an agent or the gates look; document them (docs/openapi.yaml), add them to the served spec (server/discoverability.mjs), classify them (scripts/route-contract-exemptions.json), or — for a pre-existing divergence only — grandfather them in scripts/route-contract-served-parity.json");
});

test("agent packet worked examples name only census routes or grandfathered examples", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/llms.txt`, { headers: { Origin: origin, "User-Agent": "project-room-agent" } });
  assert.equal(res.status, 200, "GET /llms.txt serves 200");
  const examples = packetExamples(await res.text());
  assert.ok(examples.size >= 20, `packet worked-example floor (got ${examples.size})`);
  const unaccounted = [...examples].filter(k => !censusKeys.has(k) && !parityByKey.has(k));
  assert.deepEqual(unaccounted.sort(), [],
    "the served agent packet works examples of routes the census does not serve; fix the packet (server/agent-discovery.mjs) or — for a pre-existing example only — grandfather it in scripts/route-contract-served-parity.json");
});

test("parity list is shrink-only and current (no stale, duplicate, or unsubstantiated entries)", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const served = await fetchServedSpec(origin, "/openapi.json");
  const res = await fetch(`${origin}/llms.txt`, { headers: { Origin: origin, "User-Agent": "project-room-agent" } });
  const examples = packetExamples(await res.text());
  assert.equal(parityByKey.size, parity.entries.length, "duplicate parity entries");
  const stale = [];
  for (const e of parity.entries) {
    assert.ok(PARITY_CLASSES.has(e.class), `unknown parity class ${e.class} for ${e.method} ${e.template}`);
    assert.ok(typeof e.reason === "string" && e.reason.length >= 40, `parity entry ${e.method} ${e.template} needs a substantive reason`);
    const key = `${e.method} ${e.template}`;
    if (e.class === "packet-example") {
      if (!examples.has(key)) stale.push(`${key} (no longer a packet worked example)`);
      else if (censusKeys.has(key)) stale.push(`${key} (now a census route; remove the entry)`);
      continue;
    }
    const record = census.records.find(r => r.key === key);
    if (!record) stale.push(`${key} (no longer served)`);
    else if (served.has(key)) stale.push(`${key} (now in the served spec; remove the entry)`);
    else if (record.inDocs) stale.push(`${key} (now in docs/openapi.yaml; remove the entry)`);
    else if (templateExempt.has(record.templateKey) || methodExempt.has(key)) stale.push(`${key} (now classified in route-contract-exemptions.json; remove the entry)`);
  }
  assert.deepEqual(stale.sort(), [], "stale served-parity entries — the parity list only shrinks");
});
