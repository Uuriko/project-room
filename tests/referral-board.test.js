// Referral board view model: newest-first rows, plain leaderboard ranking,
// the caller's own rows, and HTML-escaped display names.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { referralBoardModel, escapeHtml, formatReferralWhen, myReferralRowHtml, leaderboardRowHtml, recentReferralRowHtml, installReferralBoard } from "../src/referral-board.js";

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

// BU-08 board-UI polish: the referral board reuses the room's standard
// sidebar list classes so it reads as one surface with the rest of the
// sidebar instead of browser-default bullets, numbers, and spacing.

test("my-referral rows use the room's standard row and actor classes", () => {
  const html = myReferralRowHtml({ referee: "Bob", when: "Sep 23" });
  assert.match(html, /<li class="rb-event">/, "row carries the standard row class");
  assert.match(html, /<span class="rb-actor">Bob<\/span>/, "name carries the actor class");
  assert.match(html, /joined Sep 23/);
});

test("my-referral row names are HTML-escaped", () => {
  const html = myReferralRowHtml({ referee: "<script>alert(1)</script>", when: "" });
  assert.ok(!html.includes("<script>"), "raw markup is not emitted");
  assert.match(html, /&lt;script&gt;/);
});

test("leaderboard rows use tabular rank styling, not the unstyled rank span", () => {
  const html = leaderboardRowHtml({ rank: 1, name: "Alice", count: 2 });
  assert.match(html, /<li class="rb-event">/, "row carries the standard row class");
  assert.match(html, /<span class="rb-seq">1\.<\/span>/, "rank uses the tabular-nums sequence class");
  assert.ok(!html.includes("referral-rank"), "the old unstyled rank class is gone");
  assert.match(html, /<span class="rb-actor">Alice<\/span>/);
  assert.match(html, /2 referrals/);
});

test("leaderboard singular referral count reads naturally", () => {
  assert.match(leaderboardRowHtml({ rank: 2, name: "Cara", count: 1 }), /1 referral<\/span>/);
});

test("recent-join rows use the room's standard row and actor classes", () => {
  const html = recentReferralRowHtml({ from: "Alice", to: "Bob", when: "Sep 23" });
  assert.match(html, /<li class="rb-event">/, "row carries the standard row class");
  assert.match(html, /<span class="rb-actor">Alice<\/span>/);
  assert.match(html, /<span class="rb-actor">Bob<\/span>/);
  assert.match(html, /aria-hidden="true">→</, "the join arrow stays decorative");
});

test("recent-join display names are HTML-escaped", () => {
  const html = recentReferralRowHtml({ from: "A & B", to: "<b>", when: "" });
  assert.match(html, /A &amp; B/);
  assert.ok(!html.includes("<b>"), "raw markup is not emitted");
});

test("render applies the room's standard list class to every referral list", () => {
  // Minimal document double: only the surfaces installReferralBoard touches.
  const lists = {};
  const fakeList = id => ({
    id,
    added: [],
    classList: { add(...names) { lists[id].added.push(...names); } },
    set innerHTML(value) { this.html = value; },
    hidden: true,
  });
  const fakeEl = id => ({ id, hidden: false, textContent: "", addEventListener() {} });
  const saved = globalThis.document;
  globalThis.document = {
    querySelector(selector) {
      if (selector === "#referral-my-items" || selector === "#referral-leaderboard" || selector === "#referral-recent") {
        return lists[selector] ??= fakeList(selector);
      }
      if (selector === "#referral-progress") return null;
      return fakeEl(selector);
    },
  };
  try {
    const { reset } = installReferralBoard({ client: {}, getState: () => ({}), getSession: () => null });
    reset(); // reset() re-renders, which must style the lists
    for (const selector of ["#referral-my-items", "#referral-leaderboard", "#referral-recent"]) {
      assert.deepEqual(lists[selector].added, ["rb-list"], `${selector} drops browser-default list styling`);
    }
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
});
