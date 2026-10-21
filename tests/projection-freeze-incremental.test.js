import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-incremental-freeze-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, file, owner };
}

test("posting reuses a verified frozen message without inspecting its properties again", t => {
  const { store, file, owner } = fixture(t);
  const post = messageId => store.command(owner, "commons", {
    id: crypto.randomUUID(), type: "message.posted", data: { messageId, body: messageId }
  });
  post("original");
  const original = store.room("commons").state.messages.find(message => message.id === "original");
  assert.ok(Object.isFrozen(original));
  let inspections = 0;
  const descriptor = Object.getOwnPropertyDescriptor;
  Object.getOwnPropertyDescriptor = (value, key) => {
    if (value === original) inspections += 1;
    return descriptor(value, key);
  };
  try { post("next"); }
  finally { Object.getOwnPropertyDescriptor = descriptor; }
  const warm = store.room("commons");
  assert.equal(warm.state.messages.find(message => message.id === "original"), original);
  assert.equal(inspections, 0, "an unchanged validated subtree must not be walked again");
  assert.throws(() => { original.body = "changed"; }, TypeError);
  const cold = new RoomStore(file, { readOnly: true });
  try { assert.deepEqual(warm, cold.room("commons")); }
  finally { cold.close(); }
});

test("externally frozen JSON-unstable objects never bypass canonical storage reads", t => {
  const { store, file } = fixture(t);
  for (const unstable of [undefined, -0, NaN, Infinity]) {
    const state = Object.freeze({ ...store.room("commons").state,
      extension: Object.freeze({ unstable }) });
    const projection = JSON.stringify(state);
    store.transaction(() => {
      store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(projection, "commons");
      store._queueProjectionCache("commons", store.headSequence("commons"), state, projection);
    });
    const cold = new RoomStore(file, { readOnly: true });
    try { assert.deepEqual(store.room("commons"), cold.room("commons")); }
    finally { cold.close(); }
  }
});
