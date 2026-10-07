// Contract tests for connectors/muse.md (the Meta Muse custom-connector brief).
//
// HT task 96 (200-hard-tasks): dogfood the brief as a new connector author
// would, pinning every example in the brief against the real server behavior:
//   - message.posted examples must carry data.messageId (the server requires
//     it; the 2026-10-07 dogfood found the examples missing it — every
//     connector built from the brief fails with 422 or posts un-addressable
//     messages).
//   - the events-response example must use the real envelope shape:
//     {"events": [{"sequence": N, "event": {"id", "type", "actorId", "at",
//     "data"}}], "next": N, "hasMore": bool} — the brief showed a flattened
//     {seq, type, actor} shape that no endpoint returns.
//   - every room_* MCP tool name mentioned must exist in the real tool
//     registry (server/mcp-discovery.mjs); bare tool names (e.g.
//     submit_text_result for room_submit_text_result) fail.
//
// These tests read the brief as shipped and fail on drift, so a stale brief
// cannot silently rot again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const briefPath = join(checkout, "connectors/muse.md");
const discoveryPath = join(checkout, "server/mcp-discovery.mjs");

function brief() {
  return readFileSync(briefPath, "utf8");
}

function jsonBlocks(md) {
  const out = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // ignore non-parseable blocks (e.g. the illustrative events shape
      // carries ellipses) — the shape assertion below is text-level.
    }
  }
  return out;
}

test("message.posted examples carry data.messageId (server requires it)", () => {
  const posts = jsonBlocks(brief()).filter(b => b.type === "message.posted");
  assert.ok(posts.length > 0, "brief should show at least one message.posted example");
  for (const p of posts) {
    assert.ok(
      p.data && typeof p.data.messageId === "string" && p.data.messageId.length > 0,
      `message.posted example must include data.messageId; got ${JSON.stringify(p.data)}`
    );
  }
});

test("events-response example uses the real envelope shape {sequence, event:{...}}", () => {
  const md = brief();
  // The dogfood failure was a flattened {"seq":1,"type":"message.posted","actor":"..."}
  // example. The real endpoint returns items shaped {sequence, event}.
  assert.ok(md.includes('"sequence"'), "brief events example must show the real 'sequence' field");
  assert.ok(
    /"event"\s*:\s*\{/.test(md),
    "brief events example must show the nested 'event' object"
  );
  assert.ok(md.includes('"actorId"'), "brief events example must show the real 'actorId' field (not 'actor')");
  assert.ok(md.includes('"hasMore"'), "brief events example must show 'hasMore'");
});

test("MCP tool names mentioned in the brief exist in the real registry", () => {
  const md = brief();
  const discovery = readFileSync(discoveryPath, "utf8");
  const mentioned = new Set();
  for (const m of md.matchAll(/\b(room_[a-z_]+)\b/g)) mentioned.add(m[1]);
  assert.ok(mentioned.size > 0, "brief should mention at least one room_* tool");
  for (const name of mentioned) {
    assert.ok(
      discovery.includes(`"${name}"`),
      `brief mentions MCP tool ${name} but it is not in server/mcp-discovery.mjs`
    );
  }
});

test("no bare (unprefixed) MCP tool names in the brief", () => {
  const md = brief();
  const bare = [...md.matchAll(/(?<![a-z_])submit_text_result(?![a-z_])/g)];
  assert.equal(
    bare.length,
    0,
    "brief must use the real tool name room_submit_text_result, not bare submit_text_result"
  );
});
