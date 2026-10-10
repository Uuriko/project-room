// QA plan points 1, 2 and 6: a refused storage write must preserve the
// committed message history; an exact retry after recovery must commit once;
// closing and reopening the persistent store must preserve those same bytes.
// This is a synthetic, isolated SQLite fixture. It makes no production calls.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, StorageUnavailableError } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const command = (id, messageId, body) => ({
  id,
  type: T.MESSAGE_POSTED,
  data: { messageId, body },
});

const count = (store, table) => store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE room_id=?`).get("commons").n;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-storage-sequence-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner");
  const snapshot = () => ({
    sequence: store.room("commons").sequence,
    eventCount: count(store, "events"),
    commandCount: count(store, "commands"),
  });
  const pinFull = () => {
    store.db.exec("VACUUM");
    store.db.exec(`PRAGMA max_page_count=${store.db.prepare("PRAGMA page_count").get().page_count}`);
  };
  const restoreCapacity = () => store.db.exec("PRAGMA max_page_count=1073741823");
  t.after(() => {
    try { store.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    filename,
    get store() { return store; },
    set store(next) { store = next; },
    owner,
    snapshot,
    pinFull,
    restoreCapacity,
  };
}

test("storage refusal, exact retry and persistent reopen preserve committed message bytes exactly once", t => {
  const f = fixture(t);
  const originalId = "storage-sequence-original";
  const originalBody = "Committed before storage refusal: " + "A".repeat(6000);
  const original = f.store.command(f.owner, "commons", command("storage-command-original", originalId, originalBody));
  assert.equal(original.duplicate, false);

  f.pinFull();
  let refusedCommand;
  let beforeRefusal;
  for (let attempt = 0; attempt < 24; attempt++) {
    const candidate = command(
      `storage-sequence-retry-${attempt}`,
      `storage-sequence-retry-message-${attempt}`,
      `Exact retry after recovery ${attempt}: ` + "B".repeat(6000),
    );
    beforeRefusal = f.snapshot();
    try {
      f.store.command(f.owner, "commons", candidate);
    } catch (error) {
      assert.ok(error instanceof StorageUnavailableError, error.message);
      refusedCommand = candidate;
      break;
    }
  }
  assert.ok(refusedCommand, "the real SQLite file did not reach SQLITE_FULL during bounded writes");
  assert.deepEqual(f.snapshot(), beforeRefusal, "the rejected write changed no event, command, sequence, or projection");
  assert.equal(f.store.room("commons").state.messages.some(message => message.id === refusedCommand.data.messageId), false);

  f.restoreCapacity();
  const committed = f.store.command(f.owner, "commons", refusedCommand);
  assert.equal(committed.duplicate, false, "a previously refused command remains eligible for its exact retry");
  const duplicate = f.store.command(f.owner, "commons", refusedCommand);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sequence, committed.sequence);
  const beforeRestart = f.snapshot();
  assert.equal(beforeRestart.sequence, beforeRefusal.sequence + 1,
    "only the exact retry advances the sequence after the refused command");

  f.store.close();
  f.store = new RoomStore(f.filename);
  const reopened = f.store;
  const messages = reopened.room("commons").state.messages;
  assert.equal(messages.find(message => message.id === originalId)?.body, originalBody);
  assert.equal(messages.find(message => message.id === refusedCommand.data.messageId)?.body, refusedCommand.data.body);
  assert.equal(messages.filter(message => message.id === refusedCommand.data.messageId).length, 1);

  const rows = reopened.db.prepare("SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence").all("commons");
  const retryEvents = rows.map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }))
    .filter(row => row.event.type === T.MESSAGE_POSTED && row.event.data.messageId === refusedCommand.data.messageId);
  assert.deepEqual(retryEvents, [{ sequence: committed.sequence, event: committed.event }],
    "the persisted event journal contains the exact retried event once");
  const commandRows = reopened.db.prepare("SELECT sequence FROM commands WHERE room_id=? AND actor_id=? AND id=?")
    .all("commons", "owner", refusedCommand.id);
  assert.deepEqual(commandRows.map(row => row.sequence), [committed.sequence], "the command journal records the retry once");
  assert.deepEqual({
    sequence: reopened.room("commons").sequence,
    eventCount: count(reopened, "events"),
    commandCount: count(reopened, "commands"),
  }, beforeRestart, "reopen preserves committed counts and head");
});
