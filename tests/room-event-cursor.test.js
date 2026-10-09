// tests/room-event-cursor.test.js
//
// FIX-38: event-log cursor discipline. Every room helper that pages the
// event log must follow `next` while `hasMore` is true — page length never
// signals the terminal page (the service filters rows after scanning, so a
// page may be short, even empty, while hasMore is true).
//
// Fixture: a 3-page event log where page 2 is short-but-non-terminal and
// page 3 overlaps page 2 by one event. The old single-page behavior returns
// only page 1; collectEventPages must return all 3 pages in order, no dupes.
import test from "node:test";
import assert from "node:assert/strict";
import { collectEventPages } from "../client/room-agent.mjs";

function row(sequence, type = "message.posted") {
  return { sequence, event: { id: `e${sequence}`, type, at: "2026-10-09T00:00:00.000Z" } };
}

// Mimics GET /events?after=<cursor>&limit=<pageLimit>: { events, next, hasMore }.
// Page 2 is short-but-non-terminal (visibility filtering trimmed the scanned
// page). Page 3 re-includes the boundary row (seq 60): the walk already saw it
// via page 2's `next`, so dedupe must drop the repeat, not double-count it.
function fixturePages() {
  const page1 = { events: Array.from({ length: 50 }, (_, i) => row(i + 1)), next: 50, hasMore: true };
  const page2 = { events: Array.from({ length: 10 }, (_, i) => row(51 + i)), next: 60, hasMore: true };
  const page3 = { events: [row(60), ...Array.from({ length: 10 }, (_, i) => row(61 + i))], next: 70, hasMore: false };
  const calls = [];
  const fetchPage = async (after, pageLimit) => {
    calls.push([after, pageLimit]);
    if (after === 0) return page1;
    if (after === 50) return page2;
    if (after === 60) return page3;
    throw new Error(`unexpected cursor ${after}`);
  };
  return { fetchPage, calls };
}

test("baseline: a single page read returns only page 1 (the FIX-38 bug)", async () => {
  const { fetchPage } = fixturePages();
  const page = await fetchPage(0, 50);
  assert.equal(page.events.length, 50);
  assert.equal(page.hasMore, true, "more pages exist but a single read stops here");
});

test("collectEventPages returns all 3 pages in order with no duplicates", async () => {
  const { fetchPage, calls } = fixturePages();
  const result = await collectEventPages(fetchPage, { after: 0, pageLimit: 50 });
  assert.equal(result.pages, 3, "walked all three pages");
  assert.equal(result.capped, false);
  assert.equal(result.hasMore, false, "stopped at the terminal page");
  assert.equal(result.next, 70);
  assert.equal(result.events.length, 70, "1..70 exactly once");
  assert.deepEqual(
    result.events.map(e => e.sequence),
    Array.from({ length: 70 }, (_, i) => i + 1),
  );
  assert.equal(new Set(result.events.map(e => e.event.id)).size, 70, "no duplicate event ids");
  assert.deepEqual(calls.map(c => c[0]), [0, 50, 60], "advanced via each page's next cursor");
});

test("collectEventPages treats a short-but-non-terminal page as more-coming", async () => {
  const { fetchPage } = fixturePages();
  // Page 2 holds 10 events (< pageLimit 50) yet hasMore is true. A helper
  // that stops on short pages would end here with 60 events and drop page 3.
  const result = await collectEventPages(fetchPage, { after: 0, pageLimit: 50 });
  assert.ok(result.events.length > 60, "continued past the short page");
});

test("collectEventPages stops instead of spinning when the cursor stops advancing", async () => {
  let n = 0;
  const fetchPage = async () => {
    n += 1;
    return { events: [row(n)], next: 0, hasMore: true }; // hostile: hasMore but no advance
  };
  const result = await collectEventPages(fetchPage, { after: 0, pageLimit: 50, maxPages: 50 });
  assert.equal(result.capped, true);
  assert.ok(n < 50, `stopped early after ${n} pages, did not spin to the cap`);
});

test("collectEventPages honors maxPages and reports capped", async () => {
  const fetchPage = async (after) => ({ events: [row(after + 1)], next: after + 1, hasMore: true });
  const result = await collectEventPages(fetchPage, { after: 0, pageLimit: 50, maxPages: 4 });
  assert.equal(result.pages, 4);
  assert.equal(result.capped, true);
  assert.equal(result.events.length, 4);
});
