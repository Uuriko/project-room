// Guard (guard-sec-route-perms): every mutating REST operation in
// docs/openapi.yaml must say who may call it, via `x-room-permission`.
// Operations that predate this guard are frozen in
// tests/fixtures/route-permission-baseline.json. The baseline may only
// shrink: a new mutating operation must declare its permission, and an
// entry must be removed once its operation declares one or disappears.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MUTATING = new Set(["post", "put", "patch", "delete"]);
const PERMISSION_RE = /^[a-z][a-z_]*(\|[a-z][a-z_]*)*$/;

export function auditSpec(spec) {
  const undeclared = [];
  const malformed = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!MUTATING.has(method)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const value = op?.["x-room-permission"];
      if (value === undefined) undeclared.push(key);
      else if (typeof value !== "string" || !PERMISSION_RE.test(value)) malformed.push(key);
    }
  }
  return { undeclared: undeclared.sort(), malformed: malformed.sort() };
}

export function compareToBaseline(undeclared, baseline) {
  const base = new Set(baseline);
  const now = new Set(undeclared);
  return {
    added: undeclared.filter((k) => !base.has(k)),
    stale: baseline.filter((k) => !now.has(k)),
  };
}

const spec = parse(readFileSync(join(root, "docs/openapi.yaml"), "utf8"));
const baseline = JSON.parse(readFileSync(join(root, "tests/fixtures/route-permission-baseline.json"), "utf8"));

test("new mutating operations declare x-room-permission", () => {
  const { undeclared } = auditSpec(spec);
  const { added } = compareToBaseline(undeclared, baseline.undeclared);
  assert.deepEqual(added, [], `Add x-room-permission (for example "owner", "member", "accept_work", "public") to: ${added.join(", ")}`);
});

test("baseline only shrinks: remove entries that now declare or no longer exist", () => {
  const { undeclared } = auditSpec(spec);
  const { stale } = compareToBaseline(undeclared, baseline.undeclared);
  assert.deepEqual(stale, [], `Remove from tests/fixtures/route-permission-baseline.json: ${stale.join(", ")}`);
});

test("declared permissions are well formed", () => {
  assert.deepEqual(auditSpec(spec).malformed, []);
});

test("baseline is sorted and unique", () => {
  const sorted = [...new Set(baseline.undeclared)].sort();
  assert.deepEqual(baseline.undeclared, sorted);
});

test("audit catches an undeclared new route and accepts a declared one", () => {
  const synthetic = { paths: {
    "/api/rooms/{roomId}/new-thing": { post: {}, get: {} },
    "/api/rooms/{roomId}/declared": { delete: { "x-room-permission": "owner|manage_claims" } },
    "/api/rooms/{roomId}/bad": { put: { "x-room-permission": "Owner!" } },
  } };
  const audit = auditSpec(synthetic);
  assert.deepEqual(audit.undeclared, ["POST /api/rooms/{roomId}/new-thing"]);
  assert.deepEqual(audit.malformed, ["PUT /api/rooms/{roomId}/bad"]);
  assert.deepEqual(compareToBaseline(audit.undeclared, []).added, ["POST /api/rooms/{roomId}/new-thing"]);
  assert.deepEqual(compareToBaseline([], ["POST /gone"]).stale, ["POST /gone"]);
});
