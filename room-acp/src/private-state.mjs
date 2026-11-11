// Private atomic checkpoints and SQLite process ownership for join recovery.
import { DatabaseSync } from 'node:sqlite';
import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivatePath, ensurePrivateDirectory, openNewPrivateFile, readPrivateJson, atomicPrivateJson } from './private-files.mjs';
export { atomicPrivateJson } from './private-files.mjs';

export function openJoinJournal(root, key) {
  ensurePrivateDirectory(root, {recursive: true});
  const directory = ensurePrivateDirectory(join(root, '.join-' + key));
  const lock = join(directory, 'owner.sqlite');
  try { closeSync(openNewPrivateFile(lock)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertPrivatePath(lock);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { assertPrivatePath(lock + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(lock, {timeout: 0});
  try { db.exec('CREATE TABLE IF NOT EXISTS join_owner (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE'); }
  catch { db.close(); throw Error('Another join owns this invitation; wait for it to finish'); }
  const path = join(directory, 'receipt.json');
  return {
    read() { try { return readPrivateJson(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    save(value) {
      atomicPrivateJson(path, value);
    },
    close() { db.close(); }
  };
}
