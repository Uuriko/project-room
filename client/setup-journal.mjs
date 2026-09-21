import { DatabaseSync } from "node:sqlite";
import { constants, mkdirSync, lstatSync, realpathSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const privatePath = (path, directory = false) => {
  const s = lstatSync(path);
  if ((directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) || (s.mode & 0o077)
    || !process.getuid || s.uid !== process.getuid()) throw new Error("Setup requires private files and directories without links");
};
function syncDirectory(path) {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function privateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); } catch (error) { if (error.code !== "EEXIST") throw error; }
  privatePath(path, true); return realpathSync(path);
}
export function atomicPrivateJson(path, value) {
  try { privatePath(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = path + "." + randomUUID(); let fd;
  try {
    fd = openSync(temp, "wx", 0o600); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
export function openSetupJournal(directory) {
  const root = privateDirectory(resolve(directory)), lock = join(root, "owner.sqlite");
  try { closeSync(openSync(lock, "wx", 0o600)); } catch (error) { if (error.code !== "EEXIST") throw error; }
  privatePath(lock);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { privatePath(lock + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const db = new DatabaseSync(lock, { timeout: 0 });
  try { db.exec("CREATE TABLE IF NOT EXISTS setup_owner (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE"); } catch { db.close(); throw new Error("Another setup owns this directory; wait for it to finish"); }
  const path = join(root, "setup.json");
  return { root,
    read() {
      let fd;
      try {
        privatePath(path);
        if (lstatSync(path).size > 131072) throw new Error("Setup journal exceeds its limit");
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        return JSON.parse(readFileSync(fd, "utf8"));
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
    },
    save(value) { if (Buffer.byteLength(JSON.stringify(value)) > 131072) throw new Error("Setup journal exceeds its limit"); atomicPrivateJson(path, value); },
    close() { db.close(); }
  };
}
