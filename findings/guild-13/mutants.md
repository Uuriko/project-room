# Mutation testing results (wave1000 guild-13, 2026-10-08)

15 mutants, one per slice file. Runner: `findings/guild-13/tools/mutant-run.sh`
(applies mutant → runs affected test file → restores via git checkout →
records verdict). All mutants were restored; `git status -- server/` clean.

## Killed (14)

| Unit | File | Mutant | Test file |
|---|---|---|---|
| M1 | operator-auth.mjs | inverted `timingSafeEqual` in `operatorTokenMatches` | operator-purge.test.js |
| M3 | identity-ratelimit.mjs | `tokens >= 1` → `> 1` | identity-ratelimit.test.js |
| M4 | identity-verification.mjs | inverted `isVerified` | identity-verification.test.js |
| M5 | gmail-import-authority.mjs | inverted connection binding | gmail-sync.test.js |
| M6 | invitation-evidence.mjs | inverted member-kind check | invitation-evidence.test.js |
| M7 | invitation-journal.mjs | inverted checksum check in replay | invitation-journal.test.js |
| M8 | oauth-provider-store.mjs | prune `expires_at <= ?` → `>= ?` | oauth-provider-durable.test.js |
| M9 | oauth-provider.mjs | inverted PKCE `timingSafeEqual` | oauth-provider.test.js |
| M10 | mcp-identity-mint.mjs | accept wrong MCP method | mcp-identity-mint.test.js |
| M11 | github-oauth.mjs | inverted pending-state expiry | github-oauth.test.js |
| M12 | google-oauth.mjs | trust `email_verified !== true` | google-oauth-email.test.js |
| M13 | agent-invites.mjs | inverted redeemed check (double-redeem) | agent-invites.test.js |
| M14 | referral-invites.mjs | accept expired invites | referral-invites.test.js |
| M15 | guest-invites.mjs | inverted `liveInvite` expiry | guest-invite-flow.test.js |

Every security-critical conditional in the slice is pinned by at least one
failing test when inverted. Good coverage.

## Survived (1) — test gap, not a bug

**M2** — `server/identity-secret-hash.mjs`, `configuredIdentityHashKey`:
`trimmed.length < 16` → `<= 16`. `tests/agent-identity-secrets.test.js`
passes either way.

Analysis: the documented contract is "a string shorter than 16 characters is
ignored", so a exactly-16-char `ROOM_IDENTITY_HASH_KEY` is accepted by
design. The mutant moves the boundary by one char and no test pins it.
This is not an exploitable bug in the current code (the deployed behavior is
the documented one), but the boundary is untested: if a future edit moved
the boundary, no test would catch verifiers being keyed differently than the
operator configured (new rows would store the fallback HMAC while the
operator believes their 16-char key is active).

Fail-first regression test to pin the boundary (proposed — not committed to
a product path; add to `tests/agent-identity-secrets.test.js`):

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredIdentityHashKey, identityHashKeys,
  IDENTITY_HASH_KEY_FALLBACK,
} from "../server/identity-secret-hash.mjs";

test("16-char identity hash key is accepted (boundary)", () => {
  assert.equal(configuredIdentityHashKey("0123456789abcdef"), "0123456789abcdef");
  assert.equal(configuredIdentityHashKey("0123456789abcde"), null); // 15 chars
  assert.deepEqual(identityHashKeys({ ROOM_IDENTITY_HASH_KEY: "0123456789abcdef" })[0],
    "0123456789abcdef");
  assert.deepEqual(identityHashKeys({}), [IDENTITY_HASH_KEY_FALLBACK]);
});
```

No BUG CONFIRMED posted for M2 (equivalent/boundary mutant, test-gap only).
