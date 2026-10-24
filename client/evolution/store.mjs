import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, chmodSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export function requireThat(value, code) { if (!value) throw new Error(code); }
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  requireThat(value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)), 'invalid_json');
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'state_directory_not_private');
  return realpathSync(path);
}
export function openEvolution(directory) {
  directory = privateDir(directory);
  const path = join(directory, 'evolution.sqlite');
  try { const s = lstatSync(path); requireThat(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && s.nlink === 1 && !(s.mode & 0o077), 'state_database_not_private'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const db = new DatabaseSync(path); chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS packages (hash TEXT PRIMARY KEY, capability TEXT NOT NULL, manifest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activations (capability TEXT PRIMARY KEY, current TEXT NOT NULL, candidate TEXT, percent INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, room TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, pin TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, owner TEXT, heartbeat INTEGER, result TEXT, UNIQUE(room,operation));
    CREATE TABLE IF NOT EXISTS steps (job TEXT NOT NULL, ordinal INTEGER NOT NULL, state TEXT NOT NULL, receipt TEXT, PRIMARY KEY(job,ordinal));
    CREATE TABLE IF NOT EXISTS room_results (request TEXT PRIMARY KEY, job TEXT NOT NULL, binding TEXT NOT NULL, response TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, capability TEXT NOT NULL, baseline TEXT NOT NULL, candidate TEXT NOT NULL, evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL);`);
  return { db, directory, close: () => db.close() };
}
export function transaction(store, fn) {
  store.db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); store.db.exec('COMMIT'); return result; }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export function event(store, kind, subject, data) {
  store.db.prepare('INSERT INTO events(at,kind,subject,data) VALUES(?,?,?,?)').run(Date.now(), kind, subject, canonical(data));
}
export function events(store, after = 0, limit = 100) {
  requireThat(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'invalid_cursor');
  const rows = store.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
  return { items: rows.map(r => ({ ...r, data: JSON.parse(r.data) })), after: rows.at(-1)?.seq ?? after, hasMore: rows.length === limit };
}
