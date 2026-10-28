import test from "node:test";
import assert from "node:assert/strict";
import { sendsOnEnter, historyConfirmsMessage, reconcileConfirmedMessageDraft } from "../src/conversation.js";

test("desktop Enter sends; touch Return and Shift+Enter insert lines", () => {
  assert.equal(sendsOnEnter({ key: "Enter" }), true);
  assert.equal(sendsOnEnter({ key: "Enter" }, true), false);
  for (const touch of [true, false]) {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      assert.equal(sendsOnEnter({ key: "Enter", [modifier]: true }, touch), true);
      assert.equal(sendsOnEnter({ key: "Enter", [modifier]: true, shiftKey: true }, touch), false);
    }
  }
});

test("composition, legacy IME, repeat, Alt and other keys never send", () => {
  for (const touch of [true, false]) {
    for (const guard of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { shiftKey: true }, { key: "a" }]) {
      assert.equal(sendsOnEnter({ key: "Enter", ctrlKey: true, ...guard }, touch), false);
    }
  }
});

const privateSend = { id: "command-1", data: { messageId: "message-1", body: "Private review", toMemberId: "reviewer", replyToId: "thread-1", channelId: "design" } };
const confirmedPrivateMessage = { id: "message-1", authorId: "owner", body: "Private review", toMemberId: "reviewer", replyToId: "thread-1", channelId: "design" };

test("matching confirmed private history resolves a lost send response", () => {
  assert.equal(historyConfirmsMessage([confirmedPrivateMessage], privateSend, "owner"), true);
  assert.equal(historyConfirmsMessage([], privateSend, "owner"), false);
});

test("optimistic, removed, edited, or differently scoped history never confirms this send", () => {
  for (const changed of [{ pendingSend: true }, { deletedAt: "2026-10-28" }, { redacted: true },
    { id: "other-message" }, { authorId: "other-author" }, { body: "Edited review" },
    { toMemberId: null }, { toMemberId: "someone-else" }, { replyToId: null },
    { replyToId: "other-thread" }, { channelId: "general" }]) {
    assert.equal(historyConfirmsMessage([{ ...confirmedPrivateMessage, ...changed }], privateSend, "owner"), false, JSON.stringify(changed));
  }
});

test("legacy command ID and omitted default channel remain reconcilable", () => {
  const command = { id: "legacy-message", data: { body: "Legacy public message" } };
  assert.equal(historyConfirmsMessage([{ id: command.id, authorId: "owner", body: command.data.body, channelId: "general", toMemberId: null, replyToId: null }], command, "owner"), true);
});

test("late confirmation clears the old retry but preserves a newer draft", () => {
  const original = { ...privateSend.data, pending: { command: { ...privateSend, type: "message.posted" } }, error: "Unconfirmed", files: [] };
  const settled = reconcileConfirmedMessageDraft(original, [confirmedPrivateMessage], "owner");
  assert.equal(settled.body, "");
  assert.equal(settled.pending, null);
  assert.equal(settled.error, "");
  assert.equal(original.body, "Private review", "original object is not mutated");
  const newer = reconcileConfirmedMessageDraft({ ...original, body: "A newer unsent draft" }, [confirmedPrivateMessage], "owner");
  assert.equal(newer.body, "A newer unsent draft");
  assert.equal(newer.pending, null);
  assert.equal(newer.error, "");
  for (const change of [{ files: [{ id: "attachment" }] }, { mode: { kind: "request" } }, { assistantDraft: { runId: "run" } }]) {
    assert.equal(reconcileConfirmedMessageDraft({ ...original, ...change }, [confirmedPrivateMessage], "owner"), null);
  }
  assert.equal(reconcileConfirmedMessageDraft(original, [], "owner"), null);
});
