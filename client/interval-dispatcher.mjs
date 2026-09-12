import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync, realpathSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validId } from '../src/events.js';
import { validateReplyRead, validReplyArguments, submitReplyAction } from './reply-actions.mjs';

// One explicitly invoked tick, one automation, no timer or execution authority.
// The caller must bind client to this identity; credentials never enter the journal.
export async function dispatchIntervalOnce({ directory, client, identity, automationId, signal }) {
  identity = { origin: identity?.origin, roomId: identity?.roomId, memberId: identity?.memberId };
  if (!validId(identity?.roomId) || !validId(identity?.memberId) || !validId(automationId)
    || new URL(identity.origin).origin !== identity.origin) throw new Error('invalid_dispatch_identity');
  const root = realpathSync(directory), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('private_directory_required');
  const path = join(root, 'interval.sqlite');
  try { const fd = openSync(path, 'wx', 0o600); fsyncSync(fd); closeSync(fd); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid() || (file.mode & 0o077)) throw new Error('private_file_required');
  const db = new DatabaseSync(path);
  const scope = JSON.stringify([identity.origin, identity.roomId, identity.memberId, automationId]);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS dispatch (id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, args TEXT, state TEXT NOT NULL)');
    transaction(() => {
      db.prepare("INSERT OR IGNORE INTO dispatch VALUES (1, ?, NULL, 'empty')").run(scope);
      if (db.prepare('SELECT scope FROM dispatch WHERE id=1').get().scope !== scope) throw new Error('dispatch_identity_changed');
    });
    const directoryFd = openSync(root, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    let row = db.prepare('SELECT * FROM dispatch WHERE id=1').get();
    if (!['empty', 'pending', 'recorded', 'refused'].includes(row.state)
      || (row.state === 'empty' ? row.args !== null : typeof row.args !== 'string' || row.args.length > 16384)) throw new Error('invalid_dispatch_journal');
    if (row.state !== 'pending') {
      signal?.throwIfAborted();
      const preview = await client.replyRead('room_preview_automation', { automationId }, { signal });
      validateReplyRead(preview, { name: 'room_preview_automation', args: { automationId }, roomId: identity.roomId });
      if (preview.viewerId !== identity.memberId) throw new Error('dispatch_identity_changed');
      const item = preview.automations[0];
      if (item.ownerId !== identity.memberId) throw new Error('creator_required');
      if (item.definition.trigger.kind !== 'interval' || !item.actions.dispatch) return { status: 'idle', reason: item.definition.trigger.kind === 'manual' ? 'manual' : item.status, processStarted: false };
      const requestId = 'interval-' + createHash('sha256').update(JSON.stringify([scope, item.revision, item.nextSlot])).digest('hex');
      const args = { requestId, automationId, automationRevision: item.revision, automationSlot: item.nextSlot, definition: item.definition };
      row = transaction(() => {
        const current = db.prepare('SELECT * FROM dispatch WHERE id=1').get();
        if (current.state === 'pending') return current;
        // Never retry a definitively rejected selection under a fresh ID.
        if (current.args === JSON.stringify(args)) return current;
        db.prepare("UPDATE dispatch SET args=?, state='pending' WHERE id=1").run(JSON.stringify(args));
        return { args: JSON.stringify(args), state: 'pending' };
      });
    }
    if (row.state !== 'pending') return { status: row.state, processStarted: false };
    const args = JSON.parse(row.args);
    if (!validReplyArguments('room_run_automation', args) || args.automationId !== automationId || args.definition.trigger.kind !== 'interval') throw new Error('invalid_dispatch_journal');
    // Persisted original arguments win over every newer preview after uncertainty.
    // Server receipt lookup, consent/revision checks and atomic slot use arbitrate races.
    signal?.throwIfAborted();
    let result;
    try {
      result = await submitReplyAction(client, identity, 'room_run_automation', args, { signal });
    } catch (error) {
      if (error.code === 'command_rejected' && [409, 422].includes(error.status)) {
        db.prepare("UPDATE dispatch SET state='refused' WHERE id=1 AND args=? AND state='pending'").run(row.args);
        return { status: 'refused', requestId: args.requestId, processStarted: false };
      }
      return { status: 'unconfirmed', requestId: args.requestId, processStarted: false };
    }
    if (result.status === 'recorded') db.prepare("UPDATE dispatch SET state='recorded' WHERE id=1 AND args=? AND state='pending'").run(row.args);
    return result;
  } finally { db.close(); }
}
