// Regression: the store-level owner gate for sybil-flag resolution must
// compare lane identities in canonical form. member ids are validId-shaped,
// so a room owner whose member id is the legacy colon form (id:agent:jill)
// passes the route gate (raw id compare) and lane validation (colon-form
// fallback in _memberOf) — the store gate must not reject them because it
// compared the raw ownerId against the canonicalized lane.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyEscrowSchema } from "../server/bounty-escrow.mjs";

const ROOM = "room-sybil-canonical";
const OWNER = "id:agent:jill";   // legacy colon form (canonicalizes to id:agent/jill)
const GROK = "id:agent:grokbot";
const CODEX = "id:agent:codex";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

const evidence = { evidenceUrl: "https://example.com/pr/9", evidenceKind: "work.completed",
  summary: "identical work", checksClaimed: ["lint"], producerId: "x" };

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  const transaction = fn => {
    db.exec("SAVEPOINT sybil_canon");
    try { const out = fn(); db.exec("RELEASE sybil_canon"); return out; }
    catch (error) { db.exec("ROLLBACK TO sybil_canon"); db.exec("RELEASE sybil_canon"); throw error; }
  };
  const members = {
    [OWNER]: { active: true, kind: "agent" },
    [GROK]: { active: true, kind: "agent" },
    [CODEX]: { active: true, kind: "agent" },
  };
  const store = { db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: OWNER, members }) };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

function openFlag(escrow) {
  const submitFor = lane => {
    const { bountyId } = escrow.postBounty(ROOM,
      { poster: OWNER, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
    escrow.fundBounty(ROOM, bountyId, { funder: OWNER });
    escrow.claimBounty(ROOM, bountyId, { claimant: lane });
    return escrow.submitWork(ROOM, bountyId, { claimant: lane, evidence });
  };
  tick(1000); submitFor(GROK);
  tick(1000);
  const { flags } = submitFor(CODEX);
  assert.equal(flags.length, 1, "expected one copy-paste flag");
  return flags[0].flagId;
}

test("store owner gate: colon-form room owner may resolve a sybil flag", () => {
  const escrow = makeEscrow();
  const flagId = openFlag(escrow);
  const resolved = escrow.resolveSybilFlag(ROOM, flagId,
    { resolution: "dismissed", reason: "honest coincidence", resolver: OWNER });
  assert.equal(resolved.status, "dismissed");
  assert.equal(resolved.resolvedBy, "id:agent/jill");
});

test("store owner gate: colon-form non-owner is still denied", () => {
  const escrow = makeEscrow();
  const flagId = openFlag(escrow);
  assert.throws(() => escrow.resolveSybilFlag(ROOM, flagId,
      { resolution: "dismissed", reason: "nope", resolver: GROK }),
    error => error.code === "not_authorized" && /only the room owner/.test(error.message));
  assert.equal(escrow.getSybilFlags(ROOM, { status: "open" }).length, 1, "flag stays open");
});

// #1061 (dc66c2a24): rejectWork validates reasons up to 500 chars and the
// settlement record keeps the raw reason — the old "verification rejected
// by <lane>: " prefix overflowed _recordSettlement's own 1..500 check and
// threw invalid_input on valid max-length reasons. Guard the boundary.
test("rejectWork: a max-length 500-char reason settles with the reason intact", () => {
  const escrow = makeEscrow();
  const { bountyId } = escrow.postBounty(ROOM,
    { poster: OWNER, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bountyId, { funder: OWNER });
  escrow.claimBounty(ROOM, bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bountyId, { claimant: GROK, evidence });
  const reason = "r".repeat(500);
  const { settlement } = escrow.rejectWork(ROOM, bountyId, { rejector: OWNER, reason });
  assert.equal(settlement.kind, "failed");
  assert.equal(settlement.reason, reason, "the full 500-char reason is stored in the settlement record");
});
