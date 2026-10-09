import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture, applyFixtureFix } from "../scripts/acceptance-fixture.mjs";

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

test("applyFixtureFix applies positional substitutions", () => {
  assert.equal(applyFixtureFix("abcdef", "1:X\n"), "aXcdef");
  assert.equal(applyFixtureFix("abcdef", "\n  \n3:YZ\n"), "abcYZef");
  assert.equal(applyFixtureFix("abcdef", "0:a\n5:f"), "abcdef");
});

test("applyFixtureFix fails loud on malformed fix lines", () => {
  // The old loop silently corrupted the payload here: "5" parsed as pos 0,
  // "99:x" padded the payload with empty strings, "2:" deleted a char.
  for (const bad of ["5", "99:x", "-1:x", "2:", "2.5:x", "abc:x"]) {
    assert.throws(() => applyFixtureFix("abcdef", bad), /malformed fix line/);
  }
});
