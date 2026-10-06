// Tests for scripts/i18n-harness.mjs (backlog Q012).
//
// Test-audit authoring gate answers:
// 1. Contract protected: the harness's extraction + three readiness rules
//    detect hardcoded UI strings, sentence concatenation, and positional
//    placeholders, and `--check` ratchets violation counts against the
//    committed baseline (fails when any rule count grows).
// 2. Credible regression: a change to the extractor (e.g. the comment
//    stripper or the line-index fix) that silently drops literals or stops
//    flagging known patterns; a `--check` that passes while counts grow.
// 3. Existing coverage: none — the harness is new; this file is its primary
//    owner at the real boundary (exported extraction functions + CLI exit
//    codes, no test-only seams).
// 4. No production seam for tests: tests import the script's exported
//    functions (used by the CLI's own --extract/--check modes) and spawn the
//    real CLI for the ratchet check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  extractLiterals,
  looksLikeProse,
  checkSource,
  runExtraction,
  summarize,
  RULES,
} from "../scripts/i18n-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const harness = join(root, "scripts", "i18n-harness.mjs");
const baselinePath = join(root, "strings", "i18n-baseline.json");

test("extractLiterals finds quoted strings and counts template interpolations", () => {
  const lits = extractLiterals(`const a = "hello world"; const b = 'x'; const t = \`Hi \${name}, you have \${n} items\`;`);
  assert.equal(lits.length, 3);
  assert.equal(lits[0].value, "hello world");
  assert.equal(lits[2].interpolations, 2);
});

test("extractLiterals skips commented-out copy", () => {
  const lits = extractLiterals(`// "This sentence is a comment"\nconst a = "Real user facing sentence here";`);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].value, "Real user facing sentence here");
});

test("extractLiterals handles escaped quotes without splitting", () => {
  const lits = extractLiterals(`const a = "She said \\"hello there friend\\"";`);
  assert.equal(lits.length, 1);
  assert.ok(lits[0].value.includes("hello there friend"));
});

test("looksLikeProse: table of positives and negatives", () => {
  const yes = [
    "Name must be 80 characters or fewer.",
    "Something needs you in Room",
    "Choose contribute, collaborate, or review.",
    "<li>No decisions recorded yet.</li>",
  ];
  const no = [
    "https://room.trydemigod.com/api",
    "#agent-invite-dialog",
    "INVALID_EMAIL",
    "./channel-connection.mjs",
    "application/json",
    "hi",
    "room.trydemigod.com",
  ];
  for (const s of yes) assert.ok(looksLikeProse(s), `expected prose: ${s}`);
  for (const s of no) assert.ok(!looksLikeProse(s), `expected non-prose: ${s}`);
});

test("checkSource flags hardcoded UI strings and ignores code-like literals", () => {
  const v = checkSource(`el.textContent = "Invite someone to the room";\nfetch("https://example.com/api");`, "src/x.js");
  assert.equal(v.filter((x) => x.rule === "hardcoded-ui-string").length, 1);
});

test("checkSource flags sentence concatenation (binary + and multi-interpolation)", () => {
  const bin = checkSource(`const s = "Hello " + name + ", welcome back";`, "src/y.js");
  assert.ok(bin.some((x) => x.rule === "sentence-concatenation"), "binary + not flagged");
  const tpl = checkSource("const s = `Hi ${first}, you have ${count} items`;", "src/y.js");
  assert.ok(tpl.some((x) => x.rule === "sentence-concatenation"), "multi-interpolation template not flagged");
  const single = checkSource("const s = `Hello ${name}`;", "src/y.js");
  assert.ok(!single.some((x) => x.rule === "sentence-concatenation"), "single interpolation should pass");
});

test("checkSource flags positional placeholders but allows named ones", () => {
  const pos = checkSource(`const s = "Item {0} of %d failed";`, "src/z.js");
  assert.ok(pos.some((x) => x.rule === "positional-placeholder"), "{0}/%d not flagged");
  const named = checkSource(`const s = "{count} things need you in Room";`, "src/z.js");
  assert.ok(!named.some((x) => x.rule === "positional-placeholder"), "named placeholder should pass");
});

test("runExtraction on current main proves the harness detects (failing-first evidence)", () => {
  const violations = runExtraction();
  const s = summarize(violations);
  assert.ok(s.counts["hardcoded-ui-string"] > 100, `expected real hardcoded strings on main, got ${s.counts["hardcoded-ui-string"]}`);
  assert.ok(s.counts["sentence-concatenation"] > 10, `expected concatenation hits on main, got ${s.counts["sentence-concatenation"]}`);
  assert.deepEqual(Object.keys(s.counts).sort(), [...RULES].sort());
});

test("--check ratchets: fails when a rule count grows beyond baseline", () => {
  const had = (() => { try { return readFileSync(baselinePath, "utf8"); } catch { return null; } })();
  try {
    writeFileSync(baselinePath, JSON.stringify({ generatedAt: "test", counts: { "hardcoded-ui-string": 0, "sentence-concatenation": 0, "positional-placeholder": 0 } }));
    const r = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8" });
    assert.equal(r.status, 1, `--check should exit 1 when counts exceed baseline; stderr: ${r.stderr}`);
    assert.match(r.stderr + r.stdout, /grew 0 ->/);
    // Restoring the true baseline makes --check pass again.
    if (had !== null) writeFileSync(baselinePath, had);
    const r2 = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8" });
    assert.equal(r2.status, 0, `--check should exit 0 within baseline; stderr: ${r2.stderr}`);
  } finally {
    if (had !== null) writeFileSync(baselinePath, had);
  }
});

test("--check without a baseline exits 2 with guidance", () => {
  const had = (() => { try { return readFileSync(baselinePath, "utf8"); } catch { return null; } })();
  try {
    if (had !== null) renameSync(baselinePath, baselinePath + ".bak");
    const r = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--baseline/);
  } finally {
    if (had !== null) renameSync(baselinePath + ".bak", baselinePath);
  }
});
