// FIX-24: statically partition lane scopes at brief time.
// `node scripts/scope-partition.mjs <fixture.json>` must be a machine-verifiable
// pre-PR checker: overlapping file scopes between concurrently active claims
// -> non-zero exit with a named overlap report; disjoint scopes -> exit 0;
// claims with missing/empty `files` -> loud "unpartitionable" warning, never
// a silent pass.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(root, "scripts", "scope-partition.mjs");
const scratch = join(root, ".tmp", "scope-partition-tests");

function fixture(name, claims) {
  mkdirSync(scratch, { recursive: true });
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify({ claims }));
  return path;
}

function run(fixturePath, extraArgs = []) {
  return spawnSync(process.execPath, [script, fixturePath, ...extraArgs], {
    encoding: "utf8",
    timeout: 15000,
  });
}

test("overlapping file scopes -> non-zero exit and a named overlap report", () => {
  const path = fixture("overlap.json", [
    { id: "lane-a", state: "in_progress", files: ["server/a.mjs"] },
    { id: "lane-b", state: "claimed", files: ["server/a.mjs"] },
  ]);
  const r = run(path);
  assert.notEqual(r.status, 0, "expected non-zero exit on overlap");
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /lane-a/, "report names the first claim");
  assert.match(out, /lane-b/, "report names the second claim");
  assert.match(out, /server\/a\.mjs/, "report names the overlapping path");
});

test("disjoint scopes -> exit 0", () => {
  const path = fixture("disjoint.json", [
    { id: "lane-a", state: "in_progress", files: ["server/a.mjs"] },
    { id: "lane-b", state: "in_progress", files: ["server/b.mjs"] },
  ]);
  const r = run(path);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
});

test("missing/empty files -> loud unpartitionable warning, not a silent pass", () => {
  const path = fixture("unpartitioned.json", [
    { id: "lane-a", state: "claimed", files: ["server/a.mjs"] },
    { id: "lane-mystery", state: "in_progress" },
    { id: "lane-empty", state: "claimed", files: [] },
  ]);
  const r = run(path);
  assert.notEqual(r.status, 0, "expected non-zero exit when scopes cannot be verified");
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /unpartitionable/i, "warning says unpartitionable");
  assert.match(out, /lane-mystery/, "warning names the claim with missing files");
  assert.match(out, /lane-empty/, "warning names the claim with empty files");
});

test("done and unclaimed claims are ignored", () => {
  const path = fixture("closed.json", [
    { id: "lane-old", state: "done", files: ["server/a.mjs"] },
    { id: "lane-free", state: "unclaimed", files: ["server/a.mjs"] },
    { id: "lane-new", state: "claimed", files: ["server/a.mjs"] },
  ]);
  const r = run(path);
  assert.equal(r.status, 0, `closed claims must not overlap-check, got ${r.status}: ${r.stderr}`);
});

test("directory scope covers everything under it (prefix overlap)", () => {
  const path = fixture("prefix.json", [
    { id: "lane-dir", state: "claimed", files: ["server/"] },
    { id: "lane-file", state: "in_progress", files: ["server/nested/x.mjs"] },
  ]);
  const r = run(path);
  assert.notEqual(r.status, 0, "expected non-zero exit on directory-prefix overlap");
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /server/, "report names the overlapping scope");
});

test("two different labels on the same path do not conflict", () => {
  const path = fixture("labels.json", [
    { id: "lane-a", state: "claimed", files: [{ path: "server/a.mjs", block: "imports" }] },
    { id: "lane-b", state: "claimed", files: [{ path: "server/a.mjs", block: "exports" }] },
  ]);
  const r = run(path);
  assert.equal(r.status, 0, `different labels must not conflict, got ${r.status}: ${r.stderr}`);
});

test("same label on the same path conflicts", () => {
  const path = fixture("same-label.json", [
    { id: "lane-a", state: "claimed", files: [{ path: "server/a.mjs", region: "auth" }] },
    { id: "lane-b", state: "claimed", files: [{ path: "server/a.mjs", region: "auth" }] },
  ]);
  const r = run(path);
  assert.notEqual(r.status, 0, "same label on same path must conflict");
});

test("blocked claims still hold their file lease", () => {
  const path = fixture("blocked.json", [
    { id: "lane-a", state: "blocked", files: ["server/a.mjs"] },
    { id: "lane-b", state: "claimed", files: ["server/a.mjs"] },
  ]);
  const r = run(path);
  assert.notEqual(r.status, 0, "blocked claims hold leases and must overlap-check");
});

test("--json emits machine-readable results", () => {
  const path = fixture("overlap2.json", [
    { id: "lane-a", state: "in_progress", files: ["server/a.mjs"] },
    { id: "lane-b", state: "claimed", files: ["server/a.mjs"] },
  ]);
  const r = run(path, ["--json"]);
  assert.notEqual(r.status, 0, "expected non-zero exit on overlap");
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(Array.isArray(parsed.overlaps) && parsed.overlaps.length > 0);
  assert.ok(
    parsed.overlaps.some((o) => o.claims.includes("lane-a") && o.claims.includes("lane-b")),
    "JSON report carries both claim ids"
  );
});

test("fixture accepts a bare array of claims", () => {
  const path = fixture("bare-array.json", []);
  writeFileSync(
    path,
    JSON.stringify([{ id: "lane-a", state: "claimed", files: ["server/a.mjs"] }])
  );
  const r = run(path);
  assert.equal(r.status, 0, `bare-array fixture must parse, got ${r.status}: ${r.stderr}`);
});

test("board error payload -> exit 3, never a silent pass", () => {
  const path = fixture("error-payload.json", []);
  writeFileSync(
    path,
    JSON.stringify({ error: { code: "unauthenticated", message: "No credential." } })
  );
  const r = run(path);
  assert.equal(r.status, 3, `board errors must exit 3, got ${r.status}: ${r.stderr}`);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /error/i, "report surfaces the board error");
});

test("cleanup leaves no scratch behind", (t) => {
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
});
