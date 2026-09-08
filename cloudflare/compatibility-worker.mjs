// Local-only compatibility experiment. Not an application or deployment entrypoint.
// Uses only generated synthetic schema/records; accepts no arbitrary SQL or secrets.
export class CompatibilityRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const { storage } = this.ctx;
    const sql = storage.sql;
    const path = new URL(request.url).pathname;
    const check = (name, fn) => {
      try { return { name, supported: true, result: fn() }; }
      catch (error) { return { name, supported: false, error: error.message }; }
    };
    if (path === '/native') {
      return Response.json([
        check('node-style schema version', () => sql.exec('PRAGMA user_version').toArray()),
        check('node-style transaction', () => sql.exec('BEGIN IMMEDIATE').toArray()),
        check('node writer function', () => sql.exec('SELECT project_room_writer_v7()').toArray()),
        check('foreign key enforcement', () => sql.exec('PRAGMA foreign_keys').one()),
      ]);
    }
    if (path === '/initialize') {
      storage.transactionSync(() => {
        // Explicit experiment: table-based version fence replaces the Node UDF.
        // Not a migration of a live database or a silent relaxation of its guards.
        sql.exec('CREATE TABLE room_runtime_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)');
        sql.exec('INSERT INTO room_runtime_version VALUES(1,7)');
        for (const statement of JSON.parse(this.env.SCHEMA)) sql.exec(statement);
        for (const { table, columns, values } of JSON.parse(this.env.FIXTURE)) {
          sql.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...values);
        }
      });
      return Response.json({ tables: sql.exec("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'").one().n });
    }
    if (path === '/prove') {
      const before = sql.exec('SELECT count(*) n FROM rooms').one().n;
      let rollback = false;
      try {
        storage.transactionSync(() => {
          sql.exec("INSERT INTO rooms VALUES('rolled-back',0,'{}')");
          throw new Error('intentional rollback');
        });
      } catch (error) { rollback = error.message === 'intentional rollback'; }
      const rollbackClean = rollback && sql.exec('SELECT count(*) n FROM rooms').one().n === before;
      const foreignKey = check('foreign key', () => sql.exec("INSERT INTO events VALUES('missing-room',1,'orphan-event','{}')").toArray());
      const writeGuard = storage.transactionSync(() => {
        sql.exec('UPDATE room_runtime_version SET version=8');
        const result = check('old writer rejection', () => sql.exec("INSERT INTO rooms VALUES('old-writer',0,'{}')").toArray());
        sql.exec('UPDATE room_runtime_version SET version=7');
        return result;
      });
      const missingGuard = storage.transactionSync(() => {
        sql.exec('DELETE FROM room_runtime_version');
        const result = check('missing version rejection', () => sql.exec("INSERT INTO rooms VALUES('missing-version',0,'{}')").toArray());
        sql.exec('INSERT INTO room_runtime_version VALUES(1,7)');
        return result;
      });
      return Response.json({ rollbackClean, foreignKey, writeGuard, missingGuard,
        integrity: sql.exec('PRAGMA foreign_key_check').toArray(),
        rooms: sql.exec('SELECT id,sequence,projection FROM rooms ORDER BY id').toArray(),
        eventCount: sql.exec('SELECT count(*) n FROM events').one().n });
    }
    if (path === '/read') return Response.json(sql.exec('SELECT id,sequence,projection FROM rooms ORDER BY id').toArray());
    return new Response('Not found', { status: 404 });
  }
}

export default {
  fetch(request, env) { return env.ROOM.getByName('synthetic-compatibility-room').fetch(request); }
};
