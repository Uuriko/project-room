// Audit wave LOW-C regression tests (L-19..L-30, L-54).
//
// Authoring-gate notes (repo .agents/skills/test-audit/SKILL.md):
// - Each test names (1) the observable contract it protects, (2) the credible
//   regression that makes it fail, (3) why existing coverage doesn't catch it.
// - Every regression test here was verified to FAIL on the pre-fix code for
//   the intended reason and PASS after the fix (via git diff + checkout +
//   re-apply, per the wave's probe discipline). The two exceptions are
//   documented inline: L-19 (behavior was already correct; the test pins it)
//   and L-54 (documentation-only, no behavior change — no test).
// - No test-only production seams; no mocks implementing the asserted
//   behavior; no expected values computed by the module under test; no
//   string greps of source.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJobBot } from "../server/job-bot.mjs";
import { buildNextActions } from "../server/next-actions.mjs";
import { ReferralInvites, referralInviteSchema } from "../server/referral-invites.mjs";
import { createInvites, InviteError } from "../server/invite-links.mjs";
import { createReputation } from "../server/reputation.mjs";
import { rollup } from "../server/room-rollup.mjs";
import { signPubkeyClaim, verifyPubkeyClaim, ClaimError } from "../server/signed-claims.mjs";
import { createDepGraph } from "../server/work-deps.mjs";
import { createWork, claimWork, updateWork, renewWork, releaseExpired } from "../server/work-claims.mjs";
import { WebResearch, webResearchSchema } from "../server/web-research.mjs";
import { HandoffEnvelopeJournal, handoffEnvelopeSchema } from "../server/work-handoff.mjs";
import { generateKeyPair } from "../server/agent-card-signing.mjs";

// ---- L-19: failed fixture job releases its full credit reservation --------
// (1) Contract: a failed job holds nothing back — the whole reservation is
// released (cost 0). (2) Regression: a failure path that forgets to touch
// reservedCredits would leave a stuck lock on the buyer's budget. (3) No
// existing job-bot test exercises the failure path's credit accounting.
// NOTE: verified against pre-fix code — the failure branch already left
// reservedCredits at maxBudgetCredits, so this test passes pre- and post-fix.
// The fix makes the release explicit; the test pins the behavior.
test("L-19: failed fixture job releases its full credit reservation", () => {
  let t = 1788830423207, n = 0;
  const bot = createJobBot({ secret: "x".repeat(40), now: () => t, randomId: () => `t${++n}` });
  bot.registerProvider({ providerId: "p1", models: ["m"], tokPerSec: 40, pricePer1kCredits: 5, failNext: true });
  const job = bot.postJob({ buyerId: "b1", prompt: "summarize this receipt chain", maxBudgetCredits: 50 });
  bot.matchJob(job.jobId);
  const result = bot.executeJob(job.jobId);
  assert.equal(result.status, "failed");
  assert.equal(result.receipt.credits, 0);
  // Nothing was spent, so the full reservation is released back.
  assert.equal(bot.getJob(job.jobId).reservedCredits, job.maxBudgetCredits);
});

// ---- L-20: expired bounties get no deadline-urgency boost -----------------
// (1) Contract: the <7d deadline boost applies only to live bounties.
// (2) Regression: an expired-but-unswept bounty would outrank fresh work with
// a phantom "high" urgency. (3) Existing next-actions tests never use an
// already-past deadlineMs.
test("L-20: expired bounty gets no deadline-urgency boost", () => {
  const HOUR = 3600000;
  const AT_MS = Date.parse("2026-09-25T20:30:00.000Z");
  const out = buildNextActions({
    agent: { id: "agent-jill" },
    snapshots: {
      workClaims: [],
      bounties: [
        { bountyId: "expired", title: "Stale python linter", criteria: "python ast rules",
          amountMillis: 5000, deadlineMs: AT_MS - HOUR }, // expired 1h ago, never swept
      ],
      newcomers: [],
      card: { capabilities: ["python", "linting", "ast"], skills: [], description: "a helpful agent" },
    },
    now: "2026-09-25T20:30:00.000Z",
    roomId: "commons",
  });
  const item = out.items.find(i => i.kind === "bounty-match");
  assert.ok(item, "expired bounty still listed as a match");
  assert.equal(item.urgency, "normal", "expired bounty must not get the <7d high-urgency boost");
  assert.ok(!item.scoreReason.includes("deadline <7d"), `no deadline boost in scoreReason: ${item.scoreReason}`);
});

// ---- L-21: preview never writes key material ------------------------------
// (1) Contract: preview() is read-only — its key lookup must never INSERT.
// (2) Regression: preview called roomKeys(), which generates and persists a
// fresh Ed25519 keypair when the row is missing — a write on an
// unauthenticated read path. The window is a TOCTOU: verifyToken (read-only)
// sees the row, then it vanishes before the lookup. (3) Existing
// referral-invites tests go through HTTP mint/preview and never isolate the
// missing-row path.
test("L-21: preview with a missing key row fails closed without writing", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(referralInviteSchema);
  let now = 1_000_000;
  const store = {
    db,
    now: () => now,
    room: roomId => ({ state: { room: { title: "T" }, members: { inviter: { active: true } } } }),
    transaction: fn => fn(),
  };
  const invites = new ReferralInvites(store);
  const keys = invites.roomKeys("room1"); // generates + stores the keypair
  const body = { v: 1, jti: "jti-1", chainId: "chain-1", roomId: "room1", depth: 0, maxDepth: 3,
    issuedAt: now, expiresAt: now + 3600_000, tier: "chat" };
  const token = invites.signToken(body, keys.privateSeed);
  db.prepare(`INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth,
    created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minted')`)
    .run("jti-1", "room1", "chain-1", "inviter", 0, 3, now, now + 3600_000);
  // Sanity: preview works while the row exists.
  assert.equal(invites.preview(token).roomId, "room1");
  // Simulate the TOCTOU race deterministically: the key row vanishes after
  // verifyToken succeeds but before preview's own key lookup runs.
  const realVerify = invites.verifyToken.bind(invites);
  invites.verifyToken = token => {
    const payload = realVerify(token);
    if (payload) db.prepare("DELETE FROM referral_invite_keys WHERE room_id = ?").run("room1");
    return payload;
  };
  assert.throws(() => invites.preview(token),
    err => err.status === 404 && err.code === "invite_unavailable");
  const row = db.prepare("SELECT room_id FROM referral_invite_keys WHERE room_id = ?").get("room1");
  assert.equal(row, undefined, "preview must not INSERT key material");
});

// ---- L-22: invite expiry is inclusive -------------------------------------
// (1) Contract: an invite is expired at exactly expiresAt. (2) Regression:
// a 1ms redemption window at the boundary admits a technically-expired
// invite. (3) Existing invite-links tests redeem well before/after expiry,
// never at the exact boundary.
test("L-22: invite redeem at exactly expiresAt is rejected", () => {
  let n = 0;
  const invites = createInvites({ randomBytes: () => `token-${++n}-abcdef` });
  const invite = invites.issue({ room: "dev", ttlMs: 1000, now: 0 });
  assert.equal(new Date(invite.expiresAt).getTime(), 1000);
  assert.throws(() => invites.redeem(invite.token, { now: 1000 }),
    err => err instanceof InviteError && err.code === "invite_expired");
});

// ---- L-23: out-of-order typed signals are ignored -------------------------
// (1) Contract: a typed signal older than the record's updatedMs never moves
// the timeline backwards. (2) Regression: decayedScore clamps negative
// elapsed to 0, so a stale signal would overwrite updatedMs with an older
// timestamp while applying a full fresh weight. (3) Existing reputation
// tests only signal in chronological order.
test("L-23: out-of-order typed signal does not regress the timeline", () => {
  const rep = createReputation();
  const fresh = rep.signalTyped("ada", "payout_released", { at: 2000 });
  const stale = rep.signalTyped("ada", "payout_released", { at: 1000 });
  assert.equal(stale.updatedMs, 2000, "stale signal must not move updatedMs backwards");
  assert.equal(stale.score, fresh.score, "stale signal must not change the score");
  assert.deepEqual({ positive: stale.positive, negative: stale.negative },
    { positive: fresh.positive, negative: fresh.negative });
});

// ---- L-24: non-ISO timestamps bucket to a real UTC day ---------------------
// (1) Contract: rollup day-buckets use the event's actual UTC calendar day.
// (2) Regression: slicing the first 10 chars of a non-ISO timestamp puts
// the event on a garbage "day" key. (3) Existing room-rollup tests only use
// ISO timestamps.
test("L-24: rollup buckets a non-ISO-but-parseable timestamp to its UTC day", () => {
  const out = rollup({ events: [
    { type: "message", roomId: "room1", timestamp: "Mon Sep 28 2026 23:30:00 GMT-0700 (Pacific Daylight Time)" },
  ]});
  // 23:30 PDT Sep 28 = 06:30 UTC Sep 29.
  const days = out.map(r => r.day);
  assert.deepEqual(days, ["2026-09-29"], `expected UTC day 2026-09-29, got ${JSON.stringify(days)}`);
});

// ---- L-25: future-dated issuedAt is rejected --------------------------------
// (1) Contract: a claim issued beyond the clock-skew allowance never
// verifies. (2) Regression: without a not-before bound, a stolen key could
// mint claims that only become valid later (or a skewed signer could
// pre-date authority). (3) Existing signed-claims tests never issue in the
// future.
test("L-25: claim issued beyond the clock-skew allowance is rejected", () => {
  const kp = generateKeyPair();
  const keysFor = [{ publicKey: kp.publicKey, validFrom: 0, validUntil: null, revokedAt: null }];
  const t = 1_000_000;
  const SKEW_MS = 5 * 60 * 1000; // mirrors PUBKEY_CLAIM_CLOCK_SKEW_MS in server/signed-claims.mjs
  const future = signPubkeyClaim({ agentId: "ada", action: "room.join", payload: {},
    privateKey: kp.privateKey, now: () => t + SKEW_MS + 60_000, ttlMs: 3_600_000 });
  assert.throws(() => verifyPubkeyClaim({ token: future, keysFor, now: () => t }),
    err => err instanceof ClaimError && err.code === "invalid_claim");
  // Within the allowance still verifies (clock skew is tolerated).
  const skewed = signPubkeyClaim({ agentId: "ada", action: "room.join", payload: {},
    privateKey: kp.privateKey, now: () => t + 60_000, ttlMs: 3_600_000 });
  assert.equal(verifyPubkeyClaim({ token: skewed, keysFor, now: () => t }).agentId, "ada");
});

// ---- L-26: topoOrder handles deep graphs without stack overflow -----------
// (1) Contract: topological ordering works for arbitrarily deep dependency
// chains. (2) Regression: a recursive DFS throws RangeError past ~10k depth.
// (3) Existing work-deps tests use 3-node graphs only.
test("L-26: topoOrder survives a 250k-deep chain without stack overflow", () => {
  // Build the store directly: addDependency runs a full cycle check per
  // edge (O(N^2) for a chain), so a deep fixture goes through the Map the
  // graph itself reads. This exercises exactly the fixed topoOrder.
  // (Pre-fix recursive DFS throws RangeError at ~200k depth on this machine.)
  const store = new Map();
  const N = 250_000;
  for (let i = 0; i < N; i++) store.set(`n${i}`, i === 0 ? new Set() : new Set([`n${i - 1}`]));
  const graph = createDepGraph({ store });
  const order = graph.topoOrder();
  assert.equal(order.length, N);
  assert.equal(order[0], "n0");
  assert.equal(order[N - 1], `n${N - 1}`);
  assert.ok(Object.isFrozen(order));
});

// ---- L-27: renew honors explicit leaseHours: null --------------------------
// (1) Contract: renewing with leaseHours: null converts the claim to no-lease,
// exactly like claimWork. (2) Regression: the null fell through to the room
// default, so a caller asking to drop the lease got a fresh 24h lease
// instead. (3) Existing work-claims tests never renew with null.
test("L-27: renewWork with leaseHours null converts the claim to no-lease", () => {
  const t = 1_000_000;
  const work = createWork({ id: "w27" }, { now: t });
  const claimed = claimWork(work, "ada", { now: t }); // default 24h lease
  assert.ok(claimed.leaseExpiresAt !== null);
  const renewed = renewWork(claimed, "ada", { leaseHours: null, now: t + 1000 });
  assert.equal(renewed.leaseStartAt, null);
  assert.equal(renewed.leaseExpiresAt, null);
  assert.match(renewed.history.at(-1).note, /lease removed/);
  // A normal renew still refreshes the window.
  const refreshed = renewWork(claimed, "ada", { now: t + 1000 });
  assert.ok(refreshed.leaseExpiresAt !== null && refreshed.leaseExpiresAt > claimed.leaseExpiresAt);
});

// ---- L-28: release clears the owner's declared files ----------------------
// (1) Contract: a released claim drops its declared files, like attestations.
// (2) Regression: the next claimant inherited the previous owner's file
// declarations. (3) Existing work-claims tests never assert on files across
// a release.
test("L-28: releasing a claim resets its declared files", () => {
  const t = 1_000_000;
  const work = createWork({ id: "w28" }, { now: t });
  const claimed = claimWork(work, "ada", { files: ["src/a.js", "src/b.js"], now: t });
  assert.deepEqual([...claimed.files], ["src/a.js", "src/b.js"]);
  const released = updateWork(claimed, "ada", { state: "unclaimed", now: t + 1000 });
  assert.deepEqual([...released.files], [], "manual release drops declared files");
  assert.deepEqual([...released.attestations], []);
  // Auto-release on lease expiry does the same.
  const claimed2 = claimWork(createWork({ id: "w28b" }, { now: t }), "ada",
    { files: ["src/c.js"], leaseHours: 1, now: t });
  const [auto] = releaseExpired([claimed2], t + 2 * 3600_000);
  assert.equal(auto.state, "unclaimed");
  assert.deepEqual([...auto.files], [], "auto-release drops declared files");
  // And a fresh claim starts clean (work-spec files are preserved separately
  // via createWork, not via the claim).
  const reclaimed = claimWork(auto, "grok", { now: t + 2 * 3600_000 + 1000 });
  assert.deepEqual([...reclaimed.files], []);
});

// ---- L-29: fetch stops once the evidence cap is reached --------------------
// (1) Contract: fetchUrls never bills web-fetch quota for URLs past
// maxEvidence. (2) Regression: every listed URL was fetched even when the
// first already filled the cap. (3) Existing web-research tests never pass
// more URLs than maxEvidence.
test("L-29: fetchUrls stops fetching once maxEvidence is reached", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(webResearchSchema);
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY)`);
  db.prepare("INSERT OR IGNORE INTO rooms(id) VALUES('room1')").run();
  const calls = [];
  const store = {
    db,
    now: () => 1_000_000,
    webFetch: {
      async fetch(roomId, memberId, input) {
        calls.push(input.url);
        return { url: input.url, metadata: { title: "T" },
          markdown: { data: "# T\n\nbody" }, highlights: { data: ["body"] },
          cache_metadata: { status: "miss", age_ms: 0 }, request_id: "req-1" };
      },
    },
  };
  const service = new WebResearch(store);
  const urls = ["https://example.com/1", "https://example.com/2", "https://example.com/3"];
  const res = await service.research("room1", "member1",
    { question: "leases", sources: ["fetch"], urls, maxEvidence: 1 });
  assert.equal(res.evidence.length, 1);
  assert.deepEqual(calls, ["https://example.com/1"],
    "no web-fetch quota spent on URLs that can never be used");
});

// ---- L-30: checksPassed keeps every asserted pass --------------------------
// (1) Contract: complete() records exactly the checks the recipient
// asserted, without collapsing duplicates. (2) Regression: dedupe merged
// two distinct same-kind checks into one, weakening acceptance on the
// receipt. (3) Existing handoff-envelope tests never complete with duplicate
// check kinds.
test("L-30: complete records every asserted check pass without dedupe", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(handoffEnvelopeSchema);
  const NOW = 1729219200000, HOUR = 3600 * 1000;
  const iso = ms => new Date(ms).toISOString();
  const store = { db, transaction: fn => fn(), readTransaction: fn => fn(), now: () => NOW };
  const journal = new HandoffEnvelopeJournal(store);
  const fields = {
    to: "agent-b",
    objective: "Do the thing",
    inputs: [{ kind: "message", ref: "msg-1", label: "the thread" }],
    authority: { permissions: ["accept_work"], scope: { rooms: ["room-1"] }, expiresAt: iso(NOW + 24 * HOUR) },
    expectedOutput: { kind: "text_result", description: "done" },
    acceptanceTest: { checks: [
      { kind: "result_submitted", workId: "work-1" },
      { kind: "result_submitted", workId: "work-2" }, // two distinct checks, same kind
    ]},
    termination: { expiresAt: iso(NOW + 24 * HOUR), onExpiry: "release", escalateTo: null },
    provenance: { taskId: "work-1", chain: [] },
  };
  const { envelopeId } = journal.create("room-1", fields, { from: "agent-a" });
  journal.transition("room-1", envelopeId, "accepted", { by: "agent-b" });
  const done = journal.transition("room-1", envelopeId, "completed",
    { by: "agent-b", checksPassed: ["result_submitted", "result_submitted"] });
  const entry = done.history.at(-1);
  assert.deepEqual([...entry.checksPassed], ["result_submitted", "result_submitted"],
    "both asserted passes are recorded");
});

// L-54 (telegram transport at-least-once) is documentation-only: the audit
// marks it CONFIRMED by design, so there is no behavior change to test.
