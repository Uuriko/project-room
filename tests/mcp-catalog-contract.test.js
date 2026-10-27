// TST-05: contract snapshot of the hosted MCP catalog.
// A tool add, remove, inputSchema change or annotation change in any served
// tools/list profile fails here until tests/fixtures/mcp-catalog.snapshot.json
// is regenerated in the same PR (node scripts/mcp-catalog-snapshot.mjs --write).
// The snapshot diff is the review surface for catalog changes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SNAPSHOT_PATH, buildSnapshot, canonicalJson, diffSnapshots, formatSnapshotDiff } from "../scripts/mcp-catalog-snapshot.mjs";

test("the served MCP catalog matches the reviewed snapshot", () => {
  const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const actual = buildSnapshot();
  const changes = diffSnapshots(expected, actual);
  assert.deepEqual(changes, [], `MCP catalog changed:\n${formatSnapshotDiff(expected, actual)}`);
});

test("formatSnapshotDiff prints the real hashes and the cure, including the count-pin follow-on", () => {
  const base = { core: { room_a: { inputSchema: "aaaa", annotations: {} } } };
  const next = { core: { room_a: { inputSchema: "bbbb", annotations: {} }, room_c: { inputSchema: "cccc", annotations: {} } } };
  const report = formatSnapshotDiff(base, next);
  assert.match(report, /core: ~ room_a inputSchema hash committed aaaa -> served bbbb/);
  assert.match(report, /core: \+ room_c/);
  assert.match(report, /node scripts\/mcp-catalog-snapshot\.mjs --write/);
  assert.match(report, /tests\/mcp-search-actions\.test\.js/);
  assert.match(report, /tests\/mcp-untrusted-content\.test\.js/);
  assert.equal(formatSnapshotDiff(base, base), "");
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
