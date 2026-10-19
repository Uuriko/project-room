#!/usr/bin/env node
// IR-2 operator remedy: reconcile a restored store against a surviving
// current store — the mechanised form of the Fix Programme v2 §4
// emergency exception — or acknowledge a restore for which no reference
// survives anywhere.
//
//   node scripts/restore-reconcile.mjs --restored <db> --current <db>
//   node scripts/restore-reconcile.mjs --restored <db> --acknowledge --reason "<why no reference exists>"
//
// The gate path captures the current store's authority extract, runs the
// full reconcile against the restored store, re-applies every named
// post-watermark revocation in one transaction, journals the report into
// the restored store's operator_actions, and stamps it reconciled (agent
// authentication unblocks). The acknowledge path records that no
// reference exists — post-watermark revocations stay unknowable — and
// unlocks on that journaled record alone; it requires a reason.
import { RoomStore } from "../server/store.mjs";
import {
  captureAuthorityExtract, runRestoreGate, acknowledgeRestoredUnreconciled,
  restoreReconcileState, storeRestoredUnreconciled,
} from "../server/restore-reconcile.mjs";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const restoredPath = argValue("--restored");
const currentPath = argValue("--current");
const acknowledge = process.argv.includes("--acknowledge");
const reason = argValue("--reason");

if (!restoredPath || (!currentPath && !acknowledge) || (currentPath && acknowledge)) {
  console.error("usage: restore-reconcile.mjs --restored <db> (--current <db> | --acknowledge --reason \"<why>\")");
  process.exit(2);
}
if (acknowledge && !reason) {
  console.error("--acknowledge requires --reason: the acknowledgement is the audit record and must say why no reference exists");
  process.exit(2);
}

const restored = new RoomStore(restoredPath);
try {
  if (!storeRestoredUnreconciled(restored.db)) {
    console.log(JSON.stringify({ ok: true, status: "not_locked", state: restoreReconcileState(restored.db) }));
    process.exit(0);
  }
  if (acknowledge) {
    const { acknowledged, state } = acknowledgeRestoredUnreconciled(restored, { reason });
    console.log(JSON.stringify({ ok: acknowledged, status: acknowledged ? "acknowledged_no_reference" : "not_locked", restoredFrom: state?.restoredFrom ?? null }));
    process.exit(acknowledged ? 0 : 1);
  }
  const current = new RoomStore(currentPath, { readOnly: true });
  try {
    const extract = captureAuthorityExtract(current);
    const backedUpAt = restoreReconcileState(restored.db)?.restoredFrom ?? null;
    const report = restored.transaction(() => runRestoreGate(restored, extract, { backedUpAt, source: "operator-script" }));
    console.log(JSON.stringify({
      ok: true, status: report.status,
      stale: report.stale, reapplied: report.reapplied.length,
      skipped: report.skipped, checkedClasses: report.checkedClasses,
    }, null, 2));
    process.exit(0);
  } finally { current.close(); }
} finally { restored.close(); }
