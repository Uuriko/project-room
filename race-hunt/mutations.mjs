// Guild-20 mutation track runner. For each mutant: backup the target file,
// apply the exact string replacement, run the killing test, restore the file,
// verify restoration via git diff. Reports killed/survived per mutant.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
mkdirSync(join(REPO, ".tmp", "mutbak"), { recursive: true });

const runTest = (cmd, args, opts = {}) => {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 240000,
      cwd: REPO, env: { ...process.env, REPO, TMPDIR: join(REPO, ".tmp") }, ...opts });
    return { pass: true, out: out.slice(-1500) };
  } catch (e) {
    return { pass: false, out: ((e.stdout ?? "") + (e.stderr ?? "")).slice(-1500) };
  }
};

const mutants = [
  { id: "M-01", file: "server/instance-lock.mjs",
    find: "    try { unlinkSync(lockPath); }",
    replace: "    try { /* MUTANT M-01: stale reclaim unlink removed */ }",
    test: ["node", ["--test", "tests/instance-lock.test.js"]],
    expect: "kill", note: "stale lock never reclaimed" },
  { id: "M-02", file: "server/instance-lock.mjs",
    find: '  catch (error) { return error?.code === "EPERM"; }',
    replace: '  catch (error) { return true; /* MUTANT M-02: pidAlive always true */ }',
    test: ["node", ["--test", "tests/instance-lock.test.js"]],
    expect: "kill", note: "reclaim never happens" },
  { id: "M-03", file: "server/public-work-claim-fence.mjs",
    find: "COALESCE((SELECT enabled FROM ${permit} WHERE singleton=1),0) IS NOT 1",
    replace: "COALESCE((SELECT enabled FROM ${permit} WHERE singleton=1),0) IS 1 /* MUTANT M-03: inverted */",
    test: ["node", ["race-hunt/rh03-public-fence-permit.mjs"]],
    expect: "kill", note: "trigger fence inverted" },
  { id: "M-04", file: "server/public-work-claim-fence.mjs",
    find: "if (store.db.isTransaction) store.db.prepare(`UPDATE ${permit} SET enabled=0 WHERE singleton=1`).run();",
    replace: "/* MUTANT M-04: permit never closed */",
    test: ["node", ["race-hunt/rh03-public-fence-permit.mjs"]],
    expect: "kill", note: "permit left open" },
  { id: "M-05", file: "server/writer-fence.mjs",
    find: "db.function(WRITER_FUNCTION, () => STORE_SCHEMA_VERSION);",
    replace: "db.function(WRITER_FUNCTION, () => STORE_SCHEMA_VERSION - 1); /* MUTANT M-05 */",
    test: ["node", ["race-hunt/rh18-writer-fence-hammer.mjs"]],
    expect: "kill", note: "writer version mismatch" },
  { id: "M-06", file: "server/work-claims.mjs",
    find: `  if (item.claimedAt !== expectedClaimedAt || claimHistoryLength(item) !== expectedHistoryLength) {
    fail("work_claim_conflict", "The claim changed since it was read");
  }`,
    replace: `  /* MUTANT M-06: round check removed */`,
    test: ["node", ["race-hunt/rh06-stale-append-replay.mjs"]],
    expect: "kill", note: "E5 compare-and-release removed" },
  { id: "M-07", file: "server/channel-journal.mjs",
    find: "ON CONFLICT(account_id,connection_id,update_id) DO NOTHING",
    replace: "/* MUTANT M-07: idempotency removed */",
    test: ["node", ["race-hunt/rh09-channel-journal-record-race.mjs"]],
    expect: "kill", note: "journal idempotency removed" },
  { id: "M-08", file: "server/claim-pr-sync.mjs",
    find: "const linked = pullLinks(current).find(pull => pull.url === result.url && !pull.outcome);",
    replace: "const linked = pullLinks(current).find(pull => pull.url === result.url); /* MUTANT M-08 */",
    test: ["node", ["race-hunt/rh08-settle-terminal.mjs"]],
    expect: "survive-benign", note: "retry-safety match widened; settlePullRequest still guards" },
  { id: "M-09", file: "server/store.mjs",
    find: '    db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");',
    replace: '    db.exec("BEGIN"); /* MUTANT M-09: deferred instead of immediate */',
    test: ["node", ["race-hunt/m09-counter-race.mjs"]],
    expect: "kill", note: "deferred write transactions" },
  { id: "M-10", file: "server/wake-queue.mjs",
    find: "AND state='pending' AND due_at<=?",
    replace: "/* MUTANT M-10: pending check removed */ AND due_at<=?",
    test: ["node", ["race-hunt/rh11-wake-lease-race.mjs"]],
    expect: "kill", note: "lease pending-state check removed" },
];

const results = [];
for (const m of mutants) {
  const path = join(REPO, m.file);
  const bak = join(REPO, ".tmp", "mutbak", m.id + ".bak");
  const original = readFileSync(path, "utf8");
  if (!original.includes(m.find)) {
    results.push({ ...m, outcome: "ERROR", detail: "anchor string not found" });
    console.log(`${m.id}: ERROR — anchor not found in ${m.file}`);
    continue;
  }
  copyFileSync(path, bak);
  writeFileSync(path, original.replace(m.find, m.replace));
  const t0 = Date.now();
  const res = runTest(m.test[0], m.test[1]);
  const ms = Date.now() - t0;
  // restore + verify
  copyFileSync(bak, path);
  const restored = readFileSync(path, "utf8") === original;
  const killed = !res.pass; // the killing test FAILED with the mutant = mutant killed
  const verdict = killed ? "KILLED" : "SURVIVED";
  const asExpected = (m.expect === "kill" && killed) || (m.expect === "survive-benign" && !killed);
  results.push({ ...m, outcome: verdict, ms, restored, asExpected,
    tail: res.out.split("\n").slice(-4).join(" | ") });
  console.log(`${m.id} [${m.note}]: ${verdict}${asExpected ? "" : " (UNEXPECTED)"} restored=${restored} (${ms}ms)`);
  console.log(`    tail: ${res.out.split("\n").slice(-4).join(" | ").slice(0, 220)}`);
}

const killed = results.filter(r => r.outcome === "KILLED").length;
const survived = results.filter(r => r.outcome === "SURVIVED").length;
console.log(`\nMUTATION SUMMARY: ${killed} killed, ${survived} survived, ${results.length} total`);
for (const r of results.filter(r => r.outcome === "SURVIVED" || !r.asExpected))
  console.log(`  ${r.id}: ${r.outcome} (expected ${r.expect}) — ${r.note}`);
const unrestored = results.filter(r => !r.restored);
if (unrestored.length) { console.log("UNRESTORED: " + unrestored.map(r => r.id).join(",")); process.exit(3); }
