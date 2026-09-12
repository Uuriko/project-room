import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-notifications-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const set = (token, preferences) => store.command(token, "commons",
    { id: randomUUID(), type: T.NOTIFICATION_PREFERENCES_SET, data: { preferences } });
  return { store, ownerKey, agentKey, set };
}

test("member notification preferences (round-2 #114)", async t => {
  const { store, agentKey, set } = fixture(t);

  // Partial update merges over defaults.
  set(agentKey, { mentions: "mentions_only", work_updates: "none" });
  let prefs = store.room("commons").state.members.agent.notificationPreferences;
  assert.deepEqual(prefs, { mentions: "mentions_only", replies: "all", work_updates: "none", announcements: "all" });

  // Second update merges again.
  set(agentKey, { replies: "none" });
  prefs = store.room("commons").state.members.agent.notificationPreferences;
  assert.equal(prefs.replies, "none");
  assert.equal(prefs.mentions, "mentions_only");

  // Unknown channel / level rejected.
  assert.throws(() => set(agentKey, { bogus: "all" }), /Unknown notification channel/);
  assert.throws(() => set(agentKey, { mentions: "everything" }), /Unknown notification level/);
  assert.throws(() => set(agentKey, "all"), /Invalid field/);

  // Preferences survive a snapshot read.
  const room = store.room("commons");
  assert.equal(room.state.members.agent.notificationPreferences.announcements, "all");
});

test("notification validation: preferences object-only, array fields array-only", async t => {
  const { store, ownerKey, agentKey, set } = fixture(t);

  // preferences rejects arrays and strings, accepts plain objects.
  assert.throws(() => set(agentKey, ["mentions_only"]), /Invalid field: preferences/);
  assert.throws(() => set(agentKey, "all"), /Invalid field: preferences/);
  set(agentKey, { mentions: "none" });
  assert.equal(store.room("commons").state.members.agent.notificationPreferences.mentions, "none");

  // Array fields reject plain objects: permissions must be an array.
  assert.throws(() => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: "badagent", displayName: "Bad", kind: "agent", permissions: { accept_work: true } } }),
    /Invalid field: permissions/);
  // capabilities must be an array.
  assert.throws(() => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.CAPABILITIES_ADVERTISED, data: { capabilities: { draft: true } } }),
    /Invalid field: capabilities/);
});
