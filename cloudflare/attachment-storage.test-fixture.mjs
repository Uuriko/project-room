// Storage experiment only. This is not an application attachment endpoint.
export class AttachmentStorageExperiment {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch(request) {
    const sql = this.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, bytes BLOB NOT NULL)');
    const id = new URL(request.url).pathname.slice(1);
    if (request.method === 'PUT') {
      const bytes = await request.arrayBuffer();
      try {
        this.storage.transactionSync(() => {
          sql.exec('INSERT INTO files VALUES (?, ?)', id, bytes);
          if (request.headers.get('x-test-rollback') === '1') throw new Error('rollback');
        });
      } catch (error) { return new Response(error.message, { status: 409 }); }
      return new Response(null, { status: 201 });
    }
    if (request.method === 'DELETE') {
      this.storage.transactionSync(() => sql.exec('DELETE FROM files WHERE id=?', id));
      return new Response(null, { status: 204 });
    }
    const row = sql.exec('SELECT bytes FROM files WHERE id=?', id).toArray()[0];
    return row ? new Response(row.bytes) : new Response(null, { status: 404 });
  }
}
export default {
  fetch(request, env) { return env.FILES.get(env.FILES.idFromName('synthetic')).fetch(request); }
};
