// FIX-74: room-post fallback grammar (degraded-mode channel).
// Fail-first acceptance tests for scripts/room-post-fallback.mjs.
// These tests define the contract; the implementation must satisfy them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "room-post-fallback.mjs");
const doc = join(root, "docs", "ROOM-POST-FALLBACK-RUNBOOK.md");

const mod = await import(script);
const { parseLine, parseLog, arbitrate, intentKey } = mod;

// ---------------------------------------------------------------- parser: valid lines

test("parser accepts a valid BOUNTY line", () => {
  const r = parseLine("BOUNTY b-123 | by=alice | reward=50 USDC | title=Fix the login bug");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.intent.verb, "BOUNTY");
  assert.equal(r.intent.subject, "b-123");
  assert.deepEqual(r.intent.fields, { by: "alice", reward: "50 USDC", title: "Fix the login bug" });
});

test("parser accepts all five verbs", () => {
  const cases = [
    ["TAKE b-123 | by=bob", "TAKE", "b-123", { by: "bob" }],
    ["HB alice | seq=42", "HB", "alice", { seq: "42" }],
    ["RELEASE b-123 | by=bob", "RELEASE", "b-123", { by: "bob" }],
    ["DONE b-123 | by=bob | proof=https://example.com/pr/9", "DONE", "b-123", { by: "bob", proof: "https://example.com/pr/9" }],
  ];
  for (const [line, verb, subject, fields] of cases) {
    const r = parseLine(line);
    assert.equal(r.ok, true, `line: ${line} -> ${JSON.stringify(r)}`);
    assert.equal(r.intent.verb, verb);
    assert.equal(r.intent.subject, subject);
    assert.deepEqual(r.intent.fields, fields);
  }
});

test("parser tolerates '=' inside values and trailing line whitespace", () => {
  const r = parseLine("DONE b-1 | by=bob | proof=a=b   ");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.intent.fields.proof, "a=b");
});

test("parser ignores blank lines, comments, and plain chat", () => {
  for (const line of ["", "   ", "# degraded channel opens at 18:00", "hey everyone, board is down"]) {
    const r = parseLine(line);
    assert.equal(r.ok, false, `line: ${JSON.stringify(line)}`);
    assert.equal(r.ignored, true, `line: ${JSON.stringify(line)} should be ignored, got ${JSON.stringify(r)}`);
  }
});

// ---------------------------------------------------------------- parser: malformed lines

const malformed = [
  ["take b-123 | by=bob", "lowercase verb"],
  ["GRAB b-123 | by=bob", "unknown verb"],
  ["TAKE b-123", "missing required field by"],
  ["TAKE b-123 | by=bob | extra=x", "unknown extra field"],
  ["TAKE  b-123 | by=bob", "double space after verb"],
  ["TAKE b-123| by=bob", "missing space before pipe"],
  ["TAKE b-123 |by=bob", "missing space after pipe"],
  ["DONE b-123 | proof=x | by=bob", "fields out of alphabetical order"],
  ["HB alice | seq=0", "non-positive seq"],
  ["HB alice | seq=abc", "non-numeric seq"],
  ["TAKE b-123 | by=", "empty value"],
  ["TAKE b-123 | by= bob", "space after equals"],
  ["BOUNTY b-1 | by=alice | reward=5 | title=a|b", "pipe inside value"],
  ["TAKE b 123 | by=bob", "space inside subject"],
  ["TAKE | by=bob", "empty subject"],
  ["TAKE " + "b".repeat(65) + " | by=bob", "subject too long"],
  ["CLAIM b-1 | by=x", "verb-shaped unknown token"],
  ["TAKE b-123 | By=bob", "capitalised field key"],
  ["BOUNTY", "verb with no subject"],
];

for (const [line, why] of malformed) {
  test(`parser rejects malformed line (${why})`, () => {
    const r = parseLine(line);
    assert.equal(r.ok, false, `expected rejection: ${line}`);
    assert.equal(r.ignored, false, `expected malformed (not ignored): ${line}`);
    assert.ok(typeof r.error === "string" && r.error.length > 0, "error message required");
  });
}

// ---------------------------------------------------------------- parseLog

test("parseLog extracts intents and collects malformed lines per event", () => {
  const events = [
    { seq: 3, sender: "alice", body: "BOUNTY b-9 | by=alice | reward=10 | title=Docs" },
    { seq: 4, sender: "bob", body: "lunch?\nTAKE b-9 | by=bob\ntake b-9 | by=bob" },
    { seq: 5, sender: "zed", body: "# not a real line" },
  ];
  const { records, malformed: bad } = parseLog(events);
  assert.equal(records.length, 2);
  assert.equal(records[0].seq, 3);
  assert.equal(records[0].sender, "alice");
  assert.equal(records[1].seq, 4);
  assert.equal(records[1].verb, "TAKE");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].seq, 4);
  assert.ok(bad[0].error.length > 0);
  assert.ok(bad[0].line.includes("take b-9"));
});

test("parseLog skips events without a numeric server seq", () => {
  const { records, malformed: bad } = parseLog([{ sender: "alice", body: "TAKE b-1 | by=alice" }]);
  assert.equal(records.length, 0);
  assert.equal(bad.length, 1);
  assert.ok(bad[0].error.includes("seq"));
});

// ---------------------------------------------------------------- arbitration

function ev(seq, sender, body, at) {
  return { seq, sender, body, ...(at ? { at } : {}) };
}

test("arbitration: earlier server seq wins a TAKE race (input order independent)", () => {
  const fwd = parseLog([ev(10, "alice", "TAKE b-1 | by=alice"), ev(12, "bob", "TAKE b-1 | by=bob")]).records;
  const rev = parseLog([ev(12, "bob", "TAKE b-1 | by=bob"), ev(10, "alice", "TAKE b-1 | by=alice")]).records;
  const a = arbitrate(fwd);
  const b = arbitrate(rev);
  assert.equal(a.winners["TAKE:b-1"].sender, "alice");
  assert.equal(a.winners["TAKE:b-1"].seq, 10);
  assert.equal(b.winners["TAKE:b-1"].sender, "alice");
  assert.equal(a.conflicts.length, 1);
  assert.equal(a.conflicts[0].losers.length, 1);
  assert.equal(a.conflicts[0].losers[0].sender, "bob");
});

test("arbitration: seq tie broken deterministically by sender id", () => {
  const recs = parseLog([ev(10, "zed", "TAKE b-1 | by=zed"), ev(10, "amy", "TAKE b-1 | by=amy")]).records;
  const a = arbitrate(recs);
  assert.equal(a.winners["TAKE:b-1"].sender, "amy");
  assert.equal(a.winners["TAKE:b-1"].seq, 10);
  // deterministic across shuffles: repeat with reversed input
  const again = arbitrate(parseLog([ev(10, "amy", "TAKE b-1 | by=amy"), ev(10, "zed", "TAKE b-1 | by=zed")]).records);
  assert.equal(again.winners["TAKE:b-1"].sender, "amy");
});

test("arbitration: never uses client wall-clock", () => {
  // bob's client clock is earlier, but alice's server seq is earlier: alice must win.
  const recs = parseLog([
    ev(10, "alice", "TAKE b-1 | by=alice", "2026-10-09T10:00:00Z"),
    ev(12, "bob", "TAKE b-1 | by=bob", "2026-10-09T09:59:00Z"),
  ]).records;
  const a = arbitrate(recs);
  assert.equal(a.winners["TAKE:b-1"].sender, "alice");
});

test("arbitration: different bounties do not conflict", () => {
  const recs = parseLog([
    ev(10, "alice", "TAKE b-1 | by=alice"),
    ev(11, "bob", "TAKE b-2 | by=bob"),
  ]).records;
  const a = arbitrate(recs);
  assert.equal(Object.keys(a.winners).length, 2);
  assert.equal(a.conflicts.length, 0);
});

test("arbitration: first-post-wins applies to BOUNTY, RELEASE, DONE collisions", () => {
  const recs = parseLog([
    ev(20, "dave", "BOUNTY b-7 | by=dave | reward=5 | title=X"),
    ev(21, "erin", "BOUNTY b-7 | by=erin | reward=6 | title=Y"),
    ev(30, "erin", "RELEASE b-7 | by=erin"),
    ev(31, "dave", "RELEASE b-7 | by=dave"),
    ev(40, "dave", "DONE b-7 | by=dave | proof=p1"),
    ev(41, "erin", "DONE b-7 | by=erin | proof=p2"),
  ]).records;
  const a = arbitrate(recs);
  assert.equal(a.winners["BOUNTY:b-7"].sender, "dave");
  assert.equal(a.winners["RELEASE:b-7"].sender, "erin");
  assert.equal(a.winners["DONE:b-7"].sender, "dave");
  assert.equal(a.conflicts.length, 3);
});

test("arbitration: heartbeats are per-agent liveness, never conflicts", () => {
  const recs = parseLog([
    ev(5, "alice", "HB alice | seq=1"),
    ev(7, "bob", "HB bob | seq=1"),
    ev(9, "alice", "HB alice | seq=2"),
  ]).records;
  const a = arbitrate(recs);
  assert.equal(a.conflicts.length, 0);
  assert.equal(Object.keys(a.winners).length, 0);
  assert.equal(a.liveness["alice"].seq, 9);
  assert.equal(a.liveness["bob"].seq, 7);
});

test("intentKey is verb:subject", () => {
  assert.equal(intentKey({ verb: "TAKE", subject: "b-1" }), "TAKE:b-1");
  assert.equal(intentKey({ verb: "HB", subject: "alice" }), "HB:alice");
});

// ---------------------------------------------------------------- degraded-mode end-to-end on a fixture log

const FIXTURE = [
  ev(1, "carol", "Board pinned at cap — switching to degraded channel. Follow the runbook."),
  ev(3, "carol", "BOUNTY b-9 | by=carol | reward=10 USDC | title=Write the runbook"),
  ev(5, "dave", "HB dave | seq=1"),
  ev(6, "erin", "HB erin | seq=1"),
  ev(20, "dave", "BOUNTY b-9 | by=dave | reward=11 USDC | title=Write the runbook"),
  ev(21, "dave", "TAKE b-9 | by=dave"),
  ev(22, "erin", "TAKE b-9 | By=erin"),
  ev(25, "erin", "TAKE b-9 | by=erin"),
  ev(30, "dave", "HB dave | seq=2"),
  ev(40, "dave", "DONE b-9 | by=dave | proof=docs/ROOM-POST-FALLBACK-RUNBOOK.md"),
  ev(40, "erin", "DONE b-9 | by=erin | proof=docs/other.md"),
  ev(50, "erin", "# signing off"),
];

test("degraded-mode end-to-end on fixture event log", () => {
  const { records, malformed: bad } = parseLog(FIXTURE);
  // malformed: the `By=erin` line only; chat/comment lines are ignored, not malformed.
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.equal(bad[0].seq, 22);
  const a = arbitrate(records);
  // BOUNTY collision: carol's seq 3 beats dave's seq 20.
  assert.equal(a.winners["BOUNTY:b-9"].sender, "carol");
  // TAKE race: dave seq 21 beats erin seq 25 (erin's malformed seq-22 line never entered).
  assert.equal(a.winners["TAKE:b-9"].sender, "dave");
  assert.equal(a.winners["TAKE:b-9"].seq, 21);
  // DONE tie at seq 40: deterministic sender-id break, dave < erin.
  assert.equal(a.winners["DONE:b-9"].sender, "dave");
  assert.equal(a.winners["DONE:b-9"].seq, 40);
  // liveness
  assert.equal(a.liveness["dave"].seq, 30);
  assert.equal(a.liveness["erin"].seq, 6);
  // three conflicts total (bounty, take, done)
  assert.equal(a.conflicts.length, 3);
});

// ---------------------------------------------------------------- CLI

test("CLI arbitrates a log file to JSON", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "fix74-cli-"));
  const log = join(dir, "log.json");
  writeFileSync(log, JSON.stringify(FIXTURE));
  const out = execFileSync(process.execPath, [script, "--log", log, "--format", "json"], { encoding: "utf8" });
  const d = JSON.parse(out);
  assert.equal(d.winners["TAKE:b-9"].sender, "dave");
  assert.equal(d.winners["DONE:b-9"].sender, "dave");
  assert.equal(d.malformed.length, 1);
  assert.equal(d.conflicts.length, 3);
});

test("CLI text format names the winners", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "fix74-cli-"));
  const log = join(dir, "log.json");
  writeFileSync(log, JSON.stringify(FIXTURE));
  const out = execFileSync(process.execPath, [script, "--log", log], { encoding: "utf8" });
  assert.ok(out.includes("TAKE:b-9"), out.slice(0, 400));
  assert.ok(out.includes("dave"), out.slice(0, 400));
});

test("CLI exits non-zero on missing log file", () => {
  assert.throws(() => execFileSync(process.execPath, [script, "--log", "/nope/missing.json"], { stdio: "pipe" }));
});

test("CLI exits non-zero on non-array log JSON", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "fix74-cli-"));
  const log = join(dir, "log.json");
  writeFileSync(log, JSON.stringify({ not: "an array" }));
  assert.throws(() => execFileSync(process.execPath, [script, "--log", log], { stdio: "pipe" }));
});

// ---------------------------------------------------------------- docs

test("runbook doc exists with grammar, arbitration rule, and the big warning", () => {
  assert.ok(existsSync(doc), "docs/ROOM-POST-FALLBACK-RUNBOOK.md should exist");
  const c = readFileSync(doc, "utf8").toLowerCase();
  for (const verb of ["bounty", "take", "hb", "release", "done"]) {
    assert.ok(c.includes(verb), `runbook should document ${verb}`);
  }
  assert.ok(c.includes("server sequence") || c.includes("server-seq"), "arbitration rule: server seq");
  assert.ok(c.includes("first-post-wins"), "arbitration rule: first-post-wins");
  assert.ok(c.includes("never the registry"), "BIG WARNING: never the registry");
  assert.ok(c.includes("reconcile"), "reconciliation guidance when the board recovers");
});
