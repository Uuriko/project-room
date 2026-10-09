// RH-16: fee-credit-ledger double-apply (cross-slice: guild 14 owns money
// logic — verify, don't fix). The ledger is in-memory (closure state):
// double-apply must be rejected synchronously. 50k rapid double-apply
// attempts must all be refused with no state corruption.
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const { createFeeCreditLedger } = await import(REPO + "/server/fee-credit-ledger.mjs");

let bad = 0;
const ledger = createFeeCreditLedger({ now: () => 1_700_000_000_000 });
ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "1000" });
const receipt = ledger.applyCreditToPlacement({ clientId: "c1", placementId: "p1", trialTaskId: "t1", creditMinor: "1000" });
console.log(`first apply ok: ${typeof receipt === "object"}`);

let refused = 0;
for (let i = 0; i < 50000; i++) {
  try {
    ledger.applyCreditToPlacement({ clientId: "c1", placementId: "p1", trialTaskId: "t1", creditMinor: "1000" });
    bad++;
    if (bad < 3) console.log("FAIL: double-apply accepted");
  } catch (e) {
    if (/double-apply rejected/.test(e.message)) refused++;
    else { bad++; console.log(`FAIL: wrong error ${e.message.slice(0, 80)}`); }
  }
}
// duplicate fee record also refused
try { ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "1000" }); bad++; console.log("FAIL: duplicate fee accepted"); }
catch (e) { if (!/duplicate record rejected/.test(e.message)) { bad++; console.log("FAIL: wrong dup-fee error"); } }
// unknown fee refused
try { ledger.applyCreditToPlacement({ clientId: "c9", placementId: "p9", trialTaskId: "t9", creditMinor: "5" }); bad++; }
catch (e) { if (!/unknown trial fee/.test(e.message)) bad++; }

console.log(`double-apply refused ${refused}/50000`);
console.log(bad === 0
  ? "RH-16 RESULT: PASS — in-memory ledger rejects every double-apply synchronously (note: guard is per-process)"
  : `RH-16 RESULT: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 2);
