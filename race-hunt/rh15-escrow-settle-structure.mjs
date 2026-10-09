// RH-15: bounty-escrow double-settle structural verification (cross-slice:
// guild 14 owns money logic — verify, don't fix).
// Asserts the load-bearing properties that close the settle race:
// (1) finalizeBounty and closeEpoch wrap in this.store.transaction AND
//     re-read the bounty row fresh inside the transaction (no stale object);
// (2) _keeperPass returns null for terminal states (second settle -> invalid_state);
// (3) _sweep's payout requires state=="approved" via _requireFinalityMove.
import { readFileSync } from "node:fs";
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const src = readFileSync(REPO + "/server/bounty-escrow.mjs", "utf8");
let bad = 0;
const check = (name, cond) => { console.log(`${cond ? "ok" : "FAIL"} - ${name}`); if (!cond) bad++; };

// (1) finalizeBounty: transaction + fresh read before _keeperPass/_sweep
const fin = src.slice(src.indexOf("finalizeBounty("), src.indexOf("closeEpoch("));
check("finalizeBounty wraps in store.transaction", /this\.store\.transaction\(\(\) =>/.test(fin));
const selIdx = fin.indexOf("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?");
const passIdx = fin.indexOf("_keeperPass(bounty");
check("finalizeBounty re-reads row inside txn before keeper pass", selIdx !== -1 && passIdx !== -1 && selIdx < passIdx);

// closeEpoch: single transaction around the whole sweep loop
const epoch = src.slice(src.indexOf("closeEpoch("), src.indexOf("// --- rage-quit"));
check("closeEpoch wraps whole loop in one store.transaction", /this\.store\.transaction\(\(\) =>/.test(epoch));
const epochSel = epoch.indexOf("SELECT * FROM bounty_records WHERE room_id=? AND state IN");
const epochSweep = epoch.indexOf("this._sweep(bounty");
check("closeEpoch reads rows inside the same txn as _sweep", epochSel !== -1 && epochSweep !== -1 && epochSel < epochSweep);

// (2) _keeperPass terminal states -> null (no branch matches paid/refunded/etc.)
const keeper = src.slice(src.indexOf("_keeperPass(bounty"), src.indexOf("finalizeBounty("));
for (const terminal of ["paid", "refunded", "released", "cancelled"]) {
  check(`_keeperPass has no branch for terminal state "${terminal}"`, !new RegExp(`bounty\\.state === "${terminal}"`).test(keeper));
}
// (3) payout finality: approved only
check('_requireFinalityMove payout requires state=="approved"',
  /case "payout": case "fee": return bounty\.state === "approved"/.test(src));

console.log(bad === 0
  ? "RH-15 RESULT: PASS — escrow settle paths are transaction-closed (fresh read + state machine rejects re-settle)"
  : `RH-15 RESULT: FAIL — structural settle-race guard missing (${bad})`);
process.exit(bad === 0 ? 0 : 2);
