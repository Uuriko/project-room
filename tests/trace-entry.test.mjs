// Failing-first test for W001: merge-time trace-entry automation.
// A simulated merge (pull_request_target closed/merged event) must produce a
// correct docs/ROOM-TRACES.jsonl line: right PR number, short merge SHA,
// linked claim as slice, and a line that passes the real scripts/check-wiki.mjs
// schema gate (the same gate CI enforces on main).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildTraceEntry,
  appendTraceEntry,
  extractSlice,
  main,
} from "../scripts/trace-entry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
let scratch;

function fakePr(over = {}) {
  return {
    number: 4242,
    title: "Burn: automate trace entries at merge time",
    body: "Context line.\n\nRoom-Work: muse-room/backlog-w001-trace-auto\n",
    user: { login: "lane-jill" },
    merged_by: { login: "lane-jill" },
    merged: true,
    merged_at: "2026-10-06T10:15:30Z",
    merge_commit_sha: "abcdef1234567890abcdef1234567890abcdef12",
    head: { ref: "burn/trace-auto" },
    base: { ref: "main" },
    ...over,
  };
}

function fixtureTraces(dir, lines) {
  const docs = join(dir, "docs");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(docs, { recursive: true });
  // Minimal valid ROOM-WIKI.md so the real check-wiki.mjs gate runs end to end.
  writeFileSync(
    join(docs, "ROOM-WIKI.md"),
    "# Fixture wiki\n\n## 2026-10-06 \u00b7 trace-auto-fixture \u00b7 test\n- Tried: tracing merges\n- Outcome: \u2713 \u2014 ok\n- Lesson: automation beats backfill\n- Rejected: manual entry\n"
  );
  cpSync(join(repoRoot, "scripts", "check-wiki.mjs"), join(dir, "scripts", "check-wiki.mjs"));
  const traceFile = join(docs, "ROOM-TRACES.jsonl");
  writeFileSync(traceFile, lines.join("\n") + "\n");
  return traceFile;
}

function checkWiki(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts", "check-wiki.mjs")], { encoding: "utf8" });
}

const SEED_LINE =
  '{"date": "2026-10-05", "slice": "seed-slice", "agent": "seed-agent", "pr": 4241, "sha": "1234567", "outcome": "merged", "tests": {"pass": 10, "fail": 0}, "notes": "seed"}';

describe("trace-entry automation (W001)", () => {
  before(() => {
    mkdirSync(join(repoRoot, ".tmp"), { recursive: true }); // .tmp/ is gitignored: never exists in a fresh checkout
    scratch = mkdtempSync(join(repoRoot, ".tmp", "trace-entry-test-"));
  });
  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("builds a correct trace entry from PR metadata", () => {
    const entry = buildTraceEntry(fakePr());
    assert.equal(entry.pr, 4242);
    assert.equal(entry.sha, "abcdef1"); // short 7-char merge SHA, like the manual entries
    assert.equal(entry.slice, "backlog-w001-trace-auto"); // linked claim from Room-Work:
    assert.equal(entry.agent, "lane-jill");
    assert.equal(entry.date, "2026-10-06"); // merge date, not run date
    assert.equal(entry.outcome, "merged");
    assert.deepEqual(entry.tests, { pass: 0, fail: 0 });
    assert.equal(entry.notes, "Burn: automate trace entries at merge time");
  });

  it("extractSlice falls back to branch slug, then pr-<n>", () => {
    assert.equal(extractSlice(fakePr({ body: "no claim line\n" })), "trace-auto");
    assert.equal(extractSlice(fakePr({ body: "", head: { ref: "x" } })), "x");
    assert.equal(extractSlice(fakePr({ body: "", head: {} })), "pr-4242");
    assert.equal(extractSlice(fakePr({ body: "Room-Work: backlog-w001-trace-auto\n" })), "backlog-w001-trace-auto");
  });

  it("appends one valid line and the real check-wiki gate passes", () => {
    const dir = join(scratch, "t1");
    const traceFile = fixtureTraces(dir, [SEED_LINE]);
    const res = appendTraceEntry({ traceFile, entry: buildTraceEntry(fakePr()) });
    assert.equal(res.appended, true);
    const lines = readFileSync(traceFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const appended = JSON.parse(lines[1]);
    assert.equal(appended.pr, 4242);
    assert.equal(appended.sha, "abcdef1");
    const gate = checkWiki(dir);
    assert.equal(gate.status, 0, `check-wiki failed:\n${gate.stderr}\n${gate.stdout}`);
    assert.match(gate.stdout, /traces OK/);
  });

  it("is idempotent: a second append for the same PR adds nothing", () => {
    const dir = join(scratch, "t2");
    const traceFile = fixtureTraces(dir, [SEED_LINE]);
    const first = appendTraceEntry({ traceFile, entry: buildTraceEntry(fakePr()) });
    const second = appendTraceEntry({ traceFile, entry: buildTraceEntry(fakePr()) });
    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    assert.equal(second.reason, "already-traced");
    const lines = readFileSync(traceFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("clamps the date up to the last entry so append-only order holds", () => {
    const future = '{"date": "2026-10-07", "slice": "later", "agent": "x", "pr": 4241, "sha": "1234567", "outcome": "merged", "tests": {"pass": 1, "fail": 0}, "notes": "later"}';
    const dir = join(scratch, "t3");
    const traceFile = fixtureTraces(dir, [future]);
    const res = appendTraceEntry({ traceFile, entry: buildTraceEntry(fakePr()) }); // merged 2026-10-06
    assert.equal(res.appended, true);
    assert.equal(res.clamped, true);
    const appended = JSON.parse(readFileSync(traceFile, "utf8").trim().split("\n").at(-1));
    assert.equal(appended.date, "2026-10-07");
    const gate = checkWiki(dir);
    assert.equal(gate.status, 0, `check-wiki failed:\n${gate.stderr}\n${gate.stdout}`);
  });

  it("main() end-to-end: event file in, trace line out, exit 0", () => {
    const dir = join(scratch, "t4");
    const traceFile = fixtureTraces(dir, [SEED_LINE]);
    const eventFile = join(dir, "event.json");
    writeFileSync(eventFile, JSON.stringify({ pull_request: fakePr() }));
    const env = { ...process.env, GITHUB_EVENT_PATH: eventFile, TRACE_ENTRY_FILE: traceFile };
    const code = main(env);
    assert.equal(code, 0);
    const appended = JSON.parse(readFileSync(traceFile, "utf8").trim().split("\n").at(-1));
    assert.equal(appended.pr, 4242);
    assert.equal(appended.slice, "backlog-w001-trace-auto");
    const gate = checkWiki(dir);
    assert.equal(gate.status, 0, `check-wiki failed:\n${gate.stderr}\n${gate.stdout}`);
  });
});
