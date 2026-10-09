# Bugs confirmed (wave1000 guild-13, 2026-10-08)

## BUG-1 (posted to muse-room, read-back confirmed)

**`server/guest-invites.mjs:460` — guest-invite mint deadlocks unverified
owners on mail-unconfigured deployments.**

`GuestInvites.mint` carries the f520ca69 email-verification gate:

```js
if (auth.account) this.store.accountLogins.assertEmailVerified(auth.account.id);
```

with NO `emailVerificationUnachievable` bypass. `AgentInvites.create`
(server/agent-invites.mjs:164) has the same gate WITH the bypass, added
precisely because "a deployment whose mailer is unconfigured can never
verify an account … so blocking invite mint on it would deadlock the
onboarding funnel permanently instead of nudging the owner to verify"
— and it has a dedicated contract test
(tests/agent-invites-mail-unconfigured.test.js).

Repro: an account with an unverified email login method, bound to the
owner member, minting via an account-bound room key on a mail-unconfigured
deployment → **403 `email_unverified`**, permanently (verification can
never complete). Verified empirically against origin/main.

Fail-first regression test:
`findings/guild-13/guest-invites-mail-unconfigured.test.js` — fails on
current code (403 at guest-invites.mjs:460), passes once the bypass is
threaded through (HTTP layer already computes it for agent invites via
`magicMailer.isConfigured()`).

Fix shape (for the owning lane): thread `emailVerificationUnachievable`
through `GuestInvites.mint` exactly like `AgentInvites.create`, i.e.
`if (auth.account && !emailVerificationUnachievable) …`.

Related (out of slice / stale branch, not posted):
- `origin/hardwork-sec/referral-email-gate` adds the same unconditional
  gate to `ReferralInvites.mint` — landing it as-is would open the same
  deadlock on the referral path. See `reverify.md` R5.
- `server/share-links.mjs` mint is outside this guild's slice but carries
  the same gate shape (per the code comment); worth a check by whoever
  owns that slice.

## Non-bugs / notes

- M2 (mutation): 16-char `ROOM_IDENTITY_HASH_KEY` boundary untested —
  test gap only, documented in `mutants.md`. No post.
- R1 review note: bound-invite 403-vs-404 oracle claim in a code comment
  is overstated; no practical risk (codes unguessable). Not posted.
- R2: `upstream/guild-identity-sybil/identity-discipline` bit-rotted
  (slice suite fails after rebase; later rebase conflicts outside the
  slice). Reported in `reverify.md` for the parent to route; not a
  product bug, not posted.
