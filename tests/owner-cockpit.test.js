// INBOX-MONEY-1 (fig-06 §6, items c+d) — Owner Cockpit client rendering:
// stakes inline in the item's own currency, the board_review + bounty
// kind labels, time-to-consequence, and the spend-POST fix (G7: a POST
// that is not an approve/deny decide template renders as a link, never
// as a button). Pure render helpers only — no DOM, matching the repo's
// UI test idiom.
import test from "node:test";
import assert from "node:assert/strict";
import { cockpitItemHtml, formatCountdown, formatStakes } from "../src/owner-cockpit.js";

const base = {
  id: "item-1", roomId: "room-a", roomName: "Room A", title: "Thing",
  ageMs: 3600 * 1000, consequence: null, consequenceAtMs: null, timeToConsequenceMs: null, actions: [],
};

test("stakes render in the item's own currency field, never converted or mixed", () => {
  const millis = cockpitItemHtml({ ...base, kind: "bounty_review", amountMillis: 4200 });
  assert.ok(millis.includes("4200 milli-credits at stake"), millis);
  assert.ok(!millis.includes("cents at stake"), millis);
  const cents = cockpitItemHtml({ ...base, kind: "verification", amountCents: 2500 });
  assert.ok(cents.includes("2500 cents at stake"), cents);
  assert.ok(!cents.includes("milli-credits"), cents);
  assert.equal(formatStakes({}), "");
  assert.equal(formatStakes({ amountMillis: 0 }), "0 milli-credits at stake");
});

test("the new kinds and board_review carry human labels, not raw kind strings", () => {
  assert.ok(cockpitItemHtml({ ...base, kind: "board_review" }).includes("<strong>Board review</strong>"));
  assert.ok(cockpitItemHtml({ ...base, kind: "bounty_review" }).includes("<strong>Bounty review</strong>"));
  assert.ok(cockpitItemHtml({ ...base, kind: "bounty_challenge" }).includes("<strong>Bounty challenge</strong>"));
});

test("time-to-consequence renders as a deadline; past deadlines say so", () => {
  const soon = cockpitItemHtml({ ...base, kind: "bounty_challenge", amountMillis: 100,
    timeToConsequenceMs: 26 * 3600 * 1000 });
  assert.ok(soon.includes("deadline in 26h"), soon);
  const days = cockpitItemHtml({ ...base, kind: "bounty_challenge", amountMillis: 100,
    timeToConsequenceMs: 50 * 3600 * 1000 });
  assert.ok(days.includes("deadline in 2d 2h"), days);
  const late = cockpitItemHtml({ ...base, kind: "dispute", amountMillis: 100, timeToConsequenceMs: -5 });
  assert.ok(late.includes("deadline passed"), late);
  assert.equal(formatCountdown(null), "");
  assert.equal(formatCountdown(30 * 60000), "deadline in 30m");
});

test("G7: the spend adjust POST renders as a link, never as an Approve/Deny button", () => {
  const html = cockpitItemHtml({ ...base, kind: "spend", title: "Spend allowance running low",
    actions: [{ action: "adjust", method: "POST", path: "/api/rooms/room-a/spend-allowance",
      hint: "Send { allowanceCents, periodDays? } to raise the allowance" }] });
  assert.ok(!html.includes("data-cockpit-decide"), html);
  assert.ok(!html.includes("<button"), html);
  assert.ok(html.includes("Review in room"), html);
});

test("access approve/deny POSTs still render as inline decide buttons", () => {
  const html = cockpitItemHtml({ ...base, kind: "access_request", id: "ar-1",
    actions: [
      { action: "approve", method: "POST", path: "/api/rooms/room-a/access-requests/ar-1/decide", body: { decision: "approve" } },
      { action: "deny", method: "POST", path: "/api/rooms/room-a/access-requests/ar-1/decide", body: { decision: "deny" } },
    ] });
  assert.ok(html.includes('data-cockpit-decide="approve"'), html);
  assert.ok(html.includes('data-cockpit-decide="deny"'), html);
  assert.ok(html.includes(">Approve</button>"), html);
  assert.ok(html.includes(">Deny</button>"), html);
});

test("GET drill actions render as the room link, as before", () => {
  const html = cockpitItemHtml({ ...base, kind: "bounty_review", amountMillis: 10,
    actions: [{ action: "review", method: "GET", path: "/api/rooms/room-a/bounties" }] });
  assert.ok(html.includes("Review in room"), html);
  assert.ok(!html.includes("<button"), html);
});
