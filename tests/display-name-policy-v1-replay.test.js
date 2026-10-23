import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, applyEvent, event, replay, DISPLAY_NAME_POLICY_VERSION } from "../src/events.js";

// r50: muse-room's own log holds two member.added events stamped
// displayNamePolicyVersion 1 that the live path admitted on Oct 5-6
// ("ARION (automaton-safe)" after "ARION", "Codex QA" after "Codex").
// G16b's first-word rule later joined the v1 check without a version bump,
// so today's reducer rejects those stored events: any full replay of the
// room (which a message delete forces) parks it in messages_backfill_blocks
// and integrity's messages_backfill step fails every tick. A tightened rule
// gets a new policy version; a v1 stamp replays under the v1 rules.

function at(offset) {
  return new Date(Date.UTC(2026, 9, 5) + offset * 1000).toISOString();
}

function added(roomId, id, memberId, displayName, offset, version = 1) {
  return event({
    type: T.MEMBER_ADDED, actorId: "owner", roomId, id, idempotencyKey: `${id}-key`, at: at(offset),
    data: { memberId, displayName, kind: "agent", permissions: ["accept_work"], displayNamePolicyVersion: version }
  });
}

function posted(roomId, id, actorId, messageId, body, offset) {
  return event({ type: T.MESSAGE_POSTED, actorId, roomId, id, idempotencyKey: `${id}-key`, at: at(offset), data: { messageId, body } });
}

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "r50-display-name-policy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test("live writes stamp display-name policy v3", () => {
  assert.equal(DISPLAY_NAME_POLICY_VERSION, 3);
});

test("a v1-stamped name that only the G16b first-word rule refuses still replays", () => {
  const base = replay([...initialRoom("r"), added("r", "e1", "arion", "ARION", 10)]);
  const legacy = added("r", "e2", "arion-safe", "ARION (automaton-safe)", 11, 1);
  const state = applyEvent(base, legacy);
  assert.equal(state.members["arion-safe"].displayName, "ARION (automaton-safe)");
  const codexBase = applyEvent(base, added("r", "e3", "codex", "Codex", 12));
  assert.equal(applyEvent(codexBase, added("r", "e4", "codex-qa", "Codex QA", 13, 1)).members["codex-qa"].displayName, "Codex QA");
});

test("the same name stamped v2 is refused as confusable (G16b kept for new writes)", () => {
  const base = replay([...initialRoom("r"), added("r", "e1", "arion", "ARION", 10, 2)]);
  assert.throws(() => applyEvent(base, added("r", "e2", "arion-safe", "ARION (automaton-safe)", 11, 2)), /too easy to confuse/);
});

test("v1 keeps the v1 rules: duplicate and reserved names still refuse on replay", () => {
  const base = replay([...initialRoom("r"), added("r", "e1", "arion", "ARION", 10)]);
  assert.throws(() => applyEvent(base, added("r", "e2", "dup", "arion", 11, 1)), /already used/);
  assert.throws(() => applyEvent(base, added("r", "e3", "res", "admin", 12, 1)), /reserved/);
});

test("a delete-forced full replay no longer parks a room whose log holds a v1 first-word name", t => {
  const store = open(t);
  store.initialize([
    ...initialRoom("aaa"),
    added("aaa", "ev-arion", "arion", "ARION", 10),
    added("aaa", "ev-standin", "arion-safe", "Ari Seat", 11),
    posted("aaa", "ev-m1", "arion-safe", "m1", "first", 12),
    posted("aaa", "ev-m2", "owner", "m2", "second", 13),
    posted("aaa", "ev-m3", "owner", "m3", "third", 14)
  ]);
  // Rewrite the stand-in to the shape the Oct 5 build admitted (the live path
  // today refuses to write it, which is the point).
  const row = store.db.prepare("SELECT body FROM events WHERE id='ev-standin'").get();
  const stored = JSON.parse(row.body);
  stored.data.displayName = "ARION (automaton-safe)";
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(stored));
  const projectionRow = store.db.prepare("SELECT projection FROM rooms WHERE id='aaa'").get();
  const projection = JSON.parse(projectionRow.projection);
  projection.members["arion-safe"].displayName = "ARION (automaton-safe)";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa'").run(JSON.stringify(projection));

  const first = store.backfillMessages({ limit: 1000 });
  assert.equal(first.done, true);
  assert.deepEqual(first.blocked ?? [], []);
  // commitMessageRedaction (a message delete) discards the replay snapshot
  // (state_json NULL, state_seq 0), so the next fill replays the room from
  // sequence 0 through today's reducer. Step the cursor back one event to
  // stand in for the event that arrives after the delete.
  const head = store.db.prepare("SELECT sequence, id FROM events WHERE room_id='aaa' ORDER BY sequence DESC LIMIT 2").all();
  store.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='aaa'").run();
  store.db.prepare("UPDATE messages_backfill_cursor SET state_seq=0, applied_seq=?, applied_event_id=? WHERE room_id='aaa'")
    .run(head[1].sequence, head[1].id);
  store.db.prepare("DELETE FROM messages WHERE room_id='aaa' AND message_id='m3'").run();
  const second = store.backfillMessages({ limit: 1000 });
  assert.equal(second.done, true);
  assert.deepEqual(second.blocked ?? [], [], "no block: the v1 stamp replays under v1 rules");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id='aaa'").get().n, 3);
});
