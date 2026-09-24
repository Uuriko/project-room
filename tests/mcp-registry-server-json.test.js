// server.json must stay a valid MCP Registry manifest (schema
// https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
// Remote-only (no packages) is a first-class registry path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

test("server.json has the registry-required fields", () => {
  assert.match(
    manifest.name,
    /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/,
    "name must be reverse-DNS with exactly one slash"
  );
  assert.equal(manifest.name, "io.github.Uuriko/project-room");
  assert.ok(
    typeof manifest.description === "string" &&
      manifest.description.length >= 1 &&
      manifest.description.length <= 100,
    "description is required and capped at 100 chars"
  );
  assert.ok(
    typeof manifest.version === "string" && manifest.version.length >= 1,
    "version is required"
  );
  assert.ok(
    !/[\^~><=]|1\.(x|\*)|latest/i.test(manifest.version),
    "version ranges are rejected by the registry"
  );
});

test("server.json declares the public remote MCP surface", () => {
  assert.ok(Array.isArray(manifest.remotes) && manifest.remotes.length > 0);
  for (const remote of manifest.remotes) {
    assert.ok(
      ["streamable-http", "sse"].includes(remote.type),
      `remote transport type must be streamable-http or sse, got ${remote.type}`
    );
    assert.match(remote.url, /^https:\/\/[^\s]+$/, "remote URL must be public HTTPS");
  }
  assert.equal(manifest.repository?.source, "github");
  assert.match(manifest.repository?.url ?? "", /^https:\/\/github\.com\//);
});

test("server.json stays honest about what the room actually serves", () => {
  // The registry remote must be the advertised public join URL, not a guess.
  const joinDoc = readFileSync(join(root, "src/room-mcp-join.js"), "utf8");
  const urls = manifest.remotes.map((r) => r.url);
  assert.ok(
    urls.some((u) => joinDoc.includes(u)),
    "remote URL must appear in src/room-mcp-join.js as the advertised public MCP URL"
  );
});
