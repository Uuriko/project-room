// Fleet incident evals — FLEET-METHODS-2 (Part A).
//
// Each test is the smallest executable fixture for a defect that escaped
// two individually-green PRs / a clean textual auto-merge / a composed
// head, mined from the pitfall catalogue and the landing ledgers. These
// are regression pins on the COMPOSED behavior, not re-tests of either
// side alone: every incident below passed each PR's own CI and failed
// only when the pieces met. Incident → fixture map:
//
//   E1  #3627 × #3747 composition failure (money train held at step 1,
//       main untouched at e49e9c812; ledger + ~/memory/2026-10-16.md):
//       #3747's pilot-cap test completed never-delivered claims while
//       #3627's delivered→verified guard refused them (422
//       work_not_delivered), AND #3627's reclassification of a non-owner
//       verify as a review action left the event-budget floor refusing
//       it — a delivered, approved claim was unverifiable at the cap.
//   E2  Wave-2 #3716: a clean textual auto-merge silently dropped the
//       two `optional.push` front-door registrations in
//       scripts/runtime-package.mjs (landing ledger 2026-10-17 close:
//       "restored after the import-closure test named them").
//   E3  Wave-2 #3642 × #3776: auto-merge produced a duplicate
//       `verification` declaration in server/receipts-page.mjs (#3642's
//       verdict-block parameter vs #3776's tier const), breaking the
//       tree repo-wide; cured by renaming the tier to verificationTier.
//   E4  Baseline desyncs at composed heads: #3782 merge-up i18n
//       baseline 3290 committed vs 3303 fresh scan; #3746 MCP catalog
//       snapshot stale against the served catalog. Baselines must be
//       regenerated ON the composed tree — this test is that check.
//   E5  #3946 mechanism: cloudflare/job-heartbeat.mjs applyOutcomes
//       never wrote lastSummary on the failure branch, so a failing
//       integrity tick froze the health surface on the last successful
//       tick's summary (production served a pre-#3855 summary with no
//       blockedRooms key for a week). Fix PR #3946.
//   E6  #3945 class: AgentConnections.verifyHistory compared historical
//       facts against CURRENT state (sponsor must equal the room's
//       current owner), so a legitimate ownership transfer made the
//       journal fail integrity forever. The check must be time-scoped:
//       ownerIdsAt resolves ownership at the operation's own sequence.
//       Fix PR #3945.
//
// E5/E6 note: the fix PRs shipped their own integration regression tests
// (tests/job-heartbeat.test.js, tests/integrity-block-health.test.js,
// tests/agent-connections-ownership-transfer.test.js). The fixtures here
// are deliberately smaller, mechanism-level pins (direct applyOutcomes /
// ownerIdsAt units) so the eval set stays fast and each failure names
// the exact mechanism that regressed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { deliveryDigest } from "../server/work-claims.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { allowed } from "../scripts/runtime-package.mjs";
import { renderReceiptDetailHtml } from "../server/receipts-page.mjs";
import { SNAPSHOT_PATH, buildSnapshot, diffSnapshots } from "../scripts/mcp-catalog-snapshot.mjs";
import { applyOutcomes } from "../cloudflare/job-heartbeat.mjs";

// ---------------------------------------------------------------- E1 ----
// Harness mirrors tests/work-claim-verified-routes.test.js (direct route
// handler, in-memory store) — the composed scenario the two PRs never ran
// together: a reviewed claim delivered and approved, a second claim never
// delivered, THEN the room is driven to the pilot event cap.
const SHA = "a".repeat(64);
const bundle = { artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }], criteria: [] };
const auth = (id, kind, permissions) => ({ member: { id, kind, permissions } });
const OWNER = auth("owner", "human", ["manage_claims"]);
const WORKER = auth("worker", "agent", ["accept_work", "complete_work"]);
const REVIEWER = auth("reviewer", "agent", ["verify"]);

test("E1 #3627×#3747: at the pilot cap, verify of a delivered claim lands, never-delivered completion refuses work_not_delivered, growth refuses", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, kind, permissions) => store.command(ownerKey, "commons",
    { id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind, permissions } });
  add("worker", "agent", ["accept_work", "complete_work"]);
  add("reviewer", "agent", ["verify"]);
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: "POST", body }, res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
  });
  const flow = async id => {
    await call("create", null, { id, title: `Task ${id}`, files: [`server/${id}.mjs`], reviewPolicy: "distinct_member" });
    await call("claim", id, { leaseHours: 6 }, { auth: WORKER });
    await call("update", id, { state: "in_progress" }, { auth: WORKER });
  };
  await flow("delivered-one");
  await flow("never-delivered");
  const delivered = (await call("update", "delivered-one", { state: "delivered", delivery: bundle }, { auth: WORKER })).value;
  assert.equal(delivered.delivery.digest, deliveryDigest(bundle));
  await call("review", "delivered-one", { verdict: "approve", summary: "bundle verified" }, { auth: REVIEWER });

  // The guard half (#3627): completing a claim that was never delivered is
  // refused as work_not_delivered — the exact refusal #3747's original cap
  // test collided with when it completed claims in one call.
  await assert.rejects(call("update", "never-delivered", { state: "done", delivery: bundle }, { auth: WORKER }),
    error => error.status === 422 && error.code === "work_not_delivered");
  assert.equal(store.workClaims.get("commons", "never-delivered").state, "in_progress");

  // Drive the room to the pilot event cap (#3747's condition).
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(PILOT_LIMITS.eventsPerRoom);

  // The cap half (#3747): growth still refuses at the cap, and the
  // never-delivered claim still cannot be completed there either (the
  // budget floor refuses the write before the guard is even reached).
  await assert.rejects(call("create", null, { id: "past-cap", title: "Past cap", files: [] }),
    error => error.status === 409);
  const ndAtCap = await call("update", "never-delivered", { state: "done", delivery: bundle }, { auth: WORKER })
    .then(result => result, error => ({ status: error.status, value: { error: { code: error.code } } }));
  assert.ok(ndAtCap.status >= 400, "never-delivered completion must not land at the cap");
  assert.equal(store.workClaims.get("commons", "never-delivered").state, "in_progress");

  // The composition: the non-owner reviewer's verify is a resolving exit,
  // exempt from both the budget floor and the event cap — it must land.
  const done = (await call("update", "delivered-one", { state: "done" }, { auth: REVIEWER })).value;
  assert.equal(done.state, "done");
  assert.equal(done.verification.state, "verified");
  assert.equal(done.verification.by, "reviewer");
});

// ---------------------------------------------------------------- E2 ----
test("E2 #3716: the two front-door optional.push registrations survive in the runtime-package allowlist", () => {
  // Dropped by the Wave-2 auto-merge; without them the packaged runtime
  // 404s the /about live-facts route and script the PR itself added.
  assert.ok(allowed.has("server/routes/front-door.mjs"),
    "server/routes/front-door.mjs registration dropped (cf. #3716 auto-merge)");
  assert.ok(allowed.has("src/front-door.js"),
    "src/front-door.js registration dropped (cf. #3716 auto-merge)");
  // And the consumer that makes the registration load-bearing still imports it.
  const table = readFileSync(fileURLToPath(new URL("../server/routes/table.mjs", import.meta.url)), "utf8");
  assert.match(table, /front-door\.mjs/);
});

// ---------------------------------------------------------------- E3 ----
test("E3 #3642×#3776: receipts page renders BOTH the verdict block and the verification tier (no duplicate-declaration breakage)", () => {
  // Importing the module at all is half the fixture: the duplicate
  // `verification` declaration was a parse-time SyntaxError that broke
  // every consumer of server/receipts-page.mjs repo-wide.
  const receipt = { id: "eval-receipt", title: "Eval receipt", room: { id: "commons" },
    verification: { state: "verified" }, hashes: [] };
  const verification = { verdict: "server-verified", verdictLabel: "Server-verified",
    summary: "Record matches its source.", checkedAt: "2026-10-17T00:00:00.000Z",
    scope: { by: "platform", notChecked: ["Whether the work itself is any good"] },
    checks: [{ id: "record", label: "Stored record", status: "pass", detail: "matches" }] };
  const html = renderReceiptDetailHtml(receipt, { verification });
  assert.match(html, /Member-verified completion/, "#3776 tier label renders");
  assert.match(html, /data-verdict="server-verified"/, "#3642 verdict block renders");
  assert.match(html, /Server-verified/);
});

// ---------------------------------------------------------------- E4 ----
test("E4 baselines: i18n baseline and MCP catalog snapshot match the composed tree", { timeout: 120000 }, () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const i18n = spawnSync(process.execPath, ["scripts/i18n-harness.mjs", "--check"],
    { cwd: root, encoding: "utf8", env: { ...process.env } });
  assert.equal(i18n.status, 0, `i18n baseline desync (regenerate on the composed tree):\n${i18n.stdout}\n${i18n.stderr}`);
  const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const changes = diffSnapshots(expected, buildSnapshot());
  assert.deepEqual(changes, [], `MCP catalog snapshot desync (regenerate on the composed tree):\n${changes.join("\n")}`);
});

// ---------------------------------------------------------------- E5 ----
test("E5 #3946: a failing tick's summary persists as lastSummary; a thrown tick (no summary) keeps the prior one", () => {
  const previous = { integrity: { lastRunAt: 1000, lastSuccessAt: 1000, consecutiveFailures: 114,
    lastSummary: { checked: 2, verified: 0 }, lastSummaryAt: 1000 } };
  const failed = applyOutcomes(previous, [
    { job: "integrity", ok: false, at: 2000, error: "connection_integrity_error", durationMs: 5,
      summary: { checked: 2, verified: 0, blockedRooms: 2 } },
  ]);
  assert.equal(failed.integrity.lastSummary.blockedRooms, 2,
    "the failing tick's own summary must reach the health surface (#3855's count was hidden for a week)");
  assert.equal(failed.integrity.lastSummaryAt, 2000, "the summary is labelled with the tick that produced it");
  assert.equal(failed.integrity.consecutiveFailures, 115);
  assert.equal(failed.integrity.lastSuccessAt, 1000, "a failing tick does not advance the success clock");

  const thrown = applyOutcomes(failed, [
    { job: "integrity", ok: false, at: 3000, error: "boom", durationMs: 1, summary: null },
  ]);
  assert.equal(thrown.integrity.lastSummary.blockedRooms, 2, "a tick that threw carries no summary; the prior one stands");
  assert.equal(thrown.integrity.lastSummaryAt, 2000);
});

// ---------------------------------------------------------------- E6 ----
test("E6 #3945: ownership is resolved at the operation's own sequence, not against the current owner", t => {
  const now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const session = store.createSession(ownerKey);
  const rooms = new AgentRooms(store);
  const keyHash = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex");
  store.agentConnections.apply(session.token, "commons", {
    action: "create", requestId: randomUUID(), memberId: "agent-one", displayName: "Agent One",
    access: "collaborate", keyHash, expiresAt: now + 3600000, expectedOwnerRevision: 0,
  }, session.session.sessionBinding);
  store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "human-two", displayName: "human-two", kind: "human", permissions: ["manage_members"] } });
  store.createAccount("human-two-acct");
  store.bindHumanAccount("commons", "human-two", "human-two-acct");
  rooms.transfer(session.token, "commons", { toMemberId: "human-two" }, session.session.sessionBinding);
  assert.equal(store.room("commons").state.room.ownerId, "human-two");

  const connections = store.agentConnections;
  const transferSeq = store.db.prepare(
    "SELECT sequence FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='ownership.transferred'")
    .get().sequence;
  // Time-scoped resolution: before the transfer the owner was the sponsor;
  // at/after it, the new owner. A never-owner is plausible at NO sequence.
  assert.deepEqual(connections.ownerIdsAt("commons", "human-two", { sequence: transferSeq }), ["owner"]);
  assert.deepEqual(connections.ownerIdsAt("commons", "human-two", { sequence: transferSeq + 1 }), ["human-two"]);
  // The historical journal the sponsor wrote while owner still verifies
  // whole against the transferred room — the #3945 production failure was
  // this verify throwing connection_integrity_error on every tick.
  assert.doesNotThrow(() => connections.verify());
});
