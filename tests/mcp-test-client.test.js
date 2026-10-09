// The MCP test harness must not crash when the child's stdout carries a
// non-JSON line (log noise, a stray blank line, a truncated write): malformed
// lines are quarantined into diagnostics and later responses still route.
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpLineRouter } from "../scripts/mcp-test-client.mjs";

function harness() {
  const resolved = [], malformed = [];
  const router = createMcpLineRouter({ resolve: message => resolved.push(message), malformed: line => malformed.push(line) });
  return { router, resolved, malformed };
}

test("valid JSON-RPC responses route to the resolver", () => {
  const { router, resolved, malformed } = harness();
  router.push('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 1);
  assert.deepEqual(malformed, []);
});

test("garbage, blank and non-object lines are quarantined without crashing", () => {
  const { router, resolved, malformed } = harness();
  router.push('this is not json\n');
  router.push('\n');
  router.push('42\n');
  router.push('[1,2]\n');
  assert.equal(malformed.length, 4);
  assert.equal(resolved.length, 0);
  // The harness keeps working after the noise.
  router.push('{"jsonrpc":"2.0","id":2,"result":"still alive"}\n');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 2);
});

test("lines split across data chunks are reassembled", () => {
  const { router, resolved, malformed } = harness();
  router.push('{"jsonrpc":"2.0","id":3,"res');
  router.push('ult":"split"}\n{"jsonrpc":"2.0","id":4,');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 3);
  router.push('"result":"ok"}\n');
  assert.equal(resolved.length, 2);
  assert.equal(resolved[1].id, 4);
  assert.deepEqual(malformed, []);
});
