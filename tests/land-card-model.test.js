// Land queue board card model from src/land-queue-board.js: landCardModel's
// normalization (unknown states collapse, missing fields get safe defaults),
// this module's escapeHtml, and installLandQueueBoard's fail-safe when the
// panel is absent. landCardHtml/shortSha are already covered in
// tests/land-queue.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { landCardModel, escapeHtml, installLandQueueBoard } from "../src/land-queue-board.js";

test("landCardModel normalizes a complete queue item", () => {
  assert.deepEqual(landCardModel({
    prNumber: 969, title: "Ship the queue", url: "https://github.com/acme/demo/pull/969",
    headSha: "a".repeat(40), checks: "green", behind: true, mergedSha: "c".repeat(40),
    tip: { sourceRevision: "rev-1", buildId: null },
  }), {
    prNumber: 969, title: "Ship the queue", url: "https://github.com/acme/demo/pull/969",
    head: "aaaaaaa", checks: "green", behind: true, merged: true, tip: true,
  });
});

test("landCardModel collapses unknown states to safe defaults", () => {
  assert.deepEqual(landCardModel({ prNumber: 1, checks: "weird" }), {
    prNumber: 1, title: "PR 1", url: "", head: "", checks: "pending",
    behind: false, merged: false, tip: false,
  });
  assert.equal(landCardModel({ checks: "red" }).checks, "red");
  assert.equal(landCardModel({}).title, "PR ");
  assert.equal(landCardModel({ prNumber: 7, title: "" }).title, "PR 7");
  assert.equal(landCardModel({ headSha: "abc" }).head, "");
});

test("landCardModel marks a tip only when the tip names a revision or build", () => {
  assert.equal(landCardModel({ tip: {} }).tip, false);
  assert.equal(landCardModel({ tip: null }).tip, false);
  assert.equal(landCardModel({ tip: { buildId: "build-9" } }).tip, true);
  assert.equal(landCardModel({ tip: { sourceRevision: "rev-1" } }).tip, true);
  assert.equal(landCardModel({ mergedSha: null }).merged, false);
});

test("escapeHtml neutralizes every HTML metacharacter", () => {
  assert.equal(
    escapeHtml(`<a href='x'>&"y"</a>`),
    "&lt;a href=&#39;x&#39;&gt;&amp;&quot;y&quot;&lt;/a&gt;");
});

test("escapeHtml coerces missing and non-string input", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(969), "969");
});

test("installLandQueueBoard without a panel never touches client or session", () => {
  const realDocument = globalThis.document;
  globalThis.document = { querySelector: () => null };
  try {
    const board = installLandQueueBoard({
      client: { request() { throw new Error("must not fetch without a panel"); } },
      getSession() { throw new Error("must not read the session without a panel"); },
    });
    assert.doesNotThrow(() => { board.sync(); board.reset(); });
  } finally {
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
});
