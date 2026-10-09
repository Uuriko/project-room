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
import { readFileSync, writeFileSync, renameSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  extractLiterals,
  looksLikeProse,
  checkSource,
  runExtraction,
  summarize,
  scannableRels,
  checkScopeConsistency,
  findUnpinnedFiles,
  growthAllowance,
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

test("checkScopeConsistency reports dropped and extra files", () => {
  const manifest = ["a.js", "b.js", "c.js"];
  const r1 = checkScopeConsistency(manifest, ["a.js", "b.js", "c.js", "d.js"]);
  assert.deepEqual(r1.dropped, []);
  assert.deepEqual(r1.extra, ["d.js"]);
  const r2 = checkScopeConsistency(manifest, ["a.js"]);
  assert.deepEqual(r2.dropped, ["b.js", "c.js"]);
  // Live: the committed manifest must be a subset of the current scan.
  const scope = JSON.parse(readFileSync(join(root, "strings", "i18n-scope.json"), "utf8"));
  const live = checkScopeConsistency(scope, scannableRels());
  assert.deepEqual(live.dropped, [], "manifest lists files the scan no longer covers");
});

test("--check fails closed when the scope manifest is tampered", () => {
  const scopePath = join(root, "strings", "i18n-scope.json");
  const had = readFileSync(scopePath, "utf8");
  try {
    // Shrink the manifest to 3 files: simulates a narrowed scan scope.
    const manifest = JSON.parse(had);
    writeFileSync(scopePath, JSON.stringify(manifest.slice(0, 3), null, 2));
    const r = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8" });
    assert.equal(r.status, 1, `--check should exit 1 on scope tamper; stderr: ${r.stderr}`);
    assert.match(r.stderr, /scope manifest modified but does not match/);
  } finally {
    writeFileSync(scopePath, had);
  }
});

test("--check rejects an inflated committed baseline (bootstrap exactness)", () => {
  const had = readFileSync(baselinePath, "utf8");
  try {
    const baseline = JSON.parse(had);
    const inflated = { ...baseline, counts: { ...baseline.counts, "hardcoded-ui-string": 100000 } };
    writeFileSync(baselinePath, JSON.stringify(inflated));
    const r = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8" });
    assert.equal(r.status, 1, `--check should exit 1 on baseline inflation; stderr: ${r.stderr}`);
    assert.match(r.stderr, /baseline counts do not match fresh scan/);
  } finally {
    writeFileSync(baselinePath, had);
  }
});

test("--check ratchets in steady state: fails when counts grow past an untouched baseline", () => {
  // Steady state = baseline file identical to the base ref (committed). With
  // I18N_BASE_REF=HEAD the classic ratchet applies, not bootstrap exactness.
  // Current copy may be below the ratchet after a legitimate catalog migration.
  // Add enough real probe literals to exceed the unchanged baseline by one.
  const probe = join(root, "src", "__i18n-probe.tmp.mjs");
  const env = { ...strictEnv(), I18N_BASE_REF: "HEAD" };
  // The ceiling is the larger of the committed count and the base tree's
  // own scan (HEAD here, without the untracked probe).
  const committedCount = JSON.parse(readFileSync(baselinePath, "utf8")).counts["hardcoded-ui-string"];
  const currentCount = summarize(runExtraction()).counts["hardcoded-ui-string"];
  const baseCount = Math.max(committedCount, currentCount);
  const addedCount = Math.max(1, baseCount - currentCount + 1);
  try {
    const literals = Array(addedCount).fill('"This is a brand new hardcoded user facing sentence for the probe"');
    writeFileSync(probe, `export const probe = [${literals.join(",")}];\n`);
    const r = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8", env });
    assert.equal(r.status, 1, `--check should exit 1 when counts exceed baseline; stderr: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`grew ${baseCount} -> ${currentCount + addedCount}`));
  } finally {
    rmSync(probe, { force: true });
  }
  const r2 = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8", env });
  assert.equal(r2.status, 0, `--check should exit 0 within baseline; stderr: ${r2.stderr}`);
});

// The environment minus anything that would allow growth, so a CI run on a
// PR carrying the i18n-growth label still exercises the strict ratchet.
function strictEnv() {
  const env = { ...process.env };
  delete env.I18N_ALLOW_GROWTH;
  delete env.GITHUB_EVENT_PATH;
  delete env.GITHUB_EVENT_NAME;
  return env;
}

function git(args, env = process.env) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

test("--check: declared growth passes, undeclared growth names the way to declare it", () => {
  const probe = join(root, "src", "__i18n-probe-growth.tmp.mjs");
  const env = { ...strictEnv(), I18N_BASE_REF: "HEAD" };
  const committedCount = JSON.parse(readFileSync(baselinePath, "utf8")).counts["hardcoded-ui-string"];
  const currentCount = summarize(runExtraction()).counts["hardcoded-ui-string"];
  const added = Math.max(1, Math.max(committedCount, currentCount) - currentCount + 1);
  try {
    writeFileSync(probe, `export const probe = [${Array(added).fill('"Another brand new hardcoded user facing sentence for the probe"').join(",")}];\n`);
    const strict = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8", env });
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(strict.stderr, /i18n-growth/);
    assert.match(strict.stderr, /Do not commit a regenerated baseline/);
    const allowed = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8", env: { ...env, I18N_ALLOW_GROWTH: "1" } });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /allowed by I18N_ALLOW_GROWTH=1/);
  } finally {
    rmSync(probe, { force: true });
  }
});

test("--check: growth already in the base tree passes without a regenerated baseline", () => {
  // Main moved: the base tree carries strings the committed baseline does not
  // count. Build that base as a throwaway commit (temporary index, no ref is
  // moved) and check the same working tree against it.
  const probeRel = "src/__i18n-probe-base.tmp.mjs";
  const probe = join(root, probeRel);
  const dir = mkdtempSync(join(tmpdir(), "i18n-index-"));
  const committedCount = JSON.parse(readFileSync(baselinePath, "utf8")).counts["hardcoded-ui-string"];
  const currentCount = summarize(runExtraction()).counts["hardcoded-ui-string"];
  const added = Math.max(1, committedCount - currentCount + 1);
  try {
    writeFileSync(probe, `export const probe = [${Array(added).fill('"A sentence that already landed on the base branch for the probe"').join(",")}];\n`);
    const indexEnv = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    git(["read-tree", "HEAD"], indexEnv);
    git(["add", "-f", probeRel], indexEnv);
    const tree = git(["write-tree"], indexEnv);
    const base = git(["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit-tree", tree, "-p", "HEAD", "-m", "i18n probe base"]);
    const env = { ...strictEnv(), I18N_BASE_REF: base };
    const r = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8", env });
    // The scope manifest does not list the probe, so only the pin may fail;
    // the count ratchet itself must not.
    assert.doesNotMatch(r.stderr, /grew/, r.stderr);
    const strict = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8", env: { ...env, I18N_BASE_REF: "HEAD" } });
    assert.match(strict.stderr, /grew/, "against HEAD (no probe) the same tree is growth");
  } finally {
    rmSync(probe, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importing the harness does not run --check (undeclared growth must not fail an importer)", () => {
  const probe = join(root, "src", "__i18n-probe-import.tmp.mjs");
  try {
    writeFileSync(probe, `export const probe = [${Array(50).fill('"An imported module must not run the ratchet for this probe"').join(",")}];\n`);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(harness)});`], { encoding: "utf8", env: strictEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, "");
  } finally {
    rmSync(probe, { force: true });
  }
});

test("growthAllowance reads the PR label or an i18n-growth body line from the event payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "i18n-event-"));
  const event = join(dir, "event.json");
  try {
    const at = pr => { writeFileSync(event, JSON.stringify({ pull_request: pr })); return growthAllowance({ GITHUB_EVENT_PATH: event }); };
    assert.equal(at({ labels: [{ name: "i18n-growth" }], body: "" }), "PR label i18n-growth");
    assert.match(at({ labels: [], body: "Summary\n\ni18n-growth: new onboarding copy, catalog move tracked in #1\n" }), /new onboarding copy/);
    assert.equal(at({ labels: [{ name: "docs" }], body: "mentions i18n-growth in prose only" }), null);
    assert.equal(growthAllowance({}), null);
    assert.equal(growthAllowance({ I18N_ALLOW_GROWTH: "1" }), "I18N_ALLOW_GROWTH=1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findUnpinnedFiles flags tracked surface files missing from the manifest", () => {
  assert.deepEqual(findUnpinnedFiles(["a.js", "b.js"], ["a.js", "b.js", "c.js"]), []);
  assert.deepEqual(findUnpinnedFiles(["a.js", "b.js"], ["a.js"]), ["b.js"]);
});

test("--check defeats paired evasion without any base ref (bootstrap path)", () => {
  // Simulates the full paired evasion on the bootstrap PR itself: narrow the
  // globs AND regenerate manifest+baseline with --baseline. No I18N_BASE_REF
  // is set, so the old base-manifest comparison would silently skip -- the
  // independent tree pin must still fail.
  const scopePath = join(root, "strings", "i18n-scope.json");
  const hadScope = readFileSync(scopePath, "utf8");
  const hadBaseline = readFileSync(baselinePath, "utf8");
  try {
    const manifest = JSON.parse(hadScope);
    writeFileSync(scopePath, JSON.stringify(manifest.slice(0, 5), null, 2));
    const r = spawnSync(process.execPath, [harness, "--check"], { encoding: "utf8" });
    assert.equal(r.status, 1, `--check should exit 1 on paired evasion; stderr: ${r.stderr}`);
    assert.match(r.stderr, /not in strings\/i18n-scope\.json/);
  } finally {
    writeFileSync(scopePath, hadScope);
    writeFileSync(baselinePath, hadBaseline);
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
