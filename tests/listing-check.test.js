// Listing classifier. Stub fetch only: each kind can be listed, missing,
// stale, or unknown, and HTTP 429 is unknown.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkListings, checkRow, commandIdFor, listingExitCode, postListingSummary, renderSummary
} from "../scripts/listing-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(root, "docs/listings.json"), "utf8"));

function jsonResponse(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

const htmlRow = {
  id: "page", title: "Page", kind: "html", group: "directory",
  url: "https://directory.example/project-room",
  expect: { contains: "Project Room" }
};
const oneLinerRow = { ...htmlRow, id: "glama", expect: { oneLiner: true } };
const registryRow = {
  id: "mcp-registry", title: "Official MCP Registry", kind: "api", group: "directory",
  url: "https://registry.example/versions",
  expect: { type: "registry" }
};
const searchRow = {
  id: "pulsemcp", title: "PulseMCP", kind: "api", group: "directory",
  url: "https://api.example/search",
  expect: { type: "search" }
};
const statusRow = {
  id: "agent-card", title: "Room agent card", kind: "api", group: "room",
  url: "https://room.example/.well-known/agent-card.json",
  expect: { type: "status", status: 200, contains: "Project Room" }
};
const pullRow = {
  id: "awesome", title: "awesome list", kind: "github_pr", group: "directory",
  url: "https://github.com/example/list/pull/1",
  expect: { repo: "example/list", number: 1 }
};

function registryBody(version, description) {
  return {
    servers: [{
      server: { name: server.name, version, description },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } }
    }]
  };
}

test("html is listed, missing, stale, or unknown", async () => {
  const listed = await checkRow(htmlRow, { server, fetchImpl: async () => jsonResponse(200, "Find Project Room here") });
  assert.equal(listed.status, "listed");
  const missing = await checkRow(htmlRow, { server, fetchImpl: async () => jsonResponse(404, "nope") });
  assert.equal(missing.status, "missing");
  const stale = await checkRow(oneLinerRow, { server, fetchImpl: async () => jsonResponse(200, "Project Room, old blurb") });
  assert.equal(stale.status, "stale");
  const unknown = await checkRow(htmlRow, { server, fetchImpl: async () => jsonResponse(429, "slow down") });
  assert.equal(unknown.status, "unknown");
  const wall = await checkRow(htmlRow, { server, fetchImpl: async () => jsonResponse(403, "<title>Just a moment...</title>") });
  assert.equal(wall.status, "unknown");
  assert.equal(wall.detail, "bot wall");
});

test("the registry API is listed, missing, stale, or unknown", async () => {
  const listed = await checkRow(registryRow, {
    server,
    fetchImpl: async () => jsonResponse(200, registryBody(server.version, server.description))
  });
  assert.equal(listed.status, "listed");
  const missing = await checkRow(registryRow, { server, fetchImpl: async () => jsonResponse(404, {}) });
  assert.equal(missing.status, "missing");
  const stale = await checkRow(registryRow, {
    server,
    fetchImpl: async () => jsonResponse(200, registryBody("1.0.0", "old description"))
  });
  assert.equal(stale.status, "stale");
  const unknown = await checkRow(registryRow, { server, fetchImpl: async () => jsonResponse(429, {}) });
  assert.equal(unknown.status, "unknown");
});

test("search and status rows are listed, missing, stale, or unknown", async () => {
  const hit = { name: "project-room", source_code_url: "https://github.com/Uuriko/project-room", description: server.description };
  const listed = await checkRow(searchRow, { server, fetchImpl: async () => jsonResponse(200, { servers: [hit] }) });
  assert.equal(listed.status, "listed");
  const missing = await checkRow(searchRow, { server, fetchImpl: async () => jsonResponse(200, { servers: [{ name: "other" }] }) });
  assert.equal(missing.status, "missing");
  const stale = await checkRow(searchRow, {
    server,
    fetchImpl: async () => jsonResponse(200, { servers: [{ ...hit, description: "old" }] })
  });
  assert.equal(stale.status, "stale");
  const unknown = await checkRow(searchRow, { server, fetchImpl: async () => jsonResponse(401, { error: "Invalid or missing API key" }) });
  assert.equal(unknown.status, "unknown");

  const up = await checkRow(statusRow, { server, fetchImpl: async () => jsonResponse(200, "{\"name\":\"Project Room\"}") });
  assert.equal(up.status, "listed");
  const gone = await checkRow(statusRow, { server, fetchImpl: async () => jsonResponse(404, "missing") });
  assert.equal(gone.status, "missing");
  const drifted = await checkRow(statusRow, { server, fetchImpl: async () => jsonResponse(200, "{\"name\":\"other\"}") });
  assert.equal(drifted.status, "stale");
  const limited = await checkRow(statusRow, { server, fetchImpl: async () => jsonResponse(429, "") });
  assert.equal(limited.status, "unknown");
});

test("a GitHub pull request is listed, missing, stale, or unknown", async () => {
  const listed = await checkRow(pullRow, {
    server,
    fetchImpl: async () => jsonResponse(200, { title: "Add Project Room", state: "closed", merged: true, merged_at: "2026-10-01T00:00:00Z" })
  });
  assert.equal(listed.status, "listed");
  const missing = await checkRow(pullRow, { server, fetchImpl: async () => jsonResponse(404, { message: "Not Found" }) });
  assert.equal(missing.status, "missing");
  const closed = await checkRow(pullRow, {
    server,
    fetchImpl: async () => jsonResponse(200, { title: "Add Project Room", state: "closed", merged: false, merged_at: null })
  });
  assert.equal(closed.status, "missing");
  const stale = await checkRow(pullRow, {
    server,
    fetchImpl: async () => jsonResponse(200, { title: "Add something else", state: "closed", merged: true, merged_at: "2026-10-01T00:00:00Z" })
  });
  assert.equal(stale.status, "stale");
  const unknown = await checkRow(pullRow, { server, fetchImpl: async () => jsonResponse(429, {}) });
  assert.equal(unknown.status, "unknown");
  const open = await checkRow(pullRow, {
    server,
    fetchImpl: async () => jsonResponse(200, { title: "Add Project Room", state: "open", merged: false })
  });
  assert.equal(open.status, "unknown");
  assert.equal(open.detail, "pull request open");
});

test("the summary table names every status", () => {
  const rows = [
    { title: "Official MCP Registry", group: "directory", status: "listed", detail: "1.1.0" },
    { title: "Smithery", group: "directory", status: "missing", detail: "HTTP 404" },
    { title: "Glama", group: "directory", status: "stale", detail: "old one-liner" },
    { title: "cursor.directory", group: "directory", status: "unknown", detail: "429" },
    { title: "OAuth protected resource", group: "room", status: "missing", detail: "HTTP 404" }
  ];
  const markdown = renderSummary(rows, { reason: "ROOM_OPS_POST_TOKEN is not set. Skipped the ops room post." });
  assert.match(markdown, /\| Directory \| Status \| Detail \|/);
  assert.match(markdown, /\| Official MCP Registry \| listed \| 1\.1\.0 \|/);
  assert.match(markdown, /\| Smithery \| missing \| HTTP 404 \|/);
  assert.match(markdown, /\| Glama \| stale \| old one-liner \|/);
  assert.match(markdown, /\| cursor\.directory \| unknown \| 429 \|/);
  assert.match(markdown, /Skipped the ops room post/);
  assert.match(markdown, /4 directory rows: 1 listed, 1 missing, 1 stale, 1 unknown/);
});

test("the ops post is skipped without a token and uses the commands route with one", async () => {
  let called = 0;
  const skipped = await postListingSummary({
    origin: "https://room.example", roomId: "ops", token: "", markdown: "table",
    fetchImpl: async () => { called += 1; return jsonResponse(201, {}); }
  });
  assert.equal(skipped.posted, false);
  assert.equal(called, 0);
  assert.match(skipped.reason, /ROOM_OPS_POST_TOKEN is not set/);
  assert.equal(listingExitCode(skipped), 0);

  let request;
  const posted = await postListingSummary({
    origin: "https://room.example", roomId: "ops-room", token: "pri_test", markdown: "weekly table",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse(201, { sequence: 1 });
    }
  });
  assert.equal(posted.posted, true);
  assert.equal(request.url, "https://room.example/api/rooms/ops-room/commands");
  assert.equal(request.init.headers.authorization, "Bearer pri_test");
  const body = JSON.parse(request.init.body);
  assert.equal(body.type, "message.posted");
  assert.equal(body.data.body, "weekly table");
  assert.equal(body.data.messageId, body.id);
  assert.equal(body.id, commandIdFor("weekly table"));
  assert.equal(listingExitCode(posted), 0);

  const failed = await postListingSummary({
    origin: "https://room.example", roomId: "ops-room", token: "pri_test", markdown: "weekly table",
    fetchImpl: async () => jsonResponse(403, {})
  });
  assert.equal(failed.posted, false);
  assert.equal(listingExitCode(failed), 1);
});

test("every catalog row classifies, including at least 16 directories", async () => {
  const required = [
    "mcp-registry", "glama", "pulsemcp", "smithery", "cursor-directory", "mcpservers-org", "mcp-so",
    "awesome-mcp-servers", "awesome-agent-swarm", "awesome-ai-agents-2026", "curated-mcp-servers",
    "agent-card", "llms-txt", "oauth-protected-resource"
  ];
  const ids = new Set(catalog.rows.map(row => row.id));
  for (const id of required) assert.ok(ids.has(id), id);
  const directories = catalog.rows.filter(row => row.group === "directory");
  assert.ok(directories.length >= 16, `expected at least 16 directory rows, got ${directories.length}`);
  const results = await checkListings(catalog.rows, {
    server,
    fetchImpl: async () => jsonResponse(403, "<title>Just a moment...</title>")
  });
  assert.equal(results.length, catalog.rows.length);
  assert.ok(results.every(row => row.status === "unknown"));
});
