// Changes since a cursor for the shared assistant (asks), read only.
//
// Hosts and the desktop console used to re-read every run every 2 s. A read
// now returns a cursor; ?since=<cursor> answers "none" (no projection at all)
// when nothing stored has changed, "delta" with only the runs written since,
// or "full" when it can't be sure (settings changed, or the cursor is not one
// this room would issue). Nothing is added to storage and the write paths in
// room-assistant.mjs are untouched.
//
// Change detection uses facts every run write already moves: revision (every
// action except draft), answerDraftSequence (draft), updatedAt (every write),
// the stored row length and the row count, plus the settings revision. A
// settings change also edits pending runs without touching updatedAt, so it
// always answers "full".
// Delivery is at least once: a delta returns every visible run written at or
// after the previous cursor's newest write minus LOOKBACK_MS, so a write in
// the same millisecond, or a small clock step back, is delivered again
// rather than lost. Readers dedupe on (id, revision, answerDraftSequence).
// Visibility: a run's opening message being deleted, or the reader's history
// floor moving, changes what the full read shows without writing any run.
// The cursor carries a short visibility mark (deleted-message count, newest
// deletion time, the reader's floor) and answers "full" when it moves, so a
// deletion reaches every reader at once (review of #2633, muse-room 12188).
// Not covered: time-derived "not picked up" and "unknown". Readers that show
// those recompute from hostReportedAt or do a plain full read now and then
// (FULL_READ_HINT_MS).
// Privacy: the cursor is an opaque digest plus the room's newest write time,
// so it says only that something in this room changed and when, which room
// members can already see from the room's own live updates.
import { createHash } from 'node:crypto';

export const LOOKBACK_MS = 5000;
export const FULL_READ_HINT_MS = 60000;
const CURSOR = /^v1\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,9})\.([0-9a-f]{8})\.([0-9a-f]{16})$/;

export function parseAssistantCursor(raw) {
  if (raw === null || raw === undefined) return null;
  const match = CURSOR.exec(raw);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return { invalid: true };
  return { newest: Number(match[1]), configRevision: Number(match[2]), visibility: match[3], digest: match[4], raw };
}

// What the reader may see of the runs' opening messages, as 8 hex chars.
export function assistantVisibilityMark(messages, floor) {
  let deleted = 0, newestDeletion = '';
  for (const message of messages ?? []) {
    if (!message?.deletedAt) continue;
    deleted++;
    const at = String(message.deletedAt);
    if (at > newestDeletion) newestDeletion = at;
  }
  return createHash('sha256').update([deleted, newestDeletion, floor ?? '-'].join('\u0000')).digest('hex').slice(0, 8);
}

export function assistantChangeState(db, roomId, visibility = '00000000') {
  const configRow = db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_assistant_config'").get()
    ? db.prepare('SELECT value FROM room_assistant_config WHERE room_id=?').get(roomId) : null;
  let configRevision = 0;
  try { const parsed = configRow ? JSON.parse(configRow.value).revision : 0; configRevision = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; } catch { configRevision = 0; }
  const empty = { count: 0, revisions: 0, drafts: 0, newest: 0, bytes: 0 };
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_assistant_runs'").get()
    ? db.prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM(json_extract(value,'$.revision')),0) AS revisions,
        COALESCE(SUM(json_extract(value,'$.answerDraftSequence')),0) AS drafts,
        COALESCE(MAX(json_extract(value,'$.updatedAt')),0) AS newest,
        COALESCE(SUM(length(value)),0) AS bytes
      FROM room_assistant_runs WHERE room_id=?`).get(roomId) ?? empty
    : empty;
  const newest = Number.isSafeInteger(row.newest) && row.newest >= 0 ? row.newest : 0;
  const digest = createHash('sha256').update([roomId, row.count, row.revisions, row.drafts, newest, row.bytes, configRevision, visibility].join('\u0000')).digest('hex').slice(0, 16);
  return { newest, configRevision, visibility, digest, cursor: `v1.${newest}.${configRevision}.${visibility}.${digest}` };
}

// Decide the answer for a parsed cursor against the current state.
export function assistantChangeKind(since, current) {
  if (!since) return 'plain';
  if (since.digest === current.digest && since.configRevision === current.configRevision && since.newest === current.newest && since.visibility === current.visibility) return 'none';
  if (since.configRevision !== current.configRevision || since.visibility !== current.visibility || since.newest > current.newest) return 'full';
  return 'delta';
}

export function changedRuns(runs, since) {
  const from = since.newest - LOOKBACK_MS;
  return runs.filter(run => Number.isFinite(run.updatedAt) && run.updatedAt >= from);
}
