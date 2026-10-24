// Replay-matrix conformance harness — #3676 (PREP-3676-3677 §A.1/§A.5), PR-2.
//
// One shared driver, one adapter per starter surface. An adapter is:
//   {
//     name,                    // row id from ROWS below
//     setup(t) -> ctx,         // fresh primary scope
//     setupForeign(t) -> ctx,  // fresh FOREIGN scope (R3); may share state
//                              // with the primary ctx where the surface's
//                              // scope is a partition of one store/registry
//     submit(ctx, { key, payload, actor }) -> { status, code?, body? },
//                              // payload: "same" | "different";
//                              // actor: "primary" | "second";
//                              // key: string, or null for the keyless call
//     failAttempt(ctx, { key }) -> { status, code? },
//                              // an attempt with this key that fails BEFORE
//                              // anything is journaled (R5)
//     effectCount(ctx, { key, actor }) -> number,
//                              // effects attributable to this key (+ actor)
//     normalize(body) -> comparable body for replay deep-equality,
//   }
//
// Scenarios (§A.1): R1 same key+payload · R2 same key, different payload ·
// R3 same key, foreign scope · R4 same key, different actor · R5 failure
// before persist, then retry · R6 crash between execute and persist
// (CONTROL ROWS ONLY in this slice — rows 5 and 6, driven in the test file
// via PR-0 fixture reopen() + a rollback "crash"; R6 for any other row is
// PR-3, separately chartered) · R7 no key supplied · R8 concurrent
// duplicates (duplicate count and order from PR-0's seeded interleaving
// generator; concurrency is modelled by submission order, per that
// generator's discipline — no timers, no wall-clock).
//
// A row DECLARES its expected behaviour per scenario in ROWS. Where the
// surface's actual behaviour diverges from the §A.1 ideal, the declaration
// names the divergence and DIVERGENCES records it as adoption debt: the
// driver asserts the ACTUAL behaviour exactly, so the day a surface is
// migrated onto runOnce the row goes red and both registries must be
// updated in that PR. A scenario a surface cannot express at all is
// declared in NOT_APPLICABLE with the reason — never silently skipped.

import assert from "node:assert/strict";
import { generateInterleaving, SUBMIT_DUPLICATE_OPS } from "../helpers/seeded-interleaving.mjs";

export const ROWS = Object.freeze([
  Object.freeze({
    id: 1, surface: "work-claim create", module: "server/work-claim-routes.mjs + server/work-claims.mjs",
    inventoryFragment: "/work-claims",
    keyPlacement: "body:id (the claim id IS the key; there is no separate requestId)",
    scopeDerivation: "(roomId, claimId) in the work-claim registry",
    moneyFlag: false, control: false,
    r1: "conflict-409", conflictCodes: ["work_claim_exists"],
    r2: "conflict-409",
    r3: "independent",
    r4: { behaviour: "conflict-409", order: "after", code: "work_claim_exists" },
    r5: true,
    r7: { first: "refused", code: "invalid_claim_input" },
    r8: "conflict-409",
  }),
  Object.freeze({
    id: 2, surface: "work-claim close/cancel", module: "server/work-claim-routes.mjs (route-table rows work-claim-close / work-claim-cancel)",
    inventoryFragment: "/work-claims",
    keyPlacement: "path:claimId (the resource id IS the key; the operation carries no requestId)",
    scopeDerivation: "(roomId, claimId); verb (close|cancel) is the route, not the payload",
    moneyFlag: false, control: false,
    r1: "conflict-409", conflictCodes: ["work_claim_terminal"],
    r2: "conflict-409",
    r3: "independent",
    r4: { behaviour: "refused", order: "before", code: "work_not_owner", status: 403 },
    r5: true,
    r7: "n/a",
    r8: "conflict-409",
  }),
  Object.freeze({
    id: 3, surface: "agent-invite redeem", module: "server/agent-invites.mjs",
    inventoryFragment: "/agent-invites/redeem",
    keyPlacement: "body:requestId (opt-in, client-kept; no requestId = legacy behaviour)",
    scopeDerivation: "requestId is a GLOBAL journal key (receipt PK is request_id alone); the receipt binds code_hash + display_name + identity",
    moneyFlag: false, control: false,
    r1: "replay", conflictCodes: ["invite_redeem_idempotency_conflict"],
    r2: "conflict-409",
    r3: "independent",
    r4: { behaviour: "refused", order: "after", code: "invite_redeem_identity_mismatch", status: 403 },
    r5: true,
    r7: { first: "executes", second: "conflict-409", code: "invite_already_used" },
    r8: "replay",
  }),
  Object.freeze({
    id: 4, surface: "guest-invite issue/redeem", module: "server/guest-invites.mjs",
    inventoryFragment: "/guest-invites",
    keyPlacement: "body:requestId (issue_request_id; required)",
    scopeDerivation: "(roomId, mintedByMemberId, issue_request_id) unique index; NO payload fingerprint is stored",
    moneyFlag: false, control: false,
    r1: "replay", conflictCodes: [],
    r2: "replay-divergence",
    r3: "independent",
    r4: { behaviour: "refused", order: "after", code: "owner_required", status: 403 },
    r5: true,
    r7: { first: "refused", code: "invalid_guest_invite" },
    r8: "replay",
  }),
  Object.freeze({
    id: 5, surface: "buyer-signoff request", module: "server/buyer-signoff.mjs",
    inventoryFragment: "server/buyer-signoff.mjs",
    keyPlacement: "body:requestId (required)",
    scopeDerivation: "(roomId, requestId) journal (buyer_signoff_requests); the actor is folded into the fingerprint, so a foreign actor conflicts",
    moneyFlag: true, moneyKind: "money-adjacent SINGLETON", control: true,
    r1: "replay", conflictCodes: ["request_id_reused"],
    r2: "conflict-409",
    r3: "independent",
    r4: { behaviour: "conflict-409", order: "after", code: "request_id_reused" },
    r5: true, r6: true,
    r7: { first: "refused", code: "invalid_signoff" },
    r8: "replay",
  }),
  Object.freeze({
    id: 6, surface: "attention command", module: "server/attention.mjs",
    inventoryFragment: "server/attention.mjs",
    keyPlacement: "body:requestId (required)",
    scopeDerivation: "(roomId, memberId, requestId) journal (private_attention_commands)",
    moneyFlag: false, control: true,
    r1: "replay", conflictCodes: ["idempotency_conflict"],
    r2: "conflict-409",
    r3: "independent",
    r4: { behaviour: "independent", order: "after" },
    r5: true, r6: true,
    r7: { first: "refused", code: "invalid_attention" },
    r8: "replay",
  }),
  Object.freeze({
    id: 7, surface: "bounty-escrow create/fund", module: "server/bounty-escrow-routes.mjs + server/bounty-escrow.mjs",
    inventoryFragment: "bounty",
    keyPlacement: "Idempotency-Key header OR idempotencyKey body field at the routes; the harness drives BountyEscrow.idemExecute, the routes' own boundary",
    scopeDerivation: "scopeKey = v2 hash of (callerLane, route, bountyId, key); payload hash (request_hash) binds the payload; legacy unscoped rows refuse with idempotency_actor_mismatch",
    moneyFlag: true, moneyKind: "MONEY SINGLETON", control: false,
    r1: "replay", conflictCodes: ["idempotency_key_reused", "idempotency_actor_mismatch"],
    r2: "conflict-409",
    r3: "independent",
    r4: { behaviour: "independent", order: "after" },
    r5: true,
    r7: { first: "executes", second: "executes" },
    r8: "replay",
  }),
  Object.freeze({
    id: 8, surface: "spend-grant issue", module: "server/routes/spend-grants.mjs + server/spend-grants.mjs",
    inventoryFragment: "/spend-grants",
    keyPlacement: "none — the route schema (additionalProperties: false) has no key field at all",
    scopeDerivation: "no journal; the grant itself is keyed (roomId, agentId) and issue is an upsert of its terms",
    moneyFlag: true, moneyKind: "money-adjacent SINGLETON", control: false,
    r1: "n/a", r2: "n/a", conflictCodes: [],
    r3: "independent",
    r4: { behaviour: "refused", order: "after", code: "capability_grant_required", status: 403 },
    r5: "n/a",
    r7: { first: "executes", second: "executes" },
    r8: "n/a",
  }),
]);

// Divergences from the §A.1 ideal, pinned as debt (the PR-1 known-failure
// pattern): the driver asserts the defective/actual outcome exactly, so
// fixing the surface turns the row red until the declaration is updated.
export const DIVERGENCES = Object.freeze([
  Object.freeze({
    id: "RM-R1-WORK-CLAIM-CREATE-NO-REPLAY", row: 1, scenario: "R1",
    debt: "work-claim create has no replay journal: a same-key same-payload retry is refused 409 work_claim_exists instead of replaying the stored 201. The effect is still exactly-once; the retrying client cannot recover the original response. Migrating create onto runOnce is the L remainder on #3676.",
  }),
  Object.freeze({
    id: "RM-R1-WORK-CLAIM-CLOSE-NO-REPLAY", row: 2, scenario: "R1",
    debt: "work-claim close/cancel has no replay journal: a duplicate close is refused 409 work_claim_terminal instead of replaying the stored 200. Exactly-once holds; the original response is unrecoverable.",
  }),
  Object.freeze({
    id: "RM-R2-GUEST-ISSUE-NO-FINGERPRINT", row: 4, scenario: "R2",
    debt: "guest-invite issue stores no payload fingerprint: same requestId with a DIFFERENT guestLabel replays the original invite (duplicate:true, original label) instead of 409ing. A client that reuses a requestId with changed intent silently gets the old invite.",
  }),
  Object.freeze({
    id: "RM-R1-GUEST-ISSUE-CODE-NOT-RESHOWN", row: 4, scenario: "R1",
    debt: "guest-invite issue replay is not byte-identical: the GX code is shown only at mint, so the replayed body omits it (duplicate:true, same inviteId). A client that lost the mint response cannot recover the code from a retry.",
  }),
  Object.freeze({
    id: "RM-R7-BOUNTY-NULL-KEY-BYPASS", row: 7, scenario: "R7",
    debt: "bounty-escrow idemExecute treats a null/undefined key as a declared bypass: it executes every time with no journal. The production routes always supply a key, but the boundary itself blesses keyless double-execution on a money path — flagged as adoption debt in the §A.3 inventory sense.",
  }),
  Object.freeze({
    id: "RM-R7-SPEND-GRANT-NO-KEY-SURFACE", row: 8, scenario: "R7",
    debt: "spend-grant issue has no idempotency key surface at all: every issue executes (as an upsert of the (room, agent) grant terms). A lost 201 retried with different terms silently replaces the grant; there is no journal to replay or conflict against. This row's R1/R2/R5/R8 are therefore NOT_APPLICABLE, not passed.",
  }),
]);

export const NOT_APPLICABLE = Object.freeze([
  Object.freeze({ row: 2, scenario: "R7", status: "n/a — close/cancel carries no key by design; the keyless path IS the operation, and its repeat behaviour is pinned by R1 (409 work_claim_terminal)" }),
  Object.freeze({ row: 8, scenario: "R1", status: "n/a — no key surface (see RM-R7-SPEND-GRANT-NO-KEY-SURFACE); duplicate-issue behaviour is pinned under R7 as an upsert" }),
  Object.freeze({ row: 8, scenario: "R2", status: "n/a — no key surface, so no key+payload binding exists to conflict" }),
  Object.freeze({ row: 8, scenario: "R5", status: "n/a — no journal, so there is no journaled-then-failed state to retry against; a failed issue writes nothing because the route runs in one store.transaction" }),
  Object.freeze({ row: 8, scenario: "R8", status: "n/a — no key surface; concurrent grant issuance races are pinned by the existing tests/spend-grant-races.test.js" }),
  Object.freeze({ row: 1, scenario: "R6", status: "n/a in this slice — R6 beyond the two control rows is PR-3, separately chartered (PREP §A.5)" }),
  Object.freeze({ row: 2, scenario: "R6", status: "n/a in this slice — R6 beyond the two control rows is PR-3, separately chartered (PREP §A.5)" }),
  Object.freeze({ row: 3, scenario: "R6", status: "n/a in this slice — R6 beyond the two control rows is PR-3, separately chartered (PREP §A.5)" }),
  Object.freeze({ row: 4, scenario: "R6", status: "n/a in this slice — R6 beyond the two control rows is PR-3, separately chartered (PREP §A.5)" }),
  Object.freeze({ row: 7, scenario: "R6", status: "n/a in this slice — R6 beyond the two control rows is PR-3, separately chartered (PREP §A.5)" }),
  Object.freeze({ row: 8, scenario: "R6", status: "n/a in this slice — R6 beyond the two control rows is PR-3, separately chartered (PREP §A.5)" }),
]);

const isSuccess = (res) => res.status >= 200 && res.status < 300;

function expectConflict(row, res, label) {
  assert.equal(res.status, 409, `${label}: expected 409, got ${res.status} (${res.code ?? ""})`);
  assert.ok(row.conflictCodes.includes(res.code) || res.code === row.r4?.code,
    `${label}: code ${res.code} is not in the row's pinned conflict set ${JSON.stringify(row.conflictCodes)}`);
}

// R1 — same key + same payload, same scope+actor.
export async function runR1(adapter, row, ctx, key) {
  const first = await adapter.submit(ctx, { key, payload: "same", actor: "primary" });
  assert.ok(isSuccess(first), `R1 row ${row.id}: first submit failed ${first.status} ${first.code ?? ""}`);
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1, `R1 row ${row.id}: effect count after first submit`);
  const second = await adapter.submit(ctx, { key, payload: "same", actor: "primary" });
  if (row.r1 === "replay") {
    assert.ok(isSuccess(second), `R1 row ${row.id}: replay must succeed, got ${second.status} ${second.code ?? ""}`);
    assert.deepEqual(adapter.normalize(second.body), adapter.normalize(first.body),
      `R1 row ${row.id}: replayed body must equal the stored outcome`);
  } else if (row.r1 === "conflict-409") {
    expectConflict(row, second, `R1 row ${row.id}`);
  } else {
    assert.fail(`R1 row ${row.id}: scenario declared ${row.r1}; the driver must not be called for n/a rows`);
  }
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1, `R1 row ${row.id}: exactly one effect after the duplicate`);
  return { first, second };
}

// R2 — same key + different payload, same scope.
export async function runR2(adapter, row, ctx, key) {
  const first = await adapter.submit(ctx, { key, payload: "same", actor: "primary" });
  assert.ok(isSuccess(first), `R2 row ${row.id}: first submit failed ${first.status} ${first.code ?? ""}`);
  const second = await adapter.submit(ctx, { key, payload: "different", actor: "primary" });
  if (row.r2 === "conflict-409") {
    expectConflict(row, second, `R2 row ${row.id}`);
  } else if (row.r2 === "replay-divergence") {
    assert.ok(DIVERGENCES.some(d => d.row === row.id && d.scenario === "R2"),
      `R2 row ${row.id}: a replay-divergence must be recorded in DIVERGENCES`);
    assert.ok(isSuccess(second), `R2 row ${row.id}: divergent replay still succeeds, got ${second.status}`);
    assert.deepEqual(adapter.normalize(second.body), adapter.normalize(first.body),
      `R2 row ${row.id}: divergent replay returns the ORIGINAL outcome, not the changed payload's`);
  } else {
    assert.fail(`R2 row ${row.id}: scenario declared ${row.r2}; the driver must not be called for n/a rows`);
  }
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1, `R2 row ${row.id}: no second effect`);
  return { first, second };
}

// R3 — same key, foreign scope: independent execution in its own scope.
export async function runR3(adapter, row, ctx, foreignCtx, key) {
  const first = await adapter.submit(ctx, { key, payload: "same", actor: "primary" });
  assert.ok(isSuccess(first), `R3 row ${row.id}: primary submit failed ${first.status} ${first.code ?? ""}`);
  const foreign = await adapter.submit(foreignCtx, { key, payload: "same", actor: "primary" });
  assert.ok(isSuccess(foreign), `R3 row ${row.id}: foreign-scope submit must execute independently, got ${foreign.status} ${foreign.code ?? ""}`);
  assert.equal(await adapter.effectCount(foreignCtx, { key, actor: "primary" }), 1, `R3 row ${row.id}: foreign scope has its own effect`);
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1, `R3 row ${row.id}: primary scope untouched by the foreign execution`);
  return { first, foreign };
}

// R4 — same key+scope, different actor: the row's declared sub-behaviour.
export async function runR4(adapter, row, ctx, key) {
  const attemptSecond = () => adapter.submit(ctx, { key, payload: "same", actor: "second" });
  if (row.r4.order === "before") {
    const refused = await attemptSecond();
    assert.equal(refused.status, row.r4.status ?? 409, `R4 row ${row.id}: second actor must be refused before the primary acts`);
    assert.equal(refused.code, row.r4.code, `R4 row ${row.id}: pinned refusal code`);
    assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 0, `R4 row ${row.id}: refused attempt has no effect`);
    const first = await adapter.submit(ctx, { key, payload: "same", actor: "primary" });
    assert.ok(isSuccess(first), `R4 row ${row.id}: primary submit after the refused attempt`);
    assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1);
    return { first, second: refused };
  }
  const first = await adapter.submit(ctx, { key, payload: "same", actor: "primary" });
  assert.ok(isSuccess(first), `R4 row ${row.id}: primary submit failed ${first.status} ${first.code ?? ""}`);
  const second = await attemptSecond();
  if (row.r4.behaviour === "independent") {
    assert.ok(isSuccess(second), `R4 row ${row.id}: second actor must execute independently, got ${second.status} ${second.code ?? ""}`);
    assert.equal(await adapter.effectCount(ctx, { key, actor: "second" }), 1, `R4 row ${row.id}: second actor has its own effect`);
  } else if (row.r4.behaviour === "conflict-409") {
    assert.equal(second.status, 409, `R4 row ${row.id}: actor mismatch must conflict, got ${second.status}`);
    assert.equal(second.code, row.r4.code, `R4 row ${row.id}: pinned actor-conflict code`);
  } else if (row.r4.behaviour === "refused") {
    assert.equal(second.status, row.r4.status, `R4 row ${row.id}: second actor must be refused, got ${second.status}`);
    assert.equal(second.code, row.r4.code, `R4 row ${row.id}: pinned refusal code`);
  } else {
    assert.fail(`R4 row ${row.id}: undeclared actor behaviour ${row.r4.behaviour}`);
  }
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1, `R4 row ${row.id}: primary effect unchanged, no replay of the primary's result`);
  return { first, second };
}

// R5 — failure before persist: nothing journaled; the retry executes once.
export async function runR5(adapter, row, ctx, key) {
  const failed = await adapter.failAttempt(ctx, { key });
  assert.ok(!isSuccess(failed), `R5 row ${row.id}: the failing attempt must not succeed, got ${failed.status}`);
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 0, `R5 row ${row.id}: a failed attempt journals/executes nothing`);
  const retry = await adapter.submit(ctx, { key, payload: "same", actor: "primary" });
  assert.ok(isSuccess(retry), `R5 row ${row.id}: retry after failure must execute fresh, got ${retry.status} ${retry.code ?? ""}`);
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1, `R5 row ${row.id}: exactly one effect overall`);
  return { failed, retry };
}

// R7 — no key supplied: the row's declared legacy behaviour.
export async function runR7(adapter, row, ctx) {
  const first = await adapter.submit(ctx, { key: null, payload: "same", actor: "primary" });
  if (row.r7.first === "refused") {
    assert.ok(!isSuccess(first), `R7 row ${row.id}: keyless call must be refused, got ${first.status}`);
    assert.equal(first.code, row.r7.code, `R7 row ${row.id}: pinned keyless refusal code`);
    return { first };
  }
  assert.ok(isSuccess(first), `R7 row ${row.id}: keyless call executes (declared legacy behaviour), got ${first.status} ${first.code ?? ""}`);
  if (row.r7.second === "executes") {
    const second = await adapter.submit(ctx, { key: null, payload: "same", actor: "primary" });
    assert.ok(isSuccess(second), `R7 row ${row.id}: second keyless call also executes (no journal), got ${second.status}`);
    return { first, second };
  }
  if (row.r7.second === "conflict-409") {
    const second = await adapter.submit(ctx, { key: null, payload: "same", actor: "primary" });
    assert.equal(second.status, 409, `R7 row ${row.id}: second keyless call conflicts, got ${second.status}`);
    assert.equal(second.code, row.r7.code, `R7 row ${row.id}: pinned keyless-repeat code`);
    return { first, second };
  }
  return { first };
}

// R8 — concurrent duplicates: N from the seeded interleaving generator.
export async function runR8(adapter, row, ctx, key, seed = 3676 + row.id) {
  const { trace } = generateInterleaving({ seed, count: 6, ops: SUBMIT_DUPLICATE_OPS });
  const duplicates = trace.filter(step => step.op === "submitDuplicate").length;
  const n = Math.min(5, Math.max(2, duplicates + 1));
  const results = await Promise.all(Array.from({ length: n },
    () => adapter.submit(ctx, { key, payload: "same", actor: "primary" })));
  const successes = results.filter(isSuccess);
  if (row.r8 === "replay") {
    assert.equal(successes.length, n, `R8 row ${row.id} seed ${seed}: every duplicate receives the stored outcome (${JSON.stringify(results.map(r => r.status))})`);
    const expected = adapter.normalize(successes[0].body);
    for (const res of successes) assert.deepEqual(adapter.normalize(res.body), expected, `R8 row ${row.id} seed ${seed}: all callers receive the same outcome`);
  } else if (row.r8 === "conflict-409") {
    assert.equal(successes.length, 1, `R8 row ${row.id} seed ${seed}: exactly one execution succeeds (${JSON.stringify(results.map(r => r.status))})`);
    for (const res of results.filter(r => !isSuccess(r))) expectConflict(row, res, `R8 row ${row.id} seed ${seed}`);
  } else {
    assert.fail(`R8 row ${row.id}: scenario declared ${row.r8}; the driver must not be called for n/a rows`);
  }
  assert.equal(await adapter.effectCount(ctx, { key, actor: "primary" }), 1, `R8 row ${row.id} seed ${seed}: exactly one effect under concurrency`);
  return { n, results };
}
