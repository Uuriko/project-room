// W008: cross-room shared procedure library.
// The library is docs-first: docs/procedures/*.md carry YAML frontmatter
// (id, title, version, author, source_room, updated, status). The generator
// (scripts/procedures-index.mjs) validates the files and bakes a frozen index
// into deploy/procedures-index.mjs; the discovery surface serves it at
// GET /procedures (read-only, global namespace, every room).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const proceduresDir = join(repo, "docs", "procedures");

const {
  parseProcedureFile,
  buildProceduresIndex,
  PROCEDURES_SCHEMA_VERSION,
} = await import("../scripts/procedures-index.mjs");
const { PROCEDURES_INDEX } = await import("../deploy/procedures-index.mjs");
const {
  discoveryDoc,
  DISCOVERY_PATHS,
  PROCEDURES_PATH,
  KEY_ROUTES,
} = await import("../deploy/agent-discovery.mjs");

const BASE_FIELDS = {
  id: "test.example-proc",
  title: "Example procedure",
  version: "1.2.3",
  author: "test-lane",
  source_room: "muse-room",
  updated: "2026-10-06",
  status: "active",
};
const goodFile = (overrides = {}, omit = []) => {
  const fields = { ...BASE_FIELDS, ...overrides };
  const head = Object.entries(fields)
    .filter(([k]) => !omit.includes(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${head}\n---\n# Body\n\nDo the thing.\n`;
};

test("frontmatter parses the attribution + versioning fields", () => {
  const { meta, body } = parseProcedureFile(goodFile(), "example-proc.md");
  assert.equal(meta.id, "test.example-proc");
  assert.equal(meta.title, "Example procedure");
  assert.equal(meta.version, "1.2.3");
  assert.equal(meta.author, "test-lane");
  assert.equal(meta.source_room, "muse-room");
  assert.equal(meta.updated, "2026-10-06");
  assert.equal(meta.status, "active");
  assert.match(body, /Do the thing/);
});

test("frontmatter rejects missing required fields", () => {
  for (const field of ["id", "title", "version", "author", "source_room", "updated"]) {
    assert.throws(() => parseProcedureFile(goodFile({}, [field]), "x.md"), /missing/i,
      `missing ${field} should throw`);
  }
});

test("frontmatter rejects malformed ids, versions, dates, statuses and empty bodies", () => {
  assert.throws(() => parseProcedureFile(goodFile({ id: "Bad ID!" }), "x.md"), /id/i);
  assert.throws(() => parseProcedureFile(goodFile({ version: "v1" }), "x.md"), /version/i);
  assert.throws(() => parseProcedureFile(goodFile({ updated: "yesterday" }), "x.md"), /updated/i);
  assert.throws(() => parseProcedureFile(goodFile({ status: "draft" }), "x.md"), /status/i);
  assert.throws(() => parseProcedureFile("no frontmatter here", "x.md"), /frontmatter/i);
  assert.throws(() => parseProcedureFile("---\nid: a.b\n---\n", "x.md"), /missing/i);
  assert.throws(() => parseProcedureFile("---\nid: a.b\ntitle: t\nversion: 1.0.0\nauthor: a\nsource_room: r\nupdated: 2026-10-06\n---\n", "x.md"), /body/i);
});

test("buildProceduresIndex rejects duplicate ids across files", () => {
  const dir = mkdtempSync(join(tmpdir(), "proc-dup-"));
  try {
    writeFileSync(join(dir, "a.md"), goodFile());
    writeFileSync(join(dir, "b.md"), goodFile());
    assert.throws(() => buildProceduresIndex(dir), /duplicate/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildProceduresIndex sorts by id and the schema version is a string", () => {
  const dir = mkdtempSync(join(tmpdir(), "proc-sort-"));
  try {
    writeFileSync(join(dir, "b.md"), goodFile({ id: "b.proc" }));
    writeFileSync(join(dir, "a.md"), goodFile({ id: "a.proc" }));
    const index = buildProceduresIndex(dir);
    assert.deepEqual(index.map(p => p.id), ["a.proc", "b.proc"]);
    assert.equal(typeof PROCEDURES_SCHEMA_VERSION, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the library ships seeded procedures with attribution and versions", () => {
  assert.ok(existsSync(proceduresDir), "docs/procedures exists");
  assert.ok(existsSync(join(proceduresDir, "README.md")), "library contract README exists");
  assert.ok(PROCEDURES_INDEX.length >= 2, "at least two seeded procedures");
  for (const proc of PROCEDURES_INDEX) {
    for (const field of ["id", "title", "version", "author", "source_room", "updated", "status", "path", "body"]) {
      assert.ok(proc[field], `${proc.id || "?"} carries ${field}`);
    }
    assert.match(proc.version, /^\d+\.\d+\.\d+$/, `${proc.id} version is semver`);
    assert.match(proc.id, /^[a-z0-9]+(\.[a-z0-9-]+)+$/, `${proc.id} is a dotted namespace id`);
    assert.ok(proc.body.length > 50, `${proc.id} has a real body`);
  }
  const ids = PROCEDURES_INDEX.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("the baked index matches the live docs (drift gate)", () => {
  assert.deepEqual(
    buildProceduresIndex(proceduresDir),
    PROCEDURES_INDEX.map(p => ({ ...p })),
    "deploy/procedures-index.mjs is stale: run node scripts/procedures-index.mjs",
  );
});

test("discovery serves the library at /procedures with a /room alias", () => {
  assert.equal(PROCEDURES_PATH, "/procedures");
  const doc = discoveryDoc("/procedures");
  assert.ok(doc, "/procedures resolves");
  assert.match(doc.type, /text\/markdown/);
  for (const proc of PROCEDURES_INDEX) {
    assert.ok(doc.body.includes(proc.id), `index names ${proc.id}`);
    assert.ok(doc.body.includes(proc.version), `index shows ${proc.id} version`);
    assert.ok(doc.body.includes(proc.author), `index attributes ${proc.id}`);
  }
  assert.match(doc.body, /read-only/i, "read-only is stated");
  assert.equal(discoveryDoc("/room/procedures").body, doc.body, "/room alias serves same bytes");
  assert.ok(DISCOVERY_PATHS.includes("/procedures"));
  assert.ok(DISCOVERY_PATHS.includes("/room/procedures"));
  assert.ok(KEY_ROUTES.some(row => row.path === "/procedures"), "agent card key_routes lists /procedures");
});

test("the library advertises no write surface", () => {
  const doc = discoveryDoc("/procedures");
  assert.doesNotMatch(doc.body, /^#{1,3} .*(\bPOST\b|\bPUT\b|\bDELETE\b|\bPATCH\b)/m);
});
