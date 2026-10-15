// tests/herdr-migrate-resume.test.js — regression test for issue #2885.
//
// Protects: `migrate --execute --resume` resumes EACH room from that room's
// own last migration_cursor in the journal. The journal's cursor entries are
// room-scoped (the executor writes cursor = next plan index for its own
// room, and buildPlan slices ONE room's eligible list), and cmdStatus reads
// them per room. The pre-fix cmdMigrate instead took the last cursor in the
// whole journal — whichever room wrote it — and applied it as the start
// index for EVERY room, silently skipping unmigrated claims in any room
// whose cursor lagged the global one (and re-attempting finished rooms
// whose cursor led it).
//
// Credible regression: with room-a at cursor 1 (of 3) and room-b's cursor 3
// as the journal's LAST entry, the old code planned room-a from index 3 —
// an empty plan — so a2/a3 were never attempted. These tests run the real
// CLI against a fake bridge + fake room API and assert on the journal: the
// attach path is not landed (B3), so every PLANNED item is journaled
// backfill_start + backfill_aborted — the plan itself is fully observable.
//
// Production seams: none beyond loopback HTTP fakes for the two services
// the tool already talks to; journal seeding uses the module's own
// appendJournalEntry.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appendJournalEntry, readJournal } from "../scripts/herdr-migrate.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "herdr-migrate.mjs");

const claim = (id) => ({
  id, title: `work ${id}`, state: "in_progress", owner: "jillian",
  claimedAt: "2026-10-06T10:00:00Z", leaseStartAt: "2026-10-06T10:00:00Z",
  leaseExpiresAt: "2999-01-01T00:00:00Z", files: [], reviews: [], sessionBackend: "herdr",
});

const ROOMS = {
  "room-a": [claim("a1"), claim("a2"), claim("a3")],
  "room-b": [claim("b1"), claim("b2"), claim("b3")],
};

async function runResume(t, seedCursors) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-resume-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journalPath = join(dir, "journal.jsonl");
  const hostClassesPath = join(dir, "host-classes.json");
  writeFileSync(hostClassesPath, JSON.stringify({ jillian: "claude-code" }));
  for (const [roomId, cursor] of seedCursors) {
    appendJournalEntry(journalPath, { kind: "migration_cursor", room_id: roomId, cursor });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/healthz") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
    if (url.pathname === "/api/sessions/attach") { res.writeHead(404); res.end(); return; }
    const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/work-claims$/);
    if (m && ROOMS[decodeURIComponent(m[1])]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ claims: ROOMS[decodeURIComponent(m[1])] }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}");
  });
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const args = [scriptPath, "migrate", "--execute", "--resume", "--json",
    "--room", "room-a", "--room", "room-b", "--flag", "on",
    "--journal", journalPath, "--host-classes-file", hostClassesPath,
    "--api-base", base, "--bridge-base", base];
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("herdr-migrate timed out")); }, 25000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, stdout, stderr }); });
  });
  assert.equal(stderr.includes("fatal"), false, `no fatal error: ${stderr}`);
  const journal = readJournal(journalPath);
  const started = journal.filter((e) => e.kind === "backfill_start")
    .map((e) => `${e.room_id}:${e.claim_id}`);
  return { code, stdout, started };
}

test("resume: a room lagging the journal's last (other-room) cursor is NOT skipped (#2885)", { timeout: 30000 }, async (t) => {
  // room-a finished 1 of 3 in a prior run; room-b finished all 3 and its
  // cursor is the journal's last entry. Global-cursor resume planned
  // room-a from index 3 -> nothing attempted -> a2/a3 silently skipped.
  const { started } = await runResume(t, [["room-a", 1], ["room-b", 3]]);
  assert.deepEqual(started.sort(), ["room-a:a2", "room-a:a3"],
    "room-a resumes from its OWN cursor (1), room-b from its own (3 = done)");
});

test("resume: a room ahead of the journal's last (other-room) cursor is NOT re-run (#2885)", { timeout: 30000 }, async (t) => {
  // Same progress, opposite journal order: the last entry is room-a's
  // lagging cursor 1. Global-cursor resume planned room-b from index 1,
  // re-attempting b2/b3 even though room-b's own cursor says 3 (done).
  const { started } = await runResume(t, [["room-b", 3], ["room-a", 1]]);
  assert.deepEqual(started.sort(), ["room-a:a2", "room-a:a3"],
    "room-b resumes from its OWN cursor (3 = done), not room-a's 1");
});
