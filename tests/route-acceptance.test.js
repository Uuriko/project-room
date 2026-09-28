// tests/route-acceptance.test.js — scripts/route-acceptance.mjs.
// Contract guarded: a route the server really mounts passes even when it
// refuses the anonymous probe (401), and a route that only exists in a
// module nobody imports is reported MISSING with exit 1. The board v2
// prototype is the real example from 2026-09-27.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseRoutes, isUnmounted, checkRoutes } from "../scripts/route-acceptance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("mounted routes pass whatever they answer; unmounted ones fail", async () => {
  const results = await checkRoutes(parseRoutes(["GET /api/health", "GET /api/rooms/{roomId}/work-claims", "GET /api/rooms/{roomId}/board", "GET /no-such-page"]));
  assert.deepEqual(results.map(r => [r.route, r.mounted]), [
    ["GET /api/health", true],
    ["GET /api/rooms/{roomId}/work-claims", true],
    ["GET /api/rooms/{roomId}/board", false],
    ["GET /no-such-page", false],
  ]);
});

test("only the generic unmatched 404 counts as missing", () => {
  assert.equal(isUnmounted(404, JSON.stringify({ error: { code: "not_found", message: "Not found" } })), true);
  assert.equal(isUnmounted(404, JSON.stringify({ error: { code: "work_claim_not_found", message: "No work claim" } })), false);
  assert.equal(isUnmounted(401, "{}"), false);
  assert.throws(() => parseRoutes(["/api/health"]), /METHOD \/path/);
});

test("the CLI exits 1 when a named route is not mounted", () => {
  let status = 0;
  try { execFileSync(process.execPath, [join(root, "scripts", "route-acceptance.mjs"), "GET /api/health", "GET /api/rooms/{roomId}/board"], { stdio: "pipe" }); }
  catch (error) { status = error.status; }
  assert.equal(status, 1);
});
