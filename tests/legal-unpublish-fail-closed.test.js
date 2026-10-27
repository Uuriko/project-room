// isUnpublished is the operator's takedown check on public read paths. When the lookup fails
// — or cannot even be performed — it must report the content as unpublished, so a database
// error, a missing database, or an invalid target cannot re-expose it (fail closed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isUnpublished } from "../server/legal-store.mjs";

function dbReturning(row) {
  return { prepare: () => ({ get: () => row }) };
}

describe("isUnpublished", () => {
  it("reports a taken-down room as unpublished", () => {
    assert.equal(isUnpublished(dbReturning({ 1: 1 }), "room", "lobby"), true);
  });

  it("reports a room with no takedown as published", () => {
    assert.equal(isUnpublished(dbReturning(undefined), "room", "lobby"), false);
  });

  it("fails closed when the lookup throws", () => {
    const broken = { prepare: () => { throw new Error("database is locked"); } };
    assert.equal(isUnpublished(broken, "room", "lobby"), true);
  });

  it("fails closed without a database", () => {
    assert.equal(isUnpublished(null, "room", "lobby"), true);
    assert.equal(isUnpublished(undefined, "room", "lobby"), true);
    assert.equal(isUnpublished(false, "room", "lobby"), true);
  });

  it("fails closed with an invalid target", () => {
    const db = dbReturning(undefined);
    assert.equal(isUnpublished(db, "room", ""), true);
    assert.equal(isUnpublished(db, "room", null), true);
    assert.equal(isUnpublished(db, "room", undefined), true);
    assert.equal(isUnpublished(db, "room", 42), true);
    assert.equal(isUnpublished(db, "room", {}), true);
    // Even a db that would report a takedown — or none — must not rescue an invalid target.
    assert.equal(isUnpublished(dbReturning({ 1: 1 }), "room", ""), true);
    assert.equal(isUnpublished(null, "room", ""), true);
  });
});
