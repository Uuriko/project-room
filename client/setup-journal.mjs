import { DatabaseSync } from 'node:sqlite';
import { closeSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertPrivatePath, ensurePrivateDirectory, openNewPrivateFile, readPrivateJson, atomicPrivateJson } from '../room-acp/src/private-files.mjs';
export { atomicPrivateJson } from '../room-acp/src/private-files.mjs';

export function privateDirectory(path) {
  return realpathSync(ensurePrivateDirectory(path));
}
export function openSetupJournal(directory) {
  const root = privateDirectory(resolve(directory)), lock = join(root, 'owner.sqlite');
  try { closeSync(openNewPrivateFile(lock)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertPrivatePath(lock);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { assertPrivatePath(lock + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(lock, {timeout: 0});
  try { db.exec('CREATE TABLE IF NOT EXISTS setup_owner (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE'); }
  catch { db.close(); throw Error('Another setup owns this directory; wait for it to finish'); }
  const path = join(root, 'setup.json');
  return {root,
    read() { try { return readPrivateJson(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    save(value) {
      atomicPrivateJson(path, value);
    },
    close() { db.close(); }
  };
}
