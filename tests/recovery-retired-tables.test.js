// Regression: retired additive tables stay in the recovery audit's allowed
// set. agent_operator_controls shipped on main in 25ac6ce1 (2026-09-24 06:52
// UTC) and the module was removed by f235f7d7 (2026-09-24 21:52 UTC) with no
// DROP ever issued, so databases opened in that window carry the orphaned
// table forever. auditRecovery() must accept it (data preservation), not fail
// closed with "Recovery data requires operator reconciliation" — backup
// restore (server/backup.mjs) and export (server/room-export.mjs) both gate
// on the audit.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";

// The exact DDL ensureOperatorControlsSchema applied from the writer boot
// path while the module was live (server/operator-controls.mjs @ 25ac6ce1).
const ORPHANED_OPERATOR_CONTROLS_DDL = `
CREATE TABLE IF NOT EXISTS agent_operator_controls (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  spend_cap_cents INTEGER NULL,
  spend_period_days INTEGER NOT NULL DEFAULT 30,
  killed_at INTEGER NULL,
  autonomy_tier TEXT NOT NULL DEFAULT 't2_standard',
  sandboxed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NULL,
  updated_by TEXT NULL,
  PRIMARY KEY (room_id, member_id)
);`;

test("recovery audit accepts a database carrying the retired agent_operator_controls table", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-recovery-retired-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  // Simulate an upgrade-path database: the table exists (with a row) but no
  // current module creates or owns it.
  store.db.exec(ORPHANED_OPERATOR_CONTROLS_DDL);
  store.db.prepare("INSERT INTO agent_operator_controls (room_id, member_id, autonomy_tier) VALUES ('commons', 'agent-1', 't2_standard')").run();
  assert.doesNotThrow(() => auditRecovery(store),
    "a retired additive table must not fail the recovery audit");
});
