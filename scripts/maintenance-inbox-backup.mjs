import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { RoomStore } from '../server/store.mjs';

// Copy-DB only. Never a public HTTP route.
export function dumpInboxFile(sqlitePath, outPath) {
  if (!isAbsolute(resolve(sqlitePath))) throw new Error('SQLite path must be absolute');
  const store = new RoomStore(sqlitePath);
  try {
    const dump = store.inbox.dumpJournal();
    writeFileSync(outPath, JSON.stringify(dump));
    return dump;
  } finally { store.close(); }
}

export function restoreInboxFile(sqlitePath, inPath) {
  if (!isAbsolute(resolve(sqlitePath))) throw new Error('SQLite path must be absolute');
  const dump = JSON.parse(readFileSync(inPath, 'utf8'));
  const store = new RoomStore(sqlitePath);
  try {
    store.inbox.restoreJournal(dump);
    return dump;
  } finally { store.close(); }
}

const [, , cmd, db, file] = process.argv;
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!cmd || !db || !file) {
    console.error('usage: node scripts/maintenance-inbox-backup.mjs dump|restore ABSOLUTE.sqlite dump.json');
    process.exit(1);
  }
  if (cmd === 'dump') dumpInboxFile(resolve(db), file);
  else if (cmd === 'restore') restoreInboxFile(resolve(db), file);
  else process.exit(1);
}
