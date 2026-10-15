// #3224: store-level member resolution goes through ownMember. A raw
// members[memberId] lookup resolves Object.prototype names ("toString",
// "constructor") as truthy phantom members; insertCredential was one
// unguarded path — a prototype-named id would have been issued a real
// credential. These tests pin both ways: phantom ids are refused, a
// genuinely present member is served.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-store-member-primitive-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test("insertCredential refuses prototype-named member ids (#3224)", t => {
  const store = fixture(t);
  for (const phantom of ["toString", "constructor", "hasOwnProperty"]) {
    assert.throws(
      () => store.insertCredential("commons", phantom, "access", null, store.now() + 60000),
      /Room member required/, `${phantom} must not resolve as a room member`);
  }
  const issued = store.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE room_id='commons'").get().n;
  assert.equal(issued, 0, "no credential was minted for a phantom member");
});

test("insertCredential still serves a genuinely present member", t => {
  const store = fixture(t);
  const token = store.insertCredential("commons", "owner", "access", null, store.now() + 60000);
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
});
