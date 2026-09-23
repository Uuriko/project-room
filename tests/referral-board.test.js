// Referral board view model: newest-first rows, plain leaderboard ranking,
// the caller's own rows, and HTML-escaped display names.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { referralBoardModel, escapeHtml, formatReferralWhen } from "../src/referral-board.js";

const sample = {
  roomId: "commons",
  referrals: [
    { referrerMemberId: "m1", referrerDisplayName: "Alice", refereeMemberId: "m2", refereeDisplayName: "Bob", completedAt: 2000, via: "invite" },
    { referrerMemberId: "m1", referrerDisplayName: "Alice", refereeMemberId: "m3", refereeDisplayName: "Cara", completedAt: 1000, via: "request" },
  ],
  leaderboard: [
    { memberId: "m1", displayName: "Alice", referralCount: 2 },
  ],
  myReferralCount: 2,
  myReferrals: [
    { referrerMemberId: "m1", referrerDisplayName: "Alice", refereeMemberId: "m2", refereeDisplayName: "Bob", completedAt: 2000, via: "invite" },
    { referrerMemberId: "m1", referrerDisplayName: "Alice", refereeMemberId: "m3", refereeDisplayName: "Cara", completedAt: 1000, via: "request" },
  ],
};

test("board model keeps the server's newest-first order and ranks the leaderboard", () => {
  const model = referralBoardModel(sample);
  assert.equal(model.count, 2);
  assert.deepEqual(model.recent.map(r => r.to), ["Bob", "Cara"]);
  assert.deepEqual(model.leaderboard, [{ rank: 1, name: "Alice", count: 2 }]);
  assert.deepEqual(model.myItems.map(r => r.referee), ["Bob", "Cara"]);
});

test("board model tolerates missing data", () => {
  const model = referralBoardModel(null);
  assert.deepEqual(model, { count: 0, myItems: [], leaderboard: [], recent: [] });
});

test("display names are HTML-escaped", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml("A & B \"quoted\""), "A &amp; B &quot;quoted&quot;");
});

test("referral timestamps format, garbage does not", () => {
  assert.match(formatReferralWhen(Date.UTC(2026, 8, 23)), /Sep/);
  assert.equal(formatReferralWhen("not-a-date"), "");
});

test("join page carries the inviter line for the consent screen", () => {
  const html = readFileSync(new URL("../join.html", import.meta.url), "utf8");
  assert.match(html, /id="join-inviter"/, "join.html has the inviter element");
});
