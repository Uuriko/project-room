// TST-05: contract snapshot of the hosted MCP catalog.
// A tool add, remove, inputSchema change or annotation change in any served
// tools/list profile fails here until tests/fixtures/mcp-catalog.snapshot.json
// is regenerated in the same PR (node scripts/mcp-catalog-snapshot.mjs --write).
// The snapshot diff is the review surface for catalog changes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SNAPSHOT_PATH, buildSnapshot, canonicalJson, diffSnapshots } from "../scripts/mcp-catalog-snapshot.mjs";

test("the served MCP catalog matches the reviewed snapshot", () => {
  const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const changes = diffSnapshots(expected, buildSnapshot());
  assert.deepEqual(changes, [], `MCP catalog changed. Review, then run: node scripts/mcp-catalog-snapshot.mjs --write\n${changes.join("\n")}`);
});

test("canonicalJson ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3] } }), canonicalJson({ a: { c: [3], d: 2 }, b: 1 }));
});

test("diffSnapshots reports added, removed and changed tools", () => {
  const base = { core: { room_a: { inputSchema: "1", annotations: {} }, room_b: { inputSchema: "2", annotations: {} } } };
  const next = { core: { room_a: { inputSchema: "9", annotations: {} }, room_c: { inputSchema: "3", annotations: {} } } };
  assert.deepEqual(diffSnapshots(base, next), ["core: + room_c", "core: - room_b", "core: ~ room_a inputSchema"]);
});

test("every served profile is in the snapshot and none is empty", () => {
  const snap = buildSnapshot();
  for (const [profile, tools] of Object.entries(snap)) assert.ok(Object.keys(tools).length > 0, `${profile} is empty`);
});
