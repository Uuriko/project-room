// W009: read-only wiki API for agents. Failing-first contract tests.
//
// Contract pinned here:
//  - GET /api/wiki/procedures            list procedures [{id,title,summary,source}]
//  - GET /api/wiki/procedures/{id}       one procedure {id,title,body,source}; 404 unknown
//  - GET /api/wiki/entries               paginated wiki entries (oldest first; stable under appends)
//  - GET /api/wiki/entries/{id}          one entry {id,date,slice,agent,tried,outcome,lesson,rejected}; 404 unknown
//  - GET /api/wiki/runbooks              list runbooks [{id,title,path}]
//  - GET /api/wiki/runbooks/{id}         one runbook {id,title,path,body}; 404 unknown
//  - GET /api/wiki/search?q=             search procedures + entries + runbooks; 400 without q
//  - Non-GET on any wiki route           405 (read-only: no write API in W009)
//  - Unknown wiki subpath                404 with the canonical error envelope
//  - Unreadable wiki files               503 wiki_unavailable (fail closed, never a dropped connection)
//
// Test-audit gate: the observable contract is the public read API surface.
// No existing test covers wiki serving (the wiki is docs-only today, and the
// route-docs/invite-only gates extract from http.mjs literals, which the
// prefix-delegated /api/wiki/ routes intentionally keep out of). The only
// production seam is createWikiReadApi({ root }), which pins the fail-closed
// 503 contract for deployments whose docs/ are absent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  createWikiReadApi,
  parseProcedures,
  parseRunbooks,
  parseWikiEntries,
  searchWiki,
  slugify,
} from "../server/wiki-read-api.mjs";

// ---------------------------------------------------------------------------
// Pure parsers (fixture strings; no I/O).
// ---------------------------------------------------------------------------

const WIKI_FIXTURE = `# Room Wiki

## 2026-09-16 · no-collision protocol · quill
- Tried: claim-before-touch, one owner per slice.
- Outcome: ✓ — zero collisions across C1–C12.
- Lesson: the protocol is what lets parallel agents share main.
- Rejected: merging on partial checks.

## 2026-09-17 · correction · dot
- Tried: revising the 2026-09-16 entry.
- Outcome: ✗ — wiki is append-only.
- Lesson: corrections are new entries, never edits.
- Rejected: editing history.
`;

const PROCEDURES_FIXTURE = `# Room Procedures

## Claim protocol

Before touching any shared surface:

1. Post one precise claim naming the exact files.

Source: wiki 2026-09-16 (no-collision protocol).

## Merge checklist

Every PR merges only when green.

Source: wiki 2026-09-15 (PR #188).
`;

test("slugify: lowercases and hyphenates", () => {
  assert.equal(slugify("Claim protocol"), "claim-protocol");
  assert.equal(slugify("PR #188 — green CI!"), "pr-188-green-ci");
  assert.equal(slugify("  a  b "), "a-b");
});

test("parseWikiEntries: parses headers and the four bullets", () => {
  const entries = parseWikiEntries(WIKI_FIXTURE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "2026-09-16-no-collision-protocol");
  assert.equal(entries[0].date, "2026-09-16");
  assert.equal(entries[0].slice, "no-collision protocol");
  assert.equal(entries[0].agent, "quill");
  assert.match(entries[0].tried, /claim-before-touch/);
  assert.match(entries[0].outcome, /zero collisions/);
  assert.match(entries[0].lesson, /parallel agents share main/);
  assert.match(entries[0].rejected, /partial checks/);
  assert.equal(entries[1].id, "2026-09-17-correction");
});

test("parseWikiEntries: skips fenced code blocks and malformed headers", () => {
  const text = "```\n## 2026-01-01 · fake · nobody\n```\n## not a header\n## 2026-09-18 · real entry · jill\n- Tried: x\n- Outcome: y\n- Lesson: z\n- Rejected: n/a\n";
  const entries = parseWikiEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "2026-09-18-real-entry");
});

test("parseWikiEntries: dedupes repeated date+slice ids", () => {
  const text = WIKI_FIXTURE + "\n## 2026-09-16 · no-collision protocol · quill\n- Tried: x\n- Outcome: y\n- Lesson: z\n- Rejected: n/a\n";
  const entries = parseWikiEntries(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].id, "2026-09-16-no-collision-protocol-2");
});

test("parseProcedures: sections become id/title/body/source", () => {
  const procedures = parseProcedures(PROCEDURES_FIXTURE);
  assert.equal(procedures.length, 2);
  assert.equal(procedures[0].id, "claim-protocol");
  assert.equal(procedures[0].title, "Claim protocol");
  assert.match(procedures[0].body, /Post one precise claim/);
  assert.match(procedures[0].source, /2026-09-16/);
  assert.match(procedures[0].summary, /Before touching any shared surface/);
  assert.equal(procedures[1].id, "merge-checklist");
});

test("parseProcedures: missing Source line becomes null", () => {
  const procedures = parseProcedures("# P\n\n## Lonely\n\nBody text here.\n");
  assert.equal(procedures.length, 1);
  assert.equal(procedures[0].source, null);
  assert.equal(procedures[0].summary, "Body text here.");
});

test("parseRunbooks: id from filename, title from first heading", () => {
  const runbooks = parseRunbooks([
    { path: "docs/INCIDENT-RUNBOOK.md", text: "# Incident runbook\n\nDo this.\n" },
  ]);
  assert.equal(runbooks.length, 1);
  assert.equal(runbooks[0].id, "incident-runbook");
  assert.equal(runbooks[0].title, "Incident runbook");
  assert.equal(runbooks[0].path, "docs/INCIDENT-RUNBOOK.md");
});

test("searchWiki: matches across all three planes, case-insensitive", () => {
  const index = {
    procedures: parseProcedures(PROCEDURES_FIXTURE),
    entries: parseWikiEntries(WIKI_FIXTURE),
    runbooks: parseRunbooks([{ path: "docs/X.md", text: "# X\n\nclaim stuff\n" }]),
  };
  const hit = searchWiki(index, "COLLISION", 20);
  assert.ok(hit.procedures.some(p => p.id === "claim-protocol"), "procedure hit");
  assert.ok(hit.entries.some(e => e.id === "2026-09-16-no-collision-protocol"), "entry hit");
  const runbookHit = searchWiki(index, "claim stuff", 20);
  assert.ok(runbookHit.runbooks.some(r => r.id === "x"), "runbook hit");
  assert.deepEqual(searchWiki(index, "zzz-no-match", 20), { procedures: [], entries: [], runbooks: [] });
  assert.deepEqual(searchWiki(index, "   ", 20), { procedures: [], entries: [], runbooks: [] });
});

// ---------------------------------------------------------------------------
// Live HTTP boundary (real server; reads the worktree's committed docs).
// ---------------------------------------------------------------------------

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "wiki-read-api-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const get = (origin, path, method = "GET") =>
  fetch(`${origin}${path}`, { method, headers: { Origin: origin } });

function assertEnvelope(t, body, status, what) {
  assert.equal(typeof body, "object", `${what}: JSON body for ${status}`);
  assert.equal(typeof body.error?.code, "string", `${what}: error.code`);
  assert.equal(typeof body.status, "string", `${what}: status`);
  assert.equal(typeof body.reason, "string", `${what}: reason`);
  assert.equal(typeof body.hint, "string", `${what}: hint`);
  assert.ok(Array.isArray(body.next) && body.next.length > 0, `${what}: non-empty next[]`);
  assert.match(body.operationId ?? "", /^op_/, `${what}: op_ operationId`);
}

test("GET /api/wiki/procedures lists procedures", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const res = await get(origin, "/api/wiki/procedures");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.procedures) && body.procedures.length > 0, "non-empty procedures");
  assert.equal(body.count, body.procedures.length);
  for (const p of body.procedures) {
    assert.match(p.id, /^[a-z0-9-]+$/, `slug id: ${p.id}`);
    assert.equal(typeof p.title, "string");
    assert.equal(typeof p.summary, "string");
  }
  const first = body.procedures[0];
  const one = await (await get(origin, `/api/wiki/procedures/${first.id}`)).json();
  assert.equal(one.id, first.id);
  assert.equal(typeof one.body, "string");
  assert.ok(one.body.length > first.summary.length, "full body is longer than the summary");
});

test("GET /api/wiki/procedures/{id}: unknown id is a 404 envelope", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const res = await get(origin, "/api/wiki/procedures/no-such-procedure");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error?.code, "not_found");
  assertEnvelope(t, body, 404, "unknown procedure");
});

test("GET /api/wiki/entries paginates oldest-first", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const res = await get(origin, "/api/wiki/entries?limit=2");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entries.length, 2);
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 0);
  assert.ok(body.total >= 2, "total counts the whole wiki");
  assert.equal(body.count, 2);
  for (const e of body.entries) {
    for (const field of ["id", "date", "slice", "agent", "outcome", "lesson"]) {
      assert.equal(typeof e[field], "string", `entry has ${field}`);
    }
  }
  const page2 = await (await get(origin, "/api/wiki/entries?limit=2&offset=2")).json();
  assert.equal(page2.offset, 2);
  assert.ok(!page2.entries.some(e => body.entries.some(f => f.id === e.id)), "pages do not overlap");
  // Oldest first: dates never run backwards (wiki is append-only, newest last).
  const all = await (await get(origin, "/api/wiki/entries?limit=1000")).json();
  const dates = all.entries.map(e => e.date);
  assert.deepEqual([...dates].sort(), dates, "entries stay in file order");
});

test("GET /api/wiki/entries/{id}: full entry; unknown id is a 404 envelope", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const list = await (await get(origin, "/api/wiki/entries?limit=1")).json();
  assert.ok(list.entries.length > 0, "wiki has entries");
  const one = await (await get(origin, `/api/wiki/entries/${list.entries[0].id}`)).json();
  assert.equal(one.id, list.entries[0].id);
  for (const field of ["tried", "outcome", "lesson", "rejected"]) {
    assert.equal(typeof one[field], "string", `full entry has ${field}`);
  }
  const res = await get(origin, "/api/wiki/entries/2099-01-01-nope");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error?.code, "not_found");
  assertEnvelope(t, body, 404, "unknown entry");
});

test("GET /api/wiki/runbooks lists runbooks and serves one", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const res = await get(origin, "/api/wiki/runbooks");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.runbooks) && body.runbooks.length > 0, "non-empty runbooks");
  const first = body.runbooks[0];
  assert.match(first.id, /^[a-z0-9-]+$/);
  assert.equal(typeof first.title, "string");
  assert.match(first.path, /\.md$/);
  const one = await (await get(origin, `/api/wiki/runbooks/${first.id}`)).json();
  assert.equal(one.id, first.id);
  assert.ok(one.body.length > 0, "runbook body served");
  const missing = await get(origin, "/api/wiki/runbooks/no-such-runbook");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error?.code, "not_found");
});

test("GET /api/wiki/search: matches and echoes the query; missing q is 400", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const res = await get(origin, "/api/wiki/search?q=claim");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.query, "claim");
  const total = body.procedures.length + body.entries.length + body.runbooks.length;
  assert.ok(total > 0, "search finds wiki content about claims");
  assert.equal(body.count, total);
  const bare = await get(origin, "/api/wiki/search");
  assert.equal(bare.status, 400);
  const bareBody = await bare.json();
  assert.equal(bareBody.error?.code, "bad_request");
  assertEnvelope(t, bareBody, 400, "search without q");
});

test("wiki API is read-only: writes are 405", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  for (const [method, path] of [["POST", "/api/wiki/procedures"], ["PUT", "/api/wiki/entries"], ["DELETE", "/api/wiki/search?q=x"]]) {
    const res = await get(origin, path, method);
    assert.equal(res.status, 405, `${method} ${path} is refused`);
  }
});

test("GET /api/wiki/nope: unknown subpath is a 404 envelope", { timeout: 30000 }, async t => {
  const origin = await serve(t);
  const res = await get(origin, "/api/wiki/nope");
  assert.equal(res.status, 404);
  assertEnvelope(t, await res.json(), 404, "unknown wiki subpath");
});

test("unreadable wiki files fail closed with 503 (never a dropped connection)", () => {
  const api = createWikiReadApi({ root: join(tmpdir(), "wiki-read-api-missing-root") });
  const params = new URLSearchParams();
  assert.throws(() => api.handle("/api/wiki/procedures", "GET", params), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "wiki_unavailable");
    return true;
  });
  assert.equal(api.handle("/api/other", "GET", params), null, "non-wiki paths fall through");
});
