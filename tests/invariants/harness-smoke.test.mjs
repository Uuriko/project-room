// Harness self-check: proves the frame works, not the product.
//
// This file tests the runner/DSL/fixture machinery itself using trivial
// mechanics-only assertions. Real invariant scenarios (the never-break
// product properties) live in sibling files and are written by the
// invariant-lane workers.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { invariant, validateScenario } from "./dsl.mjs";
import { runInvariant, bootInvariantDB } from "./runner.mjs";
import { mintIdentity, linkToRoom, proposeWork, acceptWork, acquireClaim, workItemState } from "./fixtures.mjs";

test("dsl: builder captures declare/act/assert phases in order", async t => {
  const order = [];
  const scenario = invariant("smoke-order", "phase order")
    .given(() => { order.push("given"); })
    .when(() => { order.push("when"); })
    .then(() => { order.push("then"); })
    .build();
  assert.deepEqual(validateScenario(scenario), []);
  // Drive the phases directly (no DB needed): proves the DSL wires them in order.
  const ctx = {};
  await scenario.arrange({}, ctx);
  await scenario.act({}, ctx);
  await scenario.assert({}, ctx);
  assert.deepEqual(order, ["given", "when", "then"]);
});

test("dsl: when() captures a refusal into ctx.error for then()", async t => {
  const scenario = invariant("smoke-refusal", "refusal capture")
    .when(() => { throw Object.assign(new Error("refused"), { status: 409, code: "claim_conflict" }); })
    .then((f, ctx) => {
      assert.equal(ctx.error?.code, "claim_conflict");
      assert.equal(ctx.error?.status, 409);
    })
    .build();
  runInvariant(scenario);
});

test("fixtures: linkToRoom returns a fresh owner key; issuing it revokes f.keys.owner", async t => {
  const scenario = invariant("smoke-link", "link helper semantics")
    .given(async (f, ctx) => {
      const agent = mintIdentity(f, "link-probe");
      const { ownerKey } = linkToRoom(f, agent.identityId, ["accept_work"]);
      ctx.ownerKey = ownerKey;
      ctx.workItemId = proposeWork(f, { actor: ownerKey, title: "linked probe" });
      return ctx;
    })
    .then(async (f, ctx) => {
      // f.keys.owner was revoked when linkToRoom issued the fresh key.
      let refusal = null;
      try {
        f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "work.accepted", data: {} });
      } catch (err) { refusal = err; }
      assert.equal(refusal?.code, "unauthenticated");
      // The returned key works for owner commands.
      acceptWork(f, ctx.workItemId, { actor: ctx.ownerKey });
      assert.equal(workItemState(f, ctx.ownerKey, ctx.workItemId).revision, 1);
    })
    .build();
  runInvariant(scenario);
});

test("runner: each scenario boots an isolated disposable database", async t => {
  const scenario = invariant("smoke-isolation", "db isolation")
    .given(async (f, ctx) => {
      ctx.dir = f.directory;
      const agent = mintIdentity(f, "isolation-probe");
      const workItemId = proposeWork(f, { title: "isolation probe" });
      acceptWork(f, workItemId);
      acquireClaim(f, workItemId);
      ctx.agentId = agent.identityId;
      ctx.workItemId = workItemId;
      return ctx;
    })
    .then(async (f, ctx) => {
      assert.ok(f.directory.startsWith("/"), "fixture exposes its directory");
      assert.equal(f.directory, ctx.dir, "same fixture across phases of one scenario");
      assert.ok(ctx.agentId, "minted identity survived the scenario");
      assert.equal(workItemState(f, f.keys.owner, ctx.workItemId).claim?.status, "active");
    })
    .build();
  runInvariant(scenario);
});

test("runner: bootInvariantDB tears down the database on test end", async t => {
  const { existsSync } = await import("node:fs");
  let dir, tornDown = false;
  await t.test("child boots a db", async ct => {
    const f = bootInvariantDB(ct);
    dir = f.directory; // captured now; teardown runs when the child ends
    ct.after(() => { tornDown = true; });
  });
  assert.equal(tornDown, true, "child test finished and its after-hooks ran");
  assert.equal(existsSync(dir), false, "fixture directory removed after the test");
});
