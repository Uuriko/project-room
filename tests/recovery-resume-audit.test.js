// Recovery resume audit: unit-level contract for the browser check's post-resume
// assertion. A paused boot must not touch any table; a resumed boot may only
// write server bookkeeping (eager cold-start integrity + the public read-model
// backfill cursor). Any other table changing after resume is a data-loss or
// corruption signal.
//
// Fail-first: this test encodes the corrected contract for
// scripts/recovery-browser-check.mjs, whose line-48 assertion demanded a
// byte-identical audit after resume. That assertion fails deterministically on
// current main: the resumed boot legitimately writes integrity/backfill
// housekeeping rows (see worker-26/repro-recovery-audit.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRecoveryFixture } from "../scripts/recovery-fixture.mjs";
import { auditRecovery } from "../server/recovery.mjs";

// Server bookkeeping written by a resumed boot: eager cold-start integrity
// plus the public read-model backfill cursor row. Not room data.
export const RESUME_HOUSEKEEPING_TABLES = Object.freeze([
  "integrity_snapshot",
  "integrity_job_cursor",
  "integrity_room_state",
  "public_read_model_backfill",
]);

test("paused boot touches nothing; resumed boot writes only housekeeping", { timeout: 120000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "recovery-resume-audit-"));
  const fixture = createRecoveryFixture(join(directory, "room.sqlite"));
  const before = auditRecovery(fixture.store);
  t.after(() => { fixture.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const boot = async paused => {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ["server.mjs"], {
      env: { ...process.env, NODE_ENV: "development", ROOM_DEPLOYMENT: "", ROOM_DB: fixture.filename,
        ROOM_ORIGIN: `http://127.0.0.1:${port}`, ROOM_MAINTENANCE: paused ? "1" : "0",
        HOST: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Local service did not start")), 10000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Local service stopped before readiness")); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    await new Promise(resolve => setTimeout(resolve, 5000));
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  };
  await boot(true);
  assert.deepEqual(auditRecovery(fixture.store), before, "paused boot must not touch populated data");
  await boot(false);
  const after = auditRecovery(fixture.store);
  const housekeeping = new Set(RESUME_HOUSEKEEPING_TABLES);
  assert.deepEqual(
    after.tables.filter(row => !housekeeping.has(row.table)),
    before.tables.filter(row => !housekeeping.has(row.table)),
    "resumed boot must only write integrity/backfill housekeeping, never room data",
  );
});
