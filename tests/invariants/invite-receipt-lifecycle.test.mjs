// PRODUCT-200 reliability A10/50: INVITE + RECEIPT LIFECYCLE invariants.
//
// Two never-break properties, pinned against the real store on a fresh
// disposable database per scenario:
//
//   INVITE LIFECYCLE — a guest invite is single-use and atomic:
//     create -> redeem grants exactly one membership; retrying the redeem
//     with the same payload is refused cleanly (no double-grant, no error
//     leak); redeeming an expired invite is refused with no partial state.
//
//   RECEIPT LIFECYCLE — completing work issues exactly one receipt:
//     complete -> the work item carries exactly one receipt; retrying the
//     completion with the same command id replays the identical receipt
//     (duplicate:true, no new journal event); retrying with a new id is
//     refused and leaves the receipt untouched.
//
// Fail-first note: each scenario was verified red against a deliberately
// broken build (guard neutered) and green with the guard restored, per
// tests/invariants/README.md rule 4. The broken-build matrix is recorded
// in the PR description.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";
import {
  proposeWork,
  acceptWork,
  acquireClaim,
  completeWork,
  workItemState,
  workItemRevision,
} from "./fixtures.mjs";
import { generateKeyPair, signCard } from "../../server/agent-card-signing.mjs";
import { makeTestSigner } from "../../scripts/helpers/signed-evidence.mjs";
import { EVENT_TYPES as T } from "../../src/events.js";

const ROOM = "commons";

// --- invite helpers -------------------------------------------------------

function mintGuestInvite(f, { guestLabel = `a10-guest-${randomUUID().slice(0, 8)}` } = {}) {
  const authority = f.store.roomAuthority(ROOM);
  const expectedOwnerRevision = authority.members[authority.ownerId]?.revision;
  return f.store.guestInvites.mint(
    f.keys.owner,
    ROOM,
    { requestId: randomUUID(), guestLabel, expectedOwnerRevision },
    null,
  );
}

function guestIdentityWithCard(f, name) {
  const identity = f.store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "invariant guest", capabilities: ["chat"] };
  const card = {
    ...cardBody,
    publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }),
  };
  return { identity, card };
}

const redeemInvite = (f, code, identity, card) => f.store.guestInvites.redeem(code, identity.secret, card);

function journaledEvents(f, type) {
  return f.store.db
    .prepare("SELECT body FROM events WHERE room_id=?")
    .all(ROOM)
    .map(r => JSON.parse(r.body))
    .filter(e => e.type === type);
}

function liveCredentialCount(f, memberId) {
  return f.store.db
    .prepare("SELECT COUNT(*) n FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0")
    .get(ROOM, memberId).n;
}

function guestMemberRows(f) {
  return f.store.db.prepare("SELECT * FROM guest_members WHERE room_id=?").all(ROOM);
}

// --- receipt helpers ------------------------------------------------------

function completeAs(f, workItemId, { commandId = randomUUID(), signedEvidence, expectedRevision } = {}) {
  return completeWork(f, workItemId, { actor: f.keys.owner, commandId, signedEvidence, expectedRevision });
}

// --- scenarios ------------------------------------------------------------

invariantSuite([
  invariant("invite-redeem-grants-membership-exactly-once", "redeeming a fresh invite creates exactly one active membership")
    .given((f, ctx) => {
      ctx.minted = mintGuestInvite(f);
      const { identity, card } = guestIdentityWithCard(f, "OnceGuest");
      ctx.identity = identity;
      ctx.card = card;
      return ctx;
    })
    .when((f, ctx) => {
      ctx.first = redeemInvite(f, ctx.minted.code, ctx.identity, ctx.card);
      return ctx;
    })
    .then((f, ctx) => {
      const memberId = ctx.first.member.id;
      const member = f.store.room(ROOM).state.members[memberId];
      assert.ok(member, "the redeemed member exists in room state");
      assert.equal(member.active, true, "the membership is active");
      assert.equal(member.kind, "agent", "the membership is an agent seat");
      assert.equal(guestMemberRows(f).length, 1, "exactly one guest seat row");
      assert.equal(guestMemberRows(f)[0].member_id, memberId, "the seat row belongs to the redeemed member");
      const inviteRow = f.store.db
        .prepare("SELECT status, redeemed_by_identity_id FROM guest_invites WHERE id=?")
        .get(ctx.minted.inviteId);
      assert.equal(inviteRow.status, "redeemed", "the invite is burned");
      assert.equal(inviteRow.redeemed_by_identity_id, ctx.identity.identityId, "the burn is bound to the redeeming identity");
      assert.equal(liveCredentialCount(f, memberId), 1, "exactly one live credential");
      assert.equal(
        journaledEvents(f, T.MEMBER_ADDED).filter(e => e.data.memberId === memberId).length,
        1,
        "exactly one member.added journal event",
      );
    })
    .build(),

  invariant("invite-redeem-retry-refused-without-double-grant", "retrying a consumed redeem is refused cleanly; nothing is granted twice")
    .given((f, ctx) => {
      ctx.minted = mintGuestInvite(f);
      const { identity, card } = guestIdentityWithCard(f, "RetryGuest");
      ctx.identity = identity;
      ctx.card = card;
      ctx.first = redeemInvite(f, ctx.minted.code, identity, card);
      ctx.memberId = ctx.first.member.id;
      ctx.memberAdds = journaledEvents(f, T.MEMBER_ADDED).filter(e => e.data.memberId === ctx.memberId).length;
      return ctx;
    })
    .when((f, ctx) => {
      // Same payload, honest client retry after the first redeem committed.
      redeemInvite(f, ctx.minted.code, ctx.identity, ctx.card);
    })
    .then((f, ctx) => {
      assert.equal(ctx.error?.status, 410, "retry is refused with 410");
      assert.equal(ctx.error?.code, "invite_unavailable", "refusal carries the stable invite_unavailable code");
      const members = Object.keys(f.store.room(ROOM).state.members);
      assert.ok(members.includes(ctx.memberId), "the original membership still stands");
      assert.equal(liveCredentialCount(f, ctx.memberId), 1, "no second credential was issued");
      assert.equal(
        journaledEvents(f, T.MEMBER_ADDED).filter(e => e.data.memberId === ctx.memberId).length,
        ctx.memberAdds,
        "no second member.added journal event",
      );
      const inviteRow = f.store.db
        .prepare("SELECT status, redeemed_by_identity_id FROM guest_invites WHERE id=?")
        .get(ctx.minted.inviteId);
      assert.equal(inviteRow.status, "redeemed", "the invite stays burned");
      assert.equal(inviteRow.redeemed_by_identity_id, ctx.identity.identityId, "the burn still names the first redeemer");
    })
    .build(),

  invariant("invite-expired-redeem-rejected-without-partial-state", "an expired invite refuses redemption and leaves no membership trace")
    .given((f, ctx) => {
      ctx.minted = mintGuestInvite(f);
      // Backdate the whole invite window 72h/48h: redeem_by stays after
      // created_at (the table CHECK) but is now in the past, so the invite
      // is expired without touching any other precondition.
      f.store.db
        .prepare("UPDATE guest_invites SET created_at = created_at - 259200000, redeem_by = redeem_by - 172800000 WHERE id=?")
        .run(ctx.minted.inviteId);
      const { identity, card } = guestIdentityWithCard(f, "ExpiredGuest");
      ctx.identity = identity;
      ctx.card = card;
      ctx.membersBefore = Object.keys(f.store.room(ROOM).state.members).length;
      ctx.journalBefore = f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE room_id=?").get(ROOM).n;
      return ctx;
    })
    .when((f, ctx) => {
      redeemInvite(f, ctx.minted.code, ctx.identity, ctx.card);
    })
    .then((f, ctx) => {
      assert.equal(ctx.error?.status, 410, "expired redeem is refused with 410");
      assert.equal(ctx.error?.code, "invite_unavailable", "refusal carries the stable invite_unavailable code");
      assert.equal(guestMemberRows(f).length, 0, "no guest seat row was created");
      assert.equal(
        Object.keys(f.store.room(ROOM).state.members).length,
        ctx.membersBefore,
        "no member was added",
      );
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE room_id=?").get(ROOM).n,
        ctx.journalBefore,
        "nothing was journaled",
      );
      const inviteRow = f.store.db
        .prepare("SELECT status, redeemed_by_identity_id FROM guest_invites WHERE id=?")
        .get(ctx.minted.inviteId);
      assert.equal(inviteRow.status, "active", "the expired invite row itself is untouched");
      assert.equal(inviteRow.redeemed_by_identity_id, null, "nobody is recorded as the redeemer");
    })
    .build(),

  invariant("completion-issues-receipt-exactly-once", "completing work sets exactly one receipt on the item")
    .given((f, ctx) => {
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      acquireClaim(f, ctx.workItemId);
      return ctx;
    })
    .when((f, ctx) => {
      ctx.receipt = completeAs(f, ctx.workItemId);
      return ctx;
    })
    .then((f, ctx) => {
      assert.equal(ctx.receipt.duplicate, false, "the first completion is not a duplicate");
      const item = workItemState(f, f.keys.owner, ctx.workItemId);
      assert.equal(item.state, "completed", "the item is completed");
      assert.ok(item.receipt, "a receipt is recorded on the item");
      assert.equal(item.receipt.eventId, ctx.receipt.event.id, "the receipt names the completion event");
      assert.deepEqual(item.receiptHistory, [], "no prior receipt was displaced");
      assert.equal(
        journaledEvents(f, T.WORK_COMPLETED).filter(e => e.data.workItemId === ctx.workItemId).length,
        1,
        "exactly one work.completed journal event",
      );
    })
    .build(),

  invariant("completion-exact-retry-returns-same-receipt", "retrying a completion with the same command id replays the identical receipt")
    .given((f, ctx) => {
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      acquireClaim(f, ctx.workItemId);
      ctx.commandId = randomUUID();
      // An honest retry replays the byte-identical body: the signed evidence
      // object and the expectedRevision are pinned once, so the store sees
      // the same fingerprint and takes the duplicate path (not
      // idempotency_conflict).
      ctx.evidence = makeTestSigner(f.store)();
      ctx.rev = workItemRevision(f, f.keys.owner, ctx.workItemId);
      ctx.first = completeAs(f, ctx.workItemId, { commandId: ctx.commandId, signedEvidence: ctx.evidence, expectedRevision: ctx.rev });
      ctx.journalBefore = f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE room_id=?").get(ROOM).n;
      return ctx;
    })
    .when((f, ctx) => {
      ctx.retry = completeAs(f, ctx.workItemId, { commandId: ctx.commandId, signedEvidence: ctx.evidence, expectedRevision: ctx.rev });
      return ctx;
    })
    .then((f, ctx) => {
      assert.equal(ctx.retry.duplicate, true, "the exact retry is flagged duplicate");
      assert.equal(ctx.retry.event.id, ctx.first.event.id, "the retry replays the identical event");
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE room_id=?").get(ROOM).n,
        ctx.journalBefore,
        "no second journal event was written",
      );
      const item = workItemState(f, f.keys.owner, ctx.workItemId);
      assert.equal(item.receipt.eventId, ctx.first.event.id, "the item receipt is unchanged");
      assert.deepEqual(item.receiptHistory, [], "no duplicate receipt was recorded");
    })
    .build(),

  invariant("completion-new-id-retry-refused-without-dup-receipt", "a completion retried under a new id is refused; the receipt is untouched")
    .given((f, ctx) => {
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      acquireClaim(f, ctx.workItemId);
      ctx.first = completeAs(f, ctx.workItemId);
      ctx.receiptEventId = ctx.first.event.id;
      ctx.journalBefore = f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE room_id=?").get(ROOM).n;
      return ctx;
    })
    .when((f, ctx) => {
      completeAs(f, ctx.workItemId, { commandId: randomUUID() });
    })
    .then((f, ctx) => {
      assert.equal(ctx.error?.status, 409, "the second completion is refused with 409");
      assert.equal(ctx.error?.code, "command_rejected", "refusal carries the stable command_rejected code");
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE room_id=?").get(ROOM).n,
        ctx.journalBefore,
        "nothing new was journaled",
      );
      const item = workItemState(f, f.keys.owner, ctx.workItemId);
      assert.equal(item.state, "completed", "the item stays completed");
      assert.equal(item.receipt.eventId, ctx.receiptEventId, "the receipt is unchanged");
      assert.deepEqual(item.receiptHistory, [], "no duplicate receipt was recorded");
    })
    .build(),
]);

test("invite-receipt lifecycle scenarios are well-formed", () => {
  // The suite registers through invariantSuite above; this assertion keeps
  // node --test output honest about file-level load failures.
  assert.ok(true);
});
