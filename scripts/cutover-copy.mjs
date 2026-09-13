import { copyFileSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { STORE_SCHEMA_VERSION } from '../server/writer-fence.mjs';

// Copy-first local cutover. Never writes the source file. Refuses live object ids.
export function cutoverCopy(sourceSqlite, destSqlite) {
  if (!isAbsolute(sourceSqlite) || !isAbsolute(destSqlite)) throw new Error('Cutover paths must be absolute');
  if (/a5f2dca/i.test(sourceSqlite) || /a5f2dca/i.test(destSqlite)) {
    throw new Error('Refusing live schema-26 object id a5f2dca');
  }
  if (sourceSqlite === destSqlite) throw new Error('Dest must be a different file');
  if (!existsSync(sourceSqlite)) throw new Error('Source sqlite missing');
  if (existsSync(destSqlite)) throw new Error('Dest must not exist');
  copyFileSync(sourceSqlite, destSqlite);
  const store = new RoomStore(destSqlite);
  try {
    const row = store.db.prepare('PRAGMA user_version').get();
    const version = row.user_version ?? Object.values(row)[0];
    if (version !== STORE_SCHEMA_VERSION) throw new Error(`Copy opened at schema ${version}, expected ${STORE_SCHEMA_VERSION}`);
    return { ok: true, schema: version, dest: destSqlite };
  } finally { store.close(); }
}

const [, , src, dest] = process.argv;
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!src || !dest) {
    console.error('usage: node scripts/cutover-copy.mjs ABSOLUTE-src.sqlite ABSOLUTE-dest.sqlite');
    process.exit(1);
  }
  console.log(JSON.stringify(cutoverCopy(src, dest)));
}
