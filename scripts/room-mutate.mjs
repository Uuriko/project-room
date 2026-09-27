#!/usr/bin/env node
// scripts/room-mutate.mjs — single-point mutant generator + runner for scripts/room.
//
// Why a custom tool instead of Stryker: scripts/room is bash with embedded
// jq; no JS mutation framework targets it. The room's own `_parse` / `_state`
// verbs and the fake-gh sweep pattern give a deterministic test seam, so a
// small exact-string mutant generator is the pragmatic fit.
//
// Usage:
//   node scripts/room-mutate.mjs --list
//   node scripts/room-mutate.mjs --run M1,M7 [--jobs 4] [--workdir DIR]
//   node scripts/room-mutate.mjs --run-all [--jobs 4] [--workdir DIR]
//
// Every run first executes the suite against an UNMUTATED overlay (baseline).
// If the baseline fails, the tool exits 3 without attributing any kills —
// a broken harness must never masquerade as mutant kills.
//
// For each mutant the tool:
//   1. copies scripts/room into a scratch overlay (<workdir>/mut-<id>/),
//      applies ONE exact-string replacement, and `bash -n` checks the result
//      (a syntax-broken mutant is a bad mutant definition -> ERROR, not a kill);
//   2. copies the protocol test files into the overlay so their
//      checkout-relative `scripts/room` resolution hits the mutant;
//   3. runs `node --test` (TAP) over them with TMPDIR inside the workdir.
// A mutant is KILLED when at least one test fails. Mutants expected to
// survive must carry a precise equivalence argument (see MUTANTS[].notes).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const checkout = join(here, "..");
const roomSrc = join(checkout, "scripts", "room");

// ---------------------------------------------------------------------------
// Mutant catalog. anchor must occur EXACTLY once in scripts/room.
// expect: "kill" (a test must fail) or "equivalent" (survives with proof).
// ---------------------------------------------------------------------------
const MUTANTS = [
  { id: "M1", area: "parse", expect: "kill",
    anchor: 'elif $pf.p == "[claim]" then', replacement: 'elif $pf.p == "[receipt]" then',
    notes: "claim branch swapped to receipt: a [lane][claim] comment no longer parses as a claim." },
  { id: "M2", area: "parse", expect: "kill",
    anchor: 'elif $pf.p == "[receipt]" then', replacement: 'elif $pf.p == "[done]" then',
    notes: "receipt branch swapped to done." },
  { id: "M3", area: "parse", expect: "kill",
    anchor: 'elif $pf.p == "[done]" then', replacement: 'elif $pf.p == "[claim]" then',
    notes: "done branch swapped to claim." },
  { id: "M4", area: "parse", expect: "kill",
    anchor: 'elif ($pf.p == null) and ($rest | test("^(DONE|MERGED|DEPLOYED)(:|[ \\\\t])")) then',
    replacement: 'elif ($pf.p == null) or ($rest | test("^(DONE|MERGED|DEPLOYED)(:|[ \\\\t])")) then',
    notes: "At this branch $pf.p is always null (earlier elifs consume every non-null prefix), so the condition degrades from R to TRUE: every prefix-less prose comment attempts a prose-terminal close via first_rc on its first line. Killed by room-board-grammar 'unmarked CLAIM prose'." },
  { id: "M5", area: "validate", expect: "kill",
    anchor: 'if (($b["task-id"] // "") == "") then . + ["missing task-id"]',
    replacement: 'if (($b["task-id"] // "") != "") then . + ["missing task-id"]',
    notes: "valid claims are rejected as missing task-id." },
  { id: "M6", area: "validate", expect: "kill",
    anchor: 'if (($b.files // "") == "") then . + ["missing files"]',
    replacement: 'if (($b.files // "") != "") then . + ["missing files"]',
    notes: "valid claims are rejected as missing files." },
  { id: "M7", area: "validate", expect: "kill",
    anchor: '(($m.n | tonumber) < 1 or ($m.n | tonumber) > 72)',
    replacement: '(($m.n | tonumber) < 0 or ($m.n | tonumber) > 72)',
    notes: "lease=0h is accepted." },
  { id: "M8", area: "validate", expect: "kill",
    anchor: '(($m.n | tonumber) < 1 or ($m.n | tonumber) > 72)',
    replacement: '(($m.n | tonumber) < 1 or ($m.n | tonumber) > 73)',
    notes: "lease=73h is accepted." },
  { id: "M9", area: "validate", expect: "kill",
    anchor: 'elif $b.state == "failed" then . + ["failed requires a failure code"] else . end',
    replacement: 'elif $b.state != "failed" then . + ["failed requires a failure code"] else . end',
    notes: "every non-failed state demands a failure code." },
  { id: "M10", area: "lease", expect: "kill",
    anchor: '+ $t.lease_h * 3600) end;',
    replacement: '+ $t.lease_h * 3601) end;',
    notes: "lease expiry drifts 1s per lease-hour (6s on a 6h lease)." },
  { id: "M11", area: "lease", expect: "kill",
    anchor: '($t.heartbeat_at // $t.claim_at)',
    replacement: '($t.claim_at)',
    notes: "heartbeats stop renewing the lease (F4 regression)." },
  { id: "M12", area: "lease", expect: "kill",
    anchor: '(epoch($at) > lease_exp($t)) and ($t.strike_one_at | not)',
    replacement: '(epoch($at) >= lease_exp($t)) and ($t.strike_one_at | not)',
    notes: "a heartbeat exactly at lease expiry is wrongly voided." },
  { id: "M13", area: "strike", expect: "kill",
    anchor: 'if ((.tasks[$tid].strike_one_at // null) != null) then',
    replacement: 'if ((.tasks[$tid].strike_one_at // null) == null) then',
    notes: "strike-one replay overwrites strike_one_at (F1 regression)." },
  { id: "M14", area: "strike", expect: "kill",
    anchor: '(epoch($m.ts // "") | . == 0)',
    replacement: '(epoch($m.ts // "") | . != 0)',
    notes: "parseable strike-one stamps are refused instead of recorded." },
  { id: "M15", area: "strike", expect: "kill",
    anchor: 'then $at else $stamp end) as $clamped',
    replacement: 'then $stamp else $at end) as $clamped',
    notes: "future-dated strike-one stamps are recorded unclamped." },
  { id: "M16", area: "strike", expect: "kill",
    anchor: 'if (($t.strike_one_at // null) == null) then',
    replacement: 'if (($t.strike_one_at // null) != null) then',
    notes: "a lone forged strike-two releases a claim (F3 regression)." },
  { id: "M17", area: "strike", expect: "kill",
    anchor: '(epoch($at) - epoch($t.strike_one_at) < 14400)',
    replacement: '(epoch($at) - epoch($t.strike_one_at) <= 14400)',
    notes: "strike-two at exactly the 4h grace mark is ignored instead of releasing." },
  { id: "M18", area: "strike", expect: "kill",
    anchor: '(epoch($t.heartbeat_at) > epoch($t.strike_one_at)))',
    replacement: '(epoch($t.heartbeat_at) >= epoch($t.strike_one_at)))',
    notes: "a heartbeat simultaneous with the nudge wrongly blocks strike-two." },
  { id: "M19", area: "strike", expect: "kill",
    anchor: '.state = "submitted" | .lane = null | .released_at = $at',
    replacement: '.state = "working" | .lane = null | .released_at = $at',
    notes: "strike-two 'releases' into working-with-no-lane instead of submitted." },
  { id: "M20", area: "strike", expect: "kill",
    anchor: 'state_word(.tasks[$tid].state) != "working"',
    replacement: 'state_word(.tasks[$tid].state) == "working"',
    notes: "strike stamps are ignored on working claims and bite terminal ones." },
  { id: "M21", area: "sweep", expect: "kill",
    anchor: 'if [ "$now" -gt "$exp_e" ]; then',
    replacement: 'if [ "$now" -ge "$exp_e" ]; then',
    notes: "strike-one fires at the exact expiry instant, before the lease lapses." },
  { id: "M22", area: "sweep", expect: "kill",
    anchor: '[ $((now - strike_e)) -gt 14400 ] && [ "$hb_ok" = 0 ]',
    replacement: '[ $((now - strike_e)) -ge 14400 ] && [ "$hb_ok" = 0 ]',
    notes: "strike-two fires at exactly the 4h grace mark." },
  { id: "M23", area: "sweep", expect: "kill",
    anchor: '[ $((now - strike_e)) -gt 14400 ] && [ "$hb_ok" = 0 ]',
    replacement: '[ $((now - strike_e)) -gt 14400 ] && [ "$hb_ok" = 1 ]',
    notes: "strike-two fires only when a post-nudge heartbeat exists (inverted guard)." },
  { id: "M24", area: "sweep", expect: "kill",
    anchor: '[ "$hb_e" -gt "$strike_e" ] && hb_ok=1',
    replacement: '[ "$hb_e" -ge "$strike_e" ] && hb_ok=1',
    notes: "a heartbeat simultaneous with the nudge counts as post-nudge." },
  { id: "M25", area: "sweep", expect: "kill",
    anchor: 'select(.state == "working" and .lane != null and ((.terminal // false) | not))',
    replacement: 'select(.state == "submitted" and .lane != null and ((.terminal // false) | not))',
    notes: "sweep nudges submitted claims instead of working ones." },
  { id: "M26", area: "sweep", expect: "kill",
    anchor: 'select(.state == "working" and .lane != null and ((.terminal // false) | not))',
    replacement: 'select(.state == "working" and .lane != null and ((.terminal // false)))',
    notes: "sweep nudges terminal (completed/cancelled/receipted) claims." },
  { id: "M27", area: "sweep", expect: "kill",
    anchor: 'if [ -z "$strike" ]; then',
    replacement: 'if [ -n "$strike" ]; then',
    notes: "strike-one branch taken when a strike is already recorded (double nudge / crash path)." },
  { id: "M28", area: "parse", expect: "kill",
    anchor: '(($rest | first_rc)) as $ref',
    replacement: '(($body | first_rc)) as $ref',
    notes: "prose-terminal DONE resolves the task-id from the whole body (2026-09-20 room-watch false positive)." },
];

// Test files copied into each overlay. They resolve scripts/room via their
// checkout-relative path, so inside the overlay they exercise the mutant.
// claim-validate runs name-filtered to its parity test (its other tests need
// the real server); its ../server/*.mjs imports are satisfied by stubs that
// resolve but throw if called — the parity test never touches them.
const OVERLAY_TESTS = [
  "tests/room-protocol-mutation.test.js",
  "tests/room-strike-hardening.test.js",
  "tests/room-sweep-dry-run.test.js",
  "tests/room-sweep-terminal.test.js",
  "tests/room-board-grammar.test.js",
  "tests/room-prose-claims.test.js",
];
const PARITY_FILE = "tests/claim-validate.test.js";
// Copied verbatim (not mutated): the parity test compares this JS mirror
// against the bash validate_claim inside scripts/room.
const PARITY_DEPS = ["server/claim-validate.mjs"];
const SERVER_STUBS = {
  "server/store.mjs": "export class RoomStore { constructor() { throw new Error('stub: not the real server'); } }\n",
  "server/http.mjs": "export function createRoomServer() { throw new Error('stub: not the real server'); }\n",
  "server/bootstrap.mjs": "export function initialRoom() { throw new Error('stub: not the real server'); }\n",
};

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function buildMutant(mut, workdir) {
  const dir = join(workdir, `mut-${mut.id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(join(dir, "tests"), { recursive: true });
  fs.mkdirSync(join(dir, "server"), { recursive: true });
  const src = fs.readFileSync(roomSrc, "utf8");
  const first = src.indexOf(mut.anchor);
  if (first === -1) return { ok: false, error: `anchor not found` };
  if (src.indexOf(mut.anchor, first + mut.anchor.length) !== -1)
    return { ok: false, error: `anchor not unique` };
  const mutated = src.slice(0, first) + mut.replacement + src.slice(first + mut.anchor.length);
  // Quoting trap: an apostrophe inside the replacement would terminate an
  // enclosing bash single-quoted jq span and break the mutant in a way no
  // test should bless. Refuse such mutants outright.
  if (mut.replacement.includes("'") && !mut.anchor.includes("'"))
    return { ok: false, error: `replacement introduces an apostrophe` };
  const mutantPath = join(dir, "scripts", "room");
  fs.writeFileSync(mutantPath, mutated, { mode: 0o755 });
  const n = sh("bash", ["-n", mutantPath]);
  if (n.status !== 0) return { ok: false, error: `bash -n failed: ${n.stderr.trim().slice(0, 200)}` };
  for (const t of OVERLAY_TESTS) fs.copyFileSync(join(checkout, t), join(dir, t));
  fs.copyFileSync(join(checkout, PARITY_FILE), join(dir, PARITY_FILE));
  for (const p of PARITY_DEPS) fs.copyFileSync(join(checkout, p), join(dir, p));
  for (const [p, body] of Object.entries(SERVER_STUBS)) fs.writeFileSync(join(dir, p), body);
  return { ok: true, dir };
}

// Baseline overlay: the UNMUTATED scripts/room plus the same test files,
// stubs, and parity deps. The suite must pass here; if it does not, the
// harness itself is broken and any kill/survive attribution is meaningless.
// runSuite reports this structurally (exit 3) instead of letting mutants
// be "killed" by harness errors.
function buildBaseline(workdir) {
  const dir = join(workdir, "mut-baseline");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(join(dir, "tests"), { recursive: true });
  fs.mkdirSync(join(dir, "server"), { recursive: true });
  const baselinePath = join(dir, "scripts", "room");
  fs.copyFileSync(roomSrc, baselinePath);
  fs.chmodSync(baselinePath, 0o755);
  for (const t of OVERLAY_TESTS) fs.copyFileSync(join(checkout, t), join(dir, t));
  fs.copyFileSync(join(checkout, PARITY_FILE), join(dir, PARITY_FILE));
  for (const p of PARITY_DEPS) fs.copyFileSync(join(checkout, p), join(dir, p));
  for (const [p, body] of Object.entries(SERVER_STUBS)) fs.writeFileSync(join(dir, p), body);
  return dir;
}

function runSuite(dir, tmpBase) {
  const testArgs = OVERLAY_TESTS.map((t) => join(dir, t));
  const r1 = sh("node", ["--test", "--test-reporter=tap", ...testArgs], {
    timeout: 300000,
    env: { ...process.env, TMPDIR: join(tmpBase, "tmp") },
  });
  const r2 = sh("node", ["--test", "--test-reporter=tap",
    "--test-name-pattern=parity with scripts/room validate_claim",
    join(dir, PARITY_FILE)], {
    timeout: 120000,
    env: { ...process.env, TMPDIR: join(tmpBase, "tmp") },
  });
  const fails = new Set();
  for (const r of [r1, r2]) {
    for (const line of (r.stdout || "").split("\n")) {
      const m = line.match(/^\s*not ok \d+ - (.+?)\s*$/);
      // File-level summaries ("not ok 1 - /path/x.test.js") are noise;
      // keep the individual test names.
      if (m && !/\.(test\.)?m?js$/.test(m[1].trim())) fails.add(m[1].trim());
    }
    if (r.status !== 0 && fails.size === 0) {
      const t = (r.stderr || "").slice(0, 200) || (r.error ? String(r.error).slice(0, 120) : "unknown");
      fails.add(`harness error: ${t}`);
    }
  }
  return { killed: fails.size > 0, failing: [...fails], rawStatus: [r1.status, r2.status] };
}

async function runOne(mut, workdir) {
  const built = buildMutant(mut, workdir);
  if (!built.ok) return { id: mut.id, status: "ERROR", detail: built.error };
  const tmpBase = join(built.dir, "work");
  fs.mkdirSync(join(tmpBase, "tmp"), { recursive: true });
  const { killed, failing } = runSuite(built.dir, tmpBase);
  fs.rmSync(built.dir, { recursive: true, force: true });
  if (killed) return { id: mut.id, status: "KILLED", failing };
  return { id: mut.id, status: mut.expect === "equivalent" ? "EQUIVALENT (expected)" : "SURVIVED", failing };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const m of MUTANTS) console.log(`${m.id}\t${m.area}\t${m.expect}\t${m.notes}`);
    return;
  }
  let ids;
  const runArg = args.find((a) => a.startsWith("--run="));
  if (args.includes("--run-all")) ids = MUTANTS.map((m) => m.id);
  else if (runArg) ids = runArg.slice(6).split(",").map((s) => s.trim()).filter(Boolean);
  else if (args.includes("--run")) {
    const i = args.indexOf("--run");
    ids = (args[i + 1] || "").split(",").map((s) => s.trim()).filter(Boolean);
  } else { console.error("usage: --list | --run M1,M2 | --run-all [--jobs N] [--workdir DIR]"); process.exit(1); }
  const jobs = parseInt((args.find((a) => a.startsWith("--jobs=")) || "--jobs=4").slice(7), 10) || 4;
  const wArg = args.find((a) => a.startsWith("--workdir="));
  const workdir = wArg ? wArg.slice(10) : join(checkout, ".tmp", "room-mutate");
  fs.mkdirSync(workdir, { recursive: true });
  const selected = MUTANTS.filter((m) => ids.includes(m.id));
  if (selected.length !== ids.length) {
    console.error(`unknown mutant ids: ${ids.filter((id) => !MUTANTS.some((m) => m.id === id)).join(",")}`);
    process.exit(1);
  }
  const results = [];
  // Structural gate: the unmutated overlay must pass the full suite first.
  // Without this, a broken harness (missing module, bad stub) would mark
  // mutants "KILLED" for harness errors instead of genuine test failures.
  const baselineDir = buildBaseline(workdir);
  const baselineTmp = join(baselineDir, "work");
  fs.mkdirSync(join(baselineTmp, "tmp"), { recursive: true });
  const base = runSuite(baselineDir, baselineTmp);
  fs.rmSync(baselineDir, { recursive: true, force: true });
  if (base.killed) {
    console.error("BASELINE FAILED — harness is broken, refusing to attribute kills:");
    for (const f of base.failing) console.error(`  - ${f}`);
    process.exit(3);
  }
  console.log(`baseline: unmutated overlay passes (suite exit ${base.rawStatus.join("/")})`);
  for (let i = 0; i < selected.length; i += jobs) {
    const batch = selected.slice(i, i + jobs);
    results.push(...await Promise.all(batch.map((m) => runOne(m, workdir))));
  }
  let killed = 0, survived = 0, errors = 0;
  for (const r of results) {
    if (r.status === "KILLED") killed++;
    else if (r.status === "ERROR") errors++;
    else survived++;
    console.log(`${r.id}: ${r.status}${r.failing && r.failing.length ? " <- " + r.failing.slice(0, 4).join(" | ") : ""}${r.detail ? " (" + r.detail + ")" : ""}`);
  }
  console.log(`---\nmutants: ${results.length}, killed: ${killed}, survived: ${survived}, errors: ${errors}`);
  const reportPath = join(workdir, "mutation-report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`report: ${reportPath}`);
  if (errors > 0 || survived > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
