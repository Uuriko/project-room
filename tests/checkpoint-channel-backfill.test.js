import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Channels landed after rooms were already in service, so a database written
// before them has no #general anywhere. Opening it repairs rooms.projection -
// but a retained projection_checkpoint was left alone, and rebuildProjection
// starts from that checkpoint. The rebuild therefore had no default channel
// while the stored projection did, the two disagreed, and auditRecovery failed.
//
// auditRecovery gates backupRoom and loops every room, so one such room stopped
// the whole database being backed up, permanently, with nothing corrupt. A room
// busy enough to have a checkpoint is the normal case, not an edge one.
//
// The repair is one function called from both places now, because the bug was
// precisely that it existed in one of them.

function preChannelsDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-checkpoint-channels-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom("commons"));
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "m1", body: "hello" } });

  const sequence = store.room("commons").sequence;
  const withoutChannels = JSON.parse(JSON.stringify(store.room("commons").state));
  assert.ok(Object.hasOwn(withoutChannels, "channels"), "a current room has channels to remove");
  delete withoutChannels.channels;
  // Exactly what a pre-channels database looks like: neither the stored
  // projection nor the checkpoint has ever heard of a channel.
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(withoutChannels));
  store.db.prepare("INSERT OR REPLACE INTO projection_checkpoints VALUES(?,?,?)").run("commons", sequence, JSON.stringify(withoutChannels));
  store.close();
  return { filename, sequence };
}

test("a room whose checkpoint predates channels can still be audited", t => {
  const { filename } = preChannelsDatabase(t);
  const store = new RoomStore(filename);
  t.after(() => store.close());
  assert.doesNotThrow(() => auditRecovery(store), "this is what gates backupRoom for every room");
});

test("the replay and the stored projection agree about the default channel", t => {
  const { filename } = preChannelsDatabase(t);
  const store = new RoomStore(filename);
  t.after(() => store.close());

  const stored = store.room("commons").state.channels?.general;
  const rebuilt = store.rebuildProjection("commons").state.channels?.general;
  assert.ok(stored, "opening the database repairs the stored projection");
  assert.ok(rebuilt, "and a rebuild from the old checkpoint has to agree");
  for (const field of ["id", "name", "archivedAt"]) {
    assert.equal(rebuilt[field], stored[field], `${field} must match between replay and stored projection`);
  }
});

test("the checkpoint row itself is left alone", t => {
  const { filename } = preChannelsDatabase(t);
  const store = new RoomStore(filename);
  t.after(() => store.close());
  // The repair happens in memory during the rebuild, the way the work-control
  // backfill beside it does. Rewriting a retained checkpoint would be a
  // migration write on open, which is a much bigger promise to make.
  const checkpoint = store.db.prepare("SELECT projection FROM projection_checkpoints WHERE room_id='commons'").get();
  assert.ok(checkpoint, "the checkpoint is still there");
  assert.equal(Object.hasOwn(JSON.parse(checkpoint.projection), "channels"), false, "and still untouched on disk");
  assert.doesNotThrow(() => auditRecovery(store), "which the audit must tolerate");
});

test("a room that already had channels is unaffected", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-checkpoint-channels-ok-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.CHANNEL_CREATED, data: { channelId: "side", name: "side-quest" } });
  assert.deepEqual(
    Object.keys(store.rebuildProjection("commons").state.channels).sort(),
    Object.keys(store.room("commons").state.channels).sort(),
    "the repair must not invent or drop a channel in a healthy room");
  assert.doesNotThrow(() => auditRecovery(store));
});
