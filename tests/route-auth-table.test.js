import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { extractLegacyRoutes, loadRouteSources } from "../scripts/routes-inventory.mjs";

// Formalizes docs/ROUTE-AUTH-TABLE.md: every mutating room route rejects
// unauthenticated requests. POST /api/agent-identities is intentionally
// unauthenticated (creating an identity grants no room access).
//
// The route set is derived from the code, never hand-listed. The previous
// hand-kept list silently omitted live routes (dm-consents and its
// decide/block/revoke/unblock children, public-face, verification-policy,
// ownership/transfer, project-offers, directory, the guest-invites
// revoke/disconnect/revoke-all/upgrade family, and more), so an auth
// bypass on any of them passed the sweep. Sources:
//   - ROUTES in server/routes/table.mjs: rows registered in the route
//     table (rows with auth "none" are open by design, not credential
//     routes, and none sits under /api/rooms today);
//   - extractLegacyRoutes in scripts/routes-inventory.mjs: routes still
//     served by the legacy chain in server/http.mjs and its feature
//     modules — the same extraction the route-table parity gate uses.
// A route added to either source joins this sweep automatically.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const root = new URL("..", import.meta.url);

const templateKey = path => path.replace(/\{[^}]+\}/g, "{}");

function derivedMutatingRoomRoutes() {
  const found = new Map();
  const add = (method, path) => {
    if (!MUTATING_METHODS.has(method) || !path.startsWith("/api/rooms/")) return;
    const key = `${method} ${templateKey(path)}`;
    if (!found.has(key)) found.set(key, { method, path });
  };
  for (const row of extractLegacyRoutes(loadRouteSources(root.pathname))) add(row.method, row.path);
  for (const row of ROUTES) {
    if (row.auth === "none") continue;
    add(row.method, row.path);
  }
  return [...found.values()].sort((a, b) => a.path === b.path
    ? a.method.localeCompare(b.method)
    : a.path.localeCompare(b.path));
}

const MUTATING_ROOM_ROUTES = derivedMutatingRoomRoutes();
// Extraction sanity: a silently empty or gutted derivation must fail here,
// not pass by probing nothing. The served surface is far above this floor.
assert.ok(MUTATING_ROOM_ROUTES.length >= 100,
  `route derivation sanity: expected the full mutating room surface, got ${MUTATING_ROOM_ROUTES.length}`);

// The doc is the completeness anchor in the other direction: if a route is
// deleted from the code (either source above) while the doc still promises
// it, the derived set shrinks and this test names what went missing.
test("every mutating room route in docs/ROUTE-AUTH-TABLE.md is in the derived set", () => {
  const doc = readFileSync(new URL("../docs/ROUTE-AUTH-TABLE.md", import.meta.url), "utf8");
  const derived = new Set(MUTATING_ROOM_ROUTES.map(({ method, path }) => `${method} ${templateKey(path)}`));
  const missing = [];
  for (const match of doc.matchAll(/`(GET|POST|PUT|PATCH|DELETE|HEAD) (\/api\/rooms\/[^` ]+)`/g)) {
    if (!MUTATING_METHODS.has(match[1])) continue;
    const key = `${match[1]} ${match[2].replace(/\{[^}]+\}/g, "{}").replace(/:[A-Za-z0-9_]+/g, "{}")}`;
    if (!derived.has(key)) missing.push(key);
  }
  assert.deepEqual(missing, [], "documented mutating room routes missing from the served-route derivation");
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-route-auth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return origin;
}

// Room segment becomes the seeded room; any other parameter gets a plain
// sample value (the credential funnel answers before parameter lookups).
const concrete = template => template
  .replace(/^\/api\/rooms\/\{[^}]*\}/, "/api/rooms/commons")
  .replace(/\{[^}]*\}/g, "some-id");

test("mutating room routes reject unauthenticated requests", async t => {
  const origin = await serve(t);
  for (const { method, path } of MUTATING_ROOM_ROUTES) {
    const res = await fetch(`${origin}${concrete(path)}`, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.ok([401, 403].includes(res.status), `${method} ${path}: expected 401/403, got ${res.status}`);
    await res.text().catch(() => {});
  }
});

test("identity creation stays unauthenticated but grants no room access", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "route-auth-probe" }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.ok(created.identityId?.startsWith("ai_"), "identity id shape");
  // The new credential authenticates the identity but not any room.
  const room = await fetch(`${origin}/api/rooms/commons`, {
    headers: { Origin: origin, Authorization: `Bearer ${created.secret}` },
  });
  assert.ok([401, 403].includes(room.status), `identity token must not open rooms, got ${room.status}`);
});
