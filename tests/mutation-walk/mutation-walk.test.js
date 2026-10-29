// Mutation-walk property tests — #3677 PR-1 (PREP-3676-3677 §B.3/§B.4).
//
// Adapters: UNIFY-R read-cursor streams (scalar-seq, in-memory store) and
// the inbox source-list walk (compound-opaque cursor, real Inbox.list).
// Properties P1/P2/P5 run through the shared driver in harness.mjs; P3/P4
// are per-adapter below. The inbox P3 row is a PINNED KNOWN FAILURE — see
// KNOWN_FAILURES in harness.mjs: it is the §B.2 step-2 adoption evidence
// for the unsigned, unscoped inbox token, not a pass and not a fix.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMutationWalk, KNOWN_FAILURES, NOT_APPLICABLE } from "./harness.mjs";
import { createReadCursorAdapter } from "./read-cursor-adapter.mjs";
import { createInboxAdapter } from "./inbox-adapter.mjs";
import { cursorKey, UNIFY_R_STREAMS } from "../../server/read-cursor.mjs";

const SEEDS = [7, 42, 1234];

// ---------- read-cursor (UNIFY-R scalar foundation) ----------

for (const seed of SEEDS) {
  test(`read-cursor P1/P5: exactly-once + termination under seeded mutation (seed ${seed})`, async () => {
    const adapter = createReadCursorAdapter();
    // Exactly-once per incarnation is asserted inside the driver; a scalar
    // move re-keys an item to a new position (§B.3 re-entry), so per-id
    // uniqueness across a whole mutated walk is not the claim here.
    await runMutationWalk({ adapter, seed, itemCount: 12, pageSize: 3 });
    adapter.close();
  });
}

test("read-cursor P2: reads never advance durable; ack is advance-only and never past delivered", async () => {
  const adapter = createReadCursorAdapter();
  // Interleaved run that acks only delivered positions after each page.
  await runMutationWalk({ adapter, seed: 99, itemCount: 10, pageSize: 4, ackEachPage: true });
  assert.ok(adapter.durable() != null, "durable ack recorded");
  assert.ok(adapter.durable() <= adapter.highestDeliveredPos(), "durable <= highest delivered");

  // Fresh scope: walking without ack leaves durable untouched.
  const fresh = createReadCursorAdapter({ roomId: "mw-room-2" });
  fresh.seed(6);
  fresh.openWalk();
  const page = fresh.nextPage(3);
  assert.equal(page.items.length, 3);
  assert.equal(fresh.durable(), null, "reads never advance durable state");
  // Regress ack is a no-op through the real primitive.
  fresh.ack(30);
  assert.equal(fresh.durable(), 30);
  fresh.ack(10);
  assert.equal(fresh.durable(), 30, "ack regress is a no-op (advance-only MAX)");
  // Fold of disagreeing horizons takes MIN (no host skips unread work).
  assert.equal(fresh.fold([100, 40, 70]), 40);
});

test("read-cursor P3: cursorKey scopes a cursor to its room+member+stream+thread", () => {
  const base = cursorKey("m1", "needs-me", { roomId: "room-a" });
  assert.notEqual(base, cursorKey("m1", "needs-me", { roomId: "room-b" }), "room separates");
  assert.notEqual(base, cursorKey("m2", "needs-me", { roomId: "room-a" }), "member separates");
  assert.notEqual(base, cursorKey("m1", "mentions", { roomId: "room-a" }), "stream separates");
  assert.notEqual(base, cursorKey("m1", "needs-me", { roomId: "room-a", threadId: "t1" }), "thread separates");
  for (const streamId of UNIFY_R_STREAMS) {
    assert.equal(typeof cursorKey("m1", streamId, { roomId: "room-a" }), "string");
  }
  // A store scoped to room B holds nothing for the position acked in room A.
  const a = createReadCursorAdapter({ roomId: "room-a" });
  const b = createReadCursorAdapter({ roomId: "room-b" });
  a.ack(50);
  assert.equal(a.durable(), 50);
  assert.equal(b.durable(), null, "room A's ack is invisible in room B's scope");
});

test("read-cursor P4: recorded n/a — no page cap at this layer", () => {
  const row = NOT_APPLICABLE.find((r) => r.adapter === "read-cursor" && r.property === "P4");
  assert.ok(row, "P4 n/a declaration exists");
  assert.match(row.status, /no page cap at this layer/);
  const adapter = createReadCursorAdapter();
  assert.equal(adapter.capBehaviour, row.status);
});

// ---------- inbox source-list walk (compound-opaque) ----------

for (const seed of [7, 42]) {
  test(`inbox P1/P5: exactly-once + termination under seeded mutation incl. update-moves-item (seed ${seed})`, async (t) => {
    const adapter = createInboxAdapter();
    t.after(() => adapter.close());
    const result = await runMutationWalk({ adapter, seed, itemCount: 12, pageSize: 3 });
    // Stronger than per-incarnation: an inbox move bumps updated_at to the
    // front (the visited region), so no item id may ever be delivered
    // twice on this surface, however the mutations interleave.
    assert.equal(new Set(result.delivered).size, result.delivered.length,
      "inbox delivered an item twice under mutation");
  });
}

test("inbox P4: over-cap limit and malformed cursor fail loud (422), never a silent partial walk", (t) => {
  const adapter = createInboxAdapter();
  t.after(() => adapter.close());
  adapter.seed(3);
  for (const limit of [0, -1, 101, 1.5, "abc"]) {
    assert.throws(() => adapter.list({ limit }),
      (err) => err.status === 422 && err.code === "invalid_limit", `limit ${limit}`);
  }
  for (const cursor of ["!!!", Buffer.from("[]").toString("base64url"),
    Buffer.from(JSON.stringify({ updatedAt: "x", id: 1 })).toString("base64url"), 42]) {
    assert.throws(() => adapter.list({ cursor }),
      (err) => err.status === 422 && err.code === "invalid_cursor", `cursor ${JSON.stringify(cursor)}`);
  }
  // At the cap exactly is legal.
  const page = adapter.list({ limit: 100 });
  assert.equal(page.sources.length, 3);
  assert.equal(page.nextCursor, null);
});

test("inbox P3 KNOWN-FAILURE MW-P3-INBOX-UNSIGNED-UNSCOPED: a foreign account's cursor positions this account's walk", (t) => {
  // §B.3 P3 requires a cursor minted for scope A, presented to scope B, to
  // reset or error — never to position B's data. The inbox token
  // ({updatedAt, id} base64url, unsigned, no account/room binding) does
  // neither. This test pins the defective outcome EXACTLY: when the token
  // is signed/scoped, this test must go red and the KNOWN_FAILURES row
  // must be removed in the same PR. Do not "fix" this test to pass early.
  const debt = KNOWN_FAILURES.find((r) => r.id === "MW-P3-INBOX-UNSIGNED-UNSCOPED");
  assert.ok(debt, "known-failure debt row is registered");
  assert.equal(debt.status, "known-failure");

  const adapter = createInboxAdapter();
  t.after(() => adapter.close());
  adapter.seed(3); // owner sources at synthetic updated_at 999999000, 999998000, 999997000
  const ownerPage = adapter.list({ limit: 1 });
  assert.equal(ownerPage.sources.length, 1);
  const foreignCursor = ownerPage.nextCursor; // key: { updatedAt: 999999000, id: <owner newest> }

  const guest = adapter.openSecondScope();
  guest.addSource("g-001");
  guest.addSource("g-002");
  guest.setUpdatedAt("g-001", 999999500); // newer than the foreign cursor key
  guest.setUpdatedAt("g-002", 999998500); // older than the foreign cursor key

  // From the start, the guest sees both sources.
  assert.deepEqual(guest.list({ limit: 50 }).sources.map((s) => s.id).sort(), ["g-001", "g-002"]);
  // DEFECT (pinned): the owner's cursor is accepted for the guest's list —
  // no error, no reset — and silently positions the guest's walk past
  // g-001, so g-001 is never delivered on this walk.
  const positioned = guest.list({ limit: 50, cursor: foreignCursor });
  assert.deepEqual(positioned.sources.map((s) => s.id), ["g-002"],
    "foreign cursor positioned B's walk: B's newest source was skipped with no error and no reset");
});

// ---------- inventory consumption (PR-0 artifact, not a re-census) ----------

test("adapters consume the PR-0 conformance inventory: both adopter surfaces are registered", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const inventory = JSON.parse(readFileSync(join(here, "../fixtures/conformance-inventory.json"), "utf8"));
  const streams = inventory.rows.filter((r) => r.kind === "stream");
  assert.deepEqual(streams.map((r) => r.surface).sort(),
    ["stream:mcp-messages", "stream:mentions", "stream:needs-me", "stream:updates"]);
  for (const row of streams) {
    assert.equal(row.walk.cursorShape, "scalar-seq");
    assert.equal(row.walk.capBehaviour, "n/a — no page cap at this layer");
    assert.equal(row.walk.ackSemantics, "explicit-ack advance-only MAX");
  }
  const inboxList = inventory.rows.find((r) => r.routeId === "inbox.list");
  assert.ok(inboxList, "inbox list surface is in the inventory");
  const inboxWalkFile = inventory.walkFiles.find((w) => w.module === "server/inbox.mjs");
  assert.ok(inboxWalkFile, "server/inbox.mjs is a registered walk file");
  assert.equal(inboxWalkFile.definesCursorCodec, true);
  assert.equal(inboxWalkFile.cursorShape, "compound-opaque (encode/decodeCursor)");
  assert.equal(inboxWalkFile.signer, "none-declared", "inventory agrees: the inbox token is unsigned");
});
