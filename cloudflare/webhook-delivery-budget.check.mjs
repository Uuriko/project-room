// Workerd proof that webhook delivery hydration stays indexed as the table
// grows. Node's sqlite module does not report rows examined; the Durable
// Object cursor does, and that is the production counter.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const BUDGET = 20_000;

async function measure(mf, n, { passes = 1, oracle = false } = {}) {
  const response = await mf.dispatchFetch(`http://localhost/measure?n=${n}&passes=${passes}${oracle ? "&oracle=1" : ""}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test("production-sized webhook hydration stays under 20k rows and scales linearly", async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./webhook-delivery-budget.test-fixture.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral",
    external: ["node:*", "cloudflare:*"],
  });
  const mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "DeliveryBudgetRoom", useSQLite: true } },
  });
  try {
    const sized = await measure(mf, 3000, { passes: 2, oracle: true });
    assert.equal(sized.loaded, 100);
    assert.ok(sized.legacyRowsRead > 1_000_000, `legacy correlated read was ${sized.legacyRowsRead}`);
    for (const pass of sized.measured) {
      assert.equal(pass.hydrationStatements, sized.subscriptions);
      assert.ok(pass.deliveryRowsRead < BUDGET, `startup delivery reads ${pass.deliveryRowsRead}`);
    }
    const plan = sized.plans.join("\n");
    assert.match(plan, /SEARCH agent_webhook_deliveries USING INDEX agent_webhook_deliveries_sub_created/);
    assert.doesNotMatch(plan, /CORRELATED/);
    assert.doesNotMatch(plan, /SCAN agent_webhook_deliveries/);

    const small = await measure(mf, 1000);
    const large = await measure(mf, 4000);
    const smallReads = small.measured[0].deliveryRowsRead;
    const largeReads = large.measured[0].deliveryRowsRead;
    assert.ok(smallReads > 0 && largeReads > 0);
    assert.ok(largeReads < smallReads * 4, `1k reads ${smallReads}, 4k reads ${largeReads}`);
  } finally { await mf.dispose(); }
});
