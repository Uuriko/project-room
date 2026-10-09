// R3/R7: mini-mutation checks on the wave-branch slice changes.
// Each mutant should be KILLED by the branch's own test file.
// Usage: node mini-mutants.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = "/home/hatch/workspace/pr-wave1000-guild-07";
const G = join(HERE, "work");
mkdirSync(G, { recursive: true });
const logPath = join(W, "findings/guild-07/reverify.md");
const append = t => writeFileSync(logPath, t, { flag: "a" });

const spec = [
  // R3: fix5's client/request-journal.mjs — run in the fix5 worktree
  { id: "R3a", wt: "/home/hatch/workspace/pr-wave1000/reverify-fix5", file: "client/request-journal.mjs",
    needle: "        journal.markDone(id);", replacement: "        // MUTANT: entry never marked done",
    tests: ["tests/request-journal.test.mjs"],
    desc: "drop markDone — entries stay pending forever; crash/recover tests should fail" },
  { id: "R3b", wt: "/home/hatch/workspace/pr-wave1000/reverify-fix5", file: "client/request-journal.mjs",
    needle: '      if (name.includes(".tmp-")) continue; // leftover torn write',
    replacement: '      // MUTANT: torn temps no longer skipped',
    tests: ["tests/request-journal.test.mjs"],
    desc: "recover() returns torn temp files; corruption test should fail" },
  { id: "R3c", wt: "/home/hatch/workspace/pr-wave1000/reverify-fix5", file: "client/request-journal.mjs",
    needle: 'atomicWriteJson(this.entryPath(id), { id, route, body, state: "pending" });',
    replacement: 'atomicWriteJson(this.entryPath(id), { id, route, body, state: "done" }); // MUTANT',
    tests: ["tests/request-journal.test.mjs"],
    desc: "entries born 'done' — recover() finds nothing; crash test should fail" },
  // R7: fix6's withClaimRetryDiscipline — run in the fix6 worktree
  { id: "R7a", wt: "/home/hatch/workspace/pr-wave1000/reverify-fix6", file: "client/public-work-claims.mjs",
    needle: "      if (attempts >= maxAttempts) throw new RoomClientError(0, 'retry_exhausted',",
    replacement: "      if (attempts > maxAttempts) throw new RoomClientError(0, 'retry_exhausted', // MUTANT",
    tests: ["tests/public-work-claims-retry-discipline.test.js"],
    desc: "off-by-one allows maxAttempts+1 mutation attempts; bound test should fail" },
  { id: "R7b", wt: "/home/hatch/workspace/pr-wave1000/reverify-fix6", file: "client/public-work-claims.mjs",
    needle: "      if (decision === 'applied') return { action: retryActionNames[action], task: packet, attempts, replayed: true };",
    replacement: "      if (decision !== 'applied') return { action: retryActionNames[action], task: packet, attempts, replayed: true }; // MUTANT",
    tests: ["tests/public-work-claims-retry-discipline.test.js"],
    desc: "inverted reconcile decision — conflicts returned as applied; conflict tests should fail" },
  { id: "R7c", wt: "/home/hatch/workspace/pr-wave1000/reverify-fix6", file: "client/public-work-claims.mjs",
    needle: "    || error.status === 200 && error.code === 'invalid_response');",
    replacement: "    ); // MUTANT: 200-unparseable no longer ambiguous",
    tests: ["tests/public-work-claims-retry-discipline.test.js"],
    desc: "drop the 200-invalid_response ambiguous arm; reconcile test should fail" },
];

append(`\n# R3/R7 mini-mutations on branch slice changes (${new Date().toISOString()})\n\n`);
for (const m of spec) {
  const path = join(m.wt, m.file);
  const src = readFileSync(path, "utf8");
  copyFileSync(path, join(G, `${m.id}.orig`));
  let status, detail;
  const occ = src.split(m.needle).length - 1;
  if (occ !== 1) { status = "INCONCLUSIVE"; detail = `needle x${occ}`; }
  else {
    writeFileSync(path, src.replace(m.needle, m.replacement));
    const r = spawnSync("node", ["--test", ...m.tests], { cwd: m.wt,
      env: { ...process.env, TMPDIR: join(m.wt, ".tmp") }, timeout: 180000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    status = r.status === 0 ? "SURVIVED" : "KILLED";
    detail = r.status === 0 ? "branch tests passed with mutant — GAP in branch tests"
      : `killed; tail: ${(r.stdout + r.stderr).slice(-600).replace(/\n/g, " | ")}`;
    copyFileSync(join(G, `${m.id}.orig`), path);
    if (readFileSync(path, "utf8") !== src) { status = "RESTORE-FAILED"; detail = "restore failed"; }
  }
  append(`## ${m.id} — ${status}\n- ${m.desc}\n- ${detail}\n\n`);
  console.log(`${m.id} ${status}`);
  if (status === "RESTORE-FAILED") break;
}
console.log("mini-mutants done");
