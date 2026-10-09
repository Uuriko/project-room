// Reactions, thread mutes and read horizons answer a DM non-party exactly
// like an unknown id, and write nothing onto the private DM.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setReadHorizon } from "../server/activity.mjs";

const refusal = fn => { try { fn(); } catch (e) { return JSON.stringify({ status: e.status, code: e.code, message: e.message }); } return "accepted"; };

test("reactions, thread mutes and read horizons answer a DM non-party like an unknown id", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dm-misc-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  try {
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    for (const memberId of ["alice", "bob", "mallory"]) {
      store.command(owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: memberId, kind: "human", permissions: [] } });
    }
    const keys = Object.fromEntries(["alice", "bob", "mallory"].map(id => [id, store.issueAccessKey("commons", id)]));
    store.command(keys.alice, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "a2b", body: "secret", toMemberId: "bob" } });

    const react = (who, messageId) => store.command(keys[who], "commons", { id: randomUUID(), type: T.MESSAGE_REACTION_SET, data: { messageId, reaction: "\u{1F44D}", active: true } });
    const unknownReaction = refusal(() => react("mallory", "no-such"));
    assert.notEqual(unknownReaction, "accepted");
    assert.equal(refusal(() => react("mallory", "a2b")), unknownReaction);
    react("bob", "a2b");
    assert.deepEqual(Object.values(store.room("commons").state.messages.find(m => m.id === "a2b").reactions).flat(), ["bob"]);

    const mute = (who, threadId) => store.threadMutes.set(keys[who], "commons", { threadId, muted: true });
    const unknownMute = refusal(() => mute("mallory", "no-such"));
    assert.notEqual(unknownMute, "accepted");
    assert.equal(refusal(() => mute("mallory", "a2b")), unknownMute);
    assert.equal(mute("bob", "a2b").threadId, "a2b");

    const horizon = (who, id) => setReadHorizon(store, keys[who], "commons", { lastReadMessageId: id });
    const unknownHorizon = refusal(() => horizon("mallory", "no-such"));
    assert.notEqual(unknownHorizon, "accepted");
    assert.equal(refusal(() => horizon("mallory", "a2b")), unknownHorizon);
    assert.equal(horizon("bob", "a2b").lastReadMessageId, "a2b");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
