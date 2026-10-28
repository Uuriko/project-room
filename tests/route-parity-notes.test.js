import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES, ROUTE_PARITY_NOTE, assertRouteRow } from "../server/routes/table.mjs";
import { loadBaseline, mcpToolNames, parityProblems } from "../scripts/route-parity-notes.mjs";

const row = extra => ({ id: "probe", method: "GET", path: "/api/probe", auth: "none", capability: null, handler() {}, schema: { response: { type: "object" } }, events: [], scope: "public", ...extra });
const tools = new Set(["room_read_messages", "room_post_message"]);

test("every route row has a parity note or is grandfathered", () => {
  assert.deepEqual(parityProblems(ROUTES, loadBaseline(), mcpToolNames(), ROUTE_PARITY_NOTE), []);
});

test("the grandfather list only shrinks", () => {
  // 115 rows on main 97f4edf2 (2026-10-09). Lower this number as rows get notes.
  assert.ok(loadBaseline().length <= 115, "do not add rows to route-parity-baseline.json; give the new route a parity note");
});

test("a new row without a note fails; a note fixes it", () => {
  assert.match(parityProblems([row()], [], tools, ROUTE_PARITY_NOTE)[0], /probe .*add parity/);
  assert.deepEqual(parityProblems([row({ parity: "mcp:room_read_messages" })], [], tools, ROUTE_PARITY_NOTE), []);
  assert.deepEqual(parityProblems([row({ parity: "mcp:room_read_messages,room_post_message" })], [], tools, ROUTE_PARITY_NOTE), []);
  assert.deepEqual(parityProblems([row({ parity: "exempt:browser-only OAuth redirect" })], [], tools, ROUTE_PARITY_NOTE), []);
});

test("bad notes, unknown tools and stale baseline entries fail", () => {
  assert.match(parityProblems([row({ parity: "mcp:room_nope" })], [], tools, ROUTE_PARITY_NOTE)[0], /room_nope is not in the catalog/);
  assert.match(parityProblems([row({ parity: "exempt:no" })], [], tools, ROUTE_PARITY_NOTE)[0], /not mcp:<tool> or exempt/);
  assert.match(parityProblems([row({ parity: "mcp:room_read_messages" })], ["probe"], tools, ROUTE_PARITY_NOTE)[0], /remove it from route-parity-baseline/);
  assert.match(parityProblems([], ["gone"], tools, ROUTE_PARITY_NOTE)[0], /gone: .*not in the route table/);
});

test("assertRouteRow rejects a malformed parity value", () => {
  assert.deepEqual(assertRouteRow(row({ parity: "mcp:room_read_messages" })), []);
  assert.deepEqual(assertRouteRow(row({ parity: "yes" })), ["parity"]);
});
