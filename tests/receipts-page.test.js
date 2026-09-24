// Unit tests for server/receipts-page.mjs (public run-receipts page).
// All data below is synthetic test FIXTURE data — clearly labeled, never
// real board data. The real snapshot lives in server/receipts-data.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateReceipts,
  escapeHtml,
  receiptsJson,
  renderReceiptsHtml,
  RECEIPTS_PAGE_CSP,
} from "../server/receipts-page.mjs";

// --- FIXTURE: synthetic snapshot shaped like server/receipts-data.mjs -----
const FIXTURE_SNAPSHOT = {
  generatedAt: "2026-09-23T00:00:00.000Z",
  board: "Uuriko/project-room#266",
  boardUrl: "https://github.com/Uuriko/project-room/issues/266",
  repoUrl: "https://github.com/Uuriko/project-room",
  upstreamMain: "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd",
  commentsScanned: 42,
  receipts: [
    {
      task: "RC-2026-09-23-001", lane: "quill", date: "2026-09-23",
      pr: 900, prUrl: "https://github.com/Uuriko/project-room/pull/900",
      sha: "aaaabbbb", shaFull: "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd",
      shaUrl: "https://github.com/Uuriko/project-room/commit/aaaabbbbccccddddeeeeffffaaaabbbbccccdddd",
      result: "verified", commentId: 3,
      commentUrl: "https://github.com/Uuriko/project-room/issues/266#issuecomment-3",
      summary: "did the thing",
    },
    {
      task: null, lane: "jill", date: "2026-09-22",
      pr: 901, prUrl: "https://github.com/Uuriko/project-room/pull/901",
      sha: null, shaFull: null, shaUrl: null,
      result: "open", commentId: 2,
      commentUrl: "https://github.com/Uuriko/project-room/issues/266#issuecomment-2",
      summary: "opened a PR, not merged yet",
    },
    {
      task: "F001", lane: "quill", date: "2026-09-21",
      pr: null, prUrl: null,
      sha: "deadbeef", shaFull: null,
      shaUrl: "https://github.com/Uuriko/project-room/commit/deadbeef",
      result: "failed", commentId: 1,
      commentUrl: "https://github.com/Uuriko/project-room/issues/266#issuecomment-1",
      summary: "claimed a merge, nothing found",
    },
  ],
};

const EMPTY_FIXTURE = { generatedAt: null, board: null, boardUrl: null, repoUrl: null, upstreamMain: null, commentsScanned: 0, receipts: [] };

test("aggregateReceipts counts results and lanes", () => {
  const agg = aggregateReceipts(FIXTURE_SNAPSHOT);
  assert.deepEqual(agg.totals, { receipts: 3, verified: 1, failed: 1, open: 1, reported: 0 });
  assert.deepEqual(agg.perLane, [
    { lane: "quill", receipts: 2, verified: 1 },
    { lane: "jill", receipts: 1, verified: 0 },
  ]);
  assert.equal(agg.generatedAt, "2026-09-23T00:00:00.000Z");
  assert.equal(agg.commentsScanned, 42);
});

test("aggregateReceipts sorts receipts newest-first", () => {
  const agg = aggregateReceipts(FIXTURE_SNAPSHOT);
  assert.deepEqual(agg.receipts.map((r) => r.commentId), [3, 2, 1]);
});

test("aggregateReceipts treats unknown results as reported and tolerates junk", () => {
  const agg = aggregateReceipts({ receipts: [{ result: "bogus", lane: "", commentId: 9 }, null, "nope"] });
  assert.deepEqual(agg.totals, { receipts: 3, verified: 0, failed: 0, open: 0, reported: 3 });
  assert.equal(agg.perLane[0].lane, "(unknown)");
  const empty = aggregateReceipts(null);
  assert.deepEqual(empty.totals, { receipts: 0, verified: 0, failed: 0, open: 0, reported: 0 });
  assert.deepEqual(empty.receipts, []);
});

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml(`a'b&c`), "a&#39;b&amp;c");
  assert.equal(escapeHtml(null), "");
});

test("renderReceiptsHtml escapes untrusted receipt text", () => {
  const agg = aggregateReceipts({
    receipts: [{
      task: "<img src=x>", lane: "quill", date: "2026-09-23", pr: 1,
      prUrl: "https://example.com/?a=\"b\"", sha: null, shaFull: null, shaUrl: null,
      result: "verified", commentId: 1, commentUrl: "https://example.com/c",
      summary: `<script>alert("pwn")</script>`,
    }],
  });
  const html = renderReceiptsHtml(agg);
  assert.ok(!html.includes("<script>"), "raw script tag must not appear");
  assert.ok(html.includes("&lt;script&gt;"), "script tag must be escaped");
  assert.ok(html.includes("&lt;img src=x&gt;"), "task must be escaped");
  assert.ok(html.includes('href="https://example.com/?a=&quot;b&quot;"'), "attribute must be escaped");
  assert.ok(html.includes('<span class="result verified"'), "verified badge present");
});

test("renderReceiptsHtml shows an honest empty state", () => {
  const html = renderReceiptsHtml(aggregateReceipts(EMPTY_FIXTURE));
  assert.ok(html.includes("no runs yet"), "empty snapshot must say no runs yet");
  assert.ok(!html.includes("<tbody>"), "no tables when empty");
  assert.match(html, /0<\/span><span class="l">run receipts/);
});

test("renderReceiptsHtml renders stats, lanes, links, and methodology", () => {
  const html = renderReceiptsHtml(aggregateReceipts(FIXTURE_SNAPSHOT));
  assert.ok(html.includes("<title>Project Room — run receipts</title>"));
  assert.ok(html.includes("3</span>"), "total shown");
  assert.ok(html.includes("<code>quill</code>"), "lane table");
  assert.ok(html.includes("https://github.com/Uuriko/project-room/pull/900"), "PR link");
  assert.ok(html.includes("issuecomment-1"), "board comment link");
  assert.ok(html.includes("Regenerate the snapshot"), "methodology footer");
  assert.ok(!html.includes("<script"), "no scripts on the page");
});

test("receiptsJson exposes the machine-readable aggregate", () => {
  const body = receiptsJson(aggregateReceipts(FIXTURE_SNAPSHOT));
  assert.deepEqual(body.totals, { receipts: 3, verified: 1, failed: 1, open: 1, reported: 0 });
  assert.equal(body.receipts.length, 3);
  assert.equal(body.receipts[0].sha, "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd", "prefers the full verified SHA");
  assert.equal(body.receipts[2].result, "failed");
  assert.ok(!("mergedClaim" in body.receipts[0]), "internal parse flags stay out");
});

test("RECEIPTS_PAGE_CSP bans scripts", () => {
  assert.ok(RECEIPTS_PAGE_CSP.includes("default-src 'none'"));
  assert.ok(!RECEIPTS_PAGE_CSP.includes("script-src"), "no script source allowed");
});
