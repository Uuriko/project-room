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

test("server.json points the registry remote at the canonical origin", () => {
  assert.equal(manifest.websiteUrl, "https://room.trydemigod.com");
  assert.equal(manifest.version, "1.1.0");
  assert.ok(manifest.remotes.length > 0);
  for (const remote of manifest.remotes) {
    assert.equal(new URL(remote.url).origin, "https://room.trydemigod.com");
  }
  assert.equal(manifest.remotes[0].url, "https://room.trydemigod.com/mcp");
});
