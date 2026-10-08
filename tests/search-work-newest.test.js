/**
 * search-work-newest.test.js — qa200-reg-08 regression sweep.
 *
 * #2024 ("Keep newest matches in capped search pages") fixed the messages
 * loop in store.search to keep the NEWEST `limit` matches, because with no
 * offset and a 200 ceiling every match after the oldest ones was unreachable.
 * The workItems loop kept the old behavior (first `limit` hits), so the same
 * defect survived for kind="work"/"all": newer work items were unreachable.
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
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "search-work-newest-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  return { dir, store, ownerKey: store.issueAccessKey("commons", "owner") };
}

test("a capped work search page keeps the newest matches, oldest first", () => {
  const { dir, store, ownerKey } = fixture();
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = `w${i}`;
      ids.push(id);
      store.command(ownerKey, "commons", {
        id: randomUUID(),
        type: T.WORK_PROPOSED,
        data: {
          workItemId: id, title: `gamma task ${i}`, definitionOfDone: "done",
          accountableMemberId: "owner", mode: "write",
          independentVerificationRequired: false, ownerDecisionRequired: false,
        },
      });
    }
    const page = store.search(ownerKey, "commons", "gamma", "work", null, { limit: 2 });
    assert.equal(page.total, 5, "the match count covers every hit, not just the page");
    assert.deepEqual(page.workItems.map(w => w.id), ids.slice(-2),
      "capped work pages must keep the newest matches like message pages do (#2024)");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
