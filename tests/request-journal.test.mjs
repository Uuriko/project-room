import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Owner-boundary contract: RequestJournal (client/request-journal.mjs) makes
// "persist before send" the default for mutating room calls. The credible
// regressions each test guards:
//
//  (a) a refactor that lets send() fire before the journal entry hits disk
//      silently reintroduces duplicate work on crash — the crash test fails
//      because recover() finds nothing;
//  (b) a refactor that treats a server 200-with-duplicate:true as an error
//      turns an idempotent no-op into a failure the caller retries blindly;
//  (c) a refactor that writes the entry file directly (no temp+rename)
//      can leave a torn entry after a mid-write crash — the corruption test
//      fails when recover() throws or returns a corrupt record.
//
// Transport is injected as a `post` function; no test does live network.

import { RequestJournal, newRequestId } from "../client/request-journal.mjs";

function journalDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "reqjournal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("crash between begin() and send() leaves a recoverable pending entry", (t) => {
  const dir = journalDir(t);
  // Child process = simulated crash: begin() persists, then the process dies
  // before send() is ever called. The crash flag is how the parent arranges
  // "kill the process between begin and send" deterministically.
  const child = `
    import { RequestJournal } from ${JSON.stringify(new URL("../client/request-journal.mjs", import.meta.url).href)};
    const journal = new RequestJournal(process.env.JDIR);
    journal.begin({ route: "/work-claims", body: { task: "sweep-1" } });
    if (process.env.CRASH === "1") process.exit(137);
  `;
  let crashed = false;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", child], {
      env: { ...process.env, CRASH: "1", JDIR: dir },
      stdio: "ignore",
    });
  } catch {
    crashed = true;
  }
  assert.equal(crashed, true, "child should die before send()");
  const pending = new RequestJournal(dir).recover();
  assert.equal(pending.length, 1, "recover() finds the entry the crashed process persisted");
  assert.equal(pending[0].route, "/work-claims");
  assert.deepEqual(pending[0].body, { task: "sweep-1" });
  assert.match(pending[0].id, /^[0-9a-f-]{36}$/);
});

test("begin() returns the id before any network call and puts it in the POST body as requestId", async (t) => {
  const dir = journalDir(t);
  const calls = [];
  const post = async (route, payload) => {
    calls.push({ route, payload });
    return { ok: true, result: { claimId: "c-9" } };
  };
  const journal = new RequestJournal(dir, { post });
  const req = journal.begin({ route: "/work-claims", body: { task: "sweep-2" } });
  assert.equal(calls.length, 0, "begin() must not touch the network");
  assert.match(req.id, /^[0-9a-f-]{36}$/);
  await req.send();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "/work-claims");
  assert.equal(calls[0].payload.requestId, req.id);
  assert.deepEqual(calls[0].payload.task, "sweep-2");
});

test("200 with duplicate:true returns the prior result, marks done, and is not an error", async (t) => {
  const dir = journalDir(t);
  const post = async () => ({ ok: true, duplicate: true, result: { claimId: "c-first" } });
  const journal = new RequestJournal(dir, { post });
  const req = journal.begin({ route: "/work-claims", body: { task: "sweep-3" } });
  const out = await req.send();
  assert.deepEqual(out, { duplicate: true, result: { claimId: "c-first" } });
  assert.deepEqual(journal.recover(), [], "a deduped request is done, not pending");
});

test("a fresh 200 response is returned and the entry leaves the pending set", async (t) => {
  const dir = journalDir(t);
  const post = async () => ({ ok: true, result: { claimId: "c-new" } });
  const journal = new RequestJournal(dir, { post });
  const req = journal.begin({ route: "/work-claims", body: { task: "sweep-4" } });
  const out = await req.send();
  assert.deepEqual(out, { duplicate: false, result: { claimId: "c-new" } });
  assert.deepEqual(journal.recover(), []);
});

test("a failed send keeps the entry pending for recover() and rethrows", async (t) => {
  const dir = journalDir(t);
  const boom = new Error("socket hang up");
  const journal = new RequestJournal(dir, { post: async () => { throw boom; } });
  const req = journal.begin({ route: "/work-claims", body: { task: "sweep-5" } });
  await assert.rejects(() => req.send(), (err) => err === boom);
  const pending = journal.recover();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, req.id);
});

test("journal entry is never partial: corrupt files are skipped, torn temps never surface", (t) => {
  const dir = journalDir(t);
  // Fault injection: garbage where a complete entry should be, plus a torn
  // temp-file write (partial JSON) as a mid-write crash would leave behind.
  writeFileSync(join(dir, "bogus.json"), "{not json!!!");
  writeFileSync(join(dir, "torn.json.tmp-" + randomUUID()), '{"id":"x","state":"pend');
  const journal = new RequestJournal(dir);
  const req = journal.begin({ route: "/r", body: { a: 1 } });
  const pending = journal.recover(); // must not throw on garbage
  assert.equal(pending.length, 1, "only the complete entry surfaces");
  assert.equal(pending[0].id, req.id);
  assert.equal(pending[0].route, "/r");
  assert.deepEqual(pending[0].body, { a: 1 });
  // The on-disk entry written by begin() is always complete, parseable JSON.
  const raw = readFileSync(join(dir, req.id + ".json"), "utf8");
  assert.deepEqual(JSON.parse(raw), { id: req.id, route: "/r", body: { a: 1 }, state: "pending" });
});

test("newRequestId() yields unique UUIDs", () => {
  const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});
