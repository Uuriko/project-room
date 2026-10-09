/**
 * search-work-newest-integer-ids.test.js — ch-2075 adversarial challenge of #2075.
 *
 * #2075 kept the newest `limit` work matches by iterating
 * Object.values(room.state.workItems) and shifting off the oldest. But JS
 * objects enumerate integer-like keys ("2","10","9") in ascending NUMERIC
 * order regardless of insertion order, so for numeric ids (validId permits
 * them) the window kept the numerically-largest ids, not the newest-created
 * items. The fix orders by createdAt (stable sort) instead of key order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ch2075-break1-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  return { dir, store, ownerKey: store.issueAccessKey("commons", "owner") };
}

function propose(store, ownerKey, workItemId) {
  store.command(ownerKey, "commons", {
    id: randomUUID(),
    type: T.WORK_PROPOSED,
    data: {
      workItemId, title: `numeric task ${workItemId}`, definitionOfDone: "done",
      accountableMemberId: "owner", mode: "write",
      independentVerificationRequired: false, ownerDecisionRequired: false,
    },
  });
}

test("capped work search keeps the NEWEST-created matches even for integer-like ids", () => {
  const { dir, store, ownerKey } = fixture();
  try {
    // Proposed in this order: "2" oldest, then "10", then "9" newest.
    propose(store, ownerKey, "2");
    propose(store, ownerKey, "10");
    propose(store, ownerKey, "9");
    const page = store.search(ownerKey, "commons", "numeric task", "work", null, { limit: 2 });
    assert.equal(page.total, 3, "match count covers every hit");
    assert.deepEqual(page.workItems.map(w => w.id), ["10", "9"],
      "must keep the two newest-CREATED matches, not the two numerically-largest ids");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
