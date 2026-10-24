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
  assert.equal(classifyEdgePath("/privacy"), "legal");
  assert.equal(classifyEdgePath("/terms"), "legal");
  assert.equal(classifyEdgePath("/acceptable-use"), "legal");
  assert.equal(classifyEdgePath("/room/privacy"), "legal-alias");
  assert.equal(classifyEdgePath("/report"), "report");
  assert.equal(classifyEdgePath("/join"), "join");
  assert.equal(classifyEdgePath("/join/code"), null);
  assert.equal(classifyEdgePath("/agent-signin"), "agent-signin");
  assert.equal(classifyEdgePath("/rooms/demo"), "room-page");
  assert.equal(classifyEdgePath("/a/entry-0123456789abcdef.js"), "asset");
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

test("legal pages and the join shell are answered without the Durable Object", async () => {
  let fetches = 0;
  const env = {
    ROOM_ORIGIN: "https://room.example.test",
    ASSETS: { fetch: async request => {
      fetches += 1;
      const path = new URL(request.url).pathname;
      if (path === "/join.html") return new Response('<a href="{{ASSET_BASE}}/src/join.js">join</a>');
      if (path === "/agent-signin.html") return new Response("agent {{ASSET_BASE}}");
      return new Response("missing", { status: 404 });
    } }
  };
  const origin = "https://room.example.test";
  const privacy = await edgePublicResponse(new Request(origin + "/privacy"), env, new URL(origin + "/privacy"));
  assert.equal(privacy.status, 200);
  assert.equal(privacy.headers.get("cache-control"), "public, max-age=3600");
  assert.match(privacy.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
  assert.match(await privacy.text(), /<h1>Privacy/);
  assert.equal(fetches, 0, "legal HTML does not read ASSETS or the object");
  const alias = await edgePublicResponse(new Request(origin + "/room/terms?ref=door"), env, new URL(origin + "/room/terms?ref=door"));
  assert.equal(alias.status, 301);
  assert.equal(alias.headers.get("location"), "https://room.trydemigod.com/terms?ref=door");
  const join = await edgePublicResponse(new Request(origin + "/join"), env, new URL(origin + "/join"));
  assert.equal(join.status, 200);
  assert.equal(join.headers.get("cache-control"), "public, max-age=300");
  assert.equal(await join.text(), '<a href="/src/join.js">join</a>');
  const posted = await edgePublicResponse(new Request(origin + "/join", { method: "POST" }), env, new URL(origin + "/join"));
  assert.equal(posted, null, "POST /join stays on the Durable Object");
  const coded = await edgePublicResponse(new Request(origin + "/join/abc"), env, new URL(origin + "/join/abc"));
  assert.equal(coded, null);
  const signin = await edgePublicResponse(new Request(origin + "/room/agent-signin"), env, new URL(origin + "/room/agent-signin"));
  assert.equal(await signin.text(), "agent /room");
  const room = await edgePublicResponse(new Request(origin + "/rooms/demo", { headers: { accept: "text/html" } }), env, new URL(origin + "/rooms/demo"));
  assert.match(await room.text(), /href="\/src\/join\.js"/);
  const api = await edgePublicResponse(new Request(origin + "/rooms/demo", { headers: { accept: "application/json" } }), env, new URL(origin + "/rooms/demo"));
  assert.equal(api, null);
  const hashed = await edgePublicResponse(new Request(origin + "/a/app-0123456789abcdef.js"), env, new URL(origin + "/a/app-0123456789abcdef.js"));
  assert.equal(hashed.status, 404);
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
