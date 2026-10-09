// PRODUCT-200 RELIABILITY worker A6/50 — invariant scenarios for agent invite
// redeem atomicity (server/agent-invites.mjs redeem()).
//
// Invariants pinned here:
//   "FAILED ACTIONS PRESERVE DATA" — a redeem that fails midway must leave
//   the invite redeemable and write nothing partial.
//   "RETRY MUST NOT DUPLICATE WORK" — redeem consumes the invite exactly
//   once, grants the membership exactly once, and a retry never double-
//   grants and never leaks an error (idempotent 201 with duplicate:true
//   when the redeemer presents their identity credential; a clean 409
//   invite_already_used otherwise).
//
// redeem() runs the whole join (identity mint, member.added event, room
// projection write, identity link, compare-and-swap burn, referral journal,
// onboarding MCP token) inside one store.transaction — any throw rolls
// everything back. The CAS burn
// (UPDATE ... WHERE redeemed_at IS NULL) makes exactly one concurrent
// redemption win.
//
// KNOWN GAP (QA-200 failseq G1, owner-flagged — not fixed by this change):
// a redeemer who minted a FRESH identity and loses the redeem response has
// no credential to present on retry, so they get the clean 409 below while
// their membership sits committed server-side with no client recovery path.
// This suite pins the no-double-grant / no-error-leak half of that story;
// the recovery half (Idempotency-Key replay of the redeem receipt, or an
// owner-assisted recovery) is a product-design decision for the owner.

import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";

// Same hash redeem() uses for the lookup, so the suite can read the burn row.
const slowHash = code =>
  scryptSync(code, "project-room-agent-invite-v2", 32, { N: 16384, r: 8, p: 1 }).toString("hex");

const mintInvite = f => f.store.invites.create(f.keys.owner, "commons", { permissions: ["accept_work"] }).code;

const inviteRow = (f, code) =>
  f.store.db.prepare("SELECT redeemed_at, redeemed_identity_id FROM agent_invite_codes WHERE code_hash=?").get(slowHash(code));

// Observable write surface of a redeem: everything that must roll back together.
const snapshot = f => ({
  events: f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id='commons'").get().n,
  links: f.store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id='commons'").get().n,
  identities: f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n,
  referrals: f.store.db.prepare("SELECT COUNT(*) AS n FROM referrals").get().n,
});

const linksFor = (f, identityId) =>
  f.store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id='commons' AND identity_id=?").get(identityId).n;

invariantSuite([
  invariant("invite-redeem-failed-join-rolls-back", "a redeem that fails at the last in-transaction step leaves the invite redeemable and writes nothing")
    .given((f, ctx) => {
      ctx.code = mintInvite(f);
      ctx.before = snapshot(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      // Sabotage the LAST write inside redeem's transaction: the onboarding
      // MCP token is issued after the compare-and-swap burn. If the
      // transaction were not atomic, the burn would survive the failure and
      // the invite would be consumed by a failed redeem.
      const plugin = f.store.agentPlugin;
      const original = plugin.issueOnboardingMcpToken;
      plugin.issueOnboardingMcpToken = () => { throw new Error("simulated onboarding-token outage"); };
      try {
        ctx.first = f.store.invites.redeem(ctx.code, { displayName: "Late Failure Bot" });
      } catch (err) {
        ctx.failedError = err;
      } finally {
        plugin.issueOnboardingMcpToken = original;
      }
      ctx.midRow = inviteRow(f, ctx.code);
      ctx.midSnap = snapshot(f);
      // The invite is still live: a clean retry completes the join.
      ctx.retry = f.store.invites.redeem(ctx.code, { displayName: "Late Failure Bot" });
      return ctx;
    })
    .then((f, ctx) => {
      assert.ok(ctx.failedError instanceof Error, "the sabotaged redeem must fail, not claim success");
      assert.equal(ctx.midRow.redeemed_at, null, "the burn must roll back when a late step fails");
      assert.equal(ctx.midRow.redeemed_identity_id, null);
      assert.deepEqual(ctx.midSnap, ctx.before, "no partial writes may survive a failed redeem");
      assert.ok(ctx.retry?.memberId, "the retry mints the membership");
      assert.ok(ctx.retry?.identityId, "the retry mints the identity");
      assert.equal(ctx.retry.duplicate, undefined, "a fresh redeem is not flagged duplicate");
      const burned = inviteRow(f, ctx.code);
      assert.ok(burned.redeemed_at != null, "the successful retry burns the invite");
      assert.equal(burned.redeemed_identity_id, ctx.retry.identityId, "the burn names the retried identity");
      assert.equal(linksFor(f, ctx.retry.identityId), 1, "exactly one membership link lands");
      // member.added + the referral.completed journal event, one identity, one link, one referral row.
      const after = snapshot(f);
      assert.equal(after.events, ctx.before.events + 2, "member.added + referral journal events land exactly once");
      assert.equal(after.links, ctx.before.links + 1, "exactly one identity link lands");
      assert.equal(after.identities, ctx.before.identities + 1, "exactly one identity lands");
      assert.equal(after.referrals, ctx.before.referrals + 1, "exactly one referral row lands");
    })
    .build(),

  invariant("invite-redeem-validation-failure-burns-nothing", "a pre-write validation failure burns nothing and stays retryable")
    .given((f, ctx) => {
      ctx.code = mintInvite(f);
      ctx.before = snapshot(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      // 81-char displayName is rejected by validation before any row is
      // written. The refusal is captured by the DSL as ctx.error.
      f.store.invites.redeem(ctx.code, { displayName: "x".repeat(81) });
      return ctx;
    })
    .then((f, ctx) => {
      assert.equal(ctx.error?.status, 422, "oversized displayName is refused");
      assert.equal(ctx.error?.code, "invalid_invite_name", "with the documented invalid_invite_name code");
      assert.equal(inviteRow(f, ctx.code).redeemed_at, null, "a validation failure must not burn the invite");
      assert.deepEqual(snapshot(f), ctx.before, "a validation failure writes nothing");
    })
    .build(),

  invariant("invite-redeem-retry-with-secret-idempotent", "a lost-response retry with the redeemer identity credential is idempotent and never double-grants")
    .given((f, ctx) => {
      ctx.secret = f.store.identities.create("Idempotent Agent").secret;
      assert.ok(ctx.secret, "identity create returns the bearer credential");
      ctx.code = mintInvite(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      ctx.first = f.store.invites.redeem(ctx.code, { displayName: "Idempotent Agent", identitySecret: ctx.secret });
      // The response was "lost": retry with the same code and the same credential.
      ctx.retry = f.store.invites.redeem(ctx.code, { displayName: "Idempotent Agent", identitySecret: ctx.secret });
      return ctx;
    })
    .then((f, ctx) => {
      assert.equal(ctx.first.duplicate, false, "the first redeem is not a duplicate");
      assert.equal(ctx.retry.duplicate, true, "the retry is flagged as the duplicate of the original redeem");
      assert.equal(ctx.retry.identityId, ctx.first.identityId, "the retry resolves to the same identity");
      assert.equal(ctx.retry.memberId, ctx.first.memberId, "the retry resolves to the same membership");
      assert.equal(linksFor(f, ctx.first.identityId), 1, "no duplicate membership is created");
      assert.equal(inviteRow(f, ctx.code).redeemed_identity_id, ctx.first.identityId, "the invite names the single winning identity");
    })
    .build(),

  invariant("invite-redeem-retry-without-secret-clean-409", "a retry without the identity credential is a clean 409 and grants nothing twice")
    .given((f, ctx) => {
      ctx.code = mintInvite(f);
      ctx.before = snapshot(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      // Fresh redeem (no credential): the join commits.
      ctx.first = f.store.invites.redeem(ctx.code, { displayName: "Stranded Agent" });
      // The response is lost. The redeemer retries with the code alone.
      try {
        ctx.second = f.store.invites.redeem(ctx.code, { displayName: "Stranded Agent" });
      } catch (err) {
        ctx.retryError = err;
      }
      return ctx;
    })
    .then((f, ctx) => {
      assert.ok(ctx.first?.memberId, "the first redeem commits the membership");
      assert.equal(ctx.retryError?.status, 409, "the credential-less retry is refused");
      assert.equal(ctx.retryError?.code, "invite_already_used", "with the documented invite_already_used code — no error leak");
      assert.equal(linksFor(f, ctx.first.identityId), 1, "the retry grants no second membership");
      assert.equal(inviteRow(f, ctx.code).redeemed_identity_id, ctx.first.identityId, "the invite stays burned by the single winner");
      const after = snapshot(f);
      assert.equal(after.identities, ctx.before.identities + 1, "no duplicate identity is minted by the retry");
      // KNOWN GAP (G1): the committed membership above is unreachable to the
      // redeemer without the lost credential — no recovery path exists yet.
      // This scenario pins the safe half (no double-grant, clean 409); the
      // recovery design belongs to the owner.
    })
    .build(),
]);
