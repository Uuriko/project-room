// Disposable local Worker storage only. Never deployed.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorAttachmentIndex, ATTACHMENT_INDEX_LIMITS as L } from '../server/operator-attachment-index.mjs';
import { attachmentLiveIndexState } from '../server/attachment-schema.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
const reason = 'Synthetic bounded index qualification';
const room = index => 'r' + index + 'r'.repeat(113);
export class AttachmentIndexProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.db = new DurableDatabase(ctx.storage);
    this.store = new RoomStore(null, { database: this.db, storagePlatform: durableStorage, integrity: 'deferred' });
    this.keyReads = 0; this.builds = 0; this.costs = {};
    const prepare = this.db.prepare.bind(this.db), exec = this.db.exec.bind(this.db);
    this.db.prepare = sql => {
      if (sql.startsWith('SELECT hex(CAST(room_id AS BLOB))')) this.keyReads++;
      const statement = prepare(sql);
      const kind = sql.includes('AS roomBytes') ? 'quota' : sql.startsWith("SELECT 1 FROM room_attachments WHERE room_id=?") ? 'expiry' : null;
      if (kind) {
        if (kind === 'expiry') this.expirySql = sql;
        const method = 'get', original = statement[method].bind(statement);
        statement[method] = (...args) => { const before = this.db.rowsRead; const out = original(...args); this.costs[kind] = this.db.rowsRead - before; return out; };
      }
      return statement;
    };
    this.db.exec = sql => { if (sql.startsWith('CREATE INDEX room_attachments_live')) this.builds++; return exec(sql); };
  }
  async fetch(request) {
    const path = new URL(request.url).pathname, s = this.store, db = this.db;
    try {
      if (path === '/seed-boundary') {
        const started = performance.now();
        s.transaction(() => {
          for (let index = 0; index < 8; index++) s.initialize(initialRoom(room(index), 'owner'));
          const put = db.prepare(`INSERT INTO room_attachments(room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id)
            VALUES(?,?,'owner','f','text/plain',? ,?,zeroblob(?),'committed',0,9007199254740000,NULL)`);
          let remaining = L.storedBytes - L.rows * 208;
          for (let index = 0; index < L.rows; index++) {
            const bytes = Math.min(1048576, remaining); remaining -= bytes;
            put.run(room(index % 8), index.toString(36).padStart(4, '0'), bytes, 'a'.repeat(64), bytes);
          }
          if (remaining !== 0) throw Error('fixture size mismatch');
        });
        return Response.json({ rows: L.rows, seedMs: Math.round(performance.now() - started) });
      }
      if (path === '/seed-cost') {
        s.initialize(initialRoom());
        s.transaction(() => {
          const put = db.prepare(`INSERT INTO room_attachments(room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id)
            VALUES('commons',?,'owner','f','text/plain',0,?, ?, ?,0,9007199254740000,NULL)`);
          for (let index = 0; index < 520; index++) put.run('f' + index, 'a'.repeat(64), index < 512 ? null : new Uint8Array(), index < 512 ? 'discarded' : index < 516 ? 'staged' : 'committed');
        });
        return Response.json({ seeded: true });
      }
      if (path === '/stage') {
        const { id } = await request.json(), key = s.issueAccessKey('commons', 'owner'); this.costs = {};
        const result = s.roomAttachments.stage(key, 'commons', { id, filename: 'f.txt', mediaType: 'text/plain', data: 'eA==' });
        return Response.json({ result, costs: this.costs, expiryPlan: db.prepare('EXPLAIN QUERY PLAN ' + this.expirySql).all('commons', s.now()) });
      }
      if (path === '/over-row') {
        s.initialize(initialRoom('q', 'owner'));
        db.prepare("UPDATE room_attachments SET room_id='q' WHERE id='0000'").run();
        db.prepare(`INSERT INTO room_attachments SELECT room_id,'zzzz',uploader_id,filename,media_type,0,sha256,NULL,'discarded',created_at,expires_at,NULL FROM room_attachments WHERE id='0000'`).run();
        return Response.json({ changed: true });
      }
      if (path === '/restore-row') { db.prepare("DELETE FROM room_attachments WHERE id='zzzz'").run(); db.prepare("UPDATE room_attachments SET room_id=? WHERE id='0000'").run(room(0)); return Response.json({ changed: true }); }
      if (path === '/over-key') { db.prepare("UPDATE room_attachments SET id='extra',bytes=zeroblob(1048575),byte_length=1048575 WHERE id='0000'").run(); return Response.json({ changed: true }); }
      if (path === '/restore-key') { db.prepare("UPDATE room_attachments SET id='0000',bytes=zeroblob(1048576),byte_length=1048576 WHERE id='extra'").run(); return Response.json({ changed: true }); }
      if (path === '/over-stored') { db.prepare("UPDATE room_attachments SET bytes=zeroblob(1),byte_length=1 WHERE id='zzzz'").run(); return Response.json({ changed: true }); }
      if (path === '/stored-plus-one') {
        db.prepare("UPDATE room_attachments SET bytes=zeroblob(1),byte_length=1 WHERE id='0pa7'").run(); return Response.json({ changed: true });
      }
      if (path === '/stored-restore') {
        db.prepare("UPDATE room_attachments SET bytes=zeroblob(0),byte_length=0 WHERE id='0pa7'").run(); return Response.json({ changed: true });
      }
      if (path === '/fault-critical') {
        const prepare = db.prepare.bind(db);
        db.prepare = sql => {
          const statement = prepare(sql);
          if (sql.includes('INSERT INTO operator_actions')) statement.run = () => { throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }); };
          return statement;
        };
        this.restorePrepare = prepare; return Response.json({ ready: true });
      }
      if (path === '/unfault-critical') { db.prepare = this.restorePrepare; return Response.json({ ready: true }); }
      if (path === '/fault') { db.exec("CREATE TRIGGER reject_attachment_index_receipt BEFORE INSERT ON operator_actions WHEN NEW.action='attachment_index_execute' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END"); return Response.json({ ready: true }); }
      if (path === '/unfault') { db.exec('DROP TRIGGER reject_attachment_index_receipt'); return Response.json({ ready: true }); }
      if (path === '/sizes') return Response.json(db.prepare(`SELECT count(*) AS rows,
        SUM(length(CAST(room_id AS BLOB))+length(CAST(id AS BLOB))+length(CAST(state AS BLOB))) AS keyBytes,
        SUM(length(CAST(room_id AS BLOB))+length(CAST(id AS BLOB))+length(CAST(uploader_id AS BLOB))+length(CAST(filename AS BLOB))+length(CAST(media_type AS BLOB))+length(CAST(sha256 AS BLOB))+length(CAST(state AS BLOB))+COALESCE(length(bytes),0)+COALESCE(length(CAST(message_id AS BLOB)),0)) AS storedBytes FROM room_attachments`).get());
      if (path === '/state') return Response.json({ installed: attachmentLiveIndexState(db), keyReads: this.keyReads, builds: this.builds,
        rows: db.prepare('SELECT count(*) n FROM room_attachments').get().n, stamp: db.prepare('SELECT stamp FROM room_schema_stamp WHERE singleton=1').get().stamp,
        receipts: db.prepare("SELECT count(*) n FROM operator_actions WHERE action='attachment_index_execute'").get().n });
      if (path === '/plan' || path === '/execute') {
        const started = performance.now(), before = db.rowsRead, keys = this.keyReads, builds = this.builds;
        const result = operatorAttachmentIndex(s, { reason, ...await request.json() }, path === '/execute');
        return Response.json({ ...result, measured: { ms: Math.round(performance.now() - started), rowsRead: db.rowsRead - before, keyReads: this.keyReads - keys, builds: this.builds - builds } });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) { return Response.json({ error: { code: error.code ?? 'internal' }, keyReads: this.keyReads, builds: this.builds }, { status: error.status ?? 500 }); }
  }
}
export default { fetch(request, env) { const name = new URL(request.url).searchParams.get('fixture') === 'cost' ? 'cost' : 'boundary'; return env.ROOM.getByName(name).fetch(request); } };
