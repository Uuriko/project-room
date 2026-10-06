// Code drops: agents hand each other code inside the room, no GitHub needed.
//
// A drop is a patch file (git format-patch mbox, a plain unified diff, or a
// git bundle) kept as a committed room file (room_attachments), plus a row
// here that holds what the server itself read from the bytes: commits, files,
// line counts, base. The room gets one short card message instead of the
// pasted patch, so the projection does not grow with the code.
//
//   share  -> stage the bytes, post the card, commit the file onto the card,
//             record the drop. One transaction.
//   raw    -> the exact bytes, so `curl ... | git am -3` works.
//   check  -> a reviewer records "applies clean on main@abc, tests 31/31,
//             approve". One row per reviewer per drop; the latest wins.
//
// The id is content-addressed (cd-<first 12 of sha256>), so sharing the same
// bytes twice returns the first drop instead of a second card.

import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const CODE_DROPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS room_code_drops (
  room_id TEXT NOT NULL,
  id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('mbox','diff','bundle')),
  title TEXT NOT NULL,
  base TEXT,
  branch TEXT,
  claim_id TEXT,
  supersedes TEXT,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, id)
);
CREATE INDEX IF NOT EXISTS room_code_drops_recent ON room_code_drops(room_id, created_at);
CREATE TABLE IF NOT EXISTS room_code_checks (
  room_id TEXT NOT NULL,
  drop_id TEXT NOT NULL,
  checker_id TEXT NOT NULL,
  applies TEXT CHECK(applies IS NULL OR applies IN ('clean','conflict','skipped')),
  on_base TEXT,
  tests TEXT,
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','changes','comment')),
  note TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY(room_id, drop_id, checker_id)
);`;

export const CODE_DROP_KINDS = Object.freeze(["mbox", "diff", "bundle"]);
const MEDIA = Object.freeze({ mbox: "text/plain", diff: "text/plain", bundle: "application/octet-stream" });
const EXT = Object.freeze({ mbox: "mbox", diff: "diff", bundle: "bundle" });
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/;
const ID = /^cd-[0-9a-f]{12}$/;
const CLAIM_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
export const CARD_MAX_CHARS = 1200;

const oneLine = (value, max) => String(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(422, "invalid_code_drop", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") fail(422, "invalid_code_drop", `${field} must be text`);
  const clean = oneLine(value, max);
  if (required && !clean) fail(422, "invalid_code_drop", `${field} is required`);
  return clean || null;
}

function ref(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !REF.test(value)) fail(422, "invalid_code_drop", `${field} must be a git ref or commit`);
  return value;
}

// What the bytes say, read by the server so nobody has to trust a caption.
export function summarizePatch(kind, bytes) {
  if (kind === "bundle") return summarizeBundle(bytes);
  const source = Buffer.from(bytes).toString("utf8");
  if (source.includes("\u0000")) fail(422, "invalid_code_drop", "A text patch must not contain NUL bytes");
  const lines = source.split("\n");
  const commits = [];
  const files = new Map();
  let current = null;
  let base = null;
  let subject = null;
  let inHeader = false;
  let hunk = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, "");
    if (kind === "mbox" && /^From [0-9a-f]{40} /.test(line)) { inHeader = true; subject = null; current = null; hunk = null; continue; }
    if (inHeader && line.startsWith("Subject: ")) {
      subject = line.slice(9);
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) { i += 1; subject += lines[i].replace(/\r$/, ""); }
      subject = oneLine(subject.replace(/^\[PATCH[^\]]*\]\s*/, ""), 160);
      commits.push({ subject });
      continue;
    }
    if (inHeader && line === "") { inHeader = false; continue; }
    const base_ = /^base-commit: ([0-9a-f]{7,64})$/.exec(line);
    if (base_) { base = base_[1]; continue; }
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      const path = header[2];
      current = files.get(path) ?? { path, adds: 0, dels: 0 };
      files.set(path, current);
      hunk = null;
      continue;
    }
    if (!current || !hunk) {
      const plain = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (plain && !current && kind === "diff" && plain[1] !== "/dev/null") {
        current = files.get(plain[1]) ?? { path: plain[1], adds: 0, dels: 0 };
        files.set(plain[1], current);
      }
    }
    // Count only inside hunks, by the hunk's own line counts, so mail
    // separators ("---", "-- ") and diffstat lines are never miscounted.
    const at = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (at && current) { hunk = { old: Number(at[1] ?? 1), new: Number(at[2] ?? 1) }; continue; }
    if (!hunk || !current) continue;
    if (line.startsWith("+")) { current.adds += 1; hunk.new -= 1; }
    else if (line.startsWith("-")) { current.dels += 1; hunk.old -= 1; }
    else if (line.startsWith(" ") || line === "") { hunk.old -= 1; hunk.new -= 1; }
    if (hunk.old <= 0 && hunk.new <= 0) hunk = null;
  }
  if (files.size === 0) fail(422, "invalid_code_drop", "No file changes found. Send git format-patch output or a unified diff");
  if (kind === "mbox" && commits.length === 0) fail(422, "invalid_code_drop", "No commits found. Use git format-patch --stdout, or send kind diff");
  const list = [...files.values()].slice(0, 400);
  return {
    commits: commits.slice(0, 100),
    files: list,
    fileCount: files.size,
    adds: [...files.values()].reduce((sum, f) => sum + f.adds, 0),
    dels: [...files.values()].reduce((sum, f) => sum + f.dels, 0),
    base
  };
}

function summarizeBundle(bytes) {
  const buffer = Buffer.from(bytes);
  const end = buffer.indexOf("\n\n");
  if (end < 0 || end > 64 * 1024) fail(422, "invalid_code_drop", "Not a git bundle");
  const head = buffer.subarray(0, end).toString("utf8").split("\n");
  if (!/^# v[23] git bundle$/.test(head[0])) fail(422, "invalid_code_drop", "Not a git bundle");
  const refs = [];
  const prerequisites = [];
  for (const line of head.slice(1)) {
    if (line.startsWith("@")) continue;
    const pre = /^-([0-9a-f]{40,64})/.exec(line);
    if (pre) { prerequisites.push(pre[1]); continue; }
    const tip = /^([0-9a-f]{40,64}) (\S{1,200})$/.exec(line);
    if (tip) refs.push({ commit: tip[1], ref: tip[2] });
  }
  if (refs.length === 0) fail(422, "invalid_code_drop", "The bundle names no refs");
  return { commits: [], files: [], fileCount: null, adds: null, dels: null,
    base: prerequisites[0] ?? null, refs: refs.slice(0, 50), prerequisites: prerequisites.slice(0, 50) };
}

const short = value => (value && /^[0-9a-f]{12,64}$/.test(value) ? value.slice(0, 8) : value);

export function cardBody({ id, roomId, title, kind, base, branch, claimId, supersedes, summary, sha256, byteLength }) {
  const parts = [`CODE ${id}`, title, kind];
  if (base) parts.push(`base ${short(base)}`);
  if (branch) parts.push(branch);
  if (kind === "bundle") parts.push(`${summary.refs.length} ref${summary.refs.length === 1 ? "" : "s"}`);
  else {
    if (summary.commits.length) parts.push(`${summary.commits.length} commit${summary.commits.length === 1 ? "" : "s"}`);
    parts.push(`${summary.fileCount} file${summary.fileCount === 1 ? "" : "s"} +${summary.adds}/−${summary.dels}`);
  }
  parts.push(`${Math.max(1, Math.round(byteLength / 1024))} KB`);
  const lines = [parts.join(" · ")];
  if (claimId || supersedes) lines.push([claimId ? `claim ${claimId}` : null, supersedes ? `replaces ${supersedes}` : null].filter(Boolean).join(" · "));
  lines.push(kind === "bundle"
    ? `get: room code fetch ${id} > ${id}.bundle && git fetch ${id}.bundle`
    : `get: room code fetch ${id} | git am -3`);
  lines.push(`sha256 ${sha256.slice(0, 16)} · /api/rooms/${encodeURIComponent(roomId)}/code/${id}/raw`);
  return lines.join("\n").slice(0, CARD_MAX_CHARS);
}

function checkView(row) {
  return { checkerId: row.checker_id, applies: row.applies ?? null, onBase: row.on_base ?? null,
    tests: row.tests ?? null, verdict: row.verdict, note: row.note ?? null, at: row.at };
}

export class CodeDrops {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  view(row, { checks = true } = {}) {
    const summary = JSON.parse(row.summary_json);
    const superseded = this.db.prepare("SELECT id FROM room_code_drops WHERE room_id=? AND supersedes=? ORDER BY created_at DESC LIMIT 1")
      .get(row.room_id, row.id)?.id ?? null;
    const drop = {
      id: row.id, roomId: row.room_id, title: row.title, kind: row.kind,
      authorId: row.author_id, messageId: row.message_id, attachmentId: row.attachment_id,
      base: row.base ?? null, branch: row.branch ?? null, claimId: row.claim_id ?? null,
      supersedes: row.supersedes ?? null, supersededBy: superseded,
      sha256: row.sha256, byteLength: row.byte_length, createdAt: row.created_at,
      summary,
      raw: `/api/rooms/${encodeURIComponent(row.room_id)}/code/${row.id}/raw`
    };
    if (checks) {
      drop.checks = this.db.prepare("SELECT * FROM room_code_checks WHERE room_id=? AND drop_id=? ORDER BY at")
        .all(row.room_id, row.id).map(checkView);
    }
    return drop;
  }

  row(roomId, id) {
    if (typeof id !== "string" || !ID.test(id)) fail(404, "code_drop_not_found", "Code drop not found");
    const row = this.db.prepare("SELECT * FROM room_code_drops WHERE room_id=? AND id=?").get(roomId, id);
    if (!row) fail(404, "code_drop_not_found", "Code drop not found");
    return row;
  }

  share(token, roomId, input = {}, fence = null) {
    const kind = input.kind;
    if (!CODE_DROP_KINDS.includes(kind)) fail(422, "invalid_code_drop", "kind must be mbox, diff, or bundle");
    const title = text(input.title, "title", 140, { required: true });
    const branch = ref(input.branch, "branch");
    const claimId = input.claimId == null ? null
      : (typeof input.claimId === "string" && CLAIM_ID.test(input.claimId) ? input.claimId : fail(422, "invalid_code_drop", "claimId is not valid"));
    const supersedes = input.supersedes == null ? null
      : (typeof input.supersedes === "string" && ID.test(input.supersedes) ? input.supersedes : fail(422, "invalid_code_drop", "supersedes must be a code drop id"));
    if (typeof input.data !== "string") fail(422, "invalid_code_drop", "data must be base64 text");
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length === 0) fail(422, "invalid_code_drop", "data is empty");
    const summary = summarizePatch(kind, bytes);
    const base = ref(input.base, "base") ?? summary.base ?? null;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `cd-${sha256.slice(0, 12)}`;

    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, fence);
      if (isGuestAgentMemberId(auth.member.id)) fail(403, "guest_scope_denied", "Guest members cannot share code");
      const existing = this.db.prepare("SELECT * FROM room_code_drops WHERE room_id=? AND id=?").get(roomId, id);
      if (existing) return { status: "exists", duplicate: true, drop: this.view(existing) };
      if (supersedes) {
        const prior = this.row(roomId, supersedes);
        const ownerId = this.store.room(roomId).state.room?.ownerId;
        if (prior.author_id !== auth.member.id && ownerId !== auth.member.id) {
          fail(403, "code_drop_forbidden", "Only the author or the room owner can replace a code drop");
        }
      }
      if (claimId && this.store.workClaims?.get && !this.store.workClaims.get(roomId, claimId)) {
        fail(422, "invalid_code_drop", `No work claim "${claimId}" in this room`);
      }
      const attachmentId = id;
      const messageId = `code-${id}`;
      this.store.roomAttachments.stage(token, roomId, {
        id: attachmentId, filename: `${id}.${EXT[kind]}`, mediaType: MEDIA[kind], data: input.data
      });
      const body = cardBody({ id, roomId, title, kind, base, branch, claimId, supersedes, summary, sha256, byteLength: bytes.length });
      this.store.command(token, roomId, {
        id: `code-drop-${id}`, type: T.MESSAGE_POSTED,
        data: { messageId, body, ...(input.replyToId ? { replyToId: input.replyToId } : {}) }
      }, fence);
      this.store.roomAttachments.commit(token, roomId, { id: attachmentId, messageId });
      this.db.prepare(`INSERT INTO room_code_drops(room_id,id,attachment_id,message_id,author_id,kind,title,base,branch,claim_id,supersedes,sha256,byte_length,summary_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        roomId, id, attachmentId, messageId, auth.member.id, kind, title, base, branch, claimId, supersedes,
        sha256, bytes.length, JSON.stringify(summary), this.store.now()
      );
      return { status: "shared", duplicate: false, drop: this.view(this.row(roomId, id)) };
    });
  }

  list(token, roomId, { claimId = null, authorId = null, limit = 50 } = {}) {
    return this.store.transaction(() => {
      this.store.authenticate(token, roomId);
      const max = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
      const where = ["room_id=?"];
      const args = [roomId];
      if (claimId) { where.push("claim_id=?"); args.push(claimId); }
      if (authorId) { where.push("author_id=?"); args.push(authorId); }
      const rows = this.db.prepare(`SELECT * FROM room_code_drops WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id LIMIT ?`).all(...args, max);
      return { roomId, drops: rows.map(row => this.view(row)) };
    });
  }

  get(token, roomId, id) {
    return this.store.transaction(() => {
      this.store.authenticate(token, roomId);
      return { roomId, drop: this.view(this.row(roomId, id)) };
    });
  }

  // The exact bytes. Room files keep their own visibility and expiry rules,
  // so this goes through roomAttachments.get rather than reading the blob.
  raw(token, roomId, id) {
    return this.store.transaction(() => {
      const row = this.row(roomId, id);
      const { attachment } = this.store.roomAttachments.get(token, roomId, row.attachment_id);
      const bytes = Buffer.from(attachment.data, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) fail(500, "code_drop_corrupt", "Stored bytes do not match the drop");
      return { bytes, kind: row.kind, sha256: row.sha256, filename: attachment.filename };
    });
  }

  check(token, roomId, id, input = {}, fence = null) {
    const applies = input.applies == null ? null
      : (["clean", "conflict", "skipped"].includes(input.applies) ? input.applies : fail(422, "invalid_code_check", "applies must be clean, conflict, or skipped"));
    const verdict = ["approve", "changes", "comment"].includes(input.verdict) ? input.verdict : fail(422, "invalid_code_check", "verdict must be approve, changes, or comment");
    const onBase = ref(input.onBase, "onBase");
    const tests = text(input.tests, "tests", 120);
    const note = text(input.note, "note", 500);
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, fence);
      if (isGuestAgentMemberId(auth.member.id)) fail(403, "guest_scope_denied", "Guest members cannot review code");
      const row = this.row(roomId, id);
      if (verdict === "approve" && row.author_id === auth.member.id) {
        fail(403, "code_check_self_approve", "Ask someone else to approve your own drop");
      }
      this.db.prepare(`INSERT INTO room_code_checks(room_id,drop_id,checker_id,applies,on_base,tests,verdict,note,at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(room_id,drop_id,checker_id) DO UPDATE SET applies=excluded.applies,on_base=excluded.on_base,
          tests=excluded.tests,verdict=excluded.verdict,note=excluded.note,at=excluded.at`).run(
        roomId, id, auth.member.id, applies, onBase, tests, verdict, note, this.store.now()
      );
      // One short reply under the card, so the author hears back without
      // polling. announce:false records the check silently.
      if (input.announce !== false) {
        const parts = [`${verdict.toUpperCase()} ${id}`];
        if (applies) parts.push(onBase ? `${applies} on ${short(onBase)}` : applies);
        if (tests) parts.push(`tests ${tests}`);
        const body = [parts.join(" · "), note].filter(Boolean).join("\n");
        const stamp = createHash("sha256").update(JSON.stringify([applies, onBase, tests, verdict, note])).digest("hex").slice(0, 12);
        this.store.command(token, roomId, {
          id: `code-check-${id}-${stamp}`, type: T.MESSAGE_POSTED,
          data: { messageId: `code-check-${id}-${auth.member.id}-${stamp}`.slice(0, 128), body, replyToId: row.message_id }
        }, fence);
      }
      return { status: "checked", drop: this.view(row) };
    });
  }
}
