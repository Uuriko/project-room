// Offline operator tooling. No repair, credential use, restore or reopening path.
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { applicationTables } from '../server/writer-fence.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const quote = name => `"${name.replaceAll('"', '""')}"`;
const accessTables = new Set(['accounts', 'member_accounts', 'account_access_events', 'credentials',
  'account_credentials', 'account_session_slots', 'membership_invitations', 'membership_invitation_events',
  'membership_invitation_journal', 'share_links', 'share_link_joins', 'agent_connections', 'agent_connection_operations']);

function difference(older, reference) {
  let added = 0, removed = 0, changed = 0;
  for (const [key, value] of older) {
    if (!reference.has(key)) removed++;
    else if (value !== reference.get(key)) changed++;
  }
  for (const key of reference.keys()) if (!older.has(key)) added++;
  return { added, removed, changed };
}
const hasDifference = result => result.added + result.removed + result.changed > 0;

function inspect(store) {
  return store.readTransaction(() => {
    const audit = auditRecovery(store), tables = new Map(), rooms = new Map(), memberships = new Map();
    for (const table of applicationTables) {
      const keys = store.db.prepare(`PRAGMA table_info(${quote(table)})`).all()
        .filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
      if (!keys.length) throw new Error('Missing recovery record identity');
      tables.set(table, new Map(store.db.prepare(`SELECT * FROM ${quote(table)}`).all()
        .map(row => [canonical(keys.map(key => row[key])), digest(row)])));
    }
    for (const row of store.db.prepare('SELECT id,sequence,projection FROM rooms ORDER BY id').all()) {
      const state = JSON.parse(row.projection);
      for (const member of Object.values(state.members)) memberships.set(canonical([row.id, member.id]), digest({
        kind: member.kind, active: member.active, revision: member.revision,
        permissions: [...member.permissions].sort(), accountableHumanId: member.accountableHumanId ?? null
      }));
      const history = store.db.prepare('SELECT sequence,id,body FROM events WHERE room_id=? ORDER BY sequence').all(row.id);
      rooms.set(row.id, { sequence: row.sequence, history: history.map(event => digest(event)) });
    }
    return { audit, tables, rooms, memberships };
  });
}

export function compareRecoveryCaptures(olderPath, referencePath) {
  // Both paths must exist, and aliases/hard links to the same database are refused.
  const paths = [olderPath, referencePath].map(path => realpathSync(path));
  const files = paths.map(path => statSync(path));
  if (files.some(file => !file.isFile()) || (files[0].dev === files[1].dev && files[0].ino === files[1].ino)) {
    throw new Error('Two distinct existing capture files required');
  }
  const stores = [];
  try {
    for (const path of paths) stores.push(new RoomStore(path, { readOnly: true }));
    // Separate stable read transactions, not a cross-database atomic snapshot.
    const [older, reference] = stores.map(inspect);
    const tables = applicationTables.map(table => ({ table,
      ...difference(older.tables.get(table), reference.tables.get(table)) }));
    const memberships = difference(older.memberships, reference.memberships);
    const history = { equalRooms: 0, extendedRooms: 0, divergentRooms: 0, missingRooms: 0, addedRooms: 0, laterEvents: 0 };
    for (const [id, room] of older.rooms) {
      const next = reference.rooms.get(id);
      if (!next) { history.missingRooms++; continue; }
      if (next.sequence < room.sequence || room.history.some((event, index) => event !== next.history[index])) {
        history.divergentRooms++; continue;
      }
      if (next.sequence === room.sequence) history.equalRooms++;
      else { history.extendedRooms++; history.laterEvents += next.sequence - room.sequence; }
    }
    for (const id of reference.rooms.keys()) if (!older.rooms.has(id)) history.addedRooms++;
    const historyCompatible = history.divergentRooms === 0 && history.missingRooms === 0;
    const accessDifferences = hasDifference(memberships) || tables.some(row => accessTables.has(row.table) && hasDifference(row));
    const changed = tables.some(hasDifference);
    return { contractVersion: 1, schemaVersion: older.audit.schemaVersion,
      status: !historyCompatible ? 'history_requires_review' : changed ? 'differences_require_review' : 'no_stored_differences',
      reopenAllowed: false, authorityFreshness: 'unproven',
      captures: { older: { dataSha256: older.audit.dataSha256, rooms: older.audit.rooms, events: older.audit.events },
        reference: { dataSha256: reference.audit.dataSha256, rooms: reference.audit.rooms, events: reference.audit.events } },
      history: { ...history, olderHistoryIsPrefix: historyCompatible }, memberships, accessDifferences, tables,
      requiredReview: [
        'Establish capture provenance, exact storage identity and the independently trusted current authority horizon.',
        'Keep traffic and external agents paused; reconcile access, invitations, agent grants and pending sessions.',
        'Reconcile missing work, approvals, requests, exact retry receipts and external effects before any replay.',
        'Reconcile separate watcher journals, expiry, in-flight operations and changes after either capture.',
        'Obtain explicit operator approval and verify the chosen recovery before reopening.'
      ],
      limitation: 'Read-only comparison of two selected captures, not proof of current authority, shared provenance, external effects or hosted recovery. No identities, tokens, row values or private text are emitted.' };
  } finally { for (const store of stores) store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { older: { type: 'string' }, reference: { type: 'string' } } });
    if (!values.older || !values.reference) throw new Error('Explicit paths required');
    const report = compareRecoveryCaptures(values.older, values.reference);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    // 0 means comparison completed without stored differences, never permission to reopen.
    process.exitCode = report.status === 'no_stored_differences' ? 0 : 2;
  } catch {
    process.stderr.write('Recovery comparison unavailable. Select two distinct, trusted, current-schema captures. No repair or reopening was performed.\n');
    process.exitCode = 1;
  }
}
