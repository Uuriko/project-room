// B011: guest agent invite links. Pure manager tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createInvites, InviteError } from "../server/invite-links.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof InviteError && error.code === code);
const deterministic = (() => { let n = 0; return () => `token-${++n}-abcdef`; })();

test("issue and redeem single-use invite", () => {
  const invites = createInvites({ randomBytes: deterministic });
  const invite = invites.issue({ room: "lobby", now: 0 });
  assert.equal(invite.maxUses, 1);
  assert.equal(invite.usedCount, 0);
  assert.equal(new Date(invite.expiresAt).getTime(), 24 * 60 * 60 * 1000);
  const redeemed = invites.redeem(invite.token, { now: 1000 });
  assert.equal(redeemed.usedCount, 1);
  throwsCode(() => invites.redeem(invite.token, { now: 2000 }), "invite_exhausted");
  assert.ok(Object.isFrozen(invite) && Object.isFrozen(redeemed));
});
test("expiry is enforced; multi-use allows up to maxUses", () => {
  const invites = createInvites({ randomBytes: deterministic });
  const short = invites.issue({ room: "dev", ttlMs: 1000, maxUses: 3, now: 0 });
  throwsCode(() => invites.redeem(short.token, { now: 2000 }), "invite_expired");
  const multi = invites.issue({ room: "dev", maxUses: 2, now: 0 });
  invites.redeem(multi.token, { now: 100 });
  invites.redeem(multi.token, { now: 200 });
  throwsCode(() => invites.redeem(multi.token, { now: 300 }), "invite_exhausted");
  invites.revoke(multi.token);
  assert.equal(invites.size(), 1);
});
test("malformed inputs are refused", () => {
  const invites = createInvites({ randomBytes: deterministic });
  throwsCode(() => invites.issue({ room: "" }), "invalid_invite");
  throwsCode(() => invites.issue({ room: "x", maxUses: 0 }), "invalid_invite");
  throwsCode(() => invites.redeem("nope"), "invalid_invite");
});
test("default token generation is cryptographically secure, never Math.random", () => {
  const orig = Math.random;
  Math.random = () => 0.123456789; // constant: old Math.random default would repeat/collide
  try {
    const invites = createInvites();
    const t1 = invites.issue({ room: "lobby", now: 0 }).token;
    const t2 = invites.issue({ room: "lobby", now: 0 }).token;
    assert.match(t1, /^[0-9a-f]{16}$/);
    assert.match(t2, /^[0-9a-f]{16}$/);
    assert.notEqual(t1, t2); // constant Math.random would produce identical tokens (or a collision throw)
  } finally {
    Math.random = orig;
  }
});
