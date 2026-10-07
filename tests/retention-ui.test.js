// Fail-first tests for src/retention-ui.js (audit wave-2 item 9):
// the retention dashboard panel, wired to GET /api/rooms/{roomId}/work-claims/retention.
// Pure helpers (view model, HTML rendering, escaping) plus the wired panel
// behavior against a stub client and a fake document. No real DOM, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatLatency,
  retentionModel,
  retentionHtml,
  installRetentionPanel,
} from "../src/retention-ui.js";

const MOCK_RESPONSE = {
  generatedAt: "2026-10-06T22:00:00.000Z",
  slaHours: 24,
  zeroReplyWindowHours: 48,
  sla: {
    queue: [
      { memberId: "m1", kind: "first-claim", itemId: "c1", at: "2026-10-05T20:00:00.000Z",
        dueAt: "2026-10-06T20:00:00.000Z", status: "breached" },
      { memberId: "m2", kind: "first-claim", itemId: "c2", at: "2026-10-06T20:00:00.000Z",
        dueAt: "2026-10-07T20:00:00.000Z", status: "pending" },
    ],
    answered: [
      { memberId: "m3", kind: "first-claim", itemId: "c3", at: "2026-10-06T10:00:00.000Z",
        dueAt: "2026-10-07T10:00:00.000Z", status: "answered",
        answeredAt: "2026-10-06T12:00:00.000Z", answeredBy: "m4", latencyMs: 2 * 3600 * 1000 },
    ],
    breached: 1,
    pending: 1,
  },
  zeroReply: {
    watch: [
      { itemId: "c1", memberId: "m1", claimedAt: "2026-10-05T20:00:00.000Z", state: "claimed", acked: false, unacked: true, respondedAt: null },
    ],
    contributions: 4,
    unanswered: 2,
    unacked: 1,
    rate: 0.5,
    alert: true,
  },
  latency: { medianMs: 3 * 3600 * 1000, measured: 6 },
};

test("retentionModel normalizes a mocked endpoint response", () => {
  assert.deepEqual(retentionModel(MOCK_RESPONSE), {
    slaHours: 24,
    zeroReplyWindowHours: 48,
    breached: 1,
    pending: 1,
    answered: 1,
    queue: [
      { memberId: "m1", itemId: "c1", status: "breached", at: "2026-10-05T20:00:00.000Z", dueAt: "2026-10-06T20:00:00.000Z", when: "Oct 5" },
      { memberId: "m2", itemId: "c2", status: "pending", at: "2026-10-06T20:00:00.000Z", dueAt: "2026-10-07T20:00:00.000Z", when: "Oct 6" },
    ],
    answeredRows: [
      { memberId: "m3", itemId: "c3", answeredBy: "m4", latency: "2h", when: "Oct 6" },
    ],
    watch: [
      { itemId: "c1", memberId: "m1", claimedAt: "2026-10-05T20:00:00.000Z", unacked: true, when: "Oct 5" },
    ],
    contributions: 4,
    unanswered: 2,
    unacked: 1,
    zeroReplyRate: 0.5,
    alert: true,
    latencyMedian: "3h",
    latencyMeasured: 6,
  });
});

test("retentionModel tolerates missing fields with safe defaults", () => {
  assert.deepEqual(retentionModel(null), {
    slaHours: 24, zeroReplyWindowHours: 48,
    breached: 0, pending: 0, answered: 0,
    queue: [], answeredRows: [], watch: [],
    contributions: 0, unanswered: 0, unacked: 0, zeroReplyRate: 0,
    alert: false, latencyMedian: "—", latencyMeasured: 0,
  });
});

test("formatLatency renders human durations or an honest blank", () => {
  assert.equal(formatLatency(null), "—");
  assert.equal(formatLatency(0), "0m");
  assert.equal(formatLatency(45 * 60 * 1000), "45m");
  assert.equal(formatLatency(2 * 3600 * 1000), "2h");
  assert.equal(formatLatency(3 * 3600 * 1000 + 30 * 60 * 1000), "3h 30m");
  assert.equal(formatLatency(26 * 3600 * 1000), "26h");
  assert.equal(formatLatency(3 * 24 * 3600 * 1000), "3d");
});

test("escapeHtml neutralizes markup in ids and names", () => {
  assert.equal(escapeHtml("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
  assert.equal(escapeHtml(undefined), "");
});

test("retentionHtml renders the dashboard given a mocked endpoint response", () => {
  const html = retentionHtml(retentionModel(MOCK_RESPONSE));
  assert.ok(html.includes("Breached"), "renders the SLA queue section");
  assert.ok(html.includes("breached"), "renders the breached entry");
  assert.ok(html.includes("Zero-reply watch"), "renders the watch section");
  assert.ok(html.includes("50%"), "renders the zero-reply rate");
  assert.ok(html.includes("3h"), "renders the median latency");
  assert.ok(html.includes("retention-panel-body"), "renders the panel body element");
});

test("retentionHtml escapes member ids and is honest when empty", () => {
  const html = retentionHtml(retentionModel({
    sla: { queue: [{ memberId: "<img>", itemId: "c1", status: "pending", at: "2026-10-06T20:00:00.000Z", dueAt: "2026-10-07T20:00:00.000Z" }],
      answered: [], breached: 0, pending: 1 },
    zeroReply: { watch: [], contributions: 0, unanswered: 0, unacked: 0, rate: 0, alert: false },
    latency: { medianMs: null, measured: 0 },
  }));
  assert.ok(!html.includes("<img>"), "raw markup must not appear");
  assert.ok(html.includes("&lt;img&gt;"), "escaped markup appears instead");
  const empty = retentionHtml(retentionModel(null));
  assert.ok(empty.includes("Nothing waiting on a first response"), "empty queue says so honestly");
  assert.ok(empty.includes("No claims past the reply window"), "empty watch says so honestly");
});

test("installRetentionPanel without a panel never touches client or session", () => {
  const realDocument = globalThis.document;
  globalThis.document = { querySelector: () => null };
  try {
    const panel = installRetentionPanel({
      client: { request() { throw new Error("must not fetch without a panel"); } },
      getSession() { throw new Error("must not read the session without a panel"); },
    });
    assert.doesNotThrow(() => { panel.sync(); panel.reset(); });
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});

test("installRetentionPanel fetches the retention endpoint and renders the dashboard", async () => {
  const realDocument = globalThis.document;
  let bodyHtml = null, chipText = null;
  globalThis.document = {
    querySelector: selector => {
      if (selector === "#retention-panel") return { addEventListener() {}, open: true };
      if (selector === "#retention-panel-host") return { set innerHTML(html) { bodyHtml = html; } };
      if (selector === "#retention-alert") return { set textContent(t) { chipText = t; }, set hidden(v) {} };
      if (selector === "#retention-status") return { set textContent(t) {} };
      return null;
    },
  };
  const requested = [];
  const client = {
    session: { roomId: "room1", member: { id: "m9" } },
    path(suffix) { return `/api/rooms/room1${suffix}`; },
    async request(path, options) {
      if (path !== "/api/rooms/room1/work-claims/retention") throw new Error(`unexpected path ${path}`);
      requested.push({ path, options });
      return MOCK_RESPONSE;
    },
  };
  try {
    const panel = installRetentionPanel({ client, getSession: () => client.session });
    await panel.sync();
    assert.deepEqual(requested.map(r => r.path), ["/api/rooms/room1/work-claims/retention"]);
    assert.ok(bodyHtml && bodyHtml.includes("Zero-reply watch"), "mocked dashboard rendered");
    assert.ok(bodyHtml.includes("50%"), "mocked zero-reply rate rendered");
    assert.equal(chipText, "1 breached · 1 unacked", "alert chip summarizes breaches and unacked");
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});
