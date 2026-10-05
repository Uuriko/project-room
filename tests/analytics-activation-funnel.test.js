// Authoring gate (test-audit): this test owns the AN-FUNNEL-1 attribution
// contract — signup -> first message -> first reply computed from recorded
// events. No existing coverage (the function is new). Credible regressions:
// counting another member's message as the user's own, counting pre-signup
// rows, counting cross-room or own messages as replies, or mis-attributing
// across accounts. No production seam: activationFunnel is the real boundary
// scripts/an-funnel-1.mjs calls.
import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVATION_FUNNEL_DEFINITIONS, activationFunnel } from "../server/analytics/activation-funnel.mjs";

const MIN = 60000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

function run({ signups, memberships, messages, memberKinds } = {}) {
  return activationFunnel({ signups, memberships, messages, memberKinds });
}

function byAccount(result, accountId) {
  return result.accounts.find(a => a.accountId === accountId);
}

test("full conversion: signup -> own message -> other's reply in the same room", () => {
  const result = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: [
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN },
      { roomId: "r1", authorId: "m2", at: T0 + 12 * MIN }
    ],
    memberKinds: { m2: "human" }
  });
  const row = byAccount(result, "a1");
  assert.equal(row.firstMessageAt, T0 + 5 * MIN);
  assert.equal(row.firstReplyAt, T0 + 12 * MIN);
  assert.equal(row.firstReplyAuthorKind, "human");
  assert.equal(row.minutesToFirstMessage, 5);
  assert.equal(row.minutesToFirstReply, 7);
  assert.equal(result.summary.signups, 1);
  assert.equal(result.summary.messaged, 1);
  assert.equal(result.summary.replied, 1);
  assert.equal(result.summary.messagedRate, 1);
  assert.equal(result.summary.repliedOfMessagedRate, 1);
});

test("signup with no messages converts to nothing", () => {
  const result = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: []
  });
  const row = byAccount(result, "a1");
  assert.equal(row.firstMessageAt, null);
  assert.equal(row.firstReplyAt, null);
  assert.equal(row.minutesToFirstMessage, null);
  assert.equal(result.summary.messaged, 0);
  assert.equal(result.summary.replied, 0);
  assert.equal(result.summary.medianMinutesToFirstMessage, null);
});

test("messaged but never replied", () => {
  const result = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: [
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN },
      { roomId: "r1", authorId: "m1", at: T0 + 60 * MIN }
    ]
  });
  const row = byAccount(result, "a1");
  assert.equal(row.firstMessageAt, T0 + 5 * MIN);
  assert.equal(row.firstReplyAt, null);
  assert.equal(result.summary.messaged, 1);
  assert.equal(result.summary.replied, 0);
  assert.equal(result.summary.repliedOfMessagedRate, 0);
});

test("pre-signup messages are excluded as clock-skew noise", () => {
  const result = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: [
      { roomId: "r1", authorId: "m1", at: T0 - 10 * MIN },
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN }
    ]
  });
  assert.equal(byAccount(result, "a1").firstMessageAt, T0 + 5 * MIN);
});

test("another member's message is never the user's first message", () => {
  const result = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: [
      { roomId: "r1", authorId: "m2", at: T0 + 2 * MIN },
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN }
    ]
  });
  assert.equal(byAccount(result, "a1").firstMessageAt, T0 + 5 * MIN);
});

test("reply must be in the same room and after the first message", () => {
  const result = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [
      { roomId: "r1", memberId: "m1", accountId: "a1" },
      { roomId: "r2", memberId: "m1b", accountId: "a1" }
    ],
    messages: [
      { roomId: "r2", authorId: "m9", at: T0 + 3 * MIN },
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN },
      { roomId: "r2", authorId: "m9", at: T0 + 6 * MIN },
      { roomId: "r1", authorId: "m9", at: T0 + 9 * MIN }
    ]
  });
  const row = byAccount(result, "a1");
  assert.equal(row.firstMessageAt, T0 + 5 * MIN);
  assert.equal(row.firstReplyAt, T0 + 9 * MIN);
});

test("accounts are independent", () => {
  const result = run({
    signups: [{ accountId: "a1", at: T0 }, { accountId: "a2", at: T0 }],
    memberships: [
      { roomId: "r1", memberId: "m1", accountId: "a1" },
      { roomId: "r1", memberId: "m2", accountId: "a2" }
    ],
    messages: [
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN },
      { roomId: "r1", authorId: "m2", at: T0 + 7 * MIN }
    ]
  });
  const a1 = byAccount(result, "a1");
  const a2 = byAccount(result, "a2");
  assert.equal(a1.firstMessageAt, T0 + 5 * MIN);
  assert.equal(a1.firstReplyAt, T0 + 7 * MIN);
  assert.equal(a2.firstMessageAt, T0 + 7 * MIN);
  assert.equal(a2.firstReplyAt, null);
  assert.equal(result.summary.signups, 2);
  assert.equal(result.summary.messagedRate, 1);
  assert.equal(result.summary.repliedRate, 0.5);
});

test("earliest signup wins across duplicate rows; malformed rows are skipped", () => {
  const result = run({
    signups: [
      { accountId: "a1", at: T0 + 100 * MIN },
      { accountId: "a1", at: T0 },
      { accountId: null, at: T0 },
      { accountId: "a2", at: NaN }
    ],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: [{ roomId: "r1", authorId: "m1", at: T0 + 5 * MIN }]
  });
  assert.equal(result.accounts.length, 1);
  assert.equal(byAccount(result, "a1").signupAt, T0);
});

test("reply author kind passes through; unknown when unresolvable", () => {
  const withKind = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: [
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN },
      { roomId: "r1", authorId: "ag1", at: T0 + 8 * MIN }
    ],
    memberKinds: { ag1: "agent" }
  });
  assert.equal(byAccount(withKind, "a1").firstReplyAuthorKind, "agent");

  const withoutKind = run({
    signups: [{ accountId: "a1", at: T0 }],
    memberships: [{ roomId: "r1", memberId: "m1", accountId: "a1" }],
    messages: [
      { roomId: "r1", authorId: "m1", at: T0 + 5 * MIN },
      { roomId: "r1", authorId: "m9", at: T0 + 8 * MIN }
    ]
  });
  assert.equal(byAccount(withoutKind, "a1").firstReplyAuthorKind, "unknown");
});

test("summary medians and p90s across a cohort", () => {
  const result = run({
    signups: [
      { accountId: "a1", at: T0 },
      { accountId: "a2", at: T0 },
      { accountId: "a3", at: T0 }
    ],
    memberships: [
      { roomId: "r1", memberId: "m1", accountId: "a1" },
      { roomId: "r1", memberId: "m2", accountId: "a2" },
      { roomId: "r1", memberId: "m3", accountId: "a3" }
    ],
    messages: [
      { roomId: "r1", authorId: "m1", at: T0 + 10 * MIN },
      { roomId: "r1", authorId: "m9", at: T0 + 20 * MIN },
      { roomId: "r1", authorId: "m2", at: T0 + 30 * MIN },
      { roomId: "r1", authorId: "m9", at: T0 + 60 * MIN },
      { roomId: "r1", authorId: "m3", at: T0 + 50 * MIN }
    ]
  });
  assert.equal(result.summary.medianMinutesToFirstMessage, 30);
  assert.equal(result.summary.p90MinutesToFirstMessage, 50);
  // a1: reply 10 min after first message; a2: m3's message at +50 is the first
  // other-member message after a2's +30 first message -> 20 min; a3: m9 at +60
  // replies to a3's +50 message -> 10 min. Median of [10,20,10] is 10.
  assert.equal(result.summary.medianMinutesToFirstReply, 10);
  assert.equal(result.summary.p90MinutesToFirstReply, 20);
});

test("definitions document the funnel stages", () => {
  assert.match(ACTIVATION_FUNNEL_DEFINITIONS.firstMessage, /member_accounts/);
  assert.match(ACTIVATION_FUNNEL_DEFINITIONS.firstReply, /same room/i);
});
