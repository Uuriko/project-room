import entry, { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

export class ReplyIntegrityRoom extends HttpTestRoom {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/__integrity') return super.fetch(request);
    try {
      const store = this.store; store.initialize(initialRoom());
      const owner = store.issueAccessKey('commons', 'owner');
      store.command(owner, 'commons', { id: 'reader', type: 'member.added', data: {
        memberId: 'reader', displayName: 'Reader', kind: 'human', permissions: [] } });
      const reader = store.issueAccessKey('commons', 'reader');
      store.dmConsents.request('commons', 'owner', 'reader', 'Test');
      store.dmConsents.decide('commons', 'reader', 'owner', 'approve');
      store.command(owner, 'commons', { id: 'ask', type: 'message.posted', data: {
        messageId: 'ask', body: 'Question', toMemberId: 'reader', requestKind: 'reply' } });
      let scans = 0; const prepare = store.db.prepare.bind(store.db);
      store.db.prepare = sql => {
        if (sql.includes('FROM events WHERE room_id=? ORDER BY sequence LIMIT 128')) scans++;
        return prepare(sql);
      };
      const read = () => store.replyRequests.selected(reader, 'commons', 'ask');
      read(); const first = scans; read(); const second = scans;
      // Prepared all bypasses the adapter's write-transaction/permit wrapper.
      store.db.prepare('CREATE TABLE integrity_probe(value TEXT)').all();
      read(); const afterDdl = scans;
      store.db.prepare("UPDATE events SET body=json_set(body,'$.id','corrupt') WHERE room_id='commons' AND sequence=2").run();
      let refused = false;
      try { read(); } catch (error) { refused = error.code === 'reply_history_changed'; }
      return Response.json({ first, second, afterDdl, refused, finalScans: scans });
    } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
  }
}
export default entry;
