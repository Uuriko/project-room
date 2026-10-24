// A busy agent room, shaped like production: bodies at rest, many members,
// and a messages table that never received the historical rows. Settled
// compaction has to shrink the hot projection without losing a page or a
// search hit, and later posts have to stay inside the hot window.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { accountStoredRoom } from "../server/projection-account.mjs";
import { HOT_MESSAGE_WINDOW, compactRoomProjection, productionProjectionOptions } from "../server/projection-compact.mjs";
import { readConversation } from "../server/conversation-sync.mjs";

const HISTORY = 22_000;
const TOKEN = "kept-history-token";

function open(filename, options) {
  const store = new RoomStore(filename, { bodiesAtRest: true, ...options });
  store.roomFlood = { consume() {} };
  return store;
}

test("a busy room's hot projection shrinks and older history stays readable", { timeout: 600_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), "projection-hot-"));
  const filename = join(directory, "room.sqlite");
  let store = open(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  for (let i = 0; i < 40; i += 1) {
    send(T.MEMBER_ADDED, { memberId: `relay${i}`, displayName: `Relay${i}`, kind: "agent", permissions: [] });
  }
  const bodyFor = (i, extra = "") => `${extra}note ${i} `.padEnd(256, "x");
  send(T.MESSAGE_POSTED, { messageId: "m-0", body: bodyFor(0) });
  send(T.MESSAGE_POSTED, { messageId: "m-1", body: bodyFor(1) });
  send(T.MESSAGE_POSTED, { messageId: "m-2", body: `${TOKEN} ${"x".repeat(240)}` });
  send(T.MESSAGE_PINNED, { messageId: "m-1" });
  send(T.WORK_PROPOSED, {
    workItemId: "board-1", title: "Keep the board", definitionOfDone: "The board stays hot",
    accountableMemberId: "owner", sourceMessageId: "m-1"
  });
  send(T.MEMBER_STATUS_UPDATED, { message: "watching the room" });
  const bytes = () => store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='commons'").get().n;
  let posted = 3;
  for (let i = posted; i < HISTORY; i += 1) {
    if (i % 100 === 0 && bytes() > 3_550_000) break;
    send(T.MESSAGE_POSTED, { messageId: `m-${i}`, body: bodyFor(i) });
    posted += 1;
  }
  const before = accountStoredRoom(store.db, "commons");
  assert.equal(JSON.stringify(before).includes(TOKEN), false);
  assert.equal(before.components.reduce((sum, component) => sum + component.bytes, 0), before.projectionBytes);
  const messageBytes = before.components.find(component => component.name === "messages").bytes;
  assert.ok(messageBytes > before.projectionBytes * 0.8, `messages ${messageBytes} of ${before.projectionBytes}`);
  assert.ok(before.projectionBytes > 3_500_000, `projection ${before.projectionBytes} after ${posted} messages`);
  assert.equal(before.jobRecords.inProjection, false);
  assert.ok(before.members.count >= 40);
  assert.equal(before.members.statusLines, 1);
  assert.ok(before.messages.bodyRefBytes > before.messages.inlineBodyBytes);
  store.db.prepare("DELETE FROM messages").run();
  store.close();
  store = open(filename, productionProjectionOptions());
  let archived = 0;
  let passes = 0;
  for (; passes < 8; passes += 1) {
    const result = compactRoomProjection(store, "commons", { keepNewest: HOT_MESSAGE_WINDOW });
    assert.equal(result.ok, true, JSON.stringify({ reason: result.reason, archived: result.archived, prepared: result.prepared }));
    archived += result.archived;
    if (!result.archived) break;
  }
  const after = accountStoredRoom(store.db, "commons");
  const hot = store.room("commons").state.messages;
  console.log(JSON.stringify({
    posted,
    passes,
    archived,
    beforeBytes: before.projectionBytes,
    afterBytes: after.projectionBytes,
    beforeComponents: before.components,
    afterComponents: after.components,
    beforeMessages: before.messages,
    afterMessages: { count: after.messages.count, entityRefs: after.messages.entityRefs, bodyRefBytes: after.messages.bodyRefBytes, inlineBodyBytes: after.messages.inlineBodyBytes, nullEnvelopes: after.messages.nullEnvelopes, receiptCards: after.messages.receiptCards },
    members: before.members,
    board: { count: before.board.count, entityRefs: before.board.entityRefs, inlineBytes: before.board.inlineBytes },
    outsideBefore: before.outsideProjection,
    outsideAfter: { messageRows: after.outsideProjection.messageRows, messageBodiesBytes: after.outsideProjection.messageBodiesBytes },
    hotMessages: hot.length
  }));
  assert.ok(passes < 8, "compaction did not finish");
  assert.ok(after.projectionBytes < before.projectionBytes / 5, `${before.projectionBytes} -> ${after.projectionBytes}`);
  assert.ok(hot.length <= HOT_MESSAGE_WINDOW + 20, `hot messages ${hot.length}`);
  assert.equal(hot.some(message => message.id === "m-1"), true);
  assert.equal(hot.some(message => message.id === "m-2"), false);
  const found = store.search(owner, "commons", TOKEN, "messages");
  assert.equal(found.messages.some(message => message.body.includes(TOKEN)), true);
  const page = readConversation(store, owner, "commons", { messageId: "m-2" });
  assert.equal(page.messages[0].body.includes(TOKEN), true);
  const reply = send(T.MESSAGE_POSTED, { messageId: "reply-1", body: "still here", replyToId: "m-2" });
  assert.equal(typeof reply.sequence, "number");
  const extra = HOT_MESSAGE_WINDOW * 2 + 50;
  for (let i = 0; i < extra; i += 1) send(T.MESSAGE_POSTED, { messageId: `later-${i}`, body: `later ${i} `.padEnd(256, "y") });
  const later = store.room("commons").state.messages;
  assert.ok(later.length <= HOT_MESSAGE_WINDOW + 80, `later hot messages ${later.length}`);
  assert.ok(bytes() < before.projectionBytes / 5, `later projection ${bytes()}`);
  assert.equal(store.search(owner, "commons", TOKEN, "messages").messages.some(message => message.body.includes(TOKEN)), true);
  assert.equal(JSON.stringify(after).includes(TOKEN), false);
});
