import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tableExists } from "../server/db-util.mjs";

test("tableExists reports real tables and ignores names that look like SQL", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT)");
  assert.equal(tableExists(db, "rooms"), true);
  assert.equal(tableExists(db, "missing"), false);
  assert.equal(tableExists(db, "rooms' OR '1'='1"), false);
  db.close();
});
