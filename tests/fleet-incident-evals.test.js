// Fleet incident evals — the incidents-as-evals catalogue (W7, data
// programme item W7, 2026-10-18). Executable fixtures for incidents the
// fleet actually had. Each fixture pins the mechanism one incident
// proved broken, at the smallest seam that still fails if the mechanism
// regresses; where a fix shipped its own integration test, the fixture
// is the smaller pin. Passing here does NOT re-qualify the paths a fix's
// own suite covers — these guard the composition seams and production
// behaviours the suites did not, and they are the pre-deploy gate's
// memory of every incident class the fleet has already paid for once.
//
// Fixtures E1–E6 originated in PR #3983 (open and unmerged at catalogue
// time; FLEET-METHODS-2 Part A) and are carried here with bodies
// verbatim; this file supersedes that PR's version wholesale. Later
// fixtures were harvested from the pitfall catalogue
// (agent-craft/pitfall-catalogue-v1.md), the CN-7 guardian census
// (2026-10-18), the backlog census, and findings verified at source in
// the research waves of 2026-10-17/18. Every fixture names its incident
// source; a fixture with no real incident behind it does not belong here.
//
// CLASSES
//   COMP     composition failures: landed changes that broke each other
//            or the tree when composed.
//   TIME     current state wrongly judged against historical facts, and
//            lease/clock semantics that lost or froze work.
//   GUARDIAN jobs and watchers that failed silently, wedged on one
//            poisoned record, or reported health they did not have.
//   MONEY    settlement semantics: bonds, dispute scope, epoch
//            progression and per-bounty isolation.
//   CONSENT  what may be shown publicly, and the gates that hide it.
//   PROOF    the verification surface's own honesty about its limits,
//            and the patrol's detection of real corruption.
//
// CONSUMPTION (the gate): the deploy packet's proof set. Packet assembly
// runs the command below at the candidate head and records the result in
// the packet's verification section; the catalogue is also standing
// proof #5 in the proof-expiry registry, whose staleness trigger is any
// change to this file or tests/incident-evals.manifest.json. The repo's
// ordinary test CI runs this file on every PR. Kill criterion (data
// programme W7): fixtures no gate consumes after 2 waves — stop
// authoring new ones.
//
// Incident map (id — class — incident — the behaviour pinned):
//   E1  COMP #3627 × #3747 composition failure (money train held at
//       step 1; ledger + fleet memory 2026-10-16): #3747's pilot-cap
//       test completed never-delivered claims while #3627's
//       delivered→verified guard refused them (422 work_not_delivered),
//       AND #3627's reclassification of a non-owner verify as a review
//       action left the event-budget floor refusing it — a delivered,
//       approved claim was unverifiable at the cap. Verify of a
//       delivered+approved claim is a resolution, never growth.
//   E2  COMP Wave-2 #3716: a clean textual auto-merge silently dropped
//       the two `optional.push` front-door registrations in
//       scripts/runtime-package.mjs. The tripwire is the allowlist itself.
//   E3  COMP Wave-2 #3642 × #3776: auto-merge produced a duplicate
//       `verification` declaration in server/receipts-page.mjs, breaking
//       the tree repo-wide. Both features must render.
//   E4  COMP baseline desyncs at composed heads: #3782 merge-up i18n
//       baseline 3290 committed vs 3303 fresh scan; #3746 MCP catalog
//       snapshot stale against the served catalog. Baselines must be
//       regenerated ON the composed tree — this test is that check.
//   E5  GUARDIAN #3946 mechanism: cloudflare/job-heartbeat.mjs
//       applyOutcomes never wrote lastSummary on the failure branch, so
//       a failing integrity tick froze the health surface on the last
//       successful tick's summary (production served a pre-#3855 summary
//       with no blockedRooms key for a week). Fix PR #3946.
//   E6  TIME #3945 class: AgentConnections.verifyHistory compared
//       historical facts against CURRENT state (sponsor must equal the
//       room's current owner), so a legitimate ownership transfer made
//       the journal fail integrity forever. The check must be
//       time-scoped: ownerIdsAt resolves ownership at the operation's
//       own sequence. Fix PR #3945.
//   E7  TIME #3987: the current-binding demand survived account deletion
//       and self-left-rejoin — production integrity failed 2026-10-11 →
//       2026-10-18 (126 consecutive failures at census). A binding
//       dissolved by a terminal fact must not fail history.
//   E8  TIME #3987 (guard half): a binding REPOINTED to a different live
//       account is not excused — history still refuses.
//   E9  TIME claim-pr-sync lease cases + #3711/CN-10 family: a valid
//       lapsed lease releases its claim; a poisoned lease row is left
//       untouched and named, never silently released or wedging.
//   E10 GUARDIAN #3988: patrol wedged forever on one room's corrupt
//       projection (1,402 consecutive failed ticks, never one success).
//       A poisoned room parks BY NAME; the tick then succeeds.
//   E11 GUARDIAN #3464/#3465: one malformed stored claim row wedged the
//       production claim-prs sweep from 2026-10-13 (380+ failed ticks).
//       The sweep skips and NAMES invalid rows, per item.
//   E12 GUARDIAN #3334: job failures surfaced as a bare count ("1
//       error(s) in tick") — no job, subcheck, or record class — so a
//       week of integrity failure read as noise. Failures carry typed
//       names: subcheck, code, error class, record class.
//   E13 GUARDIAN #3847/#3855: an un-replayable stored event wedged the
//       messages backfill for every room. The room parks by name in
//       messages_backfill_blocks; healthy rooms still backfill.
//   E14 GUARDIAN CN-7 guardian census §2 (room-backup): the backup's
//       safety is that a torn export throws BEFORE any put, so it can
//       never overwrite the last good backup. The verified writer
//       refuses torn bytes and stores verified bytes exactly once.
//   E15 GUARDIAN CN-7 launch-gate finding: integrity and patrol failed
//       for 6+ days with no alert. The health view must grade a
//       never-succeeded job STALE, never ok.
//   E16 GUARDIAN #3895 / CN-7 §4: no job watched aggregate store growth
//       while the largest room sat at 86% of its escalation line. The
//       breach check names the gauge that crossed.
//   E17 GUARDIAN 2026-10-10 claim-prs incident + 2026-10-17 recurrence:
//       a rate-limited tick that did no work still read "ok". A
//       rate-limited tick reads DEGRADED (github_rate_limited), HTTP 200.
//   E18 MONEY #3307: two specs disagreed on the dispute bond (5% vs
//       25%); production proved it is exactly 25% (a max(1,5%) probe
//       bond was refused 422 in the FS-13 drill). Exactly, not a floor.
//   E19 MONEY #3726 (Option A, decided 2026-10-16): disputes re-decide
//       an acceptance verdict, so they open only on accepted work — and
//       the refusal fires before any challenger bond can lock.
//   E20 MONEY #3275 seam + CN-7 §2: escrow epochs isolate per bounty —
//       one poisoned bounty is recorded failed by name, the rest of the
//       epoch progresses, and conservation holds throughout.
//   E21 MONEY #3693/#3844: closeEpoch once ran only when a human
//       remembered — twice — leaving accepted awards attributed
//       indefinitely. The keeper progresses epochs unaided to paid.
//   E22 CONSENT #3594 (mechanism half): a room's RECORDED
//       public-receipts-off hides even a settled bounty lot. (The
//       decided default — opt-in — is pending fixture P1 below.)
//   E23 PROOF RQ-15 U1 refutation + GREAT-DEBATE money veto V3: public
//       receipts are UNSIGNED and the verifier is the issuing server
//       re-checking its own store. The verification result must say so
//       in its own not-checked scope — the day signing lands, this
//       fixture fails and forces the deliberate update.
//   E24 PROOF patrol controls (proof-expiry registry, standing proof
//       4): the patrol catches real corruption at the event that
//       introduces it — a truncated log files a head_gap finding.
//   E25 GUARDIAN #3988 (production half of E10): once the poisoned room
//       is parked, the patrol JOB records success — lastSuccess advances
//       from null (CN-7 item F3's post-deploy check, as a fixture).
//   E26 GUARDIAN #3847/#3855 (batch half of E13): the deferred
//       integrity batch records the parked room as a named per-record
//       failure and ADVANCES past messages_backfill every tick.
//
// E5/E6 note (from #3983): the fix PRs shipped their own integration
// regression tests (tests/job-heartbeat.test.js,
// tests/integrity-block-health.test.js,
// tests/agent-connections-ownership-transfer.test.js). The fixtures here
// are deliberately smaller, mechanism-level pins so the eval set stays
// fast and each failure names the exact mechanism that regressed.
//
// PENDING FIXTURES (specified, skipped, armed — not counted in the
// catalogue's active total; each unskips when its trigger lands):
//   P1 CONSENT #3594 decision (2026-10-16): settled lots require the
//      owner's recorded opt-IN. Fix chartered to FINISH-BACKLOG.
//   P2 TIME RQ-12 ruling A2+B1 (2026-10-18): a claim renew omitting
//      leaseHours reuses the claim's current window duration.
//      Implementation chartered to FINISH-BACKLOG.
//   Further pending fixtures whose APIs do not exist on main yet are
//   specified in tests/incident-evals.manifest.json only (CN-7 F1
//   escrow-overdue grading; PR #4084 failure naming; PR #3995 sponsor
//   cap; PR #4023 closeEpoch due-filter; PR #4082 wake-poll sentence).
//
// Run everything:  node --test tests/fleet-incident-evals.test.js
// Run one:         node --test --test-name-pattern "E10" tests/fleet-incident-evals.test.js
// Machine index:   tests/incident-evals.manifest.json

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { appendWorkPullRequest, claimHistoryLength, claimWork, createWork, deliveryDigest, renewWork } from "../server/work-claims.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { planAccountDeletion, executeAccountDeletion } from "../server/account-deletion.mjs";
import { classifyIntegrityError, jobByName, storeGrowthBreach } from "../server/jobs.mjs";
import { patrolStatus } from "../server/patrol.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests } from "../server/claim-pr-sync.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { progressEscrowEpochs } from "../server/bounty-epoch-keeper.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
import { createReceiptSigner, generateReceiptKeyPair } from "../server/bounty-receipts.mjs";
import { verifyPublicReceipt } from "../server/receipt-verify.mjs";
import { exportNdjsonText } from "../server/room-export.mjs";
import { writeDailyBackup } from "../cloudflare/room-backup.mjs";
import { jobHealthResponse, jobHealthView, runCronJobs } from "../cloudflare/job-heartbeat.mjs";
import { event as makeEvent, EVENT_TYPES } from "../src/events.js";
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


// ------------------------------------------------------------------
// TIME — current state judged against history; lease/clock semantics.
// ------------------------------------------------------------------

function bindingWorld(t) {
  const now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const session = store.createSession(ownerKey);
  const rooms = new AgentRooms(store);
  const create = () => store.agentConnections.apply(session.token, "commons", {
    action: "create", requestId: randomUUID(), memberId: "agent-one", displayName: "Agent One",
    access: "collaborate",
    keyHash: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"),
    expiresAt: now + 3600000, expectedOwnerRevision: 0
  }, session.session.sessionBinding);
  const addHuman = (memberId, accountId) => {
    store.command(ownerKey, "commons", { id: randomUUID(), type: EVENT_TYPES.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "human", permissions: ["manage_members"] } });
    store.createAccount(accountId);
    store.bindHumanAccount("commons", memberId, accountId);
  };
  const sponsorAccountId = () => store.db.prepare(
    "SELECT sponsor_account_id FROM agent_connections LIMIT 1").get().sponsor_account_id;
  return { store, session, rooms, create, addHuman, sponsorAccountId };
}

test("E7: connection history verifies after the sponsor transfers ownership and deletes their account (#3987)", t => {
  const f = bindingWorld(t);
  f.create();
  f.addHuman("human-two", "human-two-acct");
  f.rooms.transfer(f.session.token, "commons", { toMemberId: "human-two" }, f.session.session.sessionBinding);
  executeAccountDeletion(f.store, planAccountDeletion(f.store, f.sponsorAccountId()).plan);
  // The dissolution is real — the binding row is gone and the account is
  // deactivated — but the journal is retained by policy, and a terminal
  // fact explains the missing binding, so history must still verify.
  // (The pre-#3987 verifier failed this forever: production integrity,
  // 2026-10-11 → 2026-10-18.)
  assert.equal(f.store.db.prepare(
    "SELECT count(*) n FROM member_accounts WHERE member_id='owner'").get().n, 0);
  assert.equal(f.store.db.prepare(
    "SELECT active FROM accounts WHERE id=?").get(f.sponsorAccountId()).active, 0);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("E8: a binding repointed to a different live account is still refused (#3987 guard half)", t => {
  const f = bindingWorld(t);
  f.create();
  f.store.createAccount("other-acct");
  f.store.db.prepare("UPDATE member_accounts SET account_id='other-acct' WHERE member_id='owner'").run();
  // No terminal fact explains a binding that names ANOTHER account —
  // the excuse must never widen into accepting repointed history.
  assert.throws(() => f.store.agentConnections.verify(), { code: "connection_integrity_error" });
});

const SYNC_NOW = Date.UTC(2026, 9, 14, 19, 0, 0);
const SYNC_HOUR = 3600_000;

function claimSyncWorld() {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  return { store: { db, workClaims: registry }, registry };
}

const openFetch = calls => async url => {
  calls.push(String(url));
  return {
    status: 200, ok: true, headers: { get: () => null },
    text: async () => JSON.stringify({ state: "open", merged: false, head: { sha: "a".repeat(40) } })
  };
};

test("E9: a valid lapsed lease releases; a poisoned lease row is left untouched and named (claim-pr-sync)", async () => {
  const { store, registry } = claimSyncWorld();
  const expiredClaim = (id, owner) => claimWork(
    createWork({ id }, { now: SYNC_NOW - 3 * SYNC_HOUR, agentId: owner }),
    owner, { now: SYNC_NOW - 3 * SYNC_HOUR, leaseHours: 1 });
  registry.set("room-a", { ...expiredClaim("poison-lease", "agent-b"), repo: "https://github.com/Uuriko/project-room" });
  registry.set("room-b", expiredClaim("good-lease", "agent-c"));
  const out = await syncClaimPullRequests(store,
    { fetchImpl: openFetch([]), nowMs: SYNC_NOW, token: null, env: {} });
  assert.equal(registry.get("room-b", "good-lease").state, "unclaimed",
    "the valid lapsed lease is released for another worker");
  assert.equal(registry.get("room-a", "poison-lease").state, "claimed",
    "the invalid row is left for operator cleanup, untouched — never silently released");
  assert.ok(out.skippedInvalid >= 1, "the poisoned lease row is reported");
  assert.ok(out.skippedInvalidItems.some(entry => entry.claimId === "poison-lease"));
});

test("P2 (pending): renew omitting leaseHours reuses the claim's current window (RQ-12 A2+B1)",
  { skip: "PENDING: RQ-12 ruled 2026-10-18 (adopt A2+B1), implementation chartered to " +
      "FINISH-BACKLOG. On main today renewWork falls back to the room default (24h) when " +
      "leaseHours is omitted, silently truncating a 72h claim. Unskip when the fix lands." }, () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  let item = createWork({ id: "renew-pin" }, { now, agentId: "agent-a" });
  item = claimWork(item, "agent-a", { now, leaseHours: 72 });
  const renewed = renewWork(item, "agent-a", { now: now + 3600_000 });
  assert.equal(Date.parse(renewed.leaseExpiresAt), now + 3600_000 + 72 * 3600_000,
    "the renewal extends the claim's own 72h window from now, not the room's 24h default");
});


// ------------------------------------------------------------------
// GUARDIAN — silent failure, poisoned-record wedges, health truth.
// ------------------------------------------------------------------

function patrolWorld(t, roomId = "alpha") {
  // In-memory on purpose: the mechanisms pinned here (patrol, backfill,
  // backup export) live entirely in store.db, and an in-memory store
  // keeps the gate runnable in VM write-fault windows that break
  // file-backed SQLite (fleet fault record, 2026-10-18).
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(roomId));
  t.after(() => store.close());
  return store;
}
const patrolHead = (store, roomId = "alpha") =>
  store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
function patrolPost(store, id, body, roomId = "alpha") {
  const key = store.issueAccessKey(roomId, "owner");
  store.command(key, roomId, { id: `cmd-${id}`, type: "message.posted", data: { body, messageId: id } });
}
const poisonProjection = (store, roomId) =>
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run("{corrupt-projection", roomId);

test("E10: patrol parks a corrupt-projection room by name and the tick succeeds (#3988)", t => {
  const store = patrolWorld(t, "aaa-poison");
  patrolPost(store, "m1", "hello", "aaa-poison");
  const head = patrolHead(store, "aaa-poison");
  poisonProjection(store, "aaa-poison");
  // Pre-fix this room re-threw at the same cursor forever: 1,402
  // consecutive failed ticks and not one patrol success in production.
  const first = store.patrolTick();
  assert.equal(first.errors, 1, "a fresh park surfaces once as a named failure");
  assert.equal(first.parked, 1);
  assert.match(first.scanError, /patrol could not process a room \(SyntaxError\)/);
  assert.ok(!first.scanError.includes("aaa-poison"),
    "the public summary names the error class, never the room (#3334)");
  assert.equal(first.failureDetail.code, "patrol_error");
  assert.equal(first.failureDetail.errorClass, "SyntaxError");
  assert.equal(first.failureDetail.recordClass, "room");
  const second = store.patrolTick();
  assert.equal(second.errors, undefined, "a standing park does not re-fail the tick");
  assert.equal(second.parked, 1, "the parked room rides as a count");
  assert.equal(second.checked, 0, "the parked room is not retried while its head is unchanged");
  assert.equal(store.patrolBlocks().length, 1, "the park is durable, recorded once");
  assert.deepEqual(patrolStatus(store).parked,
    [{ roomId: "aaa-poison", sequence: 0, headSeq: head, errorClass: "SyntaxError" }]);
});

test("E25: once parked, the patrol job records success — lastSuccess advances from null (#3988, CN-7 F3)", async t => {
  const store = patrolWorld(t, "aaa-poison");
  patrolPost(store, "m1", "hello", "aaa-poison");
  poisonProjection(store, "aaa-poison");
  const job = jobByName("patrol");
  const tick = async at => runCronJobs(
    { patrol: () => job.run(store, { deadline: Date.now() + 5000 }) },
    { now: () => at, log: () => {} });
  const first = applyOutcomes({}, await tick(1000));
  assert.equal(first.patrol.consecutiveFailures, 1, "the fresh park is the job's one named failure");
  const second = applyOutcomes(first, await tick(2000));
  assert.equal(second.patrol.consecutiveFailures, 0, "the standing park no longer fails the job");
  assert.ok(second.patrol.lastSuccessAt != null,
    "production's patrol lastSuccessAt sat at null for the job's whole life before this fix");
  const entry = jobHealthView(second, 2000).jobs.find(job => job.name === "patrol");
  assert.equal(entry.lastSummary.parked, 1, "the parked room stays visible as a count");
});

test("E11: one malformed claim row is skipped and named; the sweep still polls the good claim (#3464)", async () => {
  const { store, registry } = claimSyncWorld();
  let good = claimWork(
    createWork({ id: "good-claim" }, { now: SYNC_NOW - SYNC_HOUR, agentId: "agent-a" }),
    "agent-a", { now: SYNC_NOW - SYNC_HOUR, leaseHours: null });
  good = appendWorkPullRequest(good, "agent-a", {
    pullRequest: "https://github.com/Uuriko/project-room/pull/2479",
    expectedClaimedAt: good.claimedAt,
    expectedHistoryLength: claimHistoryLength(good),
    now: SYNC_NOW - SYNC_HOUR
  });
  registry.set("aaa-good", good);
  // Written exactly the way the pre-fix backfill wrote it: straight
  // through registry.set(), never through the state machine.
  registry.set("zzz-bad", { ...createWork({ id: "poison-claim" }, { now: SYNC_NOW - SYNC_HOUR, agentId: "agent-b" }),
    repo: "https://github.com/Uuriko/project-room" });
  const calls = [];
  const out = await syncClaimPullRequests(store,
    { fetchImpl: openFetch(calls), nowMs: SYNC_NOW, token: null, env: {} });
  assert.equal(out.checked, 1, "the good room's due claim is still polled");
  assert.ok(calls.length >= 1, "GitHub was actually called");
  assert.equal(out.skippedInvalid, 1);
  assert.equal(out.skippedInvalidItems[0].roomId, "zzz-bad");
  assert.equal(out.skippedInvalidItems[0].claimId, "poison-claim");
  assert.match(out.skippedInvalidItems[0].error, /repo must be 1\.\.200 characters/);
});

test("E12: integrity failures carry typed names — subcheck, code, error class, record class (#3334)", () => {
  // The incident shape: a week of production integrity failure surfaced
  // as a bare "1 error(s) in tick" with nothing to act on.
  const named = classifyIntegrityError(Object.assign(new Error("connection journal mismatch"),
    { integritySubcheck: "agent_connections" }));
  assert.equal(named.subcheck, "agent_connections");
  assert.equal(named.code, "agent_connections_failed");
  assert.equal(named.errorClass, "integrity_mismatch");
  assert.equal(named.recordClass, "journal");
  // A typed operational error carries its own code onto the surface.
  const typed = classifyIntegrityError(Object.assign(new Error("bad link"),
    { code: "link_integrity_error", status: 422 }));
  assert.equal(typed.subcheck, "share_links");
  assert.equal(typed.code, "link_integrity_error");
  // An untyped throw gets a stable derived code — never a bare count.
  const bare = classifyIntegrityError(new Error("boom"));
  assert.equal(bare.subcheck, "unknown");
  assert.equal(bare.code, "integrity_check_failed");
});

function bareStore(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  return store;
}

function backfillWorld(t) {
  const store = bareStore(t);
  const at = offset => new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
  const messageEvent = (roomId, id, data, offset) => makeEvent({
    type: EVENT_TYPES.MESSAGE_POSTED, actorId: "owner", roomId, id,
    idempotencyKey: `${id}-key`, at: at(offset), data });
  // A legacy writer's poison: a stored event whose messageId the current
  // envelope validator rejects, mirrored into the projection.
  store.initialize([
    ...initialRoom("aaa"),
    messageEvent("aaa", "ev-standin", { messageId: "standin", body: "legacy text" }, 10),
    messageEvent("aaa", "ev-tail", { messageId: "tail", body: "after the poison" }, 11)
  ]);
  const row = store.db.prepare("SELECT sequence, body FROM events WHERE id='ev-standin'").get();
  const stored = JSON.parse(row.body);
  stored.data.messageId = "bad id@x";
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(stored));
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("aaa");
  const projection = JSON.parse(roomRow.projection);
  projection.messages.find(message => message.id === "standin").id = "bad id@x";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), "aaa");
  store.initialize([
    ...initialRoom("zzz"),
    messageEvent("zzz", "ev-z1", { messageId: "z1", body: "z first" }, 10),
    messageEvent("zzz", "ev-z2", { messageId: "z2", body: "z second" }, 11)
  ]);
  return { store, poisonSeq: row.sequence };
}

test("E13: an un-replayable room parks by name in the backfill; healthy rooms still backfill (#3847/#3855)", t => {
  const { store, poisonSeq } = backfillWorld(t);
  const first = store.backfillMessages({ limit: 1000 });
  assert.equal(first.done, true);
  assert.deepEqual(first.blocked, [{ roomId: "aaa", sequence: poisonSeq,
    eventId: "ev-standin", error: "Invalid messageId", fresh: true }]);
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE room_id='zzz'").get().n, 2,
    "the healthy room's rows are written despite the poisoned room sorting first");
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE room_id='aaa'").get().n, 0,
    "the poisoned room's chunk rolled back; nothing partial is written");
  const second = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(second.blocked, [{ roomId: "aaa", sequence: poisonSeq,
    eventId: "ev-standin", error: "Invalid messageId", fresh: false }],
    "a standing block is reported as standing, not re-failed as fresh");
});

test("E26: the deferred integrity batch names the parked room per record and advances (#3847/#3855)", async t => {
  const { store } = backfillWorld(t);
  let reported = 0;
  for (let i = 0; i < 12; i += 1) {
    const result = await store.runDeferredIntegrityBatch({});
    if (result.failures.some(f => f.step === "messages_backfill" && f.recordId === "aaa")) reported += 1;
  }
  assert.ok(reported > 0, "the block is reported as a named per-room failure, not an anonymous throw");
  const recorded = store.db.prepare(
    "SELECT record_id AS recordId, code FROM integrity_failures WHERE step='messages_backfill'").all();
  assert.ok(recorded.some(r => r.recordId === "aaa"),
    "the failure is durably recorded against the room, so the cursor can advance past it");
});

test("E14: a torn backup export is refused before any put; verified bytes are stored once (CN-7 §2)", async t => {
  const store = patrolWorld(t, "backup-room");
  patrolPost(store, "m1", "export me", "backup-room");
  const full = exportNdjsonText(store.db);
  // The writer's own definition of torn (room-backup.mjs): the export's
  // watermark and trailer disagree with the event rows between them —
  // here, one event row lost mid-export while the trailer still counts
  // it. A merely truncated body is the replay side's refusal, not this
  // writer's; the fixture pins the writer's tear.
  const fullLines = full.split("\n").filter(line => line.trim());
  const eventIdx = fullLines.findIndex(line => {
    try { return JSON.parse(line)?.table === "events"; } catch { return false; }
  });
  assert.ok(eventIdx > 0, "the export carries event rows to tear");
  const torn = fullLines.filter((_, i) => i !== eventIdx).join("\n") + "\n";
  const puts = [];
  const bucket = {
    head: async () => null,
    put: async (key, bytes, options) => { puts.push({ key, bytes, options }); }
  };
  const env = { ROOM_BACKUPS: bucket };
  await assert.rejects(
    writeDailyBackup(env, { exportRoomNdjson: async () => torn }, new Date()),
    /refusing to store export|refusing manifest/,
    "a torn export throws before anything is stored under the day's key");
  assert.equal(puts.length, 0, "the last good backup is never overwritten by torn bytes");
  const wrote = await writeDailyBackup(env, { exportRoomNdjson: async () => full }, new Date());
  assert.ok(wrote.wrote, "the verified export is stored");
  assert.equal(puts.length, 1, "stored exactly once, after verification");
  assert.match(puts[0].options.customMetadata.sha256, /^[0-9a-f]{64}$/,
    "the stored object carries the sha256 of its exact bytes");
});

test("E15: the health view grades a never-succeeded job stale, never ok (CN-7 launch-gate finding)", () => {
  const now = Date.UTC(2026, 9, 18, 9, 0, 0);
  const view = jobHealthView({}, now);
  const patrol = view.jobs.find(job => job.name === "patrol");
  assert.equal(patrol.lastSuccessAt, null);
  assert.equal(patrol.stale, true,
    "patrol never succeeded in production and read as background noise for a week");
  const fresh = jobHealthView(
    { patrol: { lastRunAt: now - 1000, lastSuccessAt: now - 1000, consecutiveFailures: 0 } }, now);
  assert.equal(fresh.jobs.find(job => job.name === "patrol").stale, false,
    "a job inside its stale window is not cried wolf over");
});

test("E16: the store-growth breach check names the gauge that crossed (#3895)", () => {
  assert.equal(storeGrowthBreach({ maxProjectionBytes: 3_500_001, dbBytes: 0 }), "maxProjectionBytes");
  assert.equal(storeGrowthBreach({ maxProjectionBytes: 0, dbBytes: 8_000_000_001 }), "dbBytes");
  // Production's gauges at the CN-7 census: the largest room's projection
  // sat near its escalation line but under both limits — no breach.
  assert.equal(storeGrowthBreach({ maxProjectionBytes: 3_014_126, dbBytes: 102_624_262 }), null);
});

test("E17: a rate-limited claim-prs tick reads degraded, not ok, and stays HTTP 200 (2026-10-10 incident)", () => {
  const now = Date.UTC(2026, 9, 17, 12, 0, 0);
  const stored = applyOutcomes({}, [{ job: "claim-prs", ok: true, at: now - 10_000,
    summary: { checked: 0, updated: 0, rateLimited: true } }]);
  const view = jobHealthView(stored, now);
  const job = view.jobs.find(entry => entry.name === "claim-prs");
  assert.equal(job.status, "degraded", "a tick that did no work must not read ok");
  assert.equal(job.degraded, "github_rate_limited");
  assert.equal(jobHealthResponse({ ...view, status: "degraded" }).status, 200,
    "degraded is visible, not an outage");
});


// ------------------------------------------------------------------
// MONEY — settlement semantics.
// ------------------------------------------------------------------

const ESCROW_ROOM = "room-test";
const LANE_POSTER = "id:agent/jill";
const LANE_WORKER = "id:agent/grokbot";
const LANE_DECIDER = "id:agent/instinct";
const LANE_CHALLENGER = "id:agent/codex";
const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000;
let escrowNow = 1_786_000_000_000;

function escrowWorld({ signed = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT eval_escrow");
    try { const out = fn(); db.exec("RELEASE eval_escrow"); return out; }
    catch (error) { db.exec("ROLLBACK TO eval_escrow"); db.exec("RELEASE eval_escrow"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const options = { now: () => escrowNow, allowLegacyStringLanes: true };
  if (signed) {
    const keyPair = generateReceiptKeyPair();
    options.receipts = createReceiptSigner({ seedHex: keyPair.seedHex, ref: "test-operator" });
    // The lot read path joins directory tables outside the escrow schema.
    db.exec(`CREATE TABLE IF NOT EXISTS room_directory_settings (
      room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0,
      public_receipts INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS room_public_settings (
      room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS public_unpublish (kind TEXT, target TEXT);
    CREATE TABLE IF NOT EXISTS room_public_receipts_setting (
      room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS public_rooms (slug TEXT PRIMARY KEY, title TEXT);`);
  }
  const escrow = new BountyEscrow(store, options);
  escrow.ensureGenesis(ESCROW_ROOM);
  return { escrow, db, store };
}

const escrowEvidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const escrowAttest = () => ({ at: new Date(escrowNow).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

function postTen(escrow, overrides = {}) {
  return escrow.postBounty(ESCROW_ROOM, { poster: LANE_POSTER, title: "Write the migration guide",
    criteria: "C", amount: 10, deadline: new Date(escrowNow + 3_600_000).toISOString(),
    approvalMode: "human", ...overrides }).bounty;
}
function runToSubmitted(escrow, overrides) {
  const bounty = postTen(escrow, overrides);
  escrow.fundBounty(ESCROW_ROOM, bounty.bountyId, { funder: LANE_POSTER });
  escrow.claimBounty(ESCROW_ROOM, bounty.bountyId, { claimant: LANE_WORKER });
  escrow.submitWork(ESCROW_ROOM, bounty.bountyId, { claimant: LANE_WORKER, evidence: escrowEvidence });
  return escrow.getBounty(ESCROW_ROOM, bounty.bountyId);
}
function runToAccepted(escrow, overrides) {
  const submitted = runToSubmitted(escrow, overrides);
  escrow.acceptWork(ESCROW_ROOM, submitted.bountyId,
    { acceptor: LANE_POSTER, verifierAttestation: escrowAttest() });
  return escrow.getBounty(ESCROW_ROOM, submitted.bountyId);
}
function runToPaid(escrow) {
  const bounty = runToAccepted(escrow);
  escrowNow += CHALLENGE_WINDOW_MS + 1;
  escrow.finalizeBounty(ESCROW_ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ESCROW_ROOM, {});
  return escrow.getBounty(ESCROW_ROOM, bounty.bountyId);
}
const payoutLotId = (db, bountyId) => db.prepare(
  "SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' ORDER BY seq LIMIT 1")
  .get(ESCROW_ROOM, bountyId).lot_id;

test("E18: the dispute bond is exactly 25% — under and over are refused, exact opens (#3307)", () => {
  escrowNow = 1_786_000_000_000;
  const { escrow } = escrowWorld();
  const bounty = runToAccepted(escrow, { disputeDeciderId: LANE_DECIDER });
  // The FS-13 drill's probe: a max(1, 5%) bond was refused live. The 5%
  // figure was the dispute machine's internal floor; the bond itself is
  // exactly 25%, the minimum and the total-dispute-cost cap coinciding.
  for (const bond of [0.5, 2.4, 2.6]) {
    assert.throws(() => escrow.disputeBounty(ESCROW_ROOM, bounty.bountyId,
      { challenger: LANE_CHALLENGER, bond, grounds: "partial credit" }),
      /dispute bond must be exactly 25% of the bounty/,
      `bond ${bond} on a 10-credit bounty must be refused`);
  }
  escrow.disputeBounty(ESCROW_ROOM, bounty.bountyId,
    { challenger: LANE_CHALLENGER, bond: 2.5, grounds: "partial credit" });
  assert.equal(escrow.getBounty(ESCROW_ROOM, bounty.bountyId).state, "disputed");
});

test("E19: a dispute on submitted work is refused before any bond locks (#3726 Option A)", () => {
  escrowNow = 1_786_000_000_000;
  const { escrow } = escrowWorld();
  const bounty = runToSubmitted(escrow, { disputeDeciderId: LANE_DECIDER });
  const before = escrow.balances(ESCROW_ROOM, LANE_CHALLENGER);
  assert.throws(() => escrow.disputeBounty(ESCROW_ROOM, bounty.bountyId,
    { challenger: LANE_CHALLENGER, bond: 2.5, grounds: "junk work" }),
    /disputes open only on accepted work/);
  assert.deepEqual(escrow.balances(ESCROW_ROOM, LANE_CHALLENGER), before,
    "a dispute that cannot open must never lock the challenger's bond");
  assert.equal(escrow.getBounty(ESCROW_ROOM, bounty.bountyId).disputeId, null);
});

test("E20: one poisoned bounty fails alone — the epoch progresses and conservation holds (#3275/CN-7)", () => {
  escrowNow = 1_786_000_000_000;
  const { escrow, store } = escrowWorld();
  const poisoned = runToAccepted(escrow);
  const healthy = runToAccepted(escrow);
  escrowNow += 4 * 24 * 3600 * 1000;
  // The #3275 seam: every journal append for the one bounty throws.
  const original = escrow._append.bind(escrow);
  escrow._append = args => {
    if (args.bountyId === poisoned.bountyId) throw new Error("injected journal append failure");
    return original(args);
  };
  const summary = progressEscrowEpochs(store, { now: escrowNow, escrow });
  assert.equal(summary.failed, 1, "the poisoned bounty is recorded, not swallowed");
  assert.equal(summary.approved, 1, "the healthy bounty still progressed");
  assert.equal(summary.overdue, 1, "the stalled bounty stays countable from the summary");
  assert.equal(escrow.getBounty(ESCROW_ROOM, healthy.bountyId).state, "approved");
  assert.equal(escrow.getBounty(ESCROW_ROOM, poisoned.bountyId).state, "accepted");
  assert.equal(escrow.verifyConservation(ESCROW_ROOM).ok, true);
  escrow._append = original;
});

test("E21: the keeper progresses an accepted award to paid with no human invoking closeEpoch (#3693/#3844)", () => {
  escrowNow = 1_786_000_000_000;
  const { escrow, store } = escrowWorld();
  const workerBefore = escrow.balances(ESCROW_ROOM, LANE_WORKER).payable;
  const bounty = runToAccepted(escrow);
  escrowNow += 4 * 24 * 3600 * 1000;
  progressEscrowEpochs(store, { now: escrowNow, escrow });
  assert.equal(escrow.getBounty(ESCROW_ROOM, bounty.bountyId).state, "approved",
    "the keeper auto-approves at the challenge window's close");
  progressEscrowEpochs(store, { now: escrowNow, escrow });
  assert.equal(escrow.getBounty(ESCROW_ROOM, bounty.bountyId).state, "paid",
    "and settles it in a later epoch — the two stalls of 2026-10-17 cannot recur silently");
  assert.ok(Math.abs(escrow.balances(ESCROW_ROOM, LANE_WORKER).payable - workerBefore - 9.9) < 1e-9,
    "the worker's payable rises by exactly 99% of the 10-credit award (claim bond out and back)");
  assert.equal(escrow.balances(ESCROW_ROOM, LANE_WORKER).reputation.earnedCredits, 9.9,
    "earned credits record the award net of the 1% pool fee");
  assert.equal(escrow.verifyConservation(ESCROW_ROOM).ok, true);
});

// ------------------------------------------------------------------
// CONSENT — what may be shown publicly.
// ------------------------------------------------------------------

test("E22: a recorded public-receipts OFF hides even a settled bounty lot (#3594 mechanism half)", () => {
  escrowNow = 1_786_000_000_000;
  const { escrow, db, store } = escrowWorld({ signed: true });
  const bounty = runToPaid(escrow);
  const lotId = payoutLotId(db, bounty.bountyId);
  assert.ok(publicReceiptById(store, lotId),
    "today the settled lot is served while the room has recorded nothing (see pending P1)");
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 0)").run(ESCROW_ROOM);
  assert.equal(publicReceiptById(store, lotId), null,
    "a recorded off hides the lot — the mechanism the opt-in fix will build the default on");
});

test("P1 (pending): a settled lot is NOT served until the room records a public-receipts opt-in (#3594)",
  { skip: "PENDING: #3594 decision (2026-10-16) — settled lots require the owner's recorded " +
      "opt-in; fix chartered to FINISH-BACKLOG. On main today a never-recorded room's settled " +
      "lot IS served (pinned as current behaviour in E22). Unskip when the fix lands." }, () => {
  escrowNow = 1_786_000_000_000;
  const { escrow, db, store } = escrowWorld({ signed: true });
  const bounty = runToPaid(escrow);
  assert.equal(publicReceiptById(store, payoutLotId(db, bounty.bountyId)), null,
    "no recorded opt-in, no public lot — capture is not publication");
});

// ------------------------------------------------------------------
// PROOF — the verification surface's honesty; the patrol's detection.
// ------------------------------------------------------------------

test("E23: receipt verification states in its own scope that no signature is checked (U1/V3)", async () => {
  escrowNow = 1_786_000_000_000;
  const { escrow, db, store } = escrowWorld({ signed: true });
  const bounty = runToPaid(escrow);
  const receipt = publicReceiptById(store, payoutLotId(db, bounty.bountyId));
  const result = await verifyPublicReceipt(store, receipt,
    { fetchImpl: async () => { throw new Error("fixtures run offline"); } });
  assert.ok(result.checks.length >= 1 && result.checks.every(check => check.status === "pass"),
    "what IS checked — the ledger hash chain — re-verifies clean");
  assert.ok(result.scope.notChecked.some(line => /signature/i.test(line)),
    "public receipts are unsigned and the verifier must keep saying so; " +
    "when signing lands (debate V3), this fixture fails and forces the deliberate update");
});

test("E24: the patrol catches a truncated log at the event that introduces it (patrol controls)", t => {
  const store = patrolWorld(t);
  patrolPost(store, "m1", "hello world");
  patrolPost(store, "m2", "second message");
  patrolPost(store, "m3", "third message");
  patrolPost(store, "m4", "fourth message");
  const head = patrolHead(store);
  store.db.prepare("DELETE FROM commands WHERE room_id='alpha' AND sequence=?").run(head);
  store.db.prepare("DELETE FROM events WHERE room_id='alpha' AND sequence=?").run(head);
  const result = store.patrolTick();
  assert.ok(result.fresh >= 1, "the truncation files a fresh finding on the tick that reaches it");
  const findings = store.patrolFindings();
  assert.ok(findings.some(finding => finding.kind === "head_gap" && finding.room_id === "alpha"),
    "the finding names the room and the gap — the journal carries what the public surface cannot");
});
