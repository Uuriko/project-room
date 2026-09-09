import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { prepareInboxResult } from "../scripts/inbox-result-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";

function setup(t, ready = true) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, key, 0);
  f.apply = request => f.store.inbox.apply(slot.token, request, session.sessionBinding);
  f.read = () => f.store.inbox.read(slot.token, "note", session.sessionBinding);
  f.source = { action: "source.save", sourceId: "note", requestId: "source", expectedRevision: 0,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Private reply",
      paragraphs: ["Please make the launch reply warmer.", "Private budget: 4200"] } };
  f.apply(f.source);
  const work = prepareInboxResult(f, slot.token, session.sessionBinding, { ready });
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return Object.assign(f, work, { slot, session });
}
test("exact reviewed result adoption changes only a private draft and retains historical provenance", async t => {
  const f = setup(t), request = f.adoption(), before = f.store.snapshot(f.keys.producer, "commons");
  const saved = f.apply(request); assert.equal(saved.receipt.body, f.body);
  assert.equal(f.read().draft.body, f.body); assert.equal(f.read().draft.origin.unchanged, true);
  assert.equal(f.read().draft.origin.verificationEventId, f.item().verification.eventId);
  assert.deepEqual(f.store.snapshot(f.keys.producer, "commons"), before);
  f.apply({ action: "draft.save", requestId: "edit", sourceId: "note", expectedRevision: 1, sourceRevision: 1, body: "An edited private reply" });
  assert.equal(f.read().draft.origin.unchanged, false);
  assert.deepEqual(f.apply(request).receipt, saved.receipt); assert.equal(f.read().draft.body, "An edited private reply");
  f.mutate("producer", "work.blocked", { reason: "Later rework", nextAction: "Revise" });
  f.mutate("producer", "work.blocker_resolved", { resolution: "New approach" });
  f.complete("A different result"); f.review(); f.decide();
  assert.equal(f.read().draft.origin.completionEventId, saved.receipt.origin.completionEventId);
  assert.equal(auditRecovery(f.store).schemaVersion, 17);
  const backup = await backupRoom(join(f.directory, "room.sqlite"), f.directory);
  const restored = new RoomStore(backup.filename, { readOnly: true });
  try { assert.deepEqual(auditRecovery(restored), auditRecovery(f.store)); } finally { restored.close(); }
  f.store.close(); f.store = new RoomStore(join(f.directory, "room.sqlite"));
  assert.equal(f.apply(request).duplicate, true);
  f.apply({ action: "draft.save", requestId: "clear", sourceId: "note", expectedRevision: 2, sourceRevision: 1, body: "" });
  assert.equal(f.read().draft.origin, null);
});
test("unreviewed, rejected and changed results cannot be adopted; later approval does not revive an old selection", t => {
  const f = setup(t, false);
  assert.equal(f.selected().status, "no_native_result"); f.complete();
  assert.equal(f.selected().status, "needs_review"); f.review("fail");
  assert.equal(f.selected().status, "needs_review");
  f.mutate("producer", "work.blocker_resolved", { resolution: "Addressed review" }); f.complete(); f.review(); f.decide("rejected");
  assert.equal(f.selected().status, "needs_review");
  f.mutate("producer", "work.blocker_resolved", { resolution: "Addressed decision" }); f.complete(); f.review(); f.decide();
  const request = f.adoption(); f.review(); // A new review, even of identical text, is a new decision context.
  assert.throws(() => f.apply(request), { code: "stale_inbox_result" });
  const refreshed = f.adoption(); assert.equal(f.apply(refreshed).receipt.body, f.body);
});
test("private source and draft revisions, exact source linkage and owner authority gate adoption", t => {
  const f = setup(t), request = f.adoption();
  assert.throws(() => f.apply({ ...request, shareRequestId: "another-share" }), { code: "inbox_result_not_found" });
  assert.throws(() => f.store.inbox.apply(f.keys.producer, request, f.session.sessionBinding), { status: 401 });
  const account = f.store.accountForMember("commons", "guest"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  assert.throws(() => f.store.inbox.results(slot.token, "note", "commons", session.sessionBinding), { status: 404 });
  f.apply({ action: "draft.save", requestId: "parallel-draft", sourceId: "note", expectedRevision: 0, sourceRevision: 1, body: "My earlier private work" });
  assert.throws(() => f.apply(request), { code: "stale_inbox_draft" });
  f.apply({ ...f.source, requestId: "source-change", expectedRevision: 1, data: { ...f.source.data, paragraphs: ["New source"] } });
  assert.throws(() => f.apply({ ...request, expectedRevision: 1 }), { code: "stale_inbox_source" });
  assert.equal(f.selected().status, "source_changed"); assert.equal(f.read().draft.body, "My earlier private work");
});
test("adoption projection and receipt must agree with the exact historical room evidence", t => {
  const f = setup(t), saved = f.apply(f.adoption());
  assert.doesNotThrow(() => f.store.inbox.verify());
  // Fixture-only corruption: normal commands cannot rewrite the private draft silently.
  f.store.db.prepare("UPDATE private_inbox_drafts SET body=?").run("Changed outside the journal");
  assert.throws(() => f.store.inbox.verify(), /reconciliation/);
  f.store.db.prepare("UPDATE private_inbox_drafts SET body=?").run(saved.receipt.body);
  assert.doesNotThrow(() => f.store.inbox.verify());
});
