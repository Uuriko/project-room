// A008: unified inbox view. Pure view-builder tests; no store, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedView, UnifiedInboxError } from "../server/unified-inbox.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof UnifiedInboxError && error.code === code);
const msg = (id, occurredAt, extra = {}) => ({ id, occurredAt, subject: `s-${id}`, ...extra });
const conn = (connectionId, channel, messages) => ({ connectionId, channel, messages });

test("merges connections newest-first with per-connection attribution", () => {
  const view = buildUnifiedView([
    conn("graph-1", "email", [msg("m1", "2026-09-16T08:00:00Z"), msg("m2", "2026-09-16T09:00:00Z")]),
    conn("wa-1", "whatsapp", [msg("m3", "2026-09-16T08:30:00Z")]),
  ]);
  assert.deepEqual(view.items.map(i => i.id), ["m2", "m3", "m1"]);
  assert.equal(view.items[0].connectionId, "graph-1");
  assert.equal(view.items[1].channel, "whatsapp");
  assert.equal(view.totalCount, 3);
  assert.equal(view.nextCursor, null);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.items));
});
test("dedups mirrored message ids deterministically", () => {
  const view = buildUnifiedView([
    conn("b-conn", "email", [msg("m1", "2026-09-16T08:00:00Z", { body: "old" })]),
    conn("a-conn", "email", [msg("m1", "2026-09-16T10:00:00Z", { body: "new" })]),
  ]);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].body, "new");
  assert.equal(view.items[0].connectionId, "a-conn");
});
test("cursor pagination walks the whole inbox", () => {
  const connections = [conn("c1", "email", [
    msg("m1", "2026-09-16T08:00:00Z"), msg("m2", "2026-09-16T09:00:00Z"),
    msg("m3", "2026-09-16T10:00:00Z"), msg("m4", "2026-09-16T11:00:00Z")])];
  const first = buildUnifiedView(connections, { limit: 2 });
  assert.deepEqual(first.items.map(i => i.id), ["m4", "m3"]);
  assert.ok(first.nextCursor);
  const second = buildUnifiedView(connections, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(i => i.id), ["m2", "m1"]);
  assert.equal(second.nextCursor, null);
});
test("empty connections give an empty view", () => {
  const view = buildUnifiedView([conn("c1", "email", []), conn("c2", "telegram", [])]);
  assert.deepEqual(view.items, []);
  assert.equal(view.totalCount, 0);
  assert.equal(view.nextCursor, null);
});
test("malformed inputs are refused", () => {
  throwsCode(() => buildUnifiedView(null), "invalid_unified_inbox");
  throwsCode(() => buildUnifiedView([{ connectionId: "c1" }]), "invalid_unified_inbox");
  throwsCode(() => buildUnifiedView([conn("c1", "email", [{ id: "m1" }])]), "invalid_unified_inbox");
  throwsCode(() => buildUnifiedView([conn("c1", "email", [msg("m1", "not-a-date")])]), "invalid_unified_inbox");
  throwsCode(() => buildUnifiedView([conn("c1", "email", [])], { limit: 0 }), "invalid_unified_inbox");
  throwsCode(() => buildUnifiedView([conn("c1", "email", [])], { limit: 201 }), "invalid_unified_inbox");
  throwsCode(() => buildUnifiedView([conn("c1", "email", [])], { cursor: { occurredAt: "x" } }), "invalid_unified_inbox");
});
