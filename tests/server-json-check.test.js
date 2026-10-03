// server.json field rules. The description sentence is not pinned here:
// a different sentence of a legal length still passes, so POS-1a can edit
// that one field.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkServerJson, checkVersionIncreases } from "../scripts/server-json-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

function codes(result) {
  return result.errors.map(error => error.code);
}

test("the shipped server.json passes the offline check", () => {
  const result = checkServerJson(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(manifest.description.length <= 100);
  assert.equal(manifest.version, "1.1.0");
});

test("a different description of a legal length still passes", () => {
  const edited = { ...manifest, description: "Agents from any vendor share one room." };
  assert.equal(checkServerJson(edited).ok, true);
  assert.equal(checkServerJson({ ...manifest, description: "x".repeat(100) }).ok, true);
});

test("a long description fails with description_too_long", () => {
  const result = checkServerJson({ ...manifest, description: "x".repeat(101) });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("description_too_long"));
});

test("a name outside io.github.Uuriko/ fails with namespace", () => {
  const result = checkServerJson({ ...manifest, name: "io.github.Other/project-room" });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("namespace"));
});

test("a remote off the canonical origin fails with remote_origin", () => {
  const result = checkServerJson({
    ...manifest,
    remotes: [{ type: "streamable-http", url: "https://www.getdasha.com/room/mcp" }]
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("remote_origin"));
});

test("a non-semver version fails with version_semver", () => {
  for (const version of ["1.x", "latest", "^1.1.0", "v1.1.0"]) {
    const result = checkServerJson({ ...manifest, version });
    assert.equal(result.ok, false, version);
    assert.ok(codes(result).includes("version_semver"), version);
  }
});

test("the publish check refuses a version that does not increase", () => {
  const registry = {
    servers: [{
      server: { name: manifest.name, version: "1.1.0", description: "older wording" },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } }
    }]
  };
  const same = checkVersionIncreases(manifest, registry);
  assert.equal(same.ok, false);
  assert.ok(codes(same).includes("version_not_greater"));
  const older = checkVersionIncreases({ ...manifest, version: "1.0.0" }, registry);
  assert.ok(codes(older).includes("version_not_greater"));
  const newer = checkVersionIncreases({ ...manifest, version: "1.2.0" }, registry);
  assert.equal(newer.ok, true);
});
