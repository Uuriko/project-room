import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const data = { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Subject", paragraphs: ["Body."] };
function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.list = (opts) => f.store.inbox.list(f.session.token, f.session.sessionBinding, opts);
  f.addSource = (id, subject) => f.store.inbox.apply(f.session.token,
    { action: "source.save", requestId: randomUUID(), sourceId: id, expectedRevision: 0, data: { ...data, subject } },
    f.session.sessionBinding);
  return f;
}
const allPages = (f, limit) => {
  const seen = [];
  let cursor = null;
  for (;;) {
    const page = f.list({ limit, cursor });
    seen.push(...page.sources);
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
};

test("unpaginated list keeps its shape and gains a null nextCursor when everything fits", t => {
  const f = fixture(t);
  f.addSource("s-1", "First"); f.addSource("s-2", "Second");
  const result = f.list();
  assert.equal(result.contractVersion, 1);
  assert.equal(result.sources.length, 2);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.sources.map(s => s.id).sort(), ["s-1", "s-2"]);
});

test("pages walk newest-first with no duplicates or skips", t => {
  const f = fixture(t);
  for (let i = 1; i <= 60; i++) f.addSource(`s-${String(i).padStart(3, "0")}`, `Subject ${i}`);
  const p1 = f.list({ limit: 25 });
  assert.equal(p1.sources.length, 25);
  assert.equal(typeof p1.nextCursor, "string");
  const p2 = f.list({ limit: 25, cursor: p1.nextCursor });
  assert.equal(p2.sources.length, 25);
  const p3 = f.list({ limit: 25, cursor: p2.nextCursor });
  assert.equal(p3.sources.length, 10);
  assert.equal(p3.nextCursor, null);
  const ids = [...p1.sources, ...p2.sources, ...p3.sources].map(s => s.id);
  assert.equal(new Set(ids).size, 60);
  // Newest first: later-created sources sort earlier (ties break by id).
  const byRow = f.store.inbox.db.prepare("SELECT id FROM private_inbox_sources ORDER BY updated_at DESC,id").all().map(r => r.id);
  assert.deepEqual(ids, byRow);
});

test("a repeated cursor returns the same page", t => {
  const f = fixture(t);
  for (let i = 1; i <= 30; i++) f.addSource(`s-${String(i).padStart(3, "0")}`, `Subject ${i}`);
  const p1 = f.list({ limit: 10 });
  const again = f.list({ limit: 10, cursor: p1.nextCursor });
  const repeat = f.list({ limit: 10, cursor: p1.nextCursor });
  assert.deepEqual(again.sources.map(s => s.id), repeat.sources.map(s => s.id));
  assert.equal(again.nextCursor, repeat.nextCursor);
});

test("invalid cursors and limits are 422", t => {
  const f = fixture(t);
  f.addSource("s-1", "First");
  for (const cursor of ["!!!", "not-base64url!!!", Buffer.from("[]").toString("base64url"), Buffer.from(JSON.stringify({ updatedAt: "x", id: 1 })).toString("base64url"), 42])
    assert.throws(() => f.list({ cursor }), err => err.status === 422 && err.code === "invalid_cursor", `cursor ${JSON.stringify(cursor)}`);
  for (const limit of [0, -1, 101, 1.5, "abc", NaN])
    assert.throws(() => f.list({ limit }), err => err.status === 422 && err.code === "invalid_limit", `limit ${JSON.stringify(limit)}`);
});

test("string limits from query params coerce; pages stay per-account", t => {
  const f = fixture(t);
  for (let i = 1; i <= 30; i++) f.addSource(`s-${String(i).padStart(3, "0")}`, `Subject ${i}`);
  const page = f.list({ limit: "10" });
  assert.equal(page.sources.length, 10);
  assert.equal(typeof page.nextCursor, "string");
  const ids = allPages(f, 10).map(s => s.id);
  assert.equal(new Set(ids).size, 30);
  // A second account sees none of the first account's sources.
  const guest = f.store.accountForMember("commons", "guest"), key = f.store.issueAccountAccessKey(guest.id), slot = f.store.createAccountSessionSlot();
  const gs = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const guestPage = f.store.inbox.list(gs.token, gs.sessionBinding, { limit: 50 });
  assert.equal(guestPage.sources.length, 0);
  assert.equal(guestPage.nextCursor, null);
});

test("the cursor is opaque base64url carrying the row sort key", t => {
  const f = fixture(t);
  for (let i = 1; i <= 30; i++) f.addSource(`s-${String(i).padStart(3, "0")}`, `Subject ${i}`);
  const p1 = f.list({ limit: 25 });
  const key = JSON.parse(Buffer.from(p1.nextCursor, "base64url").toString("utf8"));
  assert.equal(typeof key.updatedAt, "number");
  assert.equal(key.id, p1.sources[24].id);
});
