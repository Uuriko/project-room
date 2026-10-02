import test from "node:test";
import assert from "node:assert/strict";
import { classifyEdgePath, edgePublicResponse } from "../cloudflare/edge-public.mjs";
import { percentile, probeVerdict, parseProbeArgs } from "../scripts/stall-probe.mjs";

test("static pages, source assets, and discovery documents are classified off the Durable Object", () => {
  assert.equal(classifyEdgePath("/"), "asset");
  assert.equal(classifyEdgePath("/about"), "asset");
  assert.equal(classifyEdgePath("/src/app.js"), "asset");
  assert.equal(classifyEdgePath("/src/styles.css"), "asset");
  assert.equal(classifyEdgePath("/llms.txt"), "discovery");
  assert.equal(classifyEdgePath("/agents.json"), "discovery");
  assert.equal(classifyEdgePath("/room/llms.txt"), "discovery");
  assert.equal(classifyEdgePath("/mcp/server-card"), "discovery");
  assert.equal(classifyEdgePath("/.well-known/mcp.json"), "discovery");
  assert.equal(classifyEdgePath("/openapi.json"), "openapi");
  assert.equal(classifyEdgePath("/room/openapi.json"), "openapi");
  assert.equal(classifyEdgePath("/skills"), null);
  assert.equal(classifyEdgePath("/api/health"), null);
  assert.equal(classifyEdgePath("/api/version/worker"), null);
  assert.equal(classifyEdgePath("/src/not-shipped.js"), null);
});

test("edge asset reads are cached in the isolate and carry Server-Timing later from the worker", async () => {
  let fetches = 0;
  const env = {
    ROOM_ORIGIN: "https://room.example.test",
    ASSETS: { fetch: async () => { fetches += 1; return new Response("app-bytes"); } }
  };
  const url = new URL("https://room.example.test/src/app.js");
  const first = await edgePublicResponse(new Request(url), env, url);
  const second = await edgePublicResponse(new Request(url), env, url);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "app-bytes");
  assert.equal(await second.text(), "app-bytes");
  assert.equal(fetches, 1);
  assert.match(first.headers.get("content-type"), /javascript/);
  assert.match(first.headers.get("link"), /llms\.txt/);
  const post = await edgePublicResponse(new Request(url, { method: "POST" }), env, url);
  assert.equal(post.status, 405);
  assert.equal(fetches, 1);
});

test("stall probe p99 fails above 3s and the argument parser keeps the URL", () => {
  assert.equal(percentile([10, 20, 30, 40], 99), 40);
  assert.equal(percentile([5], 99), 5);
  const fine = probeVerdict([80, 90, 120], { maxP99Ms: 3000 });
  assert.equal(fine.ok, true);
  const stalled = probeVerdict([90, 90, 4500], { maxP99Ms: 3000 });
  assert.equal(stalled.ok, false);
  assert.ok(stalled.p99 > 3000);
  assert.deepEqual(parseProbeArgs(["--url", "https://room.example", "--seconds", "12", "--path", "/llms.txt", "--max-ms", "2500"]), {
    url: "https://room.example", seconds: 12, path: "/llms.txt", maxP99Ms: 2500
  });
});
