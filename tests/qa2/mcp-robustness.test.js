import { test } from "node:test";
import assert from "node:assert/strict";
import { enabled, startServer, runChecker } from "./helpers.js";

test("MCP robustness: malformed and edge inputs never 5xx, leak, or break JSON-RPC", { skip: !enabled, timeout: 5 * 60_000 }, async () => {
  const server = await startServer();
  try {
    const { code, stdout } = await runChecker("mcp-robustness.mjs", ["--url", `${server.origin}/mcp`]);
    assert.equal(code, 0, stdout);
  } finally { server.stop(); }
});
