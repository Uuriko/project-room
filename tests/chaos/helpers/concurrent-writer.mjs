// Helper for the S5 chaos scenario: runs one store.command() in a worker
// thread against the shared file-backed room DB. workerData:
//   { dbPath, roomId, token, cmd, delayMs }
// With delayMs > 0 the worker holds COMMIT open that long (fault: slow fsync),
// so the main thread can start a second writer and sample readers while the
// first transaction is uncommitted. Posts {type:"begun"} right after
// BEGIN IMMEDIATE and {type:"done", ok, sequence} when the command returns.
import { workerData, parentPort } from "node:worker_threads";
import { RoomStore } from "../../../server/store.mjs";

const { dbPath, roomId, token, cmd, delayMs } = workerData;
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
      parentPort.postMessage({ type: "begun" });
    }
    return ret;
  }
  if (norm === "COMMIT" && delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  return realExec(sql, ...args);
};
try {
  const res = store.command(token, roomId, cmd);
  parentPort.postMessage({ type: "done", ok: true, sequence: res.sequence, cmdId: cmd.id });
} catch (error) {
  parentPort.postMessage({ type: "done", ok: false, error: error?.message ?? String(error), cmdId: cmd.id });
} finally {
  try { store.close(); } catch { /* already torn down */ }
}
