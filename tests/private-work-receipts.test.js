import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture, privateMarkers, PRIVATE, PUBLIC } from "./helpers/private-work-fixture.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`${representation}: terminal receipt list, search and addressed read respect private work`, async t => {
    const f = await privateWorkFixture(t, representation), sign = makeTestSigner(f.store);
    const send = (who, id, type, data = {}) => f.send(who, type, { workItemId: id, expectedRevision: f.rev(id), ...data });
    send(f.producer.key, "secret", "work.blocker_resolved", { resolution: PRIVATE.RESOLUTION });
    for (const id of ["secret", "open"]) {
      send(f.producer.key, id, "work.started");
      const done = send(f.producer.key, id, "work.completed", {
        summary: id === "secret" ? PRIVATE.SUMMARY : PUBLIC.TITLE,
        evidenceUrl: "https://example.invalid/result", evidenceVersion: `result-${id}`,
        producerId: f.producer.id, nextAction: "Review", signedEvidence: sign()
      });
      if (id === "secret") send(f.reviewer.key, id, "verification.recorded", {
        result: "pass", completionEventId: done.event.id, evidenceVersion: `result-${id}`, summary: PRIVATE.REVIEW
      });
    }
    const before = f.stored();
    for (const viewer of [f.observer, f.triage, f.broad]) {
      for (const path of ["/receipts", "/receipts/rc_secret", `/receipts?q=${PRIVATE.SUMMARY}`]) {
        const read = await f.rest(viewer, path);
        assert.equal(read.status, 200, path);
        assert.deepEqual(privateMarkers(read.text), [], path);
        if (path === "/receipts") assert.ok(read.text.includes(PUBLIC.TITLE), "public receipt stays useful");
        if (path.includes("?q=")) assert.deepEqual(read.json.receipts, [], "private summary cannot be searched by an outsider");
      }
    }
    for (const viewer of [f.producer, f.reviewer]) {
      for (const path of ["/receipts", "/receipts/rc_secret", `/receipts?q=${PRIVATE.SUMMARY}`]) {
        const read = await f.rest(viewer, path);
        assert.equal(read.status, 200);
        assert.ok(read.text.includes(PRIVATE.SUMMARY), "authorized receipt remains readable and searchable");
      }
    }
    assert.equal(f.stored(), before, "receipt projection never modifies stored work");
  });
}
