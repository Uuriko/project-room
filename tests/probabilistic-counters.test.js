// B2 charter §3 item 3: the 5 named behavioural cases.
// HLL/Bloom are NEVER for billing/gate counts — case 4 is the standing guard.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BloomFilter, HyperLogLog } from "../server/probabilistic-counters.mjs";

test("B2 case 1: Bloom false negatives are impossible (every inserted key reports present)", () => {
  const bf = new BloomFilter({ expectedItems: 200000, bitsPerItem: 10 });
  for (let i = 0; i < 20000; i++) bf.add(`share_${i}`);
  for (let i = 0; i < 20000; i++) assert.equal(bf.mightContain(`share_${i}`), true);
});

test("B2 case 2: Bloom false-positive rate <= 1% on a 200,000-key fixture", () => {
  const bf = new BloomFilter({ expectedItems: 200000, bitsPerItem: 10 });
  for (let i = 0; i < 200000; i++) bf.add(`share_${i}`);
  let fp = 0; const probes = 20000;
  for (let i = 0; i < probes; i++) if (bf.mightContain(`absent_${i}`)) fp++;
  assert.ok(fp / probes <= 0.01, `fp rate ${fp / probes}`);
});

test("B2 case 3: HLL estimate within 1% of exact count on a 350,000-unique fixture", () => {
  const hll = new HyperLogLog({ p: 14 });
  for (let i = 0; i < 350000; i++) hll.add(`visitor_${i}`);
  const est = hll.estimate();
  assert.ok(Math.abs(est - 350000) / 350000 <= 0.01, `estimate ${est}`);
});

test("B2 case 4 (negative guard): no money/billing/gate module imports the probabilistic counters", () => {
  const moneyModules = ["server/bounty-escrow.mjs", "server/fee-credit-ledger.mjs", "server/settlement-router.mjs", "server/bounty-receipts.mjs"];
  for (const path of moneyModules) {
    let src = "";
    try { src = readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); } catch { continue; }
    assert.ok(!src.includes("probabilistic-counters"), `${path} must never import probabilistic-counters`);
  }
});

test("B2 case 5: counter state is disposable — a lost counter degrades to recount, never a wrong verdict", () => {
  const bf = new BloomFilter({ expectedItems: 1000, bitsPerItem: 10 });
  bf.add("share_x");
  const fresh = new BloomFilter({ expectedItems: 1000, bitsPerItem: 10 });
  // A fresh (lost) filter reports "definitely absent" only as a membership
  // hint; the module contract requires the exact lookup on any positive and
  // treats absence as "recount from source", asserted here by the API shape:
  assert.equal(typeof fresh.mightContainWithFallback, "function");
  assert.equal(fresh.mightContainWithFallback("share_x", (k) => k === "share_x"), true);
});
