import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readCaptures, renderGallery } from "../scripts/design-evidence-gallery.mjs";

test("gallery binds screenshot bytes, preserves failed test status and refuses unsafe paths", t => {
  const dir = mkdtempSync(join(tmpdir(), "design-gallery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic bytes for integrity unit test");
  const item = { id: "login-390", screenshot: "login-390.png", viewport: { width: 390, height: 844 },
    sha256: createHash("sha256").update(bytes).digest("hex"), accessibility: { serious: [], other: [] } };
  const save = data => writeFileSync(join(dir, "login-390.json"), JSON.stringify(data));
  save(item); writeFileSync(join(dir, item.screenshot), bytes);
  assert.equal(readCaptures(dir, { status: 1, script: "scripts/test.mjs" }, "journey-1")[0].testPassed, false);
  save({ ...item, screenshot: "../outside.png" });
  assert.throws(() => readCaptures(dir, { status: 0 }, "journey-1"), /Invalid capture/);
  save(item); writeFileSync(join(dir, item.screenshot), "changed");
  assert.throws(() => readCaptures(dir, { status: 0 }, "journey-1"), /digest mismatch/);
});

test("gallery escapes fixture labels and keeps coverage and failure limitations visible", () => {
  const html = renderGallery({ source: { commit: "a".repeat(40), tree: "b".repeat(40), dirty: false }, environment: { node: "24", playwright: "test", platform: "test" },
    runs: [{ script: "scripts/test.mjs", status: 1, durationMs: 1, captureCount: 1, log: "journey-1.log" }],
    captures: [{ id: "login-390", title: '<script>alert("x")</script>', fixture: "Synthetic & local", component: "form", testName: "real test", script: "scripts/test.mjs",
      viewport: { width: 390, height: 844 }, testPassed: false, accessibility: { serious: [{ id: "contrast" }], other: [] }, sha256: "c".repeat(64), screenshot: "journey-1/login-390.png" }] });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /capture alone is not a pass/);
  assert.match(html, /real Google\/email delivery/);
  assert.match(html, /real-provider sign-in proof/);
  assert.match(html, /Source stable during capture: NO/);
  assert.match(html, /Overall evidence: NOT passed/);
  assert.match(html, /explicit dark and light themes/);
  assert.match(html, /Image framing/);
});
