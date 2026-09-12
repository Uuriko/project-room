import test from "node:test";
import assert from "node:assert/strict";
import { DiagnosticsLog, diagnosticRoute } from "../server/diagnostics.mjs";

test("diagnostic routes redact lowercase IDs and unknown path text", () => {
  for (const id of ["private-project", "events", "secret%2Fvalue", "ABC_123"]) {
    assert.equal(diagnosticRoute(`/api/rooms/demo/messages/${id}/thread?auth=secret`, "demo"),
      "/api/rooms/:roomId/messages/:item/thread");
    assert.equal(diagnosticRoute(`/api/rooms/demo/invitations/${id}/revoke`, "demo"),
      "/api/rooms/:roomId/invitations/:item/revoke");
  }
  for (const rest of ["private-project", "events/private-name", "a/".repeat(1000)])
    assert.equal(diagnosticRoute(`/api/rooms/demo/${rest}`, "demo"), "/api/rooms/:roomId/:unknown");
  assert.equal(diagnosticRoute("/api/rooms/demo/events?token=secret", "demo"), "/api/rooms/:roomId/events");
  assert.equal(diagnosticRoute("/api/rooms/demo", "demo"), "/api/rooms/:roomId");
  assert.equal(diagnosticRoute("/api/rooms/demo-other/events", "demo"), null);
});

test("diagnostics bound distinct rooms and retain recently written rooms", () => {
  const log = new DiagnosticsLog(2, 3);
  const add = (roomId, operationId = roomId) => log.record({ roomId, operationId });
  add("a"); add("b"); add("c"); add("a", "fresh"); add("d");
  assert.deepEqual(log.list("b"), []);
  assert.equal(log.list("a").at(-1).operationId, "fresh");
  for (let i = 0; i < 2000; i++) { add(`invented-${i}`); assert.ok(log.records.size <= 3); }
  assert.equal(log.records.size, 3);
  assert.equal(log.list("invented-1999").length, 1);
  for (const bad of [0, -1, 1001, NaN, 1.5]) assert.throws(() => new DiagnosticsLog(2, bad));
});
