import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { growthCollector, growthFanout } from "../src/growth-emit.js";
import { saveToFile, loadFromFile } from "../src/growth-persistence.js";
import { DurableDatabase, durableStorage } from "../cloudflare/storage.mjs";
import { createDoContext } from "./helpers/do-storage-emulator.mjs";

function fixture(t, platform) {
  const directory = mkdtempSync(join(tmpdir(), "room-growth-commit-"));
  const filename = join(directory, "room.sqlite");
  const ctx = platform === "durable" ? createDoContext() : null;
  let store = ctx ? new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage }) : new RoomStore(filename);
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  const prefix = crypto.randomUUID();
  const notices = [];
  const subscription = growthFanout.subscribe(envelope => envelope.fields.messageId?.startsWith(prefix), envelope => {
    notices.push({ id: envelope.fields.messageId, inTransaction: store.db.isTransaction,
      persisted: store.db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(body,'$.data.messageId')=?").get(envelope.fields.messageId).n });
  });
  t.after(() => { growthFanout.unsubscribe(subscription); store.close(); ctx?.storage.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (suffix, body = "synthetic message") => ({ id: `${prefix}-${suffix}`, type: "message.posted", data: { messageId: `${prefix}-${suffix}`, body } });
  const emitCount = () => growthCollector.query({ type: "message.sent", limit: 1000 }).filter(e => e.fields.messageId.startsWith(prefix)).length;
  return { store, key, command, notices, emitCount, directory, reopen() { store.close(); store = new RoomStore(filename); return store; } };
}

for (const platform of ["node", "durable"]) {
  test(`${platform}: refused commands and outer rollbacks emit no growth; retry and receipt replay emit once`, t => {
    const f = fixture(t, platform), { store, key, command } = f;
    assert.throws(() => store.command(key, "commons", command("invalid", " ")), /body/);
    store.db.exec("CREATE TEMP TRIGGER growth_refusal BEFORE INSERT ON events WHEN json_extract(NEW.body,'$.type')='message.posted' BEGIN SELECT RAISE(ABORT,'synthetic event refusal'); END");
    assert.throws(() => store.command(key, "commons", command("retry")), /synthetic event refusal/);
    store.db.exec("DROP TRIGGER growth_refusal");
    assert.throws(() => store.transaction(() => {
      store.command(key, "commons", command("outer"));
      throw new Error("outer rollback");
    }), /outer rollback/);
    assert.equal(f.emitCount(), 0);
    assert.deepEqual(f.notices, []);
    assert.equal(store.room("commons").sequence, 2);
    const retried = store.command(key, "commons", command("retry"));
    assert.equal(retried.duplicate, false);
    assert.equal(store.command(key, "commons", command("retry")).duplicate, true);
    assert.equal(f.emitCount(), 1);
    assert.deepEqual(f.notices, [{ id: command("retry").data.messageId, inTransaction: false, persisted: 1 }]);
    if (platform === "node") {
      const snapshot = join(f.directory, "growth.json");
      saveToFile(snapshot, growthCollector);
      assert.equal(loadFromFile(snapshot).collector.query({ type: "message.sent", limit: 1000 }).filter(e => e.fields.messageId === command("retry").data.messageId).length, 1);
      const reopened = f.reopen();
      assert.equal(reopened.command(key, "commons", command("retry")).duplicate, true);
      assert.equal(f.emitCount(), 1);
      assert.equal(f.notices.length, 1);
    }
  });

  test(`${platform}: isolated rollback discards only its growth events and nested success waits for outer commit`, t => {
    const f = fixture(t, platform), { store, key, command } = f;
    store.transaction(() => {
      store.command(key, "commons", command("first"));
      assert.throws(() => store.transaction(() => {
        store.command(key, "commons", command("isolated"));
        throw new Error("isolated rollback");
      }, { isolated: true }), /isolated rollback/);
      store.transaction(() => store.command(key, "commons", command("last")), { isolated: true });
      assert.equal(f.emitCount(), 0);
      assert.equal(f.notices.length, 0);
    });
    assert.equal(f.emitCount(), 2);
    assert.deepEqual(f.notices.map(n => n.id), [command("first").data.messageId, command("last").data.messageId]);
    assert.equal(f.notices.every(n => !n.inTransaction && n.persisted === 1), true);
    assert.equal(store.room("commons").state.messages.some(m => m.id === command("isolated").data.messageId), false);
  });

  test(`${platform}: failed commit emits nothing and listener exceptions cannot fail a durable command`, t => {
    const f = fixture(t, platform), { store, key, command } = f;
    store.db.exec("CREATE TABLE growth_commit_guard (room_id TEXT REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED)");
    assert.throws(() => store.transaction(() => {
      store.command(key, "commons", command("commit"));
      store.db.prepare("INSERT INTO growth_commit_guard VALUES(?)").run("missing-room");
    }), /FOREIGN KEY constraint failed/i);
    assert.equal(f.emitCount(), 0);
    assert.equal(f.notices.length, 0);
    assert.equal(store.room("commons").sequence, 2);
    const broken = growthFanout.subscribe({ types: ["message.sent"] }, () => { throw new Error("listener failed"); });
    try {
      assert.equal(store.command(key, "commons", command("commit")).duplicate, false);
      assert.equal(f.emitCount(), 1);
      assert.equal(store.command(key, "commons", command("commit")).duplicate, true);
      assert.equal(f.emitCount(), 1);
    } finally { growthFanout.unsubscribe(broken); }
  });
}

test("a command rejected by the post-projection capacity check emits no growth", t => {
  const f = fixture(t, "node"), { store, key, command } = f;
  const room = store.room.bind(store);
  store.room = id => {
    const current = room(id);
    return { ...current, state: { ...current.state, capacityFixture: "x".repeat(PILOT_LIMITS.projectionBytes) } };
  };
  assert.throws(() => store.command(key, "commons", command("capacity")), { code: "pilot_limit", status: 409 });
  store.room = room;
  assert.equal(store.room("commons").sequence, 2);
  assert.equal(f.emitCount(), 0);
  assert.equal(f.notices.length, 0);
});

for (const platform of ["node", "durable"]) test(`${platform}: queued growth snapshots reused command objects before outer commit`, t => {
  const f = fixture(t, platform), { store, key, command } = f;
  const first = command("first"), last = command("last", "x".repeat(250));
  const reused = structuredClone(first);
  store.transaction(() => {
    store.command(key, "commons", reused);
    reused.id = last.id;
    Object.assign(reused.data, last.data);
    const result = store.command(key, "commons", reused);
    result.event.data.messageId = "mutated-return";
    result.event.data.body = "x".repeat(3000);
    assert.equal(f.emitCount(), 0);
  });
  const persisted = store.db.prepare("SELECT json_extract(body,'$.data.messageId') AS id FROM events WHERE json_extract(body,'$.type')='message.posted' ORDER BY sequence").all().map(row => row.id);
  assert.deepEqual(persisted, [first.data.messageId, last.data.messageId]);
  assert.deepEqual(f.notices.map(notice => notice.id), persisted);
  const emitted = growthCollector.query({ type: "message.sent", limit: 1000 }).filter(envelope => persisted.includes(envelope.fields.messageId));
  assert.deepEqual(emitted.map(envelope => [envelope.fields.messageId, envelope.fields.lengthBucket]).sort(),
    [[first.data.messageId, "short"], [last.data.messageId, "medium"]].sort());
});
