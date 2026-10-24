import test from "node:test";
import assert from "node:assert/strict";
import { connectSnippet, connectChecks } from "../src/room-roster.js";

const origin = "https://room.example";
const roomKey = "a".repeat(43);
const scoped = "rak_scopedtokenvalue";

test("connect snippet is one MCP block for a scoped token and refuses anything else", () => {
  const block = JSON.parse(connectSnippet({ origin, credential: scoped }));
  assert.equal(block.mcpServers["project-room"].url, `${origin}/mcp`);
  assert.equal(block.mcpServers["project-room"].headers.Authorization, `Bearer ${scoped}`);
  const room = JSON.parse(connectSnippet({ origin: `${origin}/`, credential: roomKey }));
  assert.equal(room.mcpServers["project-room"].url, `${origin}/mcp`);
  assert.equal(room.mcpServers["project-room"].headers.Authorization, `Bearer ${roomKey}`);
  assert.equal(connectSnippet({ origin, credential: "pri_" + "b".repeat(43) }), "");
  assert.equal(connectSnippet({ origin, credential: "not-a-token" }), "");
  assert.equal(connectSnippet({ origin: "file:///tmp/room", credential: scoped }), "");
  assert.equal(connectSnippet({ origin: "https://room.example/extra", credential: scoped }), "");
  assert.equal(connectSnippet({ origin: "", credential: scoped }), "");
  assert.equal(connectSnippet({ origin, credential: "" }), "");
});

test("connect checks mark connected, read, and first post from use, not from the row existing", () => {
  assert.deepEqual(connectChecks({}), [
    { id: "connected", done: false },
    { id: "read", done: false },
    { id: "post", done: false }
  ]);
  assert.deepEqual(connectChecks({ lastUsedAt: 10, readAt: null, posted: false }).map(row => row.done), [true, false, false]);
  assert.deepEqual(connectChecks({ lastUsedAt: null, readAt: 10, posted: false }).map(row => row.done), [false, true, false]);
  assert.deepEqual(connectChecks({ lastUsedAt: null, readAt: null, posted: true }).map(row => row.done), [false, true, true]);
  assert.deepEqual(connectChecks({ lastUsedAt: 10, readAt: 10, posted: true }).map(row => row.done), [true, true, true]);
});
