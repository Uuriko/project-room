// Internal side-notes on inbox threads (lane C, inbox-agent-collab).
// Agents and humans leave private context on a thread — what was tried,
// what the sender really wants, what not to promise — that must never reach
// the channel. The contract is enforced in code, not just convention:
//
//   1. Notes live only in this journal; no method here builds or returns a
//      channel payload, so there is no accidental path from note to wire.
//   2. assertNoInternal(payload) recursively scans any outbound-bound value
//      and throws note_contract_violation if it finds an internal-flagged
//      node or a banned internal field name — the channel layer calls it
//      before sending and fails closed.
//   3. stripInternal(payload) deep-copies a value with all internal material
//      removed (defense in depth for callers that must pass untrusted
//      aggregates through).
//
// Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and
// id generator are injected so fixtures control time and ids.
import { randomUUID } from "node:crypto";
import { identityOf, threadIdOf } from "./inbox-assign.mjs";

export class NoteError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "NoteError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new NoteError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

const bodyOf = (value, field = "body", max = 4000) => {
  check(typeof value === "string" && value.isWellFormed() && value.length >= 1 && value.length <= max,
    "note_invalid", `${field} must be 1..${max} well-formed characters`);
  return value;
};
const tagOf = value => {
  if (value === undefined || value === null) return null;
  check(typeof value === "string" && /^[a-z0-9-]{1,32}$/.test(value), "note_invalid",
    "tag must be 1..32 lowercase letters, digits or dashes");
  return value;
};
const isoOf = ms => new Date(ms).toISOString();

// identityOf/threadIdOf come from the assignment module; wrap them so this
// module's public surface throws only NoteError — one error contract per
// module, one catch for the caller.
const threadOf = value => {
  try { return threadIdOf(value); } catch (error) { fail("note_invalid", error.message); }
};
const identity = (value, field) => {
  try { return identityOf(value, field); } catch (error) { fail("note_invalid", error.message); }
};

const freezeNote = note => Object.freeze({ ...note, author: Object.freeze({ ...note.author }) });

// Field names that may never appear in a channel-bound payload, and the
// per-node marker this journal stamps on every record it returns.
export const internalFieldNames = Object.freeze([
  "internal", "internalNote", "internalNotes", "internal_notes",
  "privateNote", "privateNotes", "private_note", "sideNote", "sideNotes",
]);
const banned = new Set(internalFieldNames);

const findInternal = (value, path = "$") => {
  if (value === null || typeof value !== "object") return null;
  if (value.internal === true) return path;
  for (const [key, child] of Object.entries(value)) {
    if (banned.has(key)) return `${path}.${key}`;
    const hit = findInternal(child, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
};

// Fail closed: throw note_contract_violation naming the offending path.
// Channel send paths call this on the payload before touching the wire.
export function assertNoInternal(payload) {
  const hit = findInternal(payload);
  if (hit) fail("note_contract_violation", `Channel payload carries internal material at ${hit}`, { path: hit });
  return true;
}

// Defense in depth: deep-copy a value with every internal-flagged node and
// every banned field name removed. Frozen on the way out.
export function stripInternal(payload) {
  const clean = value => {
    if (value === null || typeof value !== "object") return value;
    if (value.internal === true) return undefined;
    if (Array.isArray(value)) {
      const out = [];
      for (const child of value) {
        const cleaned = clean(child);
        if (cleaned !== undefined) out.push(cleaned);
      }
      return out;
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (banned.has(key)) continue;
      const cleaned = clean(child);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  };
  const freezeDeep = value => {
    if (value === null || typeof value !== "object") return value;
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
  };
  return freezeDeep(clean(payload) ?? (Array.isArray(payload) ? [] : {}));
}

export function createInternalNotes({ clock = () => Date.now(), id = () => randomUUID() } = {}) {
  const notes = new Map();   // noteId -> note
  const byThread = new Map(); // threadId -> [noteIds] in insertion order

  function addNote(threadId, { author, body, tag = null } = {}) {
    const tid = threadOf(threadId);
    const who = identity(author, "author");
    const note = freezeNote({ noteId: id(), threadId: tid, author: who,
      body: bodyOf(body), tag: tagOf(tag),
      createdAt: isoOf(clock()), updatedAt: null, deleted: false, internal: true });
    notes.set(note.noteId, note);
    byThread.set(tid, [...(byThread.get(tid) ?? []), note.noteId]);
    return note;
  }

  const getNote = noteId => {
    check(typeof noteId === "string" && noteId.length >= 1, "note_invalid", "noteId must be a non-empty string");
    const note = notes.get(noteId);
    if (!note) fail("note_not_found", "No such internal note.", { noteId });
    return note;
  };

  // Only the original author may edit — a note is someone's private working
  // memory, not a wiki. Editing a deleted note is refused, never resurrected.
  function editNote(noteId, { author, body } = {}) {
    const note = getNote(noteId);
    if (note.deleted) fail("note_invalid", "Deleted notes cannot be edited.");
    const who = identity(author, "author");
    if (who.kind !== note.author.kind || who.id !== note.author.id)
      fail("note_forbidden", "Only the original author may edit this note.");
    const next = freezeNote({ ...note, body: bodyOf(body), updatedAt: isoOf(clock()) });
    notes.set(noteId, next);
    return next;
  }

  // Tombstoned, not erased: the journal keeps the record for audit while the
  // body stays out of listings. Same author rule as edits.
  function deleteNote(noteId, { author } = {}) {
    const note = getNote(noteId);
    const who = identity(author, "author");
    if (who.kind !== note.author.kind || who.id !== note.author.id)
      fail("note_forbidden", "Only the original author may delete this note.");
    if (note.deleted) return note;
    const next = freezeNote({ ...note, deleted: true, updatedAt: isoOf(clock()) });
    notes.set(noteId, next);
    return next;
  }

  function listNotes(threadId, { includeDeleted = false } = {}) {
    const tid = threadOf(threadId);
    const rows = (byThread.get(tid) ?? []).map(noteId => notes.get(noteId)).filter(Boolean);
    return Object.freeze(includeDeleted ? rows : rows.filter(note => !note.deleted));
  }

  return Object.freeze({ addNote, editNote, deleteNote, listNotes });
}
