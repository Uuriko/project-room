/**
 * A member who is not a party to a direct message cannot reply into its
 * thread, and the refusal matches the one for an id that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("non-party cannot reply into a DM thread; parties and public threads still work", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dm-reply-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  try {
    store.initialize(initialRoom());
    const ownerKey = store.issueAccessKey("commons", "owner");
    for (const memberId of ["alice", "bob", "mallory"]) {
      store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: memberId, kind: "human", permissions: [] } });
    }
    const key = id => store.issueAccessKey("commons", id);
    const post = (id, data) => store.command(key(id), "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data });
    post("alice", { messageId: "pub", body: "public" });
    post("alice", { messageId: "dm", body: "private", toMemberId: "bob" });
    post("bob", { messageId: "dm-r1", body: "ok", replyToId: "dm" });
    const refusal = id => { try { post("mallory", { messageId: randomUUID(), body: "x", replyToId: id }); } catch (e) { return `${e.status}:${e.code}:${e.message}`; } return "accepted"; };
    const missing = refusal("no-such-id");
    assert.match(missing, /^422:/);
    assert.equal(refusal("dm"), missing, "DM id refusal is identical to unknown id");
    assert.equal(refusal("dm-r1"), missing, "deeper thread messages are covered too");
    post("alice", { messageId: "dm-r2", body: "party ok", replyToId: "dm-r1" });
    post("mallory", { messageId: "pub-r", body: "public reply", replyToId: "pub" });
    // A DM ancestor far up the chain must still gate the reply (no hop cap).
    // The flood guard reads store.now, so advance the clock per post.
    let clock = Date.now();
    store.now = () => clock;
    let tail = "dm-r2";
    for (let i = 0; i < 70; i++) {
      clock += 5000;
      const id = `deep-${i}`;
      post(i % 2 ? "alice" : "bob", { messageId: id, body: "chain", replyToId: tail });
      tail = id;
    }
    assert.equal(refusal(tail), missing, "DM ancestor 70+ hops up still refuses a non-party");
    post("bob", { messageId: "deep-party", body: "party deep", replyToId: tail });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
