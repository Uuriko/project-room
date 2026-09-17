import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";

const data = { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Private launch",
  paragraphs: ["Please draft a friendly launch note."] };
function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.sessions = {};
  for (const role of ["owner", "guest"]) {
    const account = f.store.accountForMember("commons", role), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
    f.sessions[role] = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  }
  f.apply = (request, role = "owner") => f.store.inbox.apply(f.sessions[role].token, request, f.sessions[role].sessionBinding);
  f.list = (role = "owner") => f.store.inbox.list(f.sessions[role].token, f.sessions[role].sessionBinding).sources;
  f.read = (role = "owner", id = "source") => f.store.inbox.read(f.sessions[role].token, id, f.sessions[role].sessionBinding).source;
  f.save = (extra = {}, role = "owner") => f.apply({ action: "source.save", requestId: randomUUID(), sourceId: "source", expectedRevision: 0, data: structuredClone(data), ...extra }, role);
  f.mark = (action, extra = {}, role = "owner") => f.apply({ action, requestId: randomUUID(), sourceId: "source", expectedRevision: 1, ...extra }, role);
  return f;
}
test("marking a source read stores a read marker without moving the source revision", t => {
  const f = fixture(t); f.save();
  assert.equal(f.list()[0].readAt, null, "new sources are unread");
  assert.equal(f.read().readAt, null);
  const result = f.mark("source.read");
  assert.equal(result.duplicate, false);
  assert.deepEqual(Object.keys(result.receipt).sort(), ["action", "readAt", "requestId", "sourceId", "sourceRevision"]);
  assert.equal(result.receipt.action, "source.read");
  assert.equal(result.receipt.sourceRevision, 1);
  assert.ok(Number.isSafeInteger(result.receipt.readAt), "readAt is a stored timestamp");
  assert.equal(f.read().revision, 1, "marking read does not create a new source version");
  assert.equal(f.list()[0].readAt, result.receipt.readAt);
  assert.equal(f.read().readAt, result.receipt.readAt);
  assert.deepEqual(f.store.inbox.verify(), { sources: 1, drafts: 0, versions: 1 });
});
test("re-marking with the same request id returns the journaled receipt", t => {
  const f = fixture(t); f.save();
  const request = { action: "source.read", requestId: randomUUID(), sourceId: "source", expectedRevision: 1 };
  const first = f.apply(request), second = f.apply(request);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.receipt, first.receipt);
  assert.throws(() => f.apply({ ...request, expectedRevision: 2 }), { status: 409, code: "idempotency_conflict" });
});
test("a read against a moved source revision is rejected as stale", t => {
  const f = fixture(t); f.save();
  assert.throws(() => f.mark("source.read", { expectedRevision: 0 }), { status: 409, code: "stale_inbox_source" });
  f.save({ expectedRevision: 1, data: { ...data, paragraphs: ["Updated follow-up"] } });
  assert.throws(() => f.mark("source.read", { expectedRevision: 1 }), { status: 409, code: "stale_inbox_source" });
  const result = f.mark("source.read", { expectedRevision: 2 });
  assert.equal(result.receipt.sourceRevision, 2);
  assert.ok(Number.isSafeInteger(result.receipt.readAt));
  // A later content version keeps the marker; nothing about read state moved it.
  f.save({ expectedRevision: 2, data: { ...data, paragraphs: ["Third version"] } });
  assert.equal(f.read().revision, 3);
  assert.equal(f.read().readAt, result.receipt.readAt);
  assert.deepEqual(f.store.inbox.verify(), { sources: 1, drafts: 0, versions: 3 });
});
test("marking a source unread clears the read marker", t => {
  const f = fixture(t); f.save(); f.mark("source.read");
  assert.ok(Number.isSafeInteger(f.read().readAt));
  const result = f.mark("source.unread");
  assert.equal(result.receipt.action, "source.unread");
  assert.equal(result.receipt.sourceRevision, 1);
  assert.equal(result.receipt.readAt, null);
  assert.equal(f.read().readAt, null);
  assert.equal(f.list()[0].readAt, null);
  // Unreading an already-unread source is a no-op, not an error.
  const again = f.mark("source.unread");
  assert.equal(again.receipt.readAt, null);
  assert.equal(f.read().revision, 1, "unread does not create a new source version");
  assert.deepEqual(f.store.inbox.verify(), { sources: 1, drafts: 0, versions: 1 });
});
test("read state is scoped to the acting account", t => {
  const f = fixture(t); f.save(); f.save({}, "guest");
  // Each account saved its own "source": marking is fine per account, and the
  // owner's marker is untouched by the guest's.
  const marked = f.apply({ action: "source.read", requestId: randomUUID(), sourceId: "source", expectedRevision: 1 }, "guest");
  assert.ok(Number.isSafeInteger(marked.receipt.readAt));
  assert.ok(Number.isSafeInteger(f.read("guest").readAt));
  assert.equal(f.read("owner").readAt, null);
  assert.throws(() => f.apply({ action: "source.unread", requestId: randomUUID(), sourceId: "nope", expectedRevision: 1 }, "guest"),
    { status: 404, code: "inbox_source_not_found" });
  assert.deepEqual(f.store.inbox.verify(), { sources: 2, drafts: 0, versions: 2 });
});
test("read markers survive a store reopen through the additive migration", t => {
  const f = fixture(t); f.save();
  const marked = f.mark("source.read");
  f.store.close(); f.store = new RoomStore(f.filename);
  assert.equal(f.list()[0].readAt, marked.receipt.readAt);
  assert.equal(f.read().readAt, marked.receipt.readAt);
  assert.deepEqual(f.store.inbox.verify(), { sources: 1, drafts: 0, versions: 1 });
  // Marking still works after reopen, against the same source revision.
  const unread = f.mark("source.unread");
  assert.equal(unread.receipt.readAt, null);
  assert.equal(f.read().readAt, null);
  assert.deepEqual(f.store.inbox.verify(), { sources: 1, drafts: 0, versions: 1 });
});
test("read actions validate their exact request shape", t => {
  const f = fixture(t); f.save();
  assert.throws(() => f.apply({ action: "source.read", requestId: randomUUID(), sourceId: "source" }),
    { status: 422, code: "invalid_inbox_request" });
  assert.throws(() => f.apply({ action: "source.unread", requestId: randomUUID(), sourceId: "source", expectedRevision: 1, extra: true }),
    { status: 422, code: "invalid_inbox_request" });
  assert.throws(() => f.apply({ action: "source.read", requestId: randomUUID(), sourceId: "source", expectedRevision: -1 }),
    { status: 422, code: "invalid_inbox_request" });
});
