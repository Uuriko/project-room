import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES, ROUTE_PUBLICATION_NOTE, assertRouteRow } from "../server/routes/table.mjs";
import { effectivePublication, isPublicRoute, isPublishable, publicationProblems } from "../scripts/route-publication.mjs";

// #3674 registry: every public route in the table declares its publication
// policy. The enumeration is the live ROUTES array, so a public route added
// later — in any route group — is enumerated automatically and fails here
// until it declares. Undeclared resolves to no policy (fail-closed).
const row = extra => ({ id: "probe", method: "GET", path: "/api/probe", auth: "none", capability: null, handler() {}, schema: { response: { type: "object" } }, events: [], scope: "public", ...extra });

test("every public route has a publication declaration", () => {
  assert.deepEqual(publicationProblems(ROUTES, ROUTE_PUBLICATION_NOTE), []);
});

test("the public set is enumerated live from the table, not a pinned list", () => {
  const publicRoutes = ROUTES.filter(isPublicRoute);
  // #3674 started with demo and the front door. Main has since added the
  // download page and the public agent page, and this batch adds the door
  // funnel. A new public route grows this set and must declare (next test);
  // a vanished one should make this line be revisited, not silently pass.
  assert.deepEqual(publicRoutes.map(r => r.id).sort(), [
    "demo-get", "demo-head", "download-get", "download-head",
    "public-agent-ask", "public-agent-card", "public-agent-page", "public-agent-poll",
    "public-front-door-get", "public-front-door-head", "public.door-funnel",
  ]);
  for (const r of publicRoutes) assert.ok(isPublishable(r, ROUTE_PUBLICATION_NOTE), `${r.id} is public but not publishable under its declaration`);
});

test("a new public route without a declaration fails; a declaration fixes it", () => {
  assert.match(publicationProblems([row()], ROUTE_PUBLICATION_NOTE)[0], /probe .*add publication/);
  assert.deepEqual(publicationProblems([row({ publication: "gate:public-visibility" })], ROUTE_PUBLICATION_NOTE), []);
  assert.deepEqual(publicationProblems([row({ publication: "open:static marketing page, no room data" })], ROUTE_PUBLICATION_NOTE), []);
  // Appended to the real table, the undeclared probe is the only problem:
  // routes added later fail loudly, by id, not by a silent pass.
  assert.deepEqual(publicationProblems([...ROUTES, row()], ROUTE_PUBLICATION_NOTE).map(p => p.split(" ")[0]), ["probe"]);
});

test("undeclared defaults to fail-closed in the registry model", () => {
  assert.equal(effectivePublication(row()), null);
  assert.equal(isPublishable(row(), ROUTE_PUBLICATION_NOTE), false);
  assert.equal(isPublishable(row({ publication: "gate:public-visibility" }), ROUTE_PUBLICATION_NOTE), true);
});

test("non-public rows need no declaration, but a malformed one fails anywhere", () => {
  assert.deepEqual(publicationProblems([row({ scope: "room" })], ROUTE_PUBLICATION_NOTE), []);
  assert.match(publicationProblems([row({ publication: "yes" })], ROUTE_PUBLICATION_NOTE)[0], /not gate:public-visibility or open:/);
  assert.match(publicationProblems([row({ publication: "open:no" })], ROUTE_PUBLICATION_NOTE)[0], /not gate:public-visibility or open:/);
  assert.match(publicationProblems([row({ scope: "room", publication: "gate:some-other-gate" })], ROUTE_PUBLICATION_NOTE)[0], /not gate:public-visibility or open:/);
});

test("assertRouteRow rejects a malformed publication value", () => {
  assert.deepEqual(assertRouteRow(row({ publication: "gate:public-visibility" })), []);
  assert.deepEqual(assertRouteRow(row({ publication: "open:static marketing page, no room data" })), []);
  assert.deepEqual(assertRouteRow(row({ publication: "yes" })), ["publication"]);
  assert.deepEqual(assertRouteRow(row()), []);
});
