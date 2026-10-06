// Regression: server/pins.mjs's HTTP pre-check must agree with the
// pinMessage reducer (src/events.js) on which messages are pinnable. A live
// message whose body was scrubbed to null with redacted:true (log rewrite
// without a delete — the account-deletion scrub + projection rebuild flow)
// is NOT deleted: the reducer accepts the pin via its redacted carve-out,
// so the HTTP pre-check must not 409 it as a deleted message.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setPin } from "../server/pins.mjs";
import { redactRemainingMessageBodies } from "../server/message-redaction.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-pins-redacted-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  return { store, ownerKey, cmd };
}

// Mirror server/account-deletion.mjs: scrub the log bodies, drop the
// checkpoint, and rebuild the projection from the rewritten log.
function scrubAndRebuild(store) {
  store.transaction(() => redactRemainingMessageBodies(store.db, "commons"));
  store.db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run("commons");
  const rebuilt = store.rebuildProjection("commons");
  store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?")
    .run(rebuilt.sequence, JSON.stringify(rebuilt.state), "commons");
}

test("setPin and the pin reducer agree on a live redacted message", t => {
  const { store, ownerKey, cmd } = fixture(t);
  const pinTarget = randomUUID(), writePath = randomUUID(), tombstone = randomUUID();
  cmd(T.MESSAGE_POSTED, { messageId: pinTarget, body: "scrubbed but live" });
  cmd(T.MESSAGE_POSTED, { messageId: writePath, body: "scrubbed but live" });
  cmd(T.MESSAGE_POSTED, { messageId: tombstone, body: "to be deleted" });
  cmd(T.MESSAGE_DELETED, { messageId: tombstone, expectedMessageRevision: 0, reason: "cleanup" });
  scrubAndRebuild(store);

  const scrubbed = store.room("commons").state.messages.find(m => m.id === pinTarget);
  assert.equal(scrubbed.body, null);
  assert.equal(scrubbed.redacted, true);
  assert.ok(!scrubbed.deletedAt, "a scrubbed message is live, not deleted");

  // The write path accepts the pin (the reducer's redacted carve-out).
  const receipt = cmd(T.MESSAGE_PINNED, { messageId: writePath });
  assert.equal(receipt.event.type, "message.pinned");

  // ...so the HTTP pre-check must not refuse it as a deleted message.
  const result = setPin(store, ownerKey, "commons", { messageId: pinTarget, pinned: true });
  assert.equal(result.pinned, true);
  assert.equal(result.changed, true);

  // A real tombstone is still refused on the HTTP path.
  assert.throws(
    () => setPin(store, ownerKey, "commons", { messageId: tombstone, pinned: true }),
    { status: 409, code: "message_deleted" }
  );
});
