import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { seedDigestJournal } from "../scripts/digest-journal-fixture.mjs";

test("file-backed digest counts a 100k journal and future types exactly in a read-only transaction", t => {
  const dir = mkdtempSync(join(tmpdir(), "digest-window-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const token = store.issueAccessKey("commons", "owner"), window = seedDigestJournal(store, 100000);
  for (const count of [100000, 20, 0]) {
    const digest = store.roomDigest(token, "commons", { since: window.through - count });
    assert.equal(digest.coverage.eventsInWindow, count);
    assert.deepEqual(digest.coverage.byType, count ? { "message.posted": count / 4, "room.policy_set": count / 4, other: count / 2 } : {});
    assert.ok(Buffer.byteLength(JSON.stringify(digest)) <= 4096);
  }
  assert.equal(store.headSequence("commons"), window.through, "reads leave the journal unchanged");
});

test("digest after metadata commits stays warm while cursor and content changes remain visible", t => {
  const store = new RoomStore(":memory:", { verifyProjectionCache: false });
  t.after(() => store.close()); store.initialize(initialRoom());
  const token = store.issueAccessKey("commons", "owner");
  const first = store.roomDigest(token, "commons");
  let reads = 0; const read = store._readProjection.bind(store);
  store._readProjection = (...args) => { reads++; return read(...args); };
  store.markCaughtUp(token, "commons", first.through);
  const caughtUp = store.roomDigest(token, "commons");
  assert.equal(reads, 0);
  assert.equal(caughtUp.context.context_version, first.context.context_version, "cursor-only changes preserve the structure version");
  assert.equal(store.roomContext(token, "commons").cursors.caughtUp, first.through, "viewer cursor state is read independently of the projection cache");
  store.command(token, "commons", { id: "digest-write", type: "message.posted", data: { messageId: "digest-write", body: "Committed evidence" } });
  const next = store.roomDigest(token, "commons", { since: first.through });
  assert.equal(next.messages[0].summary, "Committed evidence");
  assert.equal(reads, 0, "validated write candidates remain warm through a digest read");
});
