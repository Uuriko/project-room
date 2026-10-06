// Board "What needs me": the viewer's own slice of the Board, from claims already loaded.
import test from "node:test";
import assert from "node:assert/strict";
import { myBoardWork, needsMeHtml, LEASE_SOON_MS, QUIET_MS, NEEDS_ME_LIMIT } from "../src/board-mine.js";

const now = Date.parse("2026-10-06T04:00:00Z");
const iso = ms => new Date(ms).toISOString();
const me = "ai_me", other = "ai_other";
const members = { [me]: { id: me, displayName: "Codex QA", kind: "agent" }, [other]: { id: other, displayName: "Jill", kind: "agent" } };
const claim = (id, extra = {}) => ({ id, title: `Title ${id}`, state: "claimed", owner: me, tags: [], reviews: [],
  updatedAt: iso(now - 5 * 60000), leaseExpiresAt: iso(now + 5 * 3600000), ...extra });
const rows = html => (html.match(/class="needs-me-row"/g) ?? []).length;

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
  assert.equal(LEASE_SOON_MS, 3600000);
});

test("blocked claims are listed as yours, not as expiring or quiet", () => {
  const w = myBoardWork([claim("b", { state: "blocked", leaseExpiresAt: iso(now + 60000), updatedAt: iso(now - 9 * 3600000) })], me, members, now);
  assert.deepEqual([w.expiring.length, w.quiet.length, w.owned.length], [0, 0, 1]);
});

test("one primary action per row: Renew, Review, Hand off; titles escaped", () => {
  const html = needsMeHtml([
    claim("soon", { title: "<b>x</b>", leaseExpiresAt: iso(now + 20 * 60000) }),
    claim("r", { owner: other, tags: [`rev-${me}`] }),
    claim("q", { updatedAt: iso(now - QUIET_MS - 60000) })
  ], { id: me, write: true }, members, now);
  assert.match(html, /<h3 id="needs-me-heading">3 need you<\/h3>/);
  assert.match(html, /data-claim-action="renew" data-claim-id="soon"[^>]*>Renew</);
  assert.match(html, /data-needs-me-open="r">Review</);
  assert.match(html, /data-claim-action="release" data-claim-id="q"[^>]*>Hand off</);
  assert.match(html, /Your lease ends in 20m/);
  assert.match(html, /You are tagged to review · @Jill/);
  assert.equal((html.match(/needs-me-act/g) ?? []).length, 3, "exactly one action per row");
  assert.ok(!html.includes("<b>x</b>") && html.includes("&lt;b&gt;x&lt;/b&gt;"));
});

test("at most three rows, most urgent first; the rest folds behind More", () => {
  const items = [1, 2, 3, 4, 5].map(n => claim(`l${n}`, { leaseExpiresAt: iso(now + n * 60000) })).concat([claim("fine")]);
  const html = needsMeHtml(items.reverse(), { id: me }, members, now);
  assert.equal(NEEDS_ME_LIMIT, 3);
  assert.equal(rows(html), 3);
  assert.deepEqual([...html.matchAll(/class="needs-me-row"><button type="button" class="needs-me-open" data-needs-me-open="([^"]+)"/g)].map(m => m[1]), ["l1", "l2", "l3"]);
  assert.match(html, /5 need you/);
  assert.match(html, /<summary>More · 3<\/summary>/, "two waiting leases plus one owned claim");
});

test("empty states are hidden; read-only viewers get no write buttons", () => {
  assert.equal(needsMeHtml([], { id: me }, members, now), "", "nothing at all renders nothing");
  assert.equal(needsMeHtml([claim("x", { owner: other })], { id: me }, members, now), "");
  const calm = needsMeHtml([claim("fine")], { id: me }, members, now);
  assert.match(calm, /Nothing needs you<\/h3>/);
  assert.ok(!calm.includes("needs-me-list"), "no empty list");
  assert.match(calm, /More · 1/);
  assert.ok(!needsMeHtml([claim("soon", { leaseExpiresAt: iso(now + 60000) })], { id: me, write: false }, members, now).includes("data-claim-action"));
  assert.equal(needsMeHtml([claim("fine")], { id: null }, members, now), "");
});

test("a display-name slug shared by two members matches neither; ids always match", () => {
  const twins = { ...members, ai_twin: { id: "ai_twin", displayName: "Codex-QA", kind: "agent" } };
  const items = [claim("by-slug", { owner: other, tags: ["rev-codexqa"] }), claim("by-id", { owner: other, tags: [`rev-${me}`] })];
  assert.deepEqual(myBoardWork(items, me, twins, now).reviews.map(x => x.item.id), ["by-id"]);
  assert.deepEqual(myBoardWork(items, "ai_twin", twins, now).reviews.map(x => x.item.id), []);
});
