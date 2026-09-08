import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

test("acceptance setup is isolated, repeatable, scoped and includes invitation states", () => {
  const a = createAcceptanceFixture(), b = createAcceptanceFixture();
  try {
    assert.notEqual(a.directory, b.directory);
    assert.notEqual(a.keys.owner, b.keys.owner);
    const state = a.store.snapshot(a.keys.owner, "commons").state;
    assert.match(state.room.title, /Disposable Test/);
    assert.deepEqual(state.members.producer.permissions, ["accept_work", "complete_work"]);
    assert.deepEqual(state.members.reviewer.permissions, ["verify"]);
    assert.deepEqual(state.members.guest.permissions, []);
    assert.equal(state.workItems["test-handoff"].sourceMessageId, "test-request");
    assert.equal(a.store.shareLinks.preview(a.links.valid).link.remainingJoins, 10);
    for (const label of ["expired", "cancelled", "full"]) assert.throws(() => a.store.shareLinks.preview(a.links[label]), { code: "link_unavailable" });
    assert.equal(a.store.verifyInvitationAudit().consistent, true);
  } finally {
    for (const f of [a, b]) { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});
