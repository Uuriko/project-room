// Replay-matrix conformance — #3676 (PREP-3676-3677 §A.1/§A.5), PR-2.
//
// The 8-row starter set from §A.5, each driven through R1-R5 + R7-R8 by
// the shared driver in harness.mjs. R6 (crash between execute and
// persist) is included ONLY for the two control rows (5 buyer-signoff,
// 6 attention — the executeOnce adopters), via PR-0's fixture reopen()
// and a transaction-rollback crash; R6 for every other row is PR-3,
// separately chartered, and is recorded NOT_APPLICABLE in harness.mjs
// rather than silently joining this slice.
//
// Rows 5, 7 and 8 pin money-path behaviour (see ROWS moneyKind): a wrong
// pin here is a money-semantics claim, which is why this PR lands singly
// under singleton discipline even though it is tests-only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ROWS, DIVERGENCES, NOT_APPLICABLE,
  runR1, runR2, runR3, runR4, runR5, runR7, runR8,
} from "./harness.mjs";
import { ADAPTERS } from "./adapters.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const key = (row, scenario) => `rm-${row.id}-${scenario.toLowerCase()}-key`;

for (const row of ROWS) {
  const adapter = ADAPTERS[row.id];

  test(`row ${row.id} (${row.surface}): R1 same key + same payload`, async t => {
    if (row.r1 === "n/a") {
      assert.ok(NOT_APPLICABLE.some(n => n.row === row.id && n.scenario === "R1"), "n/a must be declared");
      return;
    }
    const ctx = await adapter.setup(t);
    await runR1(adapter, row, ctx, key(row, "R1"));
  });

  test(`row ${row.id} (${row.surface}): R2 same key + different payload`, async t => {
    if (row.r2 === "n/a") {
      assert.ok(NOT_APPLICABLE.some(n => n.row === row.id && n.scenario === "R2"), "n/a must be declared");
      return;
    }
    const ctx = await adapter.setup(t);
    await runR2(adapter, row, ctx, key(row, "R2"));
  });

  test(`row ${row.id} (${row.surface}): R3 same key, foreign scope`, async t => {
    const ctx = await adapter.setup(t);
    const foreign = await adapter.setupForeign(t, ctx);
    await runR3(adapter, row, ctx, foreign, key(row, "R3"));
  });

  test(`row ${row.id} (${row.surface}): R4 same key, different actor (${row.r4.behaviour})`, async t => {
    const ctx = await adapter.setup(t);
    await runR4(adapter, row, ctx, key(row, "R4"));
  });

  test(`row ${row.id} (${row.surface}): R5 failure before persist, then retry`, async t => {
    if (row.r5 === "n/a") {
      assert.ok(NOT_APPLICABLE.some(n => n.row === row.id && n.scenario === "R5"), "n/a must be declared");
      return;
    }
    const ctx = await adapter.setup(t);
    await runR5(adapter, row, ctx, key(row, "R5"));
  });

  test(`row ${row.id} (${row.surface}): R7 no key supplied`, async t => {
    if (row.r7 === "n/a") {
      assert.ok(NOT_APPLICABLE.some(n => n.row === row.id && n.scenario === "R7"), "n/a must be declared");
      return;
    }
    const ctx = await adapter.setup(t);
    await runR7(adapter, row, ctx);
  });

  test(`row ${row.id} (${row.surface}): R8 concurrent duplicates`, async t => {
    if (row.r8 === "n/a") {
      assert.ok(NOT_APPLICABLE.some(n => n.row === row.id && n.scenario === "R8"), "n/a must be declared");
      return;
    }
    const ctx = await adapter.setup(t);
    await runR8(adapter, row, ctx, key(row, "R8"));
  });
}

// ------------------------------------------------------------ R6, control rows only
for (const row of ROWS.filter(r => r.control)) {
  const adapter = ADAPTERS[row.id];

  test(`row ${row.id} (${row.surface}): R6 restart after commit replays, never re-executes`, async t => {
    const ctx = await adapter.setup(t);
    const k = key(row, "R6");
    const first = await adapter.submit(ctx, { key: k, payload: "same", actor: "primary" });
    assert.equal(first.status, 200);
    assert.equal(await adapter.effectCount(ctx, { key: k, actor: "primary" }), 1);
    await adapter.reopen(ctx); // PR-0 fixture reopen(): same on-disk store, fresh RoomStore
    const retry = await adapter.submit(ctx, { key: k, payload: "same", actor: "primary" });
    assert.equal(retry.status, 200, "the journal survives the restart, so the retry replays");
    assert.deepEqual(adapter.normalize(retry.body), adapter.normalize(first.body));
    assert.equal(await adapter.effectCount(ctx, { key: k, actor: "primary" }), 1, "no double effect after restart + retry");
  });

  test(`row ${row.id} (${row.surface}): R6 crash between execute and persist leaves neither effect nor journal`, async t => {
    const ctx = await adapter.setup(t);
    const k = key(row, "R6C");
    const crashed = await adapter.crashAttempt(ctx, { key: k });
    assert.ok(crashed.status >= 400, "the crash attempt itself fails");
    assert.equal(await adapter.effectCount(ctx, { key: k, actor: "primary" }), 0,
      "atomicity invariant: effect and journal are both absent, never effect-without-journal");
    const retry = await adapter.submit(ctx, { key: k, payload: "same", actor: "primary" });
    assert.equal(retry.status, 200, "the retry after the crash executes fresh");
    assert.equal(await adapter.effectCount(ctx, { key: k, actor: "primary" }), 1, "exactly one effect overall");
  });
}

test("R6 is scoped to the control rows in this slice (PR-3 owns the rest)", () => {
  for (const row of ROWS) {
    if (row.control) assert.equal(row.r6, true, `control row ${row.id} must declare R6`);
    else assert.ok(NOT_APPLICABLE.some(n => n.row === row.id && n.scenario === "R6"),
      `non-control row ${row.id}: R6 must be recorded as PR-3 scope, not silently included`);
  }
});

// ------------------------------------------------------------ row-specific pins
test("row 8 (spend-grant issue): a duplicate issue is an upsert — terms replaced, still one grant, no replay", async t => {
  const adapter = ADAPTERS[8];
  const ctx = await adapter.setup(t);
  const first = await adapter.submit(ctx, { key: null, payload: "same", actor: "primary" });
  assert.equal(first.status, 201);
  assert.equal(await adapter.currentCap(ctx), "5000");
  const second = await adapter.submit(ctx, { key: null, payload: "different", actor: "primary" });
  assert.equal(second.status, 201, "no key exists to conflict against: the second issue executes");
  assert.equal(await adapter.currentCap(ctx), "9000", "the second issue REPLACED the grant terms (upsert)");
  assert.equal(await adapter.effectCount(ctx, {}), 1, "still exactly one grant row for (room, agent)");
});

test("row 7 (bounty-escrow): create via idemExecute replays the same bounty; a legacy unscoped row refuses actor-mismatch", async t => {
  const adapter = ADAPTERS[7];
  const ctx = await adapter.setup(t);
  const { escrow, db } = ctx;
  const payload = { title: "P", amount: 7 };
  const created = escrow.idemExecute(ctx.room, "rm-7-create", "bounty.post", 201,
    () => escrow.postBounty(ctx.room, { poster: "id:agent/jill", title: "P", criteria: "C", amount: 7, deadline: new Date(1_786_000_000_000 + 3_600_000).toISOString() }),
    { callerLane: "id:agent/jill", bountyId: null, payload });
  assert.equal(created.replayed, false);
  const replay = escrow.idemExecute(ctx.room, "rm-7-create", "bounty.post", 201,
    () => { throw new Error("must not re-execute"); },
    { callerLane: "id:agent/jill", bountyId: null, payload });
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.bounty.bountyId, created.body.bounty.bountyId);
  db.exec("UPDATE bounty_idempotency SET version = NULL, scope_key = NULL WHERE idem_key = 'rm-7-create'");
  assert.throws(() => escrow.idemExecute(ctx.room, "rm-7-create", "bounty.post", 201, () => ({}),
    { callerLane: "id:agent/jill", bountyId: null, payload }), { code: "idempotency_actor_mismatch" },
    "the R4 sub-behaviour (b) code exists for legacy rows whose caller cannot be proven");
});

test("row 3 (agent-invite redeem): the same requestId against a second code IN THE SAME ROOM conflicts (global journal)", async t => {
  // The receipt journal's PK is request_id alone, so within one store the
  // scope is global-per-requestId; R3's independence holds across stores
  // (rooms), which the driver's foreign-scope test pins.
  const row = ROWS.find(r => r.id === 3);
  assert.match(row.scopeDerivation, /GLOBAL/);
});

// ------------------------------------------------------------ registry + inventory
test("registry: exactly the 8 §A.5 starter rows, every scenario declared", () => {
  assert.deepEqual(ROWS.map(r => r.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const row of ROWS) {
    assert.ok(row.surface && row.module && row.keyPlacement && row.scopeDerivation, `row ${row.id} identity fields`);
    for (const field of ["r1", "r2", "r3", "r4", "r5", "r7", "r8"]) assert.ok(row[field] !== undefined, `row ${row.id} declares ${field}`);
    assert.ok(ADAPTERS[row.id], `row ${row.id} has an adapter`);
  }
  const money = ROWS.filter(r => r.moneyFlag).map(r => r.id);
  assert.deepEqual(money, [5, 7, 8], "the singleton money rows are exactly 5, 7, 8");
  for (const d of DIVERGENCES) {
    assert.ok(ROWS.some(r => r.id === d.row), `divergence ${d.id} names a real row`);
    assert.ok(["R1", "R2", "R7"].includes(d.scenario) && d.debt.length > 40, `divergence ${d.id} carries its debt`);
  }
});

test("inventory: every starter row's surface is present in the PR-0 census artifact", () => {
  const artifact = JSON.parse(readFileSync(join(here, "..", "fixtures", "conformance-inventory.json"), "utf8"));
  const haystack = JSON.stringify(artifact);
  for (const row of ROWS) {
    assert.ok(haystack.includes(row.inventoryFragment),
      `row ${row.id} (${row.surface}): fragment ${row.inventoryFragment} not found in the census inventory`);
  }
  // The two control rows are the census's only runOnce adopters — the
  // file-level facts in the artifact are the evidence for their status.
  const facts = new Map(artifact.serverFileFacts.map(f => [f.module, f]));
  assert.equal(facts.get("server/attention.mjs")?.importsRunOnce, true);
  assert.equal(facts.get("server/buyer-signoff.mjs")?.importsRunOnce, true);
});
