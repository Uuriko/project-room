// The room owner cannot rewrite a DM between two other members, and the
// refusal matches the one for an unknown id. Owner delete is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("the owner cannot edit a DM between two other members; delete and public edits still work", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "owner-edit-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  try {
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    for (const memberId of ["alice", "bob"]) {
      store.command(owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: memberId, kind: "human", permissions: [] } });
    }
    const alice = store.issueAccessKey("commons", "alice");
    const run = (key, type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
    run(alice, T.MESSAGE_POSTED, { messageId: "alice-bob-dm", body: "PRIVATE", toMemberId: "bob" });
    run(alice, T.MESSAGE_POSTED, { messageId: "alice-pub", body: "public" });
    const edit = (key, messageId, revision = 0) => run(key, T.MESSAGE_EDITED, { messageId, body: "rewritten", expectedMessageRevision: revision });
    const refusal = fn => { try { fn(); } catch (e) { return `${e.status}:${e.code}:${e.message}`; } return "accepted"; };
    const unknown = refusal(() => edit(owner, "no-such-message"));
    assert.match(unknown, /^422:/);
    assert.equal(refusal(() => edit(owner, "alice-bob-dm")), unknown, "same answer as an unknown id");
    assert.equal(store.room("commons").state.messages.find(m => m.id === "alice-bob-dm").body, "PRIVATE");
    edit(alice, "alice-bob-dm"); // the author still edits
    edit(owner, "alice-pub"); // the owner still edits room messages
    run(owner, T.MESSAGE_DELETED, { messageId: "alice-bob-dm", expectedMessageRevision: 1 }); // and still moderates
    assert.ok(store.room("commons").state.messages.find(m => m.id === "alice-bob-dm").deletedAt);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
