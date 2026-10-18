// COMP-DEEP #1 (CD-01) — verdict inbox, human surface (Lane D).
//
// The surface renders Lane C's sectioned verdict-inbox read (Contract V)
// and nothing else: four server-defined sections in server order, why
// (reason) + when (waiting) on every row, every count an API total taken
// verbatim, per-type filters that change visibility only. These tests pin
// that mapping against contract-shaped fixtures — each section populated
// and empty, the badge against a capped rows array, the follow block and
// its filters, the zero state, and the a11y shape (labelled sections,
// native links/buttons, aria-pressed filters) the browser check sweeps.
import test from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT_INBOX_PATH, VERDICT_SECTIONS,
  verdictBadgeCount, formatWaiting, rowAge, verdictRowHref, verdictRowHtml,
  verdictSectionHtml, verdictSectionsHtml, verdictFollowingHtml,
  verdictFiltersHtml, verdictSummaryText, visibleSectionKeys,
  isVerdictInboxDoc, createVerdictInbox,
} from "../src/verdict-inbox.js";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

function row(claimId, roomId, reason, waitingSeconds, extra = {}) {
  return {
    claimId, roomId, title: `Deliverable ${claimId}`, reason,
    since: new Date(NOW - waitingSeconds * 1000).toISOString(), waitingSeconds,
    ...extra,
  };
}

// Contract V fixture: every section populated, totals larger than the rows
// arrays where the server would cap (badge/summary must follow totals).
function fullDoc() {
  return {
    sections: {
      needsYourVerdict: [
        row("claim-1", "room-a", "Delivery awaiting your verdict", 3 * 3600, { roomName: "Alpha" }),
        row("claim-2", "room-b", "Re-review required — new delivery", 26 * 3600),
      ],
      returnedToYou: [row("claim-3", "room-a", "Revision requested — worker sent it back to you", 600)],
      waitingOnWorker: [row("claim-4", "room-c", "You requested a revision", 50 * 3600)],
      recentlyDecided: [row("claim-5", "room-a", "You accepted this delivery", 1200)],
    },
    totals: { needsYourVerdict: 7, returnedToYou: 1, waitingOnWorker: 1, recentlyDecided: 1, followedChanges: 2, mentions: 1 },
    // Lane C's shipped shape (PR #4022): following[] aliases follow.claims,
    // every row type "followed-claim" with unread/mention counts and no
    // title/reason/since — a mention is mentionCount > 0, not a row type.
    following: [
      { claimId: "claim-6", roomId: "room-b", policy: "follow", unreadCount: 2, mentionCount: 0, type: "followed-claim" },
      { claimId: "claim-7", roomId: "room-c", policy: "follow", unreadCount: 1, mentionCount: 1, type: "followed-claim" },
    ],
  };
}

function emptyDoc() {
  return {
    sections: { needsYourVerdict: [], returnedToYou: [], waitingOnWorker: [], recentlyDecided: [] },
    totals: { needsYourVerdict: 0, returnedToYou: 0, waitingOnWorker: 0, recentlyDecided: 0, followedChanges: 0, mentions: 0 },
  };
}

test("contract path is the single declared read path", () => {
  assert.equal(VERDICT_INBOX_PATH, "/api/verdict-inbox");
  assert.equal(isVerdictInboxDoc(fullDoc()), true);
  assert.equal(isVerdictInboxDoc({ sections: {} }), false);
  assert.equal(isVerdictInboxDoc(null), false);
});

test("badge count equals the API needsYourVerdict total, not the rows length", () => {
  const doc = fullDoc();
  assert.equal(doc.sections.needsYourVerdict.length, 2);
  assert.equal(verdictBadgeCount(doc), 7);
  assert.equal(verdictBadgeCount(emptyDoc()), 0);
  assert.equal(verdictBadgeCount({ totals: { needsYourVerdict: "7" } }), 0);
});

test("every section renders in server order with its API total", () => {
  const html = verdictSectionsHtml(fullDoc(), "all", { now: NOW });
  const order = VERDICT_SECTIONS.map(def => html.indexOf(`data-verdict-section="${def.key}"`));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(html, /Needs your verdict <span class="count-chip">7<\/span>/);
  // The cap is stated honestly instead of silently truncating.
  assert.match(html, /Showing the 2 longest-waiting, of 7 total/);
});

test("server row order is preserved — no client re-sorting", () => {
  const doc = fullDoc();
  // Deliberately not waiting-sorted: the server owns the order.
  doc.sections.needsYourVerdict = [
    row("claim-new", "room-a", "Delivery awaiting your verdict", 60),
    row("claim-old", "room-a", "Delivery awaiting your verdict", 90000),
  ];
  const html = verdictSectionsHtml(doc, "all", { now: NOW });
  assert.ok(html.indexOf("claim-new") < html.indexOf("claim-old"));
});

test("every row shows why (reason) and when (waiting time)", () => {
  const html = verdictRowHtml(fullDoc().sections.needsYourVerdict[0], { now: NOW });
  assert.match(html, /Delivery awaiting your verdict/);
  assert.match(html, /waiting 3h/);
  assert.match(html, /Alpha/);
  const decided = verdictRowHtml(fullDoc().sections.recentlyDecided[0], { decided: true, now: NOW });
  assert.match(decided, /You accepted this delivery/);
  assert.match(decided, /20m ago/);
});

test("waiting falls back to the row's since timestamp", () => {
  const bare = { claimId: "c", roomId: "r", title: "T", reason: "R", since: new Date(NOW - 3600_000).toISOString() };
  assert.equal(rowAge(bare, NOW), "1h");
  assert.equal(formatWaiting(90), "1m");
  assert.equal(formatWaiting(50 * 3600), "2d 2h");
  assert.equal(formatWaiting(-1), "");
  assert.equal(formatWaiting("3"), "");
});

test("rows deep-link into the room at the claim record", () => {
  assert.equal(
    verdictRowHref({ claimId: "claim 1", roomId: "room/a" }),
    "./?room=room%2Fa#pr-record/work/claim%201",
  );
  const html = verdictRowHtml(fullDoc().sections.needsYourVerdict[1], { now: NOW });
  assert.match(html, /href="\.\/\?room=room-b#pr-record\/work\/claim-2"/);
});

test("row html escapes title, reason and room name", () => {
  const html = verdictRowHtml({
    claimId: "c<x>", roomId: "r", roomName: "<script>alert(1)</script>",
    title: "<b>bold</b>", reason: "a & b", since: "", waitingSeconds: 60,
  }, { now: NOW });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<b>bold</b>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("a &amp; b"));
});

test("empty sections render their empty state, populated ones do not", () => {
  const doc = emptyDoc();
  doc.sections.needsYourVerdict = [row("claim-1", "room-a", "Delivery awaiting your verdict", 60)];
  doc.totals.needsYourVerdict = 1;
  const html = verdictSectionsHtml(doc, "all", { now: NOW });
  assert.match(html, /Nothing has been returned to you/);
  assert.match(html, /Nothing is waiting on a worker/);
  assert.match(html, /Nothing decided recently/);
  assert.doesNotMatch(html, /Nothing needs your verdict/);
});

test("filters select sections only — order and counts untouched", () => {
  assert.deepEqual(visibleSectionKeys("verdicts"), ["needsYourVerdict"]);
  assert.deepEqual(visibleSectionKeys("nonsense"), visibleSectionKeys("all"));
  const html = verdictSectionsHtml(fullDoc(), "waiting", { now: NOW });
  assert.match(html, /data-verdict-section="waitingOnWorker"/);
  assert.doesNotMatch(html, /data-verdict-section="needsYourVerdict"/);
  const filters = verdictFiltersHtml("waiting");
  assert.match(filters, /data-verdict-filter="waiting" aria-pressed="true"/);
  assert.match(filters, /data-verdict-filter="all" aria-pressed="false"/);
});

test("follow block renders in the same neighbourhood, totals from the API", () => {
  const html = verdictFollowingHtml(fullDoc(), "all", { now: NOW });
  assert.match(html, /data-verdict-section="following"/);
  assert.match(html, /2 followed changes · 1 mention/);
  // Shipped rows carry counts, not prose: the why-line is synthesised from
  // unreadCount / mentionCount, and the claimId is the row's link text.
  assert.match(html, /Followed claim changed/);
  assert.match(html, /You were mentioned/);
  assert.match(html, />claim-6</);
  // Per-type filters narrow the block: mentions are the followed-claim rows
  // whose mentionCount is positive (Lane C emits no mention row type).
  const mentionsOnly = verdictFollowingHtml(fullDoc(), "mentions", { now: NOW });
  assert.match(mentionsOnly, /You were mentioned/);
  assert.doesNotMatch(mentionsOnly, /Followed claim changed/);
  assert.doesNotMatch(mentionsOnly, /claim-6/);
  const followedOnly = verdictFollowingHtml(fullDoc(), "following", { now: NOW });
  assert.match(followedOnly, /Followed claim changed/);
  assert.match(followedOnly, /You were mentioned/);
  // Section filters hide the block entirely.
  assert.equal(verdictFollowingHtml(fullDoc(), "verdicts", { now: NOW }), "");
  // No follow rows in the read → no block under "all".
  assert.equal(verdictFollowingHtml(emptyDoc(), "all", { now: NOW }), "");
});

test("follow block falls back to the canonical follow.claims when the alias is absent", () => {
  const doc = emptyDoc();
  doc.totals.followedChanges = 3;
  doc.totals.mentions = 1;
  doc.follow = {
    totals: { followedClaims: 1, unreadClaims: 1, unreadEvents: 3, mentions: 1 },
    claims: [{ claimId: "claim-9", roomId: "room-a", policy: "follow", unreadCount: 3, mentionCount: 1 }],
  };
  const html = verdictFollowingHtml(doc, "all", { now: NOW });
  assert.match(html, /data-verdict-section="following"/);
  assert.match(html, /You were mentioned/);
  assert.match(html, />claim-9</);
});

test("summary is built from totals verbatim", () => {
  assert.equal(verdictSummaryText(fullDoc()), "7 need your verdict · 1 returned to you · 1 waiting on worker");
  const one = fullDoc(); one.totals.needsYourVerdict = 1;
  assert.match(verdictSummaryText(one), /^1 needs your verdict/);
  assert.equal(verdictSummaryText(emptyDoc()), "Nothing needs your verdict");
});

// --- Render wiring against a minimal fake section (no DOM, no network) ---

function fakeElement() {
  return {
    innerHTML: "", textContent: "", hidden: false, attributes: {}, buttons: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector !== "[data-verdict-filter]") return [];
      // Materialise one stub per filter button in the current innerHTML.
      return [...this.innerHTML.matchAll(/data-verdict-filter="([^"]+)"/g)].map(match => {
        const button = {
          dataset: { verdictFilter: match[1] }, listeners: {},
          addEventListener(type, fn) { this.listeners[type] = fn; },
        };
        this.buttons.push(button);
        return button;
      });
    },
  };
}

function fakeSection() {
  const elements = {
    "#verdict-inbox-badge": fakeElement(),
    "#verdict-inbox-summary": fakeElement(),
    "#verdict-inbox-filters": fakeElement(),
    "#verdict-inbox-sections": fakeElement(),
    "#verdict-inbox-following": fakeElement(),
  };
  return { hidden: true, elements, querySelector(selector) { return elements[selector] ?? null; } };
}

test("render paints badge, sections and follow block from the read", async () => {
  const section = fakeSection();
  const inbox = createVerdictInbox({ load: async () => fullDoc(), section });
  await inbox.refresh();
  assert.equal(section.hidden, false);
  const badge = section.elements["#verdict-inbox-badge"];
  assert.equal(badge.textContent, "7");
  assert.equal(badge.hidden, false);
  assert.equal(badge.attributes["aria-label"], "Needs your verdict: 7 waiting");
  assert.match(section.elements["#verdict-inbox-summary"].textContent, /7 need your verdict/);
  assert.match(section.elements["#verdict-inbox-sections"].innerHTML, /Needs your verdict/);
  assert.match(section.elements["#verdict-inbox-following"].innerHTML, /You were mentioned/);
});

test("filter buttons re-render visibility without refetching or reordering", async () => {
  const section = fakeSection();
  let loads = 0;
  const inbox = createVerdictInbox({ load: async () => { loads++; return fullDoc(); }, section });
  await inbox.refresh();
  const filtersBox = section.elements["#verdict-inbox-filters"];
  const waiting = filtersBox.buttons.find(button => button.dataset.verdictFilter === "waiting");
  assert.ok(waiting);
  waiting.listeners.click();
  assert.equal(loads, 1);
  const html = section.elements["#verdict-inbox-sections"].innerHTML;
  assert.match(html, /data-verdict-section="waitingOnWorker"/);
  assert.doesNotMatch(html, /data-verdict-section="needsYourVerdict"/);
  assert.equal(section.elements["#verdict-inbox-following"].innerHTML, "");
});

test("zero state: no badge, one inbox-zero line, no sections", async () => {
  const section = fakeSection();
  const inbox = createVerdictInbox({ load: async () => emptyDoc(), section });
  await inbox.refresh();
  assert.equal(section.hidden, false);
  assert.equal(section.elements["#verdict-inbox-badge"].textContent, "");
  assert.equal(section.elements["#verdict-inbox-badge"].hidden, true);
  assert.match(section.elements["#verdict-inbox-summary"].textContent, /Inbox zero/);
  assert.equal(section.elements["#verdict-inbox-sections"].innerHTML, "");
});

test("auth failure hides the section; other failures say so once, quietly", async () => {
  const denied = fakeSection();
  const inboxDenied = createVerdictInbox({
    load: async () => { const error = new Error("nope"); error.status = 403; throw error; },
    section: denied,
  });
  await inboxDenied.refresh();
  assert.equal(denied.hidden, true);

  const broken = fakeSection();
  const inboxBroken = createVerdictInbox({
    load: async () => { throw new Error("boom"); },
    section: broken,
  });
  await inboxBroken.refresh();
  assert.equal(broken.hidden, false);
  assert.match(broken.elements["#verdict-inbox-summary"].textContent, /Couldn't load your verdict inbox/);
  assert.equal(broken.elements["#verdict-inbox-badge"].textContent, "");
});

test("a11y shape: labelled sections, native links and toggle buttons", () => {
  const sections = verdictSectionsHtml(fullDoc(), "all", { now: NOW });
  for (const def of VERDICT_SECTIONS) {
    assert.match(sections, new RegExp(`aria-label="${def.title}"`));
  }
  // Rows are native anchors (keyboard reachable, focus in document order).
  assert.match(sections, /<a href="\.\/\?room=room-a#pr-record\/work\/claim-1">/);
  assert.doesNotMatch(sections, /<div[^>]*tabindex/);
  const filters = verdictFiltersHtml("all");
  assert.match(filters, /<button type="button"[^>]*aria-pressed="true"/);
});
