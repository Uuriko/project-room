import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { event, EVENT_TYPES, replay } from "../src/events.js";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "legacy-event-recovery-"));
  const store = new RoomStore(join(dir, "source.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const legacy = event({ type: "message.reaction_set", roomId: "commons", actorId: "owner", data: { messageId: "old-message", reaction: "heart" } });
  store.initialize([...initialRoom(), legacy]);
  return { store, legacy, dir };
}
test("historical reaction survives strict backup recovery without enabling new commands", t => {
  const { store, legacy, dir } = fixture(t);
  assert.doesNotThrow(() => auditRecovery(store));
  const receipt = replayNdjson(exportNdjsonText(store.db), join(dir, "restored.sqlite"));
  assert.equal(receipt.verified, true);
  assert.equal(receipt.events, 3);
  assert.equal(Object.values(EVENT_TYPES).includes(legacy.type), false);
  const key = store.issueAccessKey("commons", "owner");
  const before = store.room("commons").sequence;
  assert.throws(() => store.command(key, "commons", { id: "new-reaction", type: legacy.type, data: legacy.data }));
  assert.equal(store.room("commons").sequence, before);
});
test("unknown historical event is still rejected by replay", () => {
  assert.throws(() => replay([...initialRoom(), event({ type: "message.unknown_legacy", roomId: "commons", actorId: "owner", data: {} })]), /Unsupported event type/);
});
test("legacy compatibility does not waive envelope validation", t => {
  const { store, legacy } = fixture(t);
  store.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify({ ...legacy, at: "invalid-date" }), legacy.id);
  assert.throws(() => auditRecovery(store));
});
