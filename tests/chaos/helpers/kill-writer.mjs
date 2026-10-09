// Helper for the S4 chaos scenario: opens the file-backed room DB, begins a
// store.command() with COMMIT held open, and waits to be SIGKILLed by the
// parent while the write transaction is still uncommitted. The marker file is
// written synchronously right after BEGIN IMMEDIATE so the parent can prove
// the kill landed mid-transaction.
//
// Usage: node kill-writer.mjs <dbPath> <roomId> <token> <commandJson> <markerPath>
import { RoomStore } from "../../../server/store.mjs";
import fs from "node:fs";

const [dbPath, roomId, token, commandJson, markerPath] = process.argv.slice(2);
const store = new RoomStore(dbPath);
const db = store.db;
const realExec = db.exec.bind(db);
let begun = false;
db.exec = function (sql, ...args) {
  const norm = String(sql).trim().toUpperCase();
  if (norm === "BEGIN IMMEDIATE") {
    const ret = realExec(sql, ...args);
    if (!begun) {
      begun = true;
      fs.writeFileSync(markerPath, "begun");
    }
    return ret;
  }
  if (norm === "COMMIT") {
    // Hold the commit open; the parent SIGKILLs us during this window.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
  }
  return realExec(sql, ...args);
};
try {
  store.command(token, roomId, JSON.parse(commandJson));
} catch {
  // A fault here is fine; the parent only cares about the on-disk state.
}
process.exit(0);
