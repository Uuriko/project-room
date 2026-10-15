// isUnpublished is the operator's takedown check on public read paths. When the lookup fails
// it must report the content as unpublished, so a database error cannot re-expose it.
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

  it("does not look anything up without a database or a target", () => {
    assert.equal(isUnpublished(null, "room", "lobby"), false);
    assert.equal(isUnpublished(dbReturning({ 1: 1 }), "room", ""), false);
  });
});
