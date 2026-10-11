// Fixture-backed rendering tests for scripts/approval-inbox.mjs.
// Spawns the CLI against a temp JSON db and asserts list/show output.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "approval-inbox.mjs");
const node = process.execPath;

const fixtureCards = () => [
  { id: "card-older", kind: "tap", status: "pending", title: "Oldest: approve $50 bounty payout",
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    what: "Pay out the $50 bounty to the winning agent.",
    context: "Bounty #882 resolved; winner verified by Dot.",
    options: [{ label: "approve", consequence: "USDC payout lands in ~1h" },
      { label: "deny-stop", consequence: "Bounty held for manual review" }],
    decision: null },
  { id: "card-newer", kind: "decision", status: "pending", title: "Newer: ship the onboarding change",
    createdAt: new Date(Date.now() - 30 * 60000).toISOString(),
    what: "Merge #2552 without a second review pass.",
    context: "QA-200 verified at head; lane-liaison asked for the call.",
    options: [{ label: "approve", consequence: "Merges and deploys tonight" }],
    decision: null },
];

const setup = t => {
  const dir = mkdtempSync(join(tmpdir(), "approval-inbox-test-"));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  const db = join(dir, "inbox.json");
  writeFileSync(db, JSON.stringify({ cards: fixtureCards() }, null, 2));
  return { dir, db };
};
const run = (...args) => spawnSync(node, [CLI, ...args], { encoding: "utf8" });

test("list renders oldest first, one line per card: id kind age title", t => {
  const { db } = setup(t);
  const r = run("list", "--db", db);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^card-older tap \d+d Oldest: approve \$50 bounty payout$/);
  assert.match(lines[1], /^card-newer decision \d+m Newer: ship the onboarding change$/);
});

test("list --status all includes decided cards, default hides them", t => {
  const { db } = setup(t);
  const cards = fixtureCards();
  cards[0].status = "decided";
  cards[0].decision = { choice: "approve", by: "jhon", at: new Date().toISOString(), note: null };
  writeFileSync(db, JSON.stringify({ cards }, null, 2));
  const rDefault = run("list", "--db", db);
  assert.equal(rDefault.status, 0, rDefault.stderr);
  assert.ok(!rDefault.stdout.includes("card-older"), "decided card hidden by default");
  const rAll = run("list", "--db", db, "--status", "all");
  assert.equal(rAll.status, 0, rAll.stderr);
  assert.match(rAll.stdout, /card-older tap \d+d \[decided\] Oldest: approve/);
});

test("list --kind filters, empty result prints (no cards)", t => {
  const { db } = setup(t);
  const r = run("list", "--db", db, "--kind", "nonexistent");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "(no cards)");
});

test("show renders what/context/options+consequences", t => {
  const { db } = setup(t);
  const r = run("show", "card-older", "--db", db);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("# Oldest: approve $50 bounty payout"));
  assert.ok(r.stdout.includes("Pay out the $50 bounty to the winning agent."));
  assert.ok(r.stdout.includes("Bounty #882 resolved; winner verified by Dot."));
  assert.ok(r.stdout.includes("- approve"));
  assert.ok(r.stdout.includes("→ USDC payout lands in ~1h"));
  assert.ok(r.stdout.includes("→ Bounty held for manual review"));
});

test("show unknown id fails with clear error", t => {
  const { db } = setup(t);
  const r = run("show", "nope", "--db", db);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /error: no card nope/);
});

test("decide refuses without --as-human", t => {
  const { db } = setup(t);
  const r = run("decide", "card-older", "approve", "--db", db);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /error: decide needs --as-human/);
});

test("decide refuses agent-shaped identities", t => {
  const { db } = setup(t);
  const r = run("decide", "card-older", "approve", "--as-human", "agent-grokbot", "--db", db);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /looks like an agent identity/);
});

test("decide with --as-human persists decision and note", t => {
  const { db } = setup(t);
  const r = run("decide", "card-older", "approve-session", "--as-human", "jhon", "--note", "looks right", "--db", db);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /card-older: approve-session recorded by jhon/);
  const saved = JSON.parse(readFileSync(db, "utf8")).cards.find(c => c.id === "card-older");
  assert.equal(saved.status, "decided");
  assert.equal(saved.decision.choice, "approve-session");
  assert.equal(saved.decision.by, "jhon");
  assert.equal(saved.decision.note, "looks right");
  // Decided card now hidden from default list and visible in show.
  const listed = run("list", "--db", db);
  assert.ok(!listed.stdout.includes("card-older"));
  const shown = run("show", "card-older", "--db", db);
  assert.ok(shown.stdout.includes("DECIDED: approve-session by jhon"));
});

test("decide rejects double-decide and bad choice", t => {
  const { db } = setup(t);
  assert.equal(run("decide", "card-older", "approve", "--as-human", "jhon", "--db", db).status, 0);
  const twice = run("decide", "card-older", "deny-stop", "--as-human", "jhon", "--db", db);
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /already decided/);
  const bad = run("decide", "card-newer", "maybe", "--as-human", "jhon", "--db", db);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /decision must be one of/);
});

test("unknown command prints usage error", t => {
  const r = run("frobnicate");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command frobnicate/);
});

test("no --db and no sibling module fails with a clear error", t => {
  const { dir } = setup(t);
  const r = spawnSync(node, [CLI, "list"], { encoding: "utf8", cwd: dir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pass --db <path>/);
});
