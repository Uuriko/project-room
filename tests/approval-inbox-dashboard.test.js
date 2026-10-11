// WAVE-500 guild 10 slice 29/50: approval-inbox dashboard — fail-first tests.
// The dashboard renders inbox health from the slice-13 metrics shape. Traceability
// rule: EVERY rendered number must link to the filtered card list producing it;
// untraceable rows are dropped. Fail-first: these were written before the module.
import test from "node:test";
import assert from "node:assert/strict";

const M = "../src/approval-inbox-dashboard.js";
const H = 3600_000;
const D = 24 * H;

// --- buildMetrics -----------------------------------------------------------

test("buildMetrics groups pending items by kind with traceable filters", async () => {
  const { buildMetrics } = await import(M);
  const now = 1_800_000_000_000;
  const items = [
    { id: "a1", kind: "money", title: "spend", createdAt: now - H, status: "pending" },
    { id: "a2", kind: "money", title: "spend2", createdAt: now - 2 * H, status: "pending" },
    { id: "b1", kind: "deploy", title: "ship", createdAt: now - 3 * H, status: "pending" },
  ];
  const m = buildMetrics(items, { now, linkBase: "/inbox?{filter}" });
  assert.equal(m.contract, "inbox-dashboard-metrics/1");
  assert.equal(m.totalPending.count, 3);
  assert.equal(m.totalPending.filter, "status=pending");
  const money = m.pendingByKind.find((k) => k.kind === "money");
  assert.equal(money.count, 2);
  assert.equal(money.filter, "status=pending&kind=money");
  const deploy = m.pendingByKind.find((k) => k.kind === "deploy");
  assert.equal(deploy.count, 1);
});

test("buildMetrics buckets pending by age oldest-first", async () => {
  const { buildMetrics } = await import(M);
  const now = 1_800_000_000_000;
  const items = [
    { id: "a", kind: "money", createdAt: now - 30 * 60_000, status: "pending" },
    { id: "b", kind: "money", createdAt: now - 3 * H, status: "pending" },
    { id: "c", kind: "money", createdAt: now - 2 * D, status: "pending" },
    { id: "d", kind: "money", createdAt: now - 5 * D, status: "pending" },
  ];
  const m = buildMetrics(items, { now });
  const bucket = Object.fromEntries(m.pendingByAge.map((b) => [b.key, b]));
  assert.equal(bucket["under-1h"].count, 1);
  assert.equal(bucket["1h-6h"].count, 1);
  assert.equal(bucket["6h-24h"].count, 0);
  assert.equal(bucket["1d-3d"].count, 1);
  assert.equal(bucket["over-3d"].count, 1);
  assert.ok(bucket["1h-6h"].filter.includes("status=pending"));
});

test("oldestPending callout names the oldest item with age and filter", async () => {
  const { buildMetrics } = await import(M);
  const now = 1_800_000_000_000;
  const items = [
    { id: "new", kind: "publish", title: "blog post", createdAt: now - H, status: "pending" },
    { id: "old", kind: "money", title: "wire transfer", createdAt: now - 9 * D, status: "pending" },
  ];
  const m = buildMetrics(items, { now });
  assert.equal(m.oldestPending.id, "old");
  assert.equal(m.oldestPending.kind, "money");
  assert.equal(m.oldestPending.ageMs, 9 * D);
  assert.ok(m.oldestPending.filter.includes("sort=oldest"));
});

test("decidedToday counts decisions in the last 24h; median from the same window", async () => {
  const { buildMetrics } = await import(M);
  const now = 1_800_000_000_000;
  const items = [
    { id: "d1", kind: "money", status: "decided", createdAt: now - 3 * H, decidedAt: now - 2 * H, decision: "approve" }, // 1h to decide
    { id: "d2", kind: "deploy", status: "decided", createdAt: now - 5 * H, decidedAt: now - 1 * H, decision: "deny-stop" }, // 4h
    { id: "d3", kind: "identity", status: "decided", createdAt: now - 40 * H, decidedAt: now - 30 * H, decision: "approve" }, // stale, excluded
    { id: "p1", kind: "money", status: "pending", createdAt: now - H },
  ];
  const m = buildMetrics(items, { now });
  assert.equal(m.decidedToday.count, 2);
  assert.equal(m.decidedToday.filter, "status=decided&since=24h");
  assert.equal(m.medianTimeToDecisionMs, 2.5 * H); // median(1h, 4h)
});

test("medianTimeToDecisionMs is null when nothing was decided today", async () => {
  const { buildMetrics } = await import(M);
  const now = 1_800_000_000_000;
  const m = buildMetrics([{ id: "p", kind: "money", status: "pending", createdAt: now - H }], { now });
  assert.equal(m.decidedToday.count, 0);
  assert.equal(m.medianTimeToDecisionMs, null);
  assert.equal(m.oldestPending.id, "p");
});

test("items === null/undefined degrades to data-unavailable (not zero-claim)", async () => {
  const { buildMetrics } = await import(M);
  const m = buildMetrics(null, { now: 1_800_000_000_000 });
  assert.equal(m.dataAvailable, false);
  const m2 = buildMetrics([], { now: 1_800_000_000_000 });
  assert.equal(m2.dataAvailable, true);
  assert.equal(m2.totalPending.count, 0);
});

// --- renderDashboard ----------------------------------------------------------

test("every rendered number links to its filtered card list", async () => {
  const { buildMetrics, renderDashboard } = await import(M);
  const now = 1_800_000_000_000;
  const items = [
    { id: "a", kind: "money", createdAt: now - 30 * 60_000, status: "pending" },
    { id: "b", kind: "deploy", createdAt: now - 3 * H, status: "pending" },
    { id: "c", kind: "money", status: "decided", createdAt: now - 4 * H, decidedAt: now - 2 * H, decision: "approve" },
  ];
  const html = renderDashboard(buildMetrics(items, { now, linkBase: "/inbox?{filter}" }));
  // total, per-kind counts, decided-today count are all linked
  assert.match(html, /<a[^>]*href="\/inbox\?status=pending"[^>]*>2<\/a>/);
  assert.match(html, /<a[^>]*href="\/inbox\?status=pending&amp;kind=money"[^>]*>1<\/a>/);
  assert.match(html, /<a[^>]*href="\/inbox\?status=decided&amp;since=24h"[^>]*>1<\/a>/);
  // oldest callout links to the oldest-first filtered list
  assert.match(html, /\/inbox\?status=pending&amp;sort=oldest/);
  // median time label is linked too (label carries the number)
  assert.match(html, /<a[^>]*href="\/inbox\?status=decided&amp;since=24h"[^>]*>[^<]*2h/);
});

test("honest empty state: inbox clear, no phantom numbers", async () => {
  const { buildMetrics, renderDashboard } = await import(M);
  const m = buildMetrics([], { now: 1_800_000_000_000, linkBase: "/inbox?{filter}" });
  const html = renderDashboard(m);
  assert.match(html, /inbox clear/i);
  assert.doesNotMatch(html, /oldest/i);
});

test("data unavailable renders a degraded panel with no numbers", async () => {
  const { buildMetrics, renderDashboard } = await import(M);
  const html = renderDashboard(buildMetrics(null, { now: 1_800_000_000_000, linkBase: "/inbox?{filter}" }));
  assert.match(html, /unavailable/i);
  assert.doesNotMatch(html, />\d+</); // no bare numbers
});

test("without linkBase, untraceable numbers are dropped, not rendered dead", async () => {
  const { buildMetrics, renderDashboard } = await import(M);
  const now = 1_800_000_000_000;
  const m = buildMetrics(
    [{ id: "a", kind: "money", createdAt: now - H, status: "pending" }],
    { now, linkBase: null },
  );
  const html = renderDashboard(m);
  assert.doesNotMatch(html, />1</); // no unlinked counts
  assert.match(html, /link/i); // explains it needs a card-list link
});

test("linkBase may be a function; titles are HTML-escaped", async () => {
  const { buildMetrics, renderDashboard } = await import(M);
  const now = 1_800_000_000_000;
  const items = [
    { id: "x", kind: "other", title: "<script>alert(1)</script>", createdAt: now - 10 * D, status: "pending" },
  ];
  const html = renderDashboard(
    buildMetrics(items, { now, linkBase: (f) => `#cards?${f}` }),
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="#cards\?status=pending&amp;sort=oldest"/);
});
