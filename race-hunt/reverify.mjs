// Guild-20 re-verify track: for each wave branch touching concurrency paths,
// rebase a SCRATCH worktree onto origin/main, run targeted tests + guild-20
// race scripts against the rebased tree, and capture the concurrency diff
// for adversarial review. Never touches the guild-20 branch itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.REPO; // the guild-20 worktree (race scripts live here)
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const SCRATCH = join(REPO, ".tmp", "reverify");
mkdirSync(SCRATCH, { recursive: true });

const sh = (cmd, args, cwd, timeout = 300000) => {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", cwd, timeout,
      env: { ...process.env, REPO: cwd, TMPDIR: join(cwd, ".tmp") } });
    return { ok: true, out: out.slice(-3000) };
  } catch (e) {
    return { ok: false, out: (((e.stdout ?? "") + (e.stderr ?? "")).slice(-3000)) };
  }
};

const branches = [
  { slug: "sharded", branch: "origin/wave300/sharded-claim-boards",
    tests: ["tests/work-claim-board.test.js", "tests/work-claim-guards.test.js"],
    race: ["race-hunt/rh05-claim-acquire-race.mjs", "race-hunt/rh06-stale-append-replay.mjs"] },
  { slug: "release-compare", branch: "origin/wave300/fix5-release-compare",
    tests: ["tests/work-claim-guards.test.js"],
    race: ["race-hunt/rh06-stale-append-replay.mjs"] },
  { slug: "cap-gapfill", branch: "origin/wave300/fix18-cap-gapfill",
    tests: ["tests/claim-pr-sync-room-scoping.test.js"],
    race: ["race-hunt/rh07-sweep-stale-settle.mjs", "race-hunt/rh08-settle-terminal.mjs"] },
  { slug: "event-light", branch: "origin/wave300/fix69-event-light-claims",
    tests: ["tests/work-claim-events.test.js"],
    race: ["race-hunt/rh07-sweep-stale-settle.mjs"] },
  { slug: "fastpath", branch: "origin/wave300/data-plane-fastpath",
    tests: ["tests/work-claim-durable-http.test.js"],
    race: ["race-hunt/rh05-claim-acquire-race.mjs"] },
  { slug: "payload-store", branch: "origin/wave300/payload-store",
    tests: ["tests/public-work-claim-fence.test.js"],
    race: ["race-hunt/rh03-public-fence-permit.mjs"] },
  { slug: "eventlog-scale", branch: "origin/wave300/fix4-eventlog-read-scale",
    tests: ["tests/work-claim-events.test.js"],
    race: [] },
  { slug: "perf", branch: "origin/wave400/perf",
    tests: ["tests/work-claim-board.test.js"],
    race: ["race-hunt/rh05-claim-acquire-race.mjs"] },
  { slug: "elegant-wcmisc", branch: "origin/wave400/elegant-wcmisc",
    tests: ["tests/work-claim-batch-outcome.test.js"],
    race: ["race-hunt/rh07-sweep-stale-settle.mjs", "race-hunt/rh08-settle-terminal.mjs"] },
  { slug: "succession", branch: "origin/wave300/fix12-unprivileged-succession",
    tests: ["tests/work-claim-guards.test.js"],
    race: ["race-hunt/rh06-stale-append-replay.mjs"] },
];

const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
const report = [];
for (const b of branches) {
  if (only && !only.includes(b.slug)) continue;
  const wt = join(SCRATCH, "wv-" + b.slug);
  const outDir = join(SCRATCH, "reports", b.slug);
  mkdirSync(outDir, { recursive: true });
  const lines = [];
  const log = s => { lines.push(s); console.log(`[${b.slug}] ${s}`); };
  if (existsSync(wt)) { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: REPO }); }
  mkdirSync(join(wt, ".tmp"), { recursive: true });
  let r = sh("git", ["worktree", "add", wt, b.branch], REPO);
  if (!r.ok) { log("worktree add FAILED: " + r.out.slice(-300)); report.push({ slug: b.slug, status: "worktree-failed" }); continue; }
  r = sh("git", ["rebase", "origin/main"], wt);
  const rebased = r.ok;
  log(rebased ? "rebased cleanly onto origin/main" : "REBASE CONFLICT: " + r.out.slice(-300));
  if (!rebased) { sh("git", ["rebase", "--abort"], wt); }
  const base = rebased ? "origin/main" : null;
  // capture concurrency diff for adversarial review
  const diffFiles = ["server/work-claims.mjs", "server/work-claim-routes.mjs", "server/work-claim-sqlite.mjs",
    "server/claim-pr-sync.mjs", "server/claim-coordination.mjs", "server/store.mjs", "server/instance-lock.mjs",
    "server/writer-fence.mjs", "server/public-work-claim-fence.mjs"];
  const d = sh("git", ["diff", "--stat", `${b.branch}...${rebased ? "HEAD" : b.branch}`, "--", ...diffFiles], wt);
  writeFileSync(join(outDir, "diffstat.txt"), d.out);
  const dfull = sh("git", ["diff", `${b.branch}...${rebased ? "HEAD" : b.branch}`, "--", ...diffFiles], wt);
  writeFileSync(join(outDir, "diff.txt"), dfull.out.slice(0, 60000));
  log("concurrency diffstat:\n" + d.out.split("\n").slice(0, 12).join("\n"));
  // targeted tests on the rebased tree
  const testRes = [];
  for (const t of b.tests) {
    const tr = sh("node", ["--test", t], wt);
    testRes.push({ test: t, ok: tr.ok });
    log(`test ${t}: ${tr.ok ? "PASS" : "FAIL"}`);
    writeFileSync(join(outDir, "test-" + t.replace(/\//g, "_") + ".log"), tr.out);
  }
  // guild-20 race scripts with REPO pointed at the rebased tree
  const raceRes = [];
  for (const rs of b.race) {
    const rr = sh("node", [join(REPO, rs)], wt, 240000);
    raceRes.push({ script: rs, ok: rr.ok });
    log(`race ${rs}: ${rr.ok ? "PASS" : "FAIL"}`);
    writeFileSync(join(outDir, "race-" + rs.split("/").pop() + ".log"), rr.out);
  }
  const broken = testRes.some(t => !t.ok) || raceRes.some(t => !t.ok);
  report.push({ slug: b.slug, branch: b.branch, rebased, tests: testRes, race: raceRes,
    status: !rebased ? "rebase-conflict" : broken ? "BREAKAGE" : "clean" });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(report[report.length - 1], null, 2));
}
writeFileSync(join(SCRATCH, "reports", "index.json"), JSON.stringify(report, null, 2));
console.log("\n=== RE-VERIFY SUMMARY ===");
for (const r of report) console.log(`${r.slug}: ${r.status} (rebased=${r.rebased})`);
const bad = report.filter(r => r.status !== "clean");
if (bad.length) { console.log("NEEDS ATTENTION: " + bad.map(r => r.slug).join(", ")); process.exit(2); }
