/**
 * schema-convergence.test.js — qa200-reg-08 regression sweep.
 *
 * Two merges added "converge on open" behavior with no test coverage:
 *
 * - #1728 re-applies shareLinkSchema on every eager open so additive table
 *   additions inside it (e.g. share_link_join_redemptions, the #770
 *   redemption idempotency table) converge on existing databases without a
 *   schema version bump. A regression must not leave the table missing when
 *   the idempotency write path needs it.
 * - #1779 converges human_push_preferences on existing databases: rows that
 *   predate preview_enabled/quiet_hours read preview off and quiet hours
 *   unset, preserving today's counts-only delivery. The read path
 *   (_prefsFor) swallows a missing column and returns all-off prefs, so a
 *   regression here would silently flip mention/dm delivery off for every
 *   human with stored preferences — this test is the only loud check.
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

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "schema-conv-"));
const createFresh = dir => {
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  return store;
};
// A reopen runs the constructor's schema pass over an existing database.
const reopen = dir => new RoomStore(join(dir, "room.sqlite"));
const tableExists = (store, name) =>
  Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

test("eager open recreates a dropped share_link_join_redemptions table", () => {
  const dir = tmp();
  const store = createFresh(dir);
  try {
    assert.ok(tableExists(store, "share_link_join_redemptions"), "precondition: table exists after first open");
    // Simulate a database that predates the #770 redemption table.
    store.db.exec("DROP TABLE share_link_join_redemptions");
    assert.ok(!tableExists(store, "share_link_join_redemptions"), "precondition: table dropped");
  } finally {
    store.close();
  }
  const reopened = reopen(dir);
  try {
    assert.ok(tableExists(reopened, "share_link_join_redemptions"),
      "shareLinkSchema must re-converge additive tables on eager open (#1728)");
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rich-push preference columns converge on a pre-#1779 database", () => {
  const dir = tmp();
  const store = createFresh(dir);
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] },
  });
  const mayaKey = store.issueAccessKey("commons", "maya");
  try {
    // Simulate a database written before the rich-push columns existed:
    // rebuild the prefs table in its old 4-column shape with a stored row.
    store.db.exec("DROP TABLE human_push_preferences");
    store.db.exec(`CREATE TABLE human_push_preferences (
      room_id TEXT NOT NULL, member_id TEXT NOT NULL,
      mention_enabled INTEGER NOT NULL DEFAULT 1, dm_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL, PRIMARY KEY (room_id, member_id))`);
    store.db.prepare(
      "INSERT INTO human_push_preferences (room_id, member_id, mention_enabled, dm_enabled, updated_at) VALUES (?,?,?,?,?)"
    ).run("commons", "maya", 1, 1, Date.now());
  } finally {
    store.close();
  }
  const reopened = reopen(dir);
  try {
    const prefs = reopened.humanPush.preferences(mayaKey, "commons").preferences;
    assert.equal(prefs.mention, true, "the stored mention switch survives convergence");
    assert.equal(prefs.dm, true, "the stored dm switch survives convergence");
    assert.equal(prefs.preview, false, "old rows read preview off (the privacy-contract default)");
    assert.equal(prefs.quietHours, null, "old rows read quiet hours as unset");
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
