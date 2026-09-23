// Agent work exchange slice 10: correlated-cluster (Sybil) detector for
// bounty submissions.
//
// Detection is content-hash comparison — no ML, no external service. A
// normalized SHA-256 fingerprint is pinned on every submission; above-
// threshold correlation raises a sybil flag for the arbiter review queue:
//   - copy-paste: >= SYBIL_COPY_PASTE_MIN_LANES distinct lanes submit the
//     byte-identical normalized fingerprint;
//   - claim-graph: one lane's submissions share submitters/evidence
//     fingerprints with another lane across >= SYBIL_GRAPH_MIN_DISTINCT_BOUNTIES
//     distinct bounties.
// REVIEW-ONLY: flags go to human/arbiter review. They never auto-ban,
// auto-slash, or move bounty state, balances, bonds, or reputation, and
// honest coincidence (same template, same trivial task) is a dismissible
// outcome with a recorded reason. Credits are valueless ledger units:
// no cash-out, no on-chain touch.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BountyEscrow, bountyEscrowSchema, canonicalSubmissionOf, submissionHashOf,
  SYBIL_COPY_PASTE_MIN_LANES, SYBIL_GRAPH_MIN_DISTINCT_BOUNTIES,
  convergeBountyDeployedSchema,
} from "../server/bounty-escrow.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const ROOM = "room-sybil";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const CODEX = "id:agent/codex";     // second worker lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const fund = (escrow, bountyId) => escrow.fundBounty(ROOM, bountyId, { funder: JILL });
const claim = (escrow, bountyId, claimant = GROK) => escrow.claimBounty(ROOM, bountyId, { claimant });
const EVIDENCE_A = { evidenceUrl: "https://example.com/pr/101", evidenceKind: "work.completed",
  summary: "did the thing", checksClaimed: ["lint", "tests"], producerId: "grokbot" };
const EVIDENCE_B = { evidenceUrl: "https://example.com/pr/102", evidenceKind: "work.completed",
  summary: "did the other thing", checksClaimed: ["lint"], producerId: "codex" };
const submit = (escrow, bountyId, claimant, evidence) =>
  escrow.submitWork(ROOM, bountyId, { claimant, evidence });
const flagsFor = escrow => escrow.getSybilFlags(ROOM);
const eventsOf = (db, type) => db.prepare(
  "SELECT * FROM bounty_events WHERE room_id=? AND type=? ORDER BY seq").all(ROOM, type);
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

test("thresholds are exported named constants with the spec values", () => {
  assert.equal(SYBIL_COPY_PASTE_MIN_LANES, 2);
  assert.equal(SYBIL_GRAPH_MIN_DISTINCT_BOUNTIES, 3);
});

test("canonicalization: line endings, whitespace runs and trim normalize; case does not", () => {
  const spaced = { ...EVIDENCE_A, summary: "did   the\tthing  ", checksClaimed: ["tests", "lint"] };
  assert.equal(canonicalSubmissionOf(spaced), canonicalSubmissionOf(EVIDENCE_A));
  assert.equal(submissionHashOf(spaced), submissionHashOf(EVIDENCE_A));
  const crlf = { ...EVIDENCE_A, summary: "did the\r\nthing" };
  const lf = { ...EVIDENCE_A, summary: "did the\nthing" };
  assert.equal(submissionHashOf(crlf), submissionHashOf(lf), "line endings normalize");
  assert.notEqual(submissionHashOf(lf), submissionHashOf(EVIDENCE_A),
    "a line break is not a space: structure is preserved");
  assert.notEqual(submissionHashOf({ ...EVIDENCE_A, summary: "Did The Thing" }),
    submissionHashOf(EVIDENCE_A), "case is meaningful: not lowercased");
});

test("identical submissions by two distinct lanes flag a copy-paste cluster", () => {
  const { escrow, db } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  const first = submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  assert.deepEqual(first.flags, [], "one lane alone is not a cluster");
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, CODEX);
  const before = escrow.balances(ROOM, CODEX); // after the claim bond locked
  const { bounty: submitted, packet, flags } = submit(escrow, b2.bountyId, CODEX, { ...EVIDENCE_A });
  assert.equal(flags.length, 1, `expected one flag, got ${flags.length}`);
  const [flag] = flags;
  assert.match(flag.flagId, /^sybf_/);
  assert.match(flag.clusterId, /^sycl_/);
  assert.equal(flag.signal, "copy-paste");
  assert.equal(flag.status, "open");
  assert.deepEqual([...flag.memberLanes].sort(), [CODEX, GROK].sort());
  assert.equal(flag.memberBounties.length, 2);
  assert.deepEqual(flag.memberBounties.map(m => m.bountyId).sort(), [b1.bountyId, b2.bountyId].sort());
  assert.equal(flag.submissionHash, submissionHashOf(EVIDENCE_A));
  assert.ok(flag.evidencePacket, "the flag carries the evidence packet");
  assert.equal(flag.evidencePacket.packetId, packet.packetId);
  assert.ok(Object.isFrozen(flag));
  // The flag is journaled exactly once.
  const created = eventsOf(db, "sybil.flag-created");
  assert.equal(created.length, 1);
  assert.equal(JSON.parse(created[0].data).flagId, flag.flagId);
  assert.equal(JSON.parse(created[0].data).signal, "copy-paste");
  // REVIEW-ONLY: the submission still sits in review; nothing moved.
  assert.equal(submitted.state, "submitted");
  assert.equal(escrow.getBounty(ROOM, b2.bountyId).state, "submitted");
  const after = escrow.balances(ROOM, CODEX);
  assert.equal(after.payable, before.payable);
  assert.equal(after.locked, before.locked, "the claim bond stays locked — not slashed, not returned");
  assert.deepEqual(after.reputation, before.reputation, "reputation untouched");
  expectConserved(escrow);
});

test("whitespace-tweaked copy-paste still correlates into a cluster", () => {
  const { escrow } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, CODEX);
  const { flags } = submit(escrow, b2.bountyId, CODEX,
    { ...EVIDENCE_A, summary: "did the   thing\r\n" });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].signal, "copy-paste");
  expectConserved(escrow);
});

test("claim-graph: a lane sharing the fingerprint across 3 bounties with another lane flags", () => {
  const { escrow } = makeEscrow();
  const codexBounties = [];
  for (let i = 0; i < 3; i++) {
    const b = post(escrow); fund(escrow, b.bountyId); claim(escrow, b.bountyId, CODEX);
    const { flags } = submit(escrow, b.bountyId, CODEX, { ...EVIDENCE_A });
    assert.deepEqual(flags, [], `codex submission ${i + 1}: one lane, no cluster yet`);
    codexBounties.push(b.bountyId);
  }
  const b4 = post(escrow); fund(escrow, b4.bountyId); claim(escrow, b4.bountyId, GROK);
  const { flags } = submit(escrow, b4.bountyId, GROK, { ...EVIDENCE_A });
  const graph = flags.filter(f => f.signal === "claim-graph");
  assert.equal(graph.length, 1, `expected one claim-graph flag, got ${JSON.stringify(flags.map(f => f.signal))}`);
  const [flag] = graph;
  assert.deepEqual([...flag.memberLanes].sort(), [CODEX, GROK].sort());
  assert.equal(flag.memberBounties.length, 4);
  assert.deepEqual(flag.memberBounties.map(m => m.bountyId).sort(),
    [...codexBounties, b4.bountyId].sort());
  // The two-lane copy-paste threshold fires on the same submission too.
  assert.ok(flags.some(f => f.signal === "copy-paste"), "copy-paste also fires at 2 distinct lanes");
  expectConserved(escrow);
});

test("distinct submissions by distinct lanes raise no flags and no packets", () => {
  const { escrow, db } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, CODEX);
  const { packet, flags } = submit(escrow, b2.bountyId, CODEX, EVIDENCE_B);
  assert.equal(packet, null);
  assert.deepEqual(flags, []);
  assert.deepEqual(flagsFor(escrow), []);
  assert.equal(eventsOf(db, "sybil.flag-created").length, 0);
  expectConserved(escrow);
});

test("one lane repeating identical work is honest coincidence: packet but no sybil flag", () => {
  const { escrow } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, GROK);
  const { packet, flags } = submit(escrow, b2.bountyId, GROK, { ...EVIDENCE_A });
  assert.ok(packet, "the loose duplicate signal still records a review packet");
  assert.deepEqual(flags, [], "a single lane never forms a sybil cluster");
  assert.deepEqual(flagsFor(escrow), []);
  expectConserved(escrow);
});

test("below-threshold claim-graph (2 bounties) raises no flag", () => {
  const { escrow } = makeEscrow();
  for (const lane of [GROK, CODEX]) {
    const b = post(escrow); fund(escrow, b.bountyId); claim(escrow, b.bountyId, lane);
    const { flags } = submit(escrow, b.bountyId, lane, { ...EVIDENCE_A });
    // copy-paste fires at 2 lanes — but claim-graph must not at < 3 bounties.
    assert.ok(!flags.some(f => f.signal === "claim-graph"), "claim-graph needs 3 bounties");
  }
  expectConserved(escrow);
});

test("dismissal records the reason and leaves everything else untouched", () => {
  const { escrow, db } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, CODEX);
  const before = escrow.balances(ROOM, CODEX); // after the claim bond locked
  const { flags } = submit(escrow, b2.bountyId, CODEX, { ...EVIDENCE_A });
  const flagId = flags[0].flagId;
  tick(1000);
  const dismissed = escrow.resolveSybilFlag(ROOM, flagId,
    { resolution: "dismissed", reason: "same template on a trivial task", resolver: JILL });
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.resolutionReason, "same template on a trivial task");
  assert.equal(dismissed.resolvedBy, JILL);
  assert.ok(dismissed.resolvedAt);
  assert.ok(Object.isFrozen(dismissed));
  // The queue reflects it: open is empty, dismissed holds the flag.
  assert.deepEqual(escrow.getSybilFlags(ROOM, { status: "open" }), []);
  const dis = escrow.getSybilFlags(ROOM, { status: "dismissed" });
  assert.equal(dis.length, 1);
  assert.equal(dis[0].flagId, flagId);
  // The resolution is journaled.
  const resolved = eventsOf(db, "sybil.flag-resolved");
  assert.equal(resolved.length, 1);
  const data = JSON.parse(resolved[0].data);
  assert.equal(data.resolution, "dismissed");
  assert.equal(data.reason, "same template on a trivial task");
  // REVIEW-ONLY: resolving moves nothing.
  assert.equal(escrow.getBounty(ROOM, b2.bountyId).state, "submitted");
  const after = escrow.balances(ROOM, CODEX);
  assert.equal(after.payable, before.payable);
  assert.equal(after.locked, before.locked);
  assert.deepEqual(after.reputation, before.reputation);
  expectConserved(escrow);
  // A resolved flag cannot be resolved again; unknown flags and empty
  // reasons are rejected.
  assert.throws(() => escrow.resolveSybilFlag(ROOM, flagId,
    { resolution: "confirmed", reason: "changed my mind", resolver: JILL }), /not open/);
  assert.throws(() => escrow.resolveSybilFlag(ROOM, "sybf_nope",
    { resolution: "dismissed", reason: "x", resolver: JILL }), /unknown sybil flag/);
  assert.throws(() => escrow.resolveSybilFlag(ROOM, flagId,
    { resolution: "dismissed", reason: "   ", resolver: JILL }), /reason is required/);
  assert.throws(() => escrow.resolveSybilFlag(ROOM, flagId,
    { resolution: "maybe", reason: "x", resolver: JILL }), /dismissed.*confirmed/);
});

test("confirmation records the arbiter verdict, still review-only", () => {
  const { escrow, db } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, CODEX);
  const { flags } = submit(escrow, b2.bountyId, CODEX, { ...EVIDENCE_A });
  const confirmed = escrow.resolveSybilFlag(ROOM, flags[0].flagId,
    { resolution: "confirmed", reason: "identical diffs, shared author metadata", resolver: JILL });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.resolutionReason, "identical diffs, shared author metadata");
  // Even a confirmed flag moves nothing by itself — no auto-ban, no
  // auto-slash; follow-up enforcement is a separate human decision.
  assert.equal(escrow.getBounty(ROOM, b2.bountyId).state, "submitted");
  const data = JSON.parse(eventsOf(db, "sybil.flag-resolved")[0].data);
  assert.equal(data.resolution, "confirmed");
  expectConserved(escrow);
});

test("flags are room-scoped", () => {
  const { escrow } = makeEscrow();
  const OTHER = "room-sybil-other";
  escrow.ensureGenesis(OTHER);
  const mk = room => {
    const b = escrow.postBounty(room, { poster: JILL, title: "T", criteria: "C",
      amount: 10, deadline: isoFuture(3_600_000) }).bounty;
    escrow.fundBounty(room, b.bountyId, { funder: JILL });
    escrow.claimBounty(room, b.bountyId, { claimant: GROK });
    return b;
  };
  const submitIn = (room, bountyId, claimant) =>
    escrow.submitWork(room, bountyId, { claimant, evidence: { ...EVIDENCE_A } });
  const o1 = mk(OTHER); submitIn(OTHER, o1.bountyId, GROK);
  const o2 = (() => {
    const b = escrow.postBounty(OTHER, { poster: JILL, title: "T", criteria: "C",
      amount: 10, deadline: isoFuture(3_600_000) }).bounty;
    escrow.fundBounty(OTHER, b.bountyId, { funder: JILL });
    escrow.claimBounty(OTHER, b.bountyId, { claimant: CODEX });
    return b;
  })();
  submitIn(OTHER, o2.bountyId, CODEX);
  assert.equal(escrow.getSybilFlags(OTHER).length, 1, "the other room flags its own cluster");
  assert.deepEqual(flagsFor(escrow), [], "this room is unaffected");
  expectConserved(escrow);
});

test("convergence creates the sybil-flags table on a slice-8-era database", () => {
  const legacySchema = bountyEscrowSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
    .filter(sql => !sql.includes("bounty_review_packets") && !sql.includes("bounty_sybil_flags"))
    .map(sql => sql.replace("    submission_hash TEXT,\n", ""))
    .join(";\n") + ";";
  const db = new DatabaseSync(":memory:");
  db.exec(legacySchema);
  convergeBountyDeployedSchema(db);
  const { escrow } = makeEscrow(db);
  assert.doesNotThrow(() => escrow.verifySchema(), "converged database verifies clean");
  // A fresh cluster flags on the converged schema.
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, CODEX);
  const { flags } = submit(escrow, b2.bountyId, CODEX, { ...EVIDENCE_A });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].signal, "copy-paste");
  assert.equal(escrow.getSybilFlags(ROOM).length, 1);
  assert.doesNotThrow(() => escrow.verifySchema(), "still verifies clean after writes");
  expectConserved(escrow);
});

// --- HTTP: the arbiter queue and resolution routes over the wire -----------

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store);
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["guest", "producer", "reviewer"]) {
      escrow._append({ roomId: HTTPROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable",
        memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
    escrow._append({ roomId: HTTPROOM, accountId: "owner", at, kind: "genesis",
      amount: 1000 * 1000, lotState: "payable",
      memo: "test seeding: 1000 credits (funds two bounties)", actor: { kind: "rule", id: "test" } });
  });
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, keys: fixture.keys };
}

const HTTPROOM = "commons";
const httpPost = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify(body),
});
const httpGet = (origin, path, secret) => fetch(`${origin}${path}`, {
  headers: { authorization: `Bearer ${secret}` },
});
const bountyBody = () => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change with a before/after example.",
  amount: 100,
  deadline: new Date(Date.now() + 86400000).toISOString(),
});
const EVIDENCE_HTTP = { evidenceUrl: "https://example.com/pr/201", evidenceKind: "work.completed",
  summary: "did the thing", checksClaimed: ["lint"] };

test("HTTP: identical submissions flag a cluster; the queue lists and dismisses it", async t => {
  const { origin, keys } = await startServer(t);
  const mkSubmitted = async memberKey => {
    const created = await (await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties`, bountyBody(), keys.owner)).json();
    const bountyId = created.bounty.bountyId;
    await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties/${bountyId}/fund`, {}, keys.owner);
    await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties/${bountyId}/claim`, {}, memberKey);
    const submitted = await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties/${bountyId}/submit`,
      EVIDENCE_HTTP, memberKey);
    assert.equal(submitted.status, 200);
    return bountyId;
  };
  await mkSubmitted(keys.producer);
  await mkSubmitted(keys.reviewer);
  // The arbiter queue lists the open flag.
  const listed = await httpGet(origin, `/api/rooms/${HTTPROOM}/bounties/sybil-flags`, keys.owner);
  assert.equal(listed.status, 200);
  const { flags } = await listed.json();
  assert.equal(flags.length, 1);
  assert.equal(flags[0].signal, "copy-paste");
  assert.equal(flags[0].status, "open");
  const flagId = flags[0].flagId;
  const openOnly = await (await httpGet(
    origin, `/api/rooms/${HTTPROOM}/bounties/sybil-flags?status=open`, keys.owner)).json();
  assert.equal(openOnly.flags.length, 1);
  const badStatus = await httpGet(
    origin, `/api/rooms/${HTTPROOM}/bounties/sybil-flags?status=bogus`, keys.owner);
  assert.equal(badStatus.status, 422);
  // Dismiss with a reason; the queue reflects the resolution.
  const dismissed = await httpPost(origin,
    `/api/rooms/${HTTPROOM}/bounties/sybil-flags/${flagId}/dismiss`,
    { reason: "same template on a trivial task" }, keys.owner);
  assert.equal(dismissed.status, 200);
  const { flag } = await dismissed.json();
  assert.equal(flag.status, "dismissed");
  assert.equal(flag.resolutionReason, "same template on a trivial task");
  const dismissedOnly = await (await httpGet(
    origin, `/api/rooms/${HTTPROOM}/bounties/sybil-flags?status=dismissed`, keys.owner)).json();
  assert.equal(dismissedOnly.flags.length, 1);
  // Resolving again is a 422; an unknown flag is a 404.
  const again = await httpPost(origin,
    `/api/rooms/${HTTPROOM}/bounties/sybil-flags/${flagId}/confirm`,
    { reason: "changed my mind" }, keys.owner);
  assert.equal(again.status, 422);
  const unknown = await httpPost(origin,
    `/api/rooms/${HTTPROOM}/bounties/sybil-flags/sybf_nope/dismiss`,
    { reason: "x" }, keys.owner);
  assert.equal(unknown.status, 404);
  const noReason = await httpPost(origin,
    `/api/rooms/${HTTPROOM}/bounties/sybil-flags/${flagId}/dismiss`, {}, keys.owner);
  assert.equal(noReason.status, 422);
});

// --- Owner-only resolver (project-room#266 decision 5801196661) ------------
// Since #800 a confirmed flag feeds reputation, so confirm/dismiss accept
// only the room owner. Everyone else — including the flagged cluster's own
// lanes and a human member with no special role — gets 403 and the flag
// stays untouched.

test("HTTP: only the room owner can confirm or dismiss a sybil flag", async t => {
  const { origin, keys } = await startServer(t);
  const mkSubmitted = async memberKey => {
    const created = await (await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties`, bountyBody(), keys.owner)).json();
    const bountyId = created.bounty.bountyId;
    await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties/${bountyId}/fund`, {}, keys.owner);
    await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties/${bountyId}/claim`, {}, memberKey);
    const submitted = await httpPost(origin, `/api/rooms/${HTTPROOM}/bounties/${bountyId}/submit`,
      EVIDENCE_HTTP, memberKey);
    assert.equal(submitted.status, 200);
  };
  const openFlags = async () => (await (await httpGet(
    origin, `/api/rooms/${HTTPROOM}/bounties/sybil-flags?status=open`, keys.owner)).json()).flags;
  const resolve = (flagId, verb, key, body = { reason: "attempt" }) =>
    httpPost(origin, `/api/rooms/${HTTPROOM}/bounties/sybil-flags/${flagId}/${verb}`, body, key);

  // producer + reviewer submit identical work -> one copy-paste flag naming both.
  await mkSubmitted(keys.producer);
  await mkSubmitted(keys.reviewer);
  let flags = await openFlags();
  assert.equal(flags.length, 1);
  const flagId = flags[0].flagId;

  // Non-owners: the flagged lanes themselves and an unflagged human guest.
  for (const [who, key] of [["producer (flagged)", keys.producer], ["reviewer (flagged)", keys.reviewer], ["guest", keys.guest]]) {
    for (const verb of ["dismiss", "confirm"]) {
      const res = await resolve(flagId, verb, key);
      assert.equal(res.status, 403, `${who} ${verb} must be 403`);
      assert.equal((await res.json()).error.code, "owner_required", `${who} ${verb} code`);
    }
    // Gate runs before body validation and before the flag lookup.
    assert.equal((await resolve(flagId, "dismiss", key, {})).status, 403, `${who} empty body still 403`);
    assert.equal((await resolve("sybf_nope", "confirm", key)).status, 403, `${who} unknown flag still 403`);
  }
  // An idempotency key replayed by a non-owner never turns into a write.
  const idemBody = { reason: "self-clear", idempotencyKey: "sybil-owner-gate-idem" };
  assert.equal((await resolve(flagId, "dismiss", keys.producer, idemBody)).status, 403);
  assert.equal((await resolve(flagId, "dismiss", keys.producer, idemBody)).status, 403);

  flags = await openFlags();
  assert.equal(flags.length, 1, "flag is still open after every non-owner attempt");
  assert.equal(flags[0].flagId, flagId);

  // The owner succeeds.
  const confirmed = await resolve(flagId, "confirm", keys.owner, { reason: "correlated cluster" });
  assert.equal(confirmed.status, 200);
  const { flag } = await confirmed.json();
  assert.equal(flag.status, "confirmed");
  assert.equal(flag.resolutionReason, "correlated cluster");
  assert.equal((await openFlags()).length, 0);
});
