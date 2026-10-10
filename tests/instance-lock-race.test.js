// REL-23: concurrent boots on one database must yield exactly one lock
// holder, both on a fresh path and on a stale lock left by a crash.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const lockModule = fileURLToPath(new URL("../server/instance-lock.mjs", import.meta.url));
const contender = `
import { acquireInstanceLock } from ${JSON.stringify(lockModule)};
const [lockPath, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) {}
try { const l = acquireInstanceLock(lockPath); process.stdout.write("WON"); setTimeout(() => { l.release(); process.exit(0); }, 600); }
catch (e) { process.stdout.write("LOST:" + e.code); process.exit(0); }
`;

const boot = (lockPath, startAt) => new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", contender, lockPath, String(startAt)]);
  let out = ""; child.stdout.on("data", d => { out += d; }); child.on("exit", () => resolve(out));
});

for (const state of ["fresh", "stale"]) test(`concurrent boots on a ${state} lock give exactly one holder`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "room-rel23-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let trial = 0; trial < 8; trial++) {
    const lockPath = join(dir, `.project-room-${trial}.lock`);
    if (state === "stale") writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, startedAt: "2020-01-01T00:00:00.000Z" }), { mode: 0o600 });
    const startAt = Date.now() + 300;
    const outs = await Promise.all(Array.from({ length: 6 }, () => boot(lockPath, startAt)));
    assert.equal(outs.filter(o => o === "WON").length, 1, `trial ${trial}: ${outs.join(",")}`);
    for (const o of outs) if (o !== "WON") assert.match(o, /^LOST:instance_lock_(held|io)$/);
    assert.equal(existsSync(lockPath), false, "the holder released its lock");
  }
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith(".tmp") || f.endsWith(".reclaim")), [], "no temp files or reclaim markers left");
});

test("restart after a crash: a dead holder's lock is reclaimed by the next boot", async t => {
  const dir = mkdtempSync(join(tmpdir(), "room-rel23-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, ".project-room.lock");
  const holder = spawn(process.execPath, ["--input-type=module", "-e",
    `import { acquireInstanceLock } from ${JSON.stringify(lockModule)}; acquireInstanceLock(process.argv[1]); process.stdout.write("HELD"); setInterval(() => {}, 1000);`, lockPath]);
  await new Promise(r => holder.stdout.once("data", r));
  assert.equal(await boot(lockPath, Date.now()), "LOST:instance_lock_held", "a live holder blocks a second boot");
  holder.kill("SIGKILL"); await new Promise(r => holder.once("exit", r));
  assert.equal(existsSync(lockPath), true, "a crash leaves the lock file");
  assert.equal(await boot(lockPath, Date.now()), "WON", "the next boot reclaims it");
});
