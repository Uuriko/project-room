// Shipped message.posted refuses file attachments rather than storing them.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore, validateCommand } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES, applyEvent, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";

test("RoomStore.command rejects message.posted attachments and accepts a text-only post", () => {
  const store = new RoomStore(":memory:");
  try {
    store.initialize(initialRoom("commons"));
    const owner = store.issueAccessKey("commons", "owner");
    assert.throws(() => store.command(owner, "commons", {
      id: randomUUID(),
      type: "message.posted",
      data: { body: "Hello without files", attachments: [{ filename: "secret.bin", bytes: [1, 2, 3] }] }
    }), { status: 422, code: "invalid_command" });
    assert.throws(() => validateCommand({
      id: randomUUID(),
      type: "message.posted",
      data: { body: "Hello without files", attachments: [{ filename: "secret.bin" }] }
    }), { status: 422, code: "invalid_command" });

    const before = store.room("commons").state.messages.length;
    store.command(owner, "commons", { id: randomUUID(), type: "message.posted", data: { body: "Hello without files" } });
    const posted = store.room("commons").state.messages.at(-1);
    assert.equal(store.room("commons").state.messages.length, before + 1);
    assert.equal(posted.body, "Hello without files");
    assert.equal(Object.hasOwn(posted, "attachments"), false);
  } finally {
    store.close();
  }
});

test("applyEvent message.posted rejects attachments instead of copying them onto messages", () => {
  const incoming = {
    id: "msg-file-ignored",
    idempotencyKey: "key-msg-file-ignored",
    roomId: "room-project-room-v0",
    type: EVENT_TYPES.MESSAGE_POSTED,
    actorId: "potter",
    at: "2026-09-05T10:00:00.000Z",
    causationId: null,
    data: { body: "No files in chat", attachments: [{ filename: "x.bin" }] }
  };
  assert.throws(() => applyEvent(replay(seedEvents), incoming), /Invalid attachments/);
  const ok = applyEvent(replay(seedEvents), { ...incoming, data: { body: "No files in chat" } });
  const posted = ok.messages.find(message => message.id === "msg-file-ignored");
  assert.equal(posted.body, "No files in chat");
  assert.equal(Object.hasOwn(posted, "attachments"), false);
});
