// Upgrade compatibility for public claim namespaces, not authentication against
// a database administrator. Existing private claim namespaces keep their rules.
const permit = 'public_work_claim_writer_permit';
const permitSql = `CREATE TABLE IF NOT EXISTS ${permit} (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
)`;
const protectedNamespace = row => `EXISTS(SELECT 1 FROM public_work_tasks WHERE namespace_key=${row}.room_id)`;
const definitions = [
  { name: permit, sql: permitSql },
  ...['work_claims', 'work_claim_config'].flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(operation => {
    const name = `public_claim_guard_${table}_${operation.toLowerCase()}`;
    const scope = operation === 'UPDATE' ? `(${protectedNamespace('OLD')} OR ${protectedNamespace('NEW')})`
      : protectedNamespace(operation === 'DELETE' ? 'OLD' : 'NEW');
    return { name, sql: `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${operation} ON ${table}
      WHEN ${scope} BEGIN
      SELECT CASE WHEN COALESCE((SELECT enabled FROM ${permit} WHERE singleton=1),0) IS NOT 1
      THEN RAISE(ABORT,'unsupported public claim writer') END;
      END` };
  }))
];
export const publicWorkClaimFenceSchema = definitions.map(({ sql }) => sql + ';').join('\n')
  + `\nINSERT OR IGNORE INTO ${permit}(singleton,enabled) VALUES(1,0);`;
const normalize = sql => sql?.trim().replace(/;$/, '').replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ');
export function verifyPublicWorkClaimFence(db, { allowAbsent = false } = {}) {
  const shapes = definitions.map(definition => ({ ...definition,
    actual: db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(definition.name)?.sql }));
  if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
  if (shapes.some(shape => normalize(shape.actual) !== normalize(shape.sql))) throw new Error('Public claim writer fence requires operator reconciliation');
  const rows = db.prepare(`SELECT singleton,enabled FROM ${permit}`).all();
  if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].enabled !== 0) throw new Error('Public claim writer permit must be closed at rest');
  return true;
}
export function withPublicWorkClaimWriter(store, fn) {
  return store.transaction(() => {
    if (store.db.prepare(`SELECT enabled FROM ${permit} WHERE singleton=1`).get()?.enabled !== 0) throw new Error('Public claim writer permit must be closed before entry');
    store.db.prepare(`UPDATE ${permit} SET enabled=1 WHERE singleton=1`).run();
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('Public claim transactions must remain synchronous');
      return result;
    } finally {
      // An SQLite I/O failure can already have rolled back the whole transaction.
      if (store.db.isTransaction) store.db.prepare(`UPDATE ${permit} SET enabled=0 WHERE singleton=1`).run();
    }
  });
}
