// Board "What needs me": the viewer's own slice of the Board, from claims already loaded.
import test from "node:test";
import assert from "node:assert/strict";
import { myBoardWork, needsMeHtml, LEASE_SOON_MS, QUIET_MS } from "../src/board-mine.js";

const now = Date.parse("2026-10-06T04:00:00Z");
const iso = ms => new Date(ms).toISOString();
const me = "ai_me", other = "ai_other";
const members = { [me]: { id: me, displayName: "Codex QA", kind: "agent" }, [other]: { id: other, displayName: "Jill", kind: "agent" } };
const claim = (id, extra = {}) => ({ id, title: `Title ${id}`, state: "claimed", owner: me, tags: [], reviews: [],
  updatedAt: iso(now - 5 * 60000), leaseExpiresAt: iso(now + 5 * 3600000), ...extra });

test("leases under an hour, quiet claims and reviews owed are sorted into the inbox", () => {
  const items = [
    claim("soon", { leaseExpiresAt: iso(now + 20 * 60000) }),
    claim("ended", { leaseExpiresAt: iso(now - 60000) }),
    claim("quiet", { updatedAt: iso(now - QUIET_MS - 60000), history: [{ at: iso(now - QUIET_MS - 60000) }] }),
    claim("fine"),
    claim("rev-by-id", { owner: other, state: "in_progress", tags: [`rev-${me}`] }),
    claim("rev-by-slug", { owner: other, tags: ["rev-codexqa"] }),
    claim("already-reviewed", { owner: other, tags: [`rev-${me}`], reviews: [{ memberId: me, verdict: "approve" }] }),
    claim("partner", { owner: null, state: "unclaimed", tags: [`build-${me}`] }),
    claim("not-mine", { owner: other }),
    claim("done", { state: "done", leaseExpiresAt: iso(now - 1) })
  ];
  const before = structuredClone(items);
  const w = myBoardWork(items, me, members, now);
  assert.deepEqual(w.expiring.map(x => x.item.id), ["ended", "soon"]);
  assert.deepEqual(w.quiet.map(x => x.item.id), ["quiet"]);
  assert.deepEqual(w.owned.map(x => x.item.id), ["fine"]);
  assert.deepEqual(w.reviews.map(x => x.item.id).sort(), ["rev-by-id", "rev-by-slug"]);
  assert.deepEqual(w.partnered.map(x => x.item.id), ["already-reviewed", "partner"]);
  assert.deepEqual(items, before, "presentation never writes claim state");
  assert.ok(LEASE_SOON_MS === 3600000);
});

test("blocked claims are listed as yours, not as expiring or quiet", () => {
  const w = myBoardWork([claim("b", { state: "blocked", leaseExpiresAt: iso(now + 60000), updatedAt: iso(now - 9 * 3600000) })], me, members, now);
  assert.deepEqual([w.expiring.length, w.quiet.length, w.owned.length], [0, 0, 1]);
});

test("the panel renders urgent rows with Renew wired to the Board's renew action, and escapes titles", () => {
  const html = needsMeHtml([claim("soon", { title: "<b>x</b>", leaseExpiresAt: iso(now + 20 * 60000) }), claim("r", { owner: other, tags: [`rev-${me}`] })], { id: me, write: true }, members, now);
  assert.match(html, /What needs me <span class="needs-me-count">2<\/span>/);
  assert.match(html, /data-claim-action="renew" data-claim-id="soon"/);
  assert.match(html, /20m left on your lease/);
  assert.match(html, /@Jill is waiting on your review/);
  assert.ok(!html.includes("<b>x</b>") && html.includes("&lt;b&gt;x&lt;/b&gt;"));
});

test("calm state, read-only viewers and signed-out viewers", () => {
  assert.match(needsMeHtml([claim("fine")], { id: me }, members, now), /Nothing needs you right now\. 1 yours\./);
  assert.ok(!needsMeHtml([claim("soon", { leaseExpiresAt: iso(now + 60000) })], { id: me, write: false }, members, now).includes("data-claim-action"));
  assert.equal(needsMeHtml([claim("fine")], { id: null }, members, now), "");
});
