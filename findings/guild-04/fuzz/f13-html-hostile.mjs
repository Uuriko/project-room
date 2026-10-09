// F13: hostile event rows into the HTML exporter — no XSS, no javascript: links, tombstones stay empty.
import assert from "node:assert/strict";
import { walkExport, renderRoomExportHtml, safeEvidenceHref, esc } from "../../server/room-export-html.mjs";
import { fuzz } from "./lib.mjs";

const X = `</title><script>alert(1)</script><img src=x onerror=alert(2)>`;
fuzz("F13-html-hostile", async () => {
  assert.equal(safeEvidenceHref("javascript:alert(1)"), null);
  assert.equal(safeEvidenceHref("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeEvidenceHref("http://example.com/x"), null, "http: must not link");
  assert.equal(safeEvidenceHref("https://user:pass@example.com/"), null, "credentials must not link");
  assert.ok(safeEvidenceHref("https://example.com/a?b=c")?.startsWith("https://"));
  assert.equal(safeEvidenceHref(42), null);
  console.log("  safeEvidenceHref: hostile schemes rejected, clean https kept");

  const rows = [
    { sequence: 1, event: { id: "e1", roomId: "r", type: "room.created", at: "2026-01-01T00:00:00Z", actorId: "o", data: { roomId: "r", title: X, purpose: X } } },
    { sequence: 2, event: { id: "e2", roomId: "r", type: "member.added", at: "2026-01-01T00:00:01Z", actorId: "o", data: { memberId: "m1", displayName: X, kind: "human" } } },
    { sequence: 3, event: { id: "e3", roomId: "r", type: "message.posted", at: "2026-01-01T00:00:02Z", actorId: "m1", data: { messageId: "msg1", body: X } } },
    { sequence: 4, event: { id: "e4", roomId: "r", type: "message.deleted", at: "2026-01-01T00:00:03Z", actorId: "m1", data: { messageId: "msg1" } } },
    { sequence: 5, event: { id: "e5", roomId: "r", type: "message.posted", at: "2026-01-01T00:00:04Z", actorId: "m1", data: { messageId: "msg2", body: "see this" } } },
    { sequence: 6, event: { id: "e6", roomId: "r", type: "work.completed", at: "2026-01-01T00:00:05Z", actorId: "m1", data: { workItemId: "w1", summary: X, evidenceUrl: "javascript:alert(9)" } } },
    { sequence: 7, event: { id: "e7", roomId: "r", type: "work.completed", at: "2026-01-01T00:00:06Z", actorId: "m1", data: { workItemId: "w1", summary: "ok", evidenceUrl: "https://example.com/evidence" } } },
    { sequence: 8, event: { id: "e8", roomId: "r", type: "weird.unknown.future", at: "not-a-date", actorId: "m1", data: null } },
    { sequence: 9, event: { id: "e9", roomId: "r", type: "message.posted", at: "2026-01-01T00:00:07Z", actorId: "m1", data: { messageId: "msg3", body: 42 } } },
  ];
  const walk = walkExport(rows); // must not throw on unknown/future types
  assert.equal(walk.count, 9);
  const html = renderRoomExportHtml(rows, { roomId: "r" });
  assert.ok(!html.includes("<script"), "raw <script in output");
  assert.ok(!html.includes("onerror="), "raw onerror in output");
  assert.ok(!html.includes("javascript:"), "javascript: URL in output");
  assert.ok(!html.includes(X), "raw payload in output");
  assert.ok(html.includes(esc(X)), "escaped payload missing");
  assert.ok(html.includes("Message deleted"), "tombstone missing");
  assert.ok(!html.includes("alert(1)</script>"), "deleted body leaked");
  assert.ok(html.includes('href="https://example.com/evidence"'), "legit evidence link missing");
  assert.ok(!/<script|onclick|onload|style=/.test(html), "handler/style attributes present");
  console.log("  hostile rows: escaped, tombstoned, unknown types ignored, legit link kept");
});
