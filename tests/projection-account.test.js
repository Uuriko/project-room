// Projection bytes are a stored row, not a guess. The breakdown is sizes
// only, and a settled compact still serves history that never had a
// messages-table row.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { accountProjection, accountStoredRoom } from "../server/projection-account.mjs";
import { compactRoomProjection } from "../server/projection-compact.mjs";
import { readConversation } from "../server/conversation-sync.mjs";

const SENTINEL = "SENTINEL-BODY-TEXT-SHOULD-NOT-LEAK";

test("projection components add up to the stored row and do not carry text", () => {
  const state = {
    room: { id: "commons", title: "Commons" },
    members: {
      owner: { id: "owner", displayName: "Owner", statusMessage: "watching the board" },
      agent: { id: "agent", displayName: "Agent" }
    },
    channels: { general: { id: "general", name: "general" } },
    messages: [
      {
        id: "a", body: SENTINEL, kind: "receipt_card", claimId: "c", title: "done",
        workItemId: null, replyToId: null, toMemberId: null,
        editHistory: [{ body: "older wording" }]
      },
      { id: "b", bodyRef: "ab".repeat(32), _nul: 1, _entity: 1 },
      { id: "c", body: "short" }
    ],
    workItems: {
      inline: {
        id: "inline", title: "Keep",
        receiptHistory: [{ n: 1 }, { n: 2 }],
        verificationHistory: [{ n: 1 }],
        decisionHistory: [{ n: 1 }],
        handoffHistory: [{ n: 1 }],
        attempts: [{ n: 1 }],
        evidenceWithdrawals: [{ messageId: "a" }]
      },
      ref: { _workEntity: 1, id: "ref", revision: 1, digest: "d".repeat(64) }
    },
    pins: [{ messageId: "a" }],
    replyRequests: { a: { id: "a" } },
    messagesArchive: { throughSeq: 4, count: 9, retainedIds: ["a"] }
  };
  const text = JSON.stringify(state);
  const account = accountProjection(text);
  assert.equal(account.readable, true);
  assert.equal(account.components.reduce((sum, component) => sum + component.bytes, 0), account.projectionBytes);
  assert.equal(account.projectionBytes, Buffer.byteLength(text));
  assert.equal(JSON.stringify(account).includes(SENTINEL), false);
  assert.equal(JSON.stringify(account).includes("watching the board"), false);
  assert.equal(account.messages.count, 3);
  assert.equal(account.messages.entityRefs, 1);
  assert.equal(account.messages.receiptCards, 1);
  assert.ok(account.messages.inlineBodyBytes >= Buffer.byteLength(SENTINEL));
  assert.equal(account.messages.bodyRefBytes, 64);
  assert.equal(account.messages.nullTriplets, 1);
  assert.equal(account.messages.nullEnvelopes, 1);
  assert.ok(account.messages.nullEnvelopeSavedBytes > 0);
  assert.equal(account.messages.editHistoryEntries, 1);
  assert.equal(account.members.count, 2);
  assert.equal(account.members.statusLines, 1);
  assert.ok(account.members.statusBytes > 0);
  assert.equal(account.board.count, 2);
  assert.equal(account.board.entityRefs, 1);
  assert.equal(account.board.unbounded.receiptHistory.entries, 2);
  assert.equal(account.board.unbounded.evidenceWithdrawals.entries, 1);
  assert.equal(account.retainedHistory.archivedMessages, 9);
  assert.equal(account.retainedHistory.pins, 1);
  assert.deepEqual(account.jobRecords, { bytes: 0, inProjection: false });
  const messages = account.components.find(component => component.name === "messages");
  const board = account.components.find(component => component.name === "board");
  assert.ok(messages.bytes > 0);
  assert.ok(board.bytes > 0);
  const blank = accountProjection("not-json");
  assert.equal(blank.readable, false);
  assert.equal(blank.projectionBytes, Buffer.byteLength("not-json"));
  assert.equal(JSON.stringify(blank).includes("not-json"), false);
});

test("a room with no messages rows still compacts, and one stale row does not block the rest", t => {
  const directory = mkdtempSync(join(tmpdir(), "projection-account-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename, { bodiesAtRest: true });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  store.roomFlood = { consume() {} };
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  const token = "paged-history-token";
  for (let i = 0; i < 40; i += 1) {
    const body = i === 3 ? `${token} ${"x".repeat(240)}` : `note ${i} `.padEnd(256, "x");
    send(T.MESSAGE_POSTED, { messageId: `m-${i}`, body });
  }
  const before = accountStoredRoom(store.db, "commons");
  assert.equal(before.components.reduce((sum, component) => sum + component.bytes, 0), before.projectionBytes);
  assert.equal(JSON.stringify(before).includes(token), false);
  assert.ok(before.outsideProjection.messageRows > 0);
  assert.ok(before.outsideProjection.projectionBodiesBytes > before.messages.inlineBodyBytes);
  store.db.prepare("UPDATE messages SET body=?, record_json=? WHERE message_id=?").run(
    "stale-body", JSON.stringify({ id: "m-0", body: "stale-body" }), "m-0");
  store.db.prepare("DELETE FROM messages WHERE message_id != ?").run("m-0");
  let archived = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const result = compactRoomProjection(store, "commons", { keepNewest: 5 });
    assert.equal(result.ok, true, JSON.stringify({ archived: result.archived, reason: result.reason, mismatches: result.mismatches }));
    archived += result.archived;
    if (!result.archived) break;
  }
  assert.ok(archived > 20, `archived ${archived}`);
  const hot = new Set(store.room("commons").state.messages.map(message => message.id));
  assert.equal(hot.has("m-0"), true);
  assert.equal(hot.has("m-3"), false);
  const found = store.search(owner, "commons", token, "messages");
  assert.equal(found.messages.some(message => message.body.includes(token)), true);
  const page = readConversation(store, owner, "commons", { messageId: "m-3" });
  assert.equal(page.messages[0].body.includes(token), true);
  const audit = store.db.prepare("SELECT counts_json FROM operator_actions WHERE action=?").all("projection_compact");
  assert.ok(audit.length > 0);
  const auditText = JSON.stringify(audit);
  assert.equal(auditText.includes(token), false);
  assert.equal(auditText.includes("stale-body"), false);
  const after = accountStoredRoom(store.db, "commons");
  assert.ok(after.projectionBytes < before.projectionBytes / 2, `${before.projectionBytes} -> ${after.projectionBytes}`);
  assert.equal(JSON.stringify(after).includes(token), false);
});
