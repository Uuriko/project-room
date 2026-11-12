// Freeze residual (16a): spend grants into archived rooms.
//
// PR #5502 froze the chartered G8 families at the store layer and named
// spend-grants/spend-pricing as an explicit residual NOT covered by it
// ("Named residuals (G8 families NOT covered by this PR)"); the tranche-2
// G8 cross-cut (LINE-FINDINGS-T2.md, T2-L10a-C6 / T2-L06b-C1) graded the
// family SKIPS: zero `archiv` hits in module + routes. #5502's guard
// provably cannot reach this surface: issueSpendGrant writes the grant
// edge + terms tables directly (no store.command), and authorizeSpend
// writes spend_authorizations / spend_room_reservations directly.
//
// Scope, mirroring #5502's own scope statement:
//  FROZEN — issuing a spend grant (issueSpendGrant, the module choke
//  point every door inherits) and taking a NEW spend authorization
//  (authorizeSpend). Both refuse 409 room_archived, in the freeze's
//  exact message shape.
//  LEFT — revocation (removes authority: the benign direction, as with
//  credential/guest-invite revocation in #5502); settle/void of an
//  authorization reserved before archiving (settlement of an existing
//  obligation, as with bounty transitions in #5502); replay of an
//  already-settled authorization (exactly-once receipt, no new record);
//  reads (spendGrantSummary).
//  ALREADY COVERED, not by this PR — spend-pricing: setSpendPricing
//  writes through store.command, which has refused archived rooms
//  since before #5502 (pinned by the last test below).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema, issueSpendGrant, issueSpendGrantRoute,
  authorizeSpend, settleSpend, revokeSpendGrant, spendGrantSummary,
} from "../server/spend-grants.mjs";
import { setSpendPricing } from "../server/spend-pricing.mjs";

const isArchivedRefusal = error => error?.status === 409 && error?.code === "room_archived";
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-freeze-spend-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  ensureSpendGrantsSchema(store.db);
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "peer", displayName: "Peer agent", kind: "agent", permissions: [] },
  });
  setTier(store.db, "commons", "peer", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const archive = () => store.command(ownerKey, "commons", { id: "archive-room", type: "room.archived", data: { reason: "pilot over" } });
  const issue = () => issueSpendGrantRoute(store, ownerKey, "commons", { agentId: "peer", capCents: "1000", perTxCapCents: "100" });
  return { store, ownerKey, archive, issue };
}

const termsCount = store => store.db.prepare("SELECT count(*) AS n FROM spend_grant_terms WHERE room_id='commons'").get().n;
const authzCount = store => store.db.prepare("SELECT count(*) AS n FROM spend_authorizations WHERE room_id='commons'").get().n;

test("issue: a spend grant cannot be issued into an archived room (route or module) and records nothing", t => {
  const { store, archive, issue } = fixture(t);
  archive();
  const routeError = capture(() => issue());
  assert.ok(isArchivedRefusal(routeError), `route issue must refuse 409 room_archived, got ${routeError?.status}/${routeError?.code}`);
  const moduleError = capture(() => issueSpendGrant(store.db, "commons", "peer", { grantedBy: "owner", capCents: "1000", perTxCapCents: "100" }));
  assert.ok(isArchivedRefusal(moduleError), `module issue must refuse 409 room_archived, got ${moduleError?.status}/${moduleError?.code}`);
  assert.equal(termsCount(store), 0, "no grant terms recorded in the archived room");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_capability_grants WHERE room_id='commons'").get().n, 0, "no grant edge recorded");
});

test("authorize: a new spend authorization cannot be taken in an archived room and records nothing", t => {
  const { store, archive, issue } = fixture(t);
  issue();
  archive();
  const error = capture(() => authorizeSpend(store.db, { roomId: "commons", agentId: "peer", toolName: "room_put_file", priceCents: 5, nonce: "n-after-archive" }));
  assert.ok(isArchivedRefusal(error), `authorize must refuse 409 room_archived, got ${error?.status}/${error?.code}`);
  assert.equal(authzCount(store), 0, "no authorization recorded in the archived room");
});

test("left alone: revoke, settle of a pre-archive reservation, settled replay and reads still work in an archived room", t => {
  const { store, archive, issue } = fixture(t);
  issue();
  const handle = authorizeSpend(store.db, { roomId: "commons", agentId: "peer", toolName: "room_put_file", priceCents: 5, nonce: "n-before-archive" });
  archive();
  assert.equal(settleSpend(store.db, { roomId: "commons", agentId: "peer", nonce: "n-before-archive" }), true,
    "settling an authorization reserved before archiving still lands");
  assert.equal(handle.replayed, undefined);
  const replay = authorizeSpend(store.db, { roomId: "commons", agentId: "peer", toolName: "room_put_file", priceCents: 5, nonce: "n-before-archive" });
  assert.equal(replay.replayed, "settled", "replay of a settled authorization still returns its receipt");
  assert.ok(spendGrantSummary(store.db, "commons", "peer"), "summary still reads in an archived room");
  assert.equal(revokeSpendGrant(store.db, "commons", "peer"), true, "revocation (removing authority) stays open");
});

test("control: issue and authorize still succeed in a live room", t => {
  const { store, issue } = fixture(t);
  issue();
  assert.equal(termsCount(store), 1);
  const handle = authorizeSpend(store.db, { roomId: "commons", agentId: "peer", toolName: "room_put_file", priceCents: 5, nonce: "n-live" });
  assert.equal(handle.priceCents, 5);
  assert.equal(authzCount(store), 1);
});

test("already covered elsewhere: spend-pricing writes refuse in an archived room via store.command (pre-#5502)", t => {
  const { store, ownerKey, archive } = fixture(t);
  archive();
  const error = capture(() => setSpendPricing(store, ownerKey, "commons", { enabled: false }));
  assert.ok(isArchivedRefusal(error), `setSpendPricing must refuse 409 room_archived, got ${error?.status}/${error?.code}`);
});
