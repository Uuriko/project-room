// Body-row release can wait. A deferred store keeps a replaced body until
// the sweep deletes shas the stored projection no longer names. The default
// store still releases in the write. A corrupt projection is left alone.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { sweepUnreferencedBodies } from "../server/projection-at-rest.mjs";
import { JOBS, jobEnabled } from "../server/jobs.mjs";

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-body-sweep-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file, { bodiesAtRest: true, deferBodyRelease: true });
  store.initialize(initialRoom());
  const owner = () => store.issueAccessKey("commons", "owner");
  const post = (messageId, body) => store.command(owner(), "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body }
  });
  const bodies = () => store.db.prepare("SELECT sha, body FROM projection_bodies WHERE room_id='commons'").all();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, post, bodies };
}

const big = tag => `${tag}:` + "y".repeat(400);

test("a deferred edit keeps the replaced body until the sweep", t => {
  const room = open(t);
  const original = big("first");
  room.post("m1", original);
  assert.equal(room.bodies().length, 1);
  room.store.command(room.owner(), "commons", { id: randomUUID(), type: T.MESSAGE_EDITED, data: {
    messageId: "m1", body: big("second"), expectedMessageRevision: 0
  } });
  const held = room.bodies();
  assert.equal(held.length, 2, "the write did not scan the body table");
  assert.ok(held.some(row => row.body === original));
  const swept = sweepUnreferencedBodies(room.store.db);
  assert.equal(swept.released, 1);
  assert.equal(swept.budgetExceeded, false);
  const left = room.bodies();
  assert.equal(left.length, 1);
  assert.equal(left[0].body.includes("second"), true);
  assert.equal(room.store.room("commons").state.messages.find(message => message.id === "m1").body, big("second"));
});

test("the sweep leaves a corrupt projection's bodies in place", t => {
  const room = open(t);
  room.post("m1", big("keep"));
  const sha = room.bodies()[0].sha;
  room.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run("{");
  const swept = sweepUnreferencedBodies(room.store.db);
  assert.equal(swept.released, 0);
  assert.equal(room.bodies()[0].sha, sha);
});

test("the body sweep stays disabled until a body row exists", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-body-sweep-gate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const job = JOBS.find(item => item.name === "projection-body-sweep");
  assert.equal(job.cadenceMs, 5 * 60 * 1000);
  assert.equal(jobEnabled(job, {}, store), false);
  store.db.prepare("INSERT INTO projection_bodies(room_id, sha, body) VALUES('commons', ?, 'held')")
    .run("a".repeat(64));
  assert.equal(jobEnabled(job, {}, store), true);
});
