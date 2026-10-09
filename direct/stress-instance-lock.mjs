// T1: instance-lock multi-process stress (mutual-exclusion invariant).
// Invariant under test: no two processes hold the lock at the same instant.
// Each racer that acquires appends hold-interval heartbeats to a shared log;
// the checker asserts no two intervals overlap. Covers: (a) fresh acquire,
// (b) stale-lock reclaim, (c) SIGKILL crash recovery.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOD = join(WT, "server/instance-lock.mjs");
const dir = mkdtempSync(join(tmpdir(), "g20-lock-"));
const lockPath = join(dir, "instance.lock");
const logPath = join(dir, "holds.log");
writeFileSync(logPath, "");

const racerSrc = `
import { acquireInstanceLock } from ${JSON.stringify("file://" + MOD)};
import { appendFileSync } from "node:fs";
const [lockPath, logPath, holdMs] = [process.argv[2], process.argv[3], Number(process.argv[4] || 0)];
const stamp = (ev) => appendFileSync(logPath, JSON.stringify({ pid: process.pid, ev, t: Date.now() }) + "\\n");
try {
  const lock = acquireInstanceLock(lockPath);
  const start = Date.now();
  stamp("acquired");
  const end = start + holdMs;
  while (Date.now() < end) { stamp("hold"); await new Promise(r => setTimeout(r, 50)); }
  stamp("released");
  lock.release();
  process.exit(0);
} catch (e) { stamp("lost:" + (e.code || "?")); process.exit(2); }
`;
const racerFile = join(dir, "racer.mjs");
writeFileSync(racerFile, racerSrc);

const runRacer = (holdMs) => new Promise(resolve => {
  const p = spawn("node", [racerFile, lockPath, logPath, String(holdMs)], { stdio: "ignore" });
  p.on("close", code => resolve(code));
});

const checkNoOverlap = (label) => {
  const events = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  const byPid = new Map();
  for (const e of events) {
    if (!byPid.has(e.pid)) byPid.set(e.pid, []);
    byPid.get(e.pid).push(e);
  }
  const intervals = [];
  for (const [pid, evs] of byPid) {
    const a = evs.find(e => e.ev === "acquired"), r = evs.find(e => e.ev === "released");
    if (a && r) intervals.push({ pid, start: a.t, end: r.t });
    else if (a && !r) intervals.push({ pid, start: a.t, end: Infinity }); // died holding
  }
  let overlap = null;
  for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
    const x = intervals[i], y = intervals[j];
    if (x.start < y.end && y.start < x.end) overlap = [x, y];
  }
  const holders = intervals.length;
  if (overlap) console.log(`FAIL ${label}: overlapping holds ${JSON.stringify(overlap)}`);
  else console.log(`PASS ${label}: ${holders} hold interval(s), no overlaps (mutual exclusion held)`);
  return !overlap;
};

const reset = () => { writeFileSync(logPath, ""); if (existsSync(lockPath)) unlinkSync(lockPath); };

// (a) fresh acquire: 20 concurrent racers, 600ms holds
reset();
await Promise.all(Array.from({ length: 20 }, () => runRacer(600)));
checkNoOverlap("fresh-acquire-20x");

// (b) stale reclaim: plant dead-pid lock, 20 racers, 400ms holds
reset();
writeFileSync(lockPath, JSON.stringify({ pid: 999999991, startedAt: new Date(Date.now() - 3600e3).toISOString() }));
await Promise.all(Array.from({ length: 20 }, () => runRacer(400)));
const okB = checkNoOverlap("stale-reclaim-20x");
if (!existsSync(lockPath)) {
  console.log("PASS: lock file absent after reclaim race (all holders released normally)");
} else try {
  const data = JSON.parse(readFileSync(lockPath, "utf8"));
  console.log(Number.isSafeInteger(data.pid) && data.pid > 0 ? "PASS: lock file valid JSON after reclaim race" : "FAIL: torn lock file");
} catch { console.log("FAIL: lock file torn JSON"); }

// (c) SIGKILL crash recovery
reset();
const holder = spawn("node", ["-e",
  `import(${JSON.stringify("file://" + MOD)}).then(m => { m.acquireInstanceLock(${JSON.stringify(lockPath)}); setTimeout(()=>{}, 60000); })`],
  { stdio: "ignore", detached: true });
await new Promise(r => setTimeout(r, 2500));
holder.kill("SIGKILL");
await new Promise(r => setTimeout(r, 500));
if (!existsSync(lockPath)) { console.log("FAIL: no lock file after SIGKILL (holder may not have acquired in time)"); }
else {
  console.log("PASS: SIGKILLed holder left stale lock file");
  const res = await new Promise(resolve => {
    const p = spawn("node", [racerFile, lockPath, logPath, "100"], { stdio: "ignore" });
    p.on("close", c => resolve(c));
  });
  console.log(res === 0 ? "PASS: crashed lock reclaimed by next boot" : "FAIL: reclaim refused after crash");
}
console.log("DONE t1-instance-lock");
