// QA2-CONTRACT served-spec coverage gate (2026-10-04).
//
// GET /openapi.json is generated from DISCOVERABILITY_ROUTES
// (server/discoverability.mjs): a hand-maintained inventory of the in-scope
// machine surfaces, not the full route table. Round 1 caught real drift by
// hand twice (served spec omitted /api/session and /api/oauth/sessions/*);
// this test mechanizes the check so the next omission fails CI instead of
// shipping silently.
//
// It boots a real server and diffs the SERVED document (not the table) against
// the routes the server actually serves, so generator bugs are caught too:
//
//   1. every /api path in the served spec must match a route the server
//      actually serves (no phantom spec paths), and
//   2. every served /api route template must be in the spec or covered by an
//      explicit exclusion in scripts/openapi-served-exclusions.json with a
//      reason (no silent omissions).
//
// The exclusion file is the machine-readable form of the table's scope: a new
// machine route fails CI until it is inventoried in server/discoverability.mjs
// or an exclusion is added with a reason. Stale exclusions (matching no
// served route) also fail, so the scope list cannot rot.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { servedRouteTemplates, routeSources, templateKey } from "../scripts/route-docs-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "openapi-served-coverage-"));
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

function loadExclusions() {
  const raw = readFileSync(join(ROOT, "scripts", "openapi-served-exclusions.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.exclusions) && parsed.exclusions.length > 0, "exclusions file has entries");
  return parsed.exclusions.map(({ prefix, reason }) => {
    assert.equal(typeof prefix, "string", "exclusion prefix is a string");
    assert.ok(typeof reason === "string" && reason.length > 10, `exclusion ${prefix} has a real reason`);
    return prefix.replace(/\/+$/, "");
  });
}

const excludedBy = (template, prefixes) =>
  prefixes.some(p => template === p || template.startsWith(p + "/"));

test("served /openapi.json matches the routes the server actually serves", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/openapi.json`, { headers: { Origin: origin } });
  assert.equal(res.status, 200, "GET /openapi.json is served");
  const doc = await res.json();
  assert.equal(doc.openapi, "3.1.0", "served document is OpenAPI 3.1");
  assert.ok(doc.paths && typeof doc.paths === "object", "served document has paths");

  const served = servedRouteTemplates(routeSources(ROOT + "/"));
  const specApi = new Map();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith("/api/")) continue;
    assert.ok(item && typeof item === "object", `spec path ${path} has an operations object`);
    specApi.set(templateKey(path), path);
  }
  assert.ok(specApi.size > 20, "served spec carries a real /api inventory");

  const prefixes = loadExclusions();

  // Direction 1: no phantom spec paths.
  const phantoms = [...specApi].filter(([key]) => !served.has(key));
  assert.deepEqual(phantoms.map(([, path]) => path), [],
    `served spec paths with no matching server route: ${phantoms.map(([, p]) => p).join(", ")}`);

  // Direction 2: no silently omitted routes.
  const omissions = [...served]
    .filter(([key]) => !specApi.has(key) && !excludedBy(key, prefixes))
    .map(([, template]) => template)
    .sort();
  assert.deepEqual(omissions, [],
    `served routes neither in the served OpenAPI spec nor excluded - inventory them in server/discoverability.mjs or add an exclusion with a reason:\n  ${omissions.join("\n  ")}`);

  // No stale exclusions.
  const stale = prefixes.filter(p => ![...served.keys()].some(k => k === p || k.startsWith(p + "/")));
  assert.deepEqual(stale, [], `stale exclusions match no served route: ${stale.join(", ")}`);
});
